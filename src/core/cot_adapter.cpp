#include "bridge.h"
#include <cmath>
#include <cstdio>
#include <cstring>

static bool xml_name_char(uint8_t value)
{
	return (value >= 'a' && value <= 'z') ||
	       (value >= 'A' && value <= 'Z') ||
	       (value >= '0' && value <= '9') || value == '_' ||
	       value == ':' || value == '-' || value == '.';
}

static bool timestamp_attribute(const uint8_t *data, size_t size, size_t at,
				const char *name, size_t *value)
{
	size_t length = std::strlen(name);

	if ((at && xml_name_char(data[at - 1])) || at > size ||
	    length > size - at || size - at - length < 2 ||
	    std::memcmp(data + at, name, length) ||
	    data[at + length] != '=' || data[at + length + 1] != '"')
		return false;
	*value = at + length + 2;
	return true;
}

static bool timestamp_trim(const uint8_t *data, size_t size, size_t at,
			   size_t *start, size_t *end)
{
	static const char *const names[] = {"time", "start", "stale"};
	size_t value = 0;

	for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i)
		if (timestamp_attribute(data, size, at, names[i], &value)) {
			size_t digits = value + 20;
			size_t count = 0;
			bool extra = false;

			if (value > size || size - value < 20 ||
			    data[value + 19] != '.')
				return false;
			while (digits < size && data[digits] >= '0' &&
			       data[digits] <= '9') {
				if (count >= 3 && data[digits] != '0')
					extra = true;
				++digits;
				++count;
			}
			if (extra && count > 3) {
				*start = value + 23;
				*end = digits;
				return true;
			}
		}
	return false;
}

static bool normalize_xml_timestamps(bridge_context *ctx,
				     const uint8_t *data, size_t size,
				     const uint8_t **normalized, size_t *length)
{
	uint8_t *copy = nullptr;
	size_t source = 0;
	size_t target = 0;

	for (size_t at = 0; at < size;) {
		size_t start, end;

		if (!timestamp_trim(data, size, at, &start, &end)) {
			++at;
			continue;
		}
		if (!copy) {
			copy = static_cast<uint8_t *>(bridge_alloc(ctx, size));
			if (!copy)
				return false;
		}
		std::memcpy(copy + target, data + source, start - source);
		target += start - source;
		source = end;
		at = end;
	}
	if (!copy) {
		*normalized = data;
		*length = size;
		return true;
	}
	std::memcpy(copy + target, data + source, size - source);
	*normalized = copy;
	*length = target + size - source;
	return true;
}

bool bridge_source_value_valid(bridge_context *ctx, int id,
			       const bridge_value *value)
{
	const cot_field_info *info =
	    cot_field_get_info(static_cast<cot_field_id>(id));

	if (!info || info->type == COT_VALUE_EXTENSIONS)
		return bridge_fail(ctx, "unsupported CoT source field");
	if (info->type == COT_VALUE_TEXT)
		return value->kind == BRIDGE_TEXT ||
		       bridge_fail(ctx, "lookup source requires text");
	if (info->type == COT_VALUE_UINT64 || info->type == COT_VALUE_UINT32) {
		if (value->kind != BRIDGE_UINT &&
		    (value->kind != BRIDGE_INT || value->i < 0))
			return bridge_fail(ctx,
					   "lookup source requires an integer");
		uint64_t number = value->kind == BRIDGE_UINT
				      ? value->u
				      : static_cast<uint64_t>(value->i);

		return info->type != COT_VALUE_UINT32 || number <= UINT32_MAX ||
		       bridge_fail(ctx, "lookup source exceeds uint32");
	}
	bridge_value converted = {};

	converted.kind = BRIDGE_REAL;
	if (value->kind == BRIDGE_REAL)
		converted.real = value->real;
	else if (value->kind == BRIDGE_UINT)
		converted.real = static_cast<double>(value->u);
	else if (value->kind == BRIDGE_INT)
		converted.real = static_cast<double>(value->i);
	else
		return bridge_fail(ctx, "lookup source requires a number");
	return std::isfinite(converted.real) &&
		       bridge_value_equal(value, &converted)
		   ? true
		   : bridge_fail(ctx,
				 "lookup source is not exactly representable");
}

bool bridge_cot_load(bridge_context *ctx, cot_format format,
		     const uint8_t *data, size_t size)
{
	cot_diagnostic error = {};
	const uint8_t *normalized = data;
	size_t normalized_size = size;
	cot_status status;

	if (format == COT_FORMAT_XML &&
	    !normalize_xml_timestamps(ctx, data, size, &normalized,
				       &normalized_size))
		return false;
	status = cot_decode_ex(format, normalized, normalized_size,
		&ctx->cot_owner, &error);

	ctx->error_code = "cot_decode";
	if (status != COT_STATUS_OK) {
		ctx->cot_error = error;
		if (error.byte_offset != COT_DIAGNOSTIC_NO_OFFSET)
			return bridge_fail(ctx, "CoT %s at %s, byte %zu",
					   cot_status_string(status),
					   error.path ? error.path : "event",
					   error.byte_offset);
		return bridge_fail(ctx, "CoT %s at %s",
				   cot_status_string(status),
				   error.path ? error.path : "event");
	}
	const cot_event *event = cot_decoded_event_get(ctx->cot_owner);

	if (cot_field_count() >= BRIDGE_COT_FIELDS)
		return bridge_fail(ctx, "CoT catalog exceeds tool field limit");
	for (size_t id = 1; id <= cot_field_count(); ++id) {
		cot_field_value native = {};

		if (cot_field_get(event, static_cast<cot_field_id>(id),
				  &native) != COT_STATUS_OK)
			return bridge_fail(ctx,
					   "cannot inspect native CoT field");
		if (!native.available)
			continue;
		bridge_value *value = &ctx->cot[id];

		switch (native.type) {
		case COT_VALUE_TEXT:
			value->kind = BRIDGE_TEXT;
			value->text = native.value.text.data;
			value->size = native.value.text.size;
			break;
		case COT_VALUE_UINT64:
		case COT_VALUE_UINT32:
			value->kind = BRIDGE_UINT;
			value->u = native.value.uint_value;
			break;
		case COT_VALUE_DOUBLE:
			value->kind = BRIDGE_REAL;
			value->real = native.value.real;
			break;
		case COT_VALUE_EXTENSIONS:
			break;
		}
	}
	if (error.unknown_protobuf_fields)
		bridge_note(
		    ctx, "unknown_protobuf_fields", true,
		    "discarded %llu unknown Protobuf fields (%llu bytes)",
		    static_cast<unsigned long long>(
			error.unknown_protobuf_fields),
		    static_cast<unsigned long long>(
			error.unknown_protobuf_bytes));
	return true;
}
