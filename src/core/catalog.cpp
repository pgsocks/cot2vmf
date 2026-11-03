#include "workspace.h"
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static bool decimal(yyjson_mut_doc *doc, yyjson_mut_val *object,
		    const char *key, uint64_t value)
{
	char buffer[32];

	std::snprintf(buffer, sizeof(buffer), "%llu",
		      static_cast<unsigned long long>(value));
	return yyjson_mut_obj_add_strcpy(doc, object, key, buffer);
}

static bool signed_decimal(yyjson_mut_doc *doc, yyjson_mut_val *object,
			   const char *key, int64_t value)
{
	char buffer[32];

	std::snprintf(buffer, sizeof(buffer), "%lld",
		      static_cast<long long>(value));
	return yyjson_mut_obj_add_strcpy(doc, object, key, buffer);
}

static const char *kind_name(vmf_field_kind kind)
{
	switch (kind) {
	case VMF_FIELD_BOOL:
		return "bool";
	case VMF_FIELD_UNSIGNED:
		return "unsigned";
	case VMF_FIELD_SIGNED:
		return "signed";
	case VMF_FIELD_ENUM:
		return "enum";
	case VMF_FIELD_SCALED:
		return "scaled";
	case VMF_FIELD_TEXT:
		return "text";
	case VMF_FIELD_OCTETS:
		return "octets";
	case VMF_FIELD_BITS:
		return "bits";
	}
	return "unknown";
}

static bool append(char *buffer, size_t capacity, const char *format, ...)
{
	size_t length = std::strlen(buffer);
	va_list args;

	va_start(args, format);
	int size = std::vsnprintf(buffer + length, capacity - length, format,
				  args);

	va_end(args);
	return size >= 0 && static_cast<size_t>(size) < capacity - length;
}

static bool index_text(vmf_index_number number, char *buffer, size_t size)
{
	buffer[0] = 0;
	for (size_t i = 0; i < number.count; ++i)
		if (!append(buffer, size, "%s%u", i ? "." : "",
			    number.parts[i]))
			return false;
	return true;
}

static yyjson_mut_val *rational(yyjson_mut_doc *doc, vmf_rational number)
{
	yyjson_mut_val *object = yyjson_mut_obj(doc);

	return object &&
			       signed_decimal(doc, object, "numerator",
					      number.numerator) &&
			       decimal(doc, object, "denominator",
				       number.denominator)
		       ? object
		       : nullptr;
}

static yyjson_mut_val *scale(yyjson_mut_doc *doc,
			     const vmf_scale_definition *definition)
{
	if (!definition)
		return yyjson_mut_null(doc);
	yyjson_mut_val *object = yyjson_mut_obj(doc);
	yyjson_mut_val *sentinels = yyjson_mut_arr(doc);

	if (!object || !sentinels ||
	    !yyjson_mut_obj_add_val(doc, object, "factor",
				    rational(doc, definition->factor)) ||
	    !yyjson_mut_obj_add_val(doc, object, "bias",
				    rational(doc, definition->bias)) ||
	    !yyjson_mut_obj_add_val(doc, object, "sentinels", sentinels))
		return nullptr;
	for (size_t i = 0; i < definition->sentinel_count; ++i) {
		char value[32];

		std::snprintf(value, sizeof(value), "%llu",
			      static_cast<unsigned long long>(
				      definition->sentinels[i]));
		if (!yyjson_mut_arr_add_strcpy(doc, sentinels, value))
			return nullptr;
	}
	return object;
}

static bool fields(yyjson_mut_doc *doc, yyjson_mut_val *array,
		   const vmf_schema_set *schemas,
		   const vmf_message_schema *message)
{
	for (size_t i = 0; i < message->index_count; ++i) {
		const vmf_index_schema *index = message->indexes + i;
		vmf_index_info info = {};

		if (vmf_schema_index_info(schemas, message, index, &info) !=
		    VMF_OK)
			return false;
		char path[768];
		const vmf_index_schema *length_source = info.length_from.count ?
			vmf_schema_find(message, info.length_from) : nullptr;
		vmf_string length = length_source ? length_source->key :
			vmf_string{nullptr, 0};
		yyjson_mut_val *item = yyjson_mut_arr_add_obj(doc, array);
		yyjson_mut_val *repeats = yyjson_mut_arr(doc);
		yyjson_mut_val *groups = yyjson_mut_arr(doc);
		yyjson_mut_val *allowed = yyjson_mut_arr(doc);

		if (!item || !repeats || !groups || !allowed ||
		    !index_text(index->index_number, path, sizeof(path)) ||
		    !yyjson_mut_obj_add_strcpy(doc, item, "index", path) ||
		    !yyjson_mut_obj_add_strncpy(doc, item, "key",
						info.key.data ? info.key.data
							      : "",
						info.key.size) ||
		    !yyjson_mut_obj_add_str(doc, item, "kind",
					    kind_name(info.kind)) ||
		    !decimal(doc, item, "bits", info.number_of_bits) ||
		    !decimal(doc, item, "capacity", info.capacity_units) ||
		    !yyjson_mut_obj_add_bool(doc, item, "variable",
					     info.variable) ||
		    !yyjson_mut_obj_add_bool(doc, item, "literal",
					     info.literal) ||
		    !yyjson_mut_obj_add_uint(doc, item, "representation",
					     info.integer.representation) ||
		    !yyjson_mut_obj_add_uint(doc, item, "text_encoding",
					     info.text_encoding) ||
		    !yyjson_mut_obj_add_uint(doc, item, "indicator",
					     info.indicator) ||
		    !yyjson_mut_obj_add_bool(doc, item, "mappable",
					     info.indicator ==
						     VMF_INDICATOR_NONE) ||
		    !yyjson_mut_obj_add_val(doc, item, "repeats", repeats) ||
		    !yyjson_mut_obj_add_val(doc, item, "groups", groups) ||
		    !yyjson_mut_obj_add_val(doc, item, "allowed", allowed) ||
		    !yyjson_mut_obj_add_val(doc, item, "scale",
					    scale(doc, info.scale)) ||
		    !yyjson_mut_obj_add_strncpy(doc, item, "length_from",
					       length.data ? length.data : "",
					       length.size) ||
		    !signed_decimal(doc, item, "length_bias",
				    info.length_bias) ||
		    !yyjson_mut_obj_add_bool(doc, item, "conditional",
					     info.when != nullptr))
			return false;
		if (info.constant.present) {
			if (!decimal(doc, item, "constant",
				     info.constant.value))
				return false;
		} else if (!yyjson_mut_obj_add_null(doc, item, "constant")) {
			return false;
		}
		for (size_t j = 0; j < index->group_code.count; ++j)
			if (!yyjson_mut_arr_add_uint(
				    doc, groups, index->group_code.parts[j]))
				return false;
		for (size_t j = 0; j < info.allowed_count; ++j) {
			yyjson_mut_val *range =
				yyjson_mut_arr_add_obj(doc, allowed);

			if (!range ||
			    !decimal(doc, range, "first",
				     info.allowed[j].first) ||
			    !decimal(doc, range, "last", info.allowed[j].last))
				return false;
		}
		for (size_t j = 0; j < index->repeat_code.count; ++j) {
			vmf_scope_ref scope = {VMF_SCOPE_REPEAT,
					       index->repeat_code.parts[j].id};
			vmf_scope_info repeat_info = {};
			yyjson_mut_val *repeat =
				yyjson_mut_arr_add_obj(doc, repeats);

			if (!repeat ||
			    vmf_schema_scope_info(schemas, message, scope,
						  &repeat_info) != VMF_OK ||
			    !yyjson_mut_obj_add_uint(doc, repeat, "repeat",
						     scope.id) ||
			    !decimal(doc, repeat, "minimum",
				     repeat_info.minimum) ||
			    !decimal(doc, repeat, "maximum",
				     repeat_info.maximum))
				return false;
		}
	}
	return true;
}

static const char *standard_name(vmf_message_standard standard)
{
	static const char *const names[] = {
		"MIL-STD-6017", "MIL-STD-6017A", "MIL-STD-6017B",
		"MIL-STD-6017C", "MIL-STD-6017D", "MIL-STD-6017E",
		"TIDP-TE-R2", "TIDP-TE-R3", "TIDP-TE-R4", "TIDP-TE-R5",
		"TIDP-TE-R6", "TIDP-TE-R7", "TIDP-FTE-R6"
	};
	unsigned index = static_cast<unsigned>(standard);

	return index < sizeof(names) / sizeof(names[0]) ? names[index] : "";
}

static bool profile_variant(yyjson_mut_doc *doc, yyjson_mut_val *profiles,
	const vmf_schema_set *view, vmf_envelope_version profile,
	const char *name)
{
	vmf_message_id identity = {};
	auto limits = vmf_default_limits();
	vmf_status status = vmf_schema_set_validate_for_profile(view, profile,
		&limits, nullptr, nullptr);

	if (status == VMF_OK)
		status = vmf_schema_message_id_for_profile(view, view->messages,
			profile, &identity);
	auto options = vmf_header_json_default_options();
	vmf_header_json_text *text = nullptr;

	if (status == VMF_OK)
		status = vmf_header_json_template(profile, &identity, 1,
			&options, &text, nullptr);
	if (status == VMF_OUT_OF_MEMORY)
		return false;
	yyjson_mut_val *item = yyjson_mut_obj(doc);

	if (!item || !yyjson_mut_obj_add_val(doc, profiles, name, item) ||
		!yyjson_mut_obj_add_bool(doc, item, "available",
			status == VMF_OK) ||
		!yyjson_mut_obj_add_str(doc, item, "diagnostic",
			status == VMF_OK ? "" : vmf_status_string(status))) {
		vmf_header_json_text_destroy(text);
		return false;
	}
	if (status != VMF_OK)
		return yyjson_mut_obj_add_null(doc, item, "identity") &&
			yyjson_mut_obj_add_null(doc, item, "header");
	yyjson_doc *parsed = yyjson_read(vmf_header_json_text_data(text),
		vmf_header_json_text_size(text), 0);
	yyjson_val *root = parsed ? yyjson_doc_get_root(parsed) : nullptr;
	yyjson_val *headers = yyjson_obj_get(
		yyjson_obj_get(root, "fields"), "messages");
	yyjson_val *id = yyjson_obj_get(yyjson_arr_get(headers, 0), "id");
	yyjson_mut_val *header = root ? yyjson_val_mut_copy(doc, root) : nullptr;
	yyjson_mut_val *exact = id ? yyjson_val_mut_copy(doc, id) : nullptr;

	yyjson_doc_free(parsed);
	vmf_header_json_text_destroy(text);
	return header && exact &&
		yyjson_mut_obj_add_val(doc, item, "identity", exact) &&
		yyjson_mut_obj_add_val(doc, item, "header", header);
}

static bool messages(yyjson_mut_doc *doc, yyjson_mut_val *array,
		     const vmf_schema_set *schemas)
{
	static const char *const names[] = {"B", "C", "D", "D1"};

	for (size_t i = 0; i < schemas->message_count; ++i) {
		const vmf_message_schema *message = schemas->messages + i;
		vmf_schema_set view = bridge_message_view(schemas, i);
		char label[160] = {}, number[32];

		std::snprintf(number, sizeof(number), "K%02u.%u",
			message->message_number.functional_area,
			message->message_number.number);
		std::snprintf(label, sizeof(label), "%s; UMF 2", number);
		if (view.standard.kind == VMF_STANDARD_EDITION)
			append(label, sizeof(label), "; %s",
				standard_name(view.standard.as.edition));
		else if (view.standard.kind == VMF_STANDARD_RAW_CODE)
			append(label, sizeof(label), "; raw version %u",
				view.standard.as.raw_code);
		else
			append(label, sizeof(label), "; version absent");
		if (message->subtype.present)
			append(label, sizeof(label), "; subtype %u",
				message->subtype.value);
		yyjson_mut_val *item = yyjson_mut_arr_add_obj(doc, array);
		yyjson_mut_val *targets = yyjson_mut_arr(doc);
		yyjson_mut_val *profiles = yyjson_mut_obj(doc);

		if (!item || !targets || !profiles ||
			!yyjson_mut_obj_add_uint(doc, item, "ordinal", i) ||
			!yyjson_mut_obj_add_strcpy(doc, item, "label", label) ||
			!yyjson_mut_obj_add_strcpy(doc, item, "message_number",
				number) ||
			!yyjson_mut_obj_add_val(doc, item, "fields", targets) ||
			!yyjson_mut_obj_add_val(doc, item, "profiles", profiles) ||
			!fields(doc, targets, &view, message))
			return false;
		for (unsigned p = VMF_ENVELOPE_B; p <= VMF_ENVELOPE_D1; ++p)
			if (!profile_variant(doc, profiles, &view,
				static_cast<vmf_envelope_version>(p), names[p - 1]))
				return false;
	}
	return true;
}

static bool cot_catalog(yyjson_mut_doc *doc, yyjson_mut_val *array)
{
	for (size_t id = 1; id <= cot_field_count(); ++id) {
		const cot_field_info *info =
			cot_field_get_info(static_cast<cot_field_id>(id));
		yyjson_mut_val *item = yyjson_mut_arr_add_obj(doc, array);

		if (!item || !yyjson_mut_obj_add_uint(doc, item, "id", id) ||
		    !yyjson_mut_obj_add_str(doc, item, "path", info->path) ||
		    !yyjson_mut_obj_add_str(
			    doc, item, "type",
			    cot_field_type_string(info->type)) ||
		    !yyjson_mut_obj_add_str(
			    doc, item, "unit",
			    cot_field_unit_string(info->unit)) ||
		    !yyjson_mut_obj_add_str(doc, item, "group",
					    cot_group_id_string(info->group)) ||
		    !yyjson_mut_obj_add_bool(doc, item, "mappable",
			info->type != COT_VALUE_EXTENSIONS &&
			info->id != COT_FIELD_DETAIL_XML))
			return false;
	}
	return true;
}

cv_status cv_catalog(const uint8_t *data, size_t size, cv_buffer *result,
		     cv_error *error)
{
	static const char empty[] = "{\"format\":\"cot-vmf-workspace/1\","
				    "\"schemas\":[],\"outputs\":[]}";

	cv_fail(error, CV_OK, "");
	if (result)
		*result = {};
	if (!result || (!data && size))
		return cv_fail(
			error, CV_INVALID_ARGUMENT,
			"catalog result and readable input are required");
	if (!data) {
		data = reinterpret_cast<const uint8_t *>(empty);
		size = sizeof(empty) - 1;
	}
	bridge_context source = {};

	if (!cv_workspace_parse(&source, data, size)) {
		cv_fail(error, CV_INVALID_CONFIG, source.error);
		bridge_destroy(&source);
		return CV_INVALID_CONFIG;
	}
	yyjson_mut_doc *doc = yyjson_mut_doc_new(nullptr);
	yyjson_mut_val *root = doc ? yyjson_mut_obj(doc) : nullptr;
	yyjson_mut_val *cot = doc ? yyjson_mut_arr(doc) : nullptr;
	yyjson_mut_val *schemas = doc ? yyjson_mut_arr(doc) : nullptr;
	bool valid = root && cot && schemas &&
		     yyjson_mut_obj_add_str(doc, root, "format",
					    "cot-vmf-catalog/1") &&
		     yyjson_mut_obj_add_val(doc, root, "cot", cot) &&
		     yyjson_mut_obj_add_val(doc, root, "schemas", schemas) &&
		     cot_catalog(doc, cot);
	yyjson_val *input =
		yyjson_obj_get(yyjson_doc_get_root(source.config), "schemas");

	if (root)
		yyjson_mut_doc_set_root(doc, root);
	for (size_t i = 0; valid && i < yyjson_arr_size(input); ++i) {
		yyjson_val *entry = yyjson_arr_get(input, i);
		vmf_schema_json_document *owner = nullptr;
		cv_error diagnostic = {};
		bool loaded = cv_schema_load(yyjson_obj_get(entry, "document"),
					     &owner, &diagnostic);
		yyjson_mut_val *item = yyjson_mut_arr_add_obj(doc, schemas);
		yyjson_mut_val *array = yyjson_mut_arr(doc);

		valid = item && array &&
			yyjson_mut_obj_add_strcpy(
				doc, item, "id",
				yyjson_get_str(yyjson_obj_get(entry, "id"))) &&
			yyjson_mut_obj_add_bool(doc, item, "valid", loaded) &&
			yyjson_mut_obj_add_strcpy(doc, item, "diagnostic",
						  diagnostic.message) &&
			yyjson_mut_obj_add_val(doc, item, "messages", array) &&
			(!loaded ||
			 messages(doc, array, vmf_schema_json_schemas(owner)));
		vmf_schema_json_destroy(owner);
	}
	if (valid) {
		char *json = yyjson_mut_write(doc, 0, &result->size);

		result->data = reinterpret_cast<uint8_t *>(json);
		valid = json && result->size <= 64 * 1024 * 1024;
	}
	yyjson_mut_doc_free(doc);
	bridge_destroy(&source);
	if (!valid) {
		cv_buffer_destroy(result);
		return cv_fail(error, CV_OUT_OF_MEMORY,
			       "catalog allocation budget exhausted");
	}
	return CV_OK;
}
