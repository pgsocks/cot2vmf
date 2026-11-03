#include "bridge.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static bool keys(bridge_context *ctx, yyjson_val *object,
		 const char *const *allowed, size_t count)
{
	if (!yyjson_is_obj(object))
		return bridge_fail(ctx, "expected configuration object");
	yyjson_obj_iter iter = yyjson_obj_iter_with(object);
	yyjson_val *key;

	while ((key = yyjson_obj_iter_next(&iter))) {
		bool known = false;

		for (size_t i = 0; i < count; ++i)
			known |= yyjson_equals_str(key, allowed[i]);
		if (!known)
			return bridge_fail(ctx, "unknown config property");
	}
	return true;
}

static bool unique_keys(bridge_context *ctx, yyjson_val *value, size_t depth)
{
	if (depth > BRIDGE_MAX_DEPTH)
		return bridge_fail(ctx, "configuration nesting too deep");
	if (yyjson_is_obj(value)) {
		if (yyjson_obj_size(value) > 4096)
			return bridge_fail(ctx,
					   "configuration object too large");
		yyjson_obj_iter iter = yyjson_obj_iter_with(value);
		yyjson_val *key;

		while ((key = yyjson_obj_iter_next(&iter))) {
			const char *name = yyjson_get_str(key);
			size_t length = yyjson_get_len(key);

			if (std::strlen(name) != length)
				return bridge_fail(ctx, "NUL in config key");
			yyjson_obj_iter prior = yyjson_obj_iter_with(value);
			yyjson_val *other;

			while ((other = yyjson_obj_iter_next(&prior)) != key)
				if (yyjson_equals_strn(other, name, length))
					return bridge_fail(
					    ctx,
					    "duplicate config property");
			if (!unique_keys(ctx, yyjson_obj_iter_get_val(key),
					 depth + 1))
				return false;
		}
	} else if (yyjson_is_arr(value)) {
		if (yyjson_arr_size(value) > 65536)
			return bridge_fail(ctx,
					   "configuration array too large");
		yyjson_arr_iter iter = yyjson_arr_iter_with(value);
		yyjson_val *child;

		while ((child = yyjson_arr_iter_next(&iter)))
			if (!unique_keys(ctx, child, depth + 1))
				return false;
	}
	return true;
}

static bool string(yyjson_val *value)
{
	return yyjson_is_str(value) &&
	       std::strlen(yyjson_get_str(value)) == yyjson_get_len(value);
}

static bool uint_value(yyjson_val *value, uint64_t *result)
{
	if (yyjson_is_uint(value)) {
		*result = yyjson_get_uint(value);
		return true;
	}
	if (yyjson_is_sint(value) && yyjson_get_sint(value) >= 0) {
		*result = static_cast<uint64_t>(yyjson_get_sint(value));
		return true;
	}
	return false;
}

static bool parse_selector(bridge_context *ctx, yyjson_val *json,
			   bridge_selector *result)
{
	if (!json)
		return true;
	if (!yyjson_is_arr(json) || yyjson_arr_size(json) > BRIDGE_MAX_DEPTH)
		return bridge_fail(ctx, "invalid occurrences selector");
	static const char *const allowed[] = {"repeat", "index"};
	yyjson_arr_iter iter = yyjson_arr_iter_with(json);
	yyjson_val *item;

	while ((item = yyjson_arr_iter_next(&iter))) {
		uint64_t repeat, occurrence;

		if (!keys(ctx, item, allowed, 2) ||
		    !uint_value(yyjson_obj_get(item, "repeat"), &repeat) ||
		    !repeat || repeat > UINT32_MAX ||
		    !uint_value(yyjson_obj_get(item, "index"), &occurrence))
			return bridge_fail(ctx, "invalid repeat occurrence");
		result->items[result->count++] = {static_cast<uint32_t>(repeat),
						  occurrence};
	}
	return true;
}

static bool parse_index(bridge_context *ctx, yyjson_val *value,
			vmf_index_number *number)
{
	uint32_t parts[BRIDGE_MAX_DEPTH];
	size_t count = 0;

	if (yyjson_is_arr(value)) {
		yyjson_arr_iter iter = yyjson_arr_iter_with(value);
		yyjson_val *part;

		while ((part = yyjson_arr_iter_next(&iter))) {
			uint64_t n;

			if (count == BRIDGE_MAX_DEPTH ||
			    !uint_value(part, &n) || n > UINT32_MAX)
				return bridge_fail(ctx,
						   "invalid VMF index array");
			parts[count++] = static_cast<uint32_t>(n);
		}
	} else if (string(value)) {
		const char *p = yyjson_get_str(value);

		while (*p) {
			if (*p < '0' || *p > '9' || count == BRIDGE_MAX_DEPTH)
				return bridge_fail(ctx, "invalid VMF index");
			uint64_t n = 0;

			while (*p >= '0' && *p <= '9') {
				n = n * 10 + static_cast<unsigned>(*p++ - '0');
				if (n > UINT32_MAX)
					return bridge_fail(
					    ctx, "VMF index overflow");
			}
			parts[count++] = static_cast<uint32_t>(n);
			if (*p && *p++ != '.')
				return bridge_fail(ctx, "invalid VMF index");
		}
	} else {
		return bridge_fail(ctx, "VMF index must be string or array");
	}
	if (!count)
		return bridge_fail(ctx, "empty VMF index");
	auto *copy = static_cast<uint32_t *>(
	    bridge_alloc(ctx, count * sizeof(uint32_t)));

	if (!copy)
		return false;
	std::memcpy(copy, parts, count * sizeof(*copy));
	*number = {copy, count};
	return true;
}

static const vmf_index_schema *reference(bridge_context *ctx, yyjson_val *value)
{
	static const char *const allowed[] = {"key", "index"};

	if (!keys(ctx, value, allowed, 2))
		return nullptr;
	yyjson_val *key = yyjson_obj_get(value, "key");
	yyjson_val *index = yyjson_obj_get(value, "index");
	const vmf_index_schema *result = nullptr;

	if (!!key == !!index) {
		bridge_fail(ctx,
			    "VMF reference needs exactly one key or index");
		return nullptr;
	}
	if (key && string(key)) {
		vmf_string name = {yyjson_get_str(key), yyjson_get_len(key)};

		result = vmf_schema_find_key(ctx->message, name);
	} else if (index) {
		vmf_index_number number = {};

		if (!parse_index(ctx, index, &number))
			return nullptr;
		result = vmf_schema_find(ctx->message, number);
	}
	if (!result || result->indicator != VMF_INDICATOR_NONE) {
		bridge_fail(ctx, "VMF reference is unknown or is an indicator");
		return nullptr;
	}
	return result;
}

static bool validate_raw(bridge_context *ctx, const bridge_binding *binding,
			 const vmf_field_event *raw)
{
	vmf_author_field field = {
	    bridge_address(ctx, binding->index, {}, &binding->selector),
	    binding->info.kind, raw->value};
	vmf_status status =
	    vmf_author_validate_field(ctx->schemas, &field, nullptr);

	return status == VMF_OK ||
	       bridge_fail(ctx, "raw value violates VMF field constraints: %s",
			   vmf_status_string(status));
}

static void lookup_sift(bridge_lookup_entry *entries, size_t count,
			size_t root)
{
	while (root < count / 2) {
		size_t child = root * 2 + 1;

		if (child + 1 < count &&
		    bridge_lookup_compare(&entries[child].key,
					  &entries[child + 1].key) < 0)
			++child;
		if (bridge_lookup_compare(&entries[root].key,
					  &entries[child].key) >= 0)
			return;
		bridge_lookup_entry swap = entries[root];

		entries[root] = entries[child];
		entries[child] = swap;
		root = child;
	}
}

static bool lookup_compile(bridge_context *ctx, bridge_binding *binding,
			   yyjson_val *table)
{
	/* Compile validated rows to native keys and raw codes once,
	 * heapsort them in the mapping arena, and reject adjacent duplicates.
	 * Per-event jobs borrow the immutable array and its document strings.
	 */
	size_t count = yyjson_arr_size(table);

	if (!count)
		return true;
	auto *entries = static_cast<bridge_lookup_entry *>(
	    bridge_alloc(ctx, count * sizeof(bridge_lookup_entry)));

	if (!entries)
		return false;
	static const char *const names[] = {"cot", "vmf"};
	const cot_field_info *source = cot_field_get_info(
	    static_cast<cot_field_id>(binding->cot_id));
	yyjson_arr_iter iter = yyjson_arr_iter_with(table);
	yyjson_val *row;
	size_t i = 0;

	while ((row = yyjson_arr_iter_next(&iter))) {
		bridge_lookup_entry *entry = &entries[i];
		vmf_field_event raw = {};

		if (!keys(ctx, row, names, 2) ||
		    !bridge_json_value(ctx, yyjson_obj_get(row, "cot"),
				       &entry->key) ||
		    !bridge_source_value_valid(ctx, binding->cot_id,
					       &entry->key) ||
		    !uint_value(yyjson_obj_get(row, "vmf"), &entry->code))
			return bridge_fail(ctx, "invalid lookup row %zu", i);
		if (!bridge_code_encode(ctx, &binding->info, entry->code,
					&raw) ||
		    !validate_raw(ctx, binding, &raw))
			return false;
		if (source->type == COT_VALUE_DOUBLE) {
			if (entry->key.kind == BRIDGE_UINT)
				entry->key.real =
				    static_cast<double>(entry->key.u);
			else if (entry->key.kind == BRIDGE_INT)
				entry->key.real =
				    static_cast<double>(entry->key.i);
			entry->key.kind = BRIDGE_REAL;
		} else if (source->type == COT_VALUE_UINT32 ||
			   source->type == COT_VALUE_UINT64) {
			if (entry->key.kind == BRIDGE_INT)
				entry->key.u =
				    static_cast<uint64_t>(entry->key.i);
			entry->key.kind = BRIDGE_UINT;
		}
		++i;
	}
	for (size_t root = count / 2; root; --root)
		lookup_sift(entries, count, root - 1);
	for (size_t end = count; end > 1; --end) {
		bridge_lookup_entry swap = entries[0];

		entries[0] = entries[end - 1];
		entries[end - 1] = swap;
		lookup_sift(entries, end - 1, 0);
	}
	for (size_t row = 1; row < count; ++row)
		if (!bridge_lookup_compare(&entries[row - 1].key,
					   &entries[row].key))
			return bridge_fail(ctx, "duplicate logical lookup key");
	binding->lookup = entries;
	binding->lookup_count = count;
	return true;
}

static bool binding_options(bridge_context *ctx, bridge_binding *binding)
{
	yyjson_val *value = binding->options;
	vmf_field_kind kind = binding->info.kind;
	bool binary = kind == VMF_FIELD_BITS || kind == VMF_FIELD_OCTETS;
	bool text = kind == VMF_FIELD_TEXT;
	const char *transforms[] = {"factor", "offset", "values"};

	for (size_t i = 0; i < 3; ++i)
		if ((binary || text) && yyjson_obj_get(value, transforms[i]))
			return bridge_fail(
			    ctx, "numeric transform on text or binary field");
	if (binding->cot_id > 0) {
		const cot_field_info *source = cot_field_get_info(
		    static_cast<cot_field_id>(binding->cot_id));

		if (source->type == COT_VALUE_EXTENSIONS ||
		    source->id == COT_FIELD_DETAIL_XML)
			return bridge_fail(
			    ctx, "residual XML and extensions "
			    "are presence-only");
		if ((binary || text) && source->type != COT_VALUE_TEXT)
			return bridge_fail(
			    ctx, "text or binary target requires a CoT string");
		yyjson_val *table = yyjson_obj_get(value, "values");

		if (!binary && !text && source->type == COT_VALUE_TEXT &&
		    (!yyjson_is_arr(table) || !yyjson_arr_size(table)))
			return bridge_fail(
			    ctx,
			    "text to numeric mapping needs a lookup table");
	}
	yyjson_val *encoding = yyjson_obj_get(value, "encoding");
	yyjson_val *bits = yyjson_obj_get(value, "bit_count");
	uint64_t bit_count;

	if ((encoding && !binary) || (bits && kind != VMF_FIELD_BITS))
		return bridge_fail(ctx,
				   "binary options on incompatible target");
	if (binary && !yyjson_equals_str(encoding, "hex"))
		return bridge_fail(ctx, "binary mapping requires encoding hex");
	if (bits && (!uint_value(bits, &bit_count) || bit_count == UINT64_MAX))
		return bridge_fail(ctx, "invalid bit_count");
	if (bits && (bit_count > binding->info.capacity_units ||
		     (!binding->info.variable &&
		      bit_count != binding->info.capacity_units)))
		return bridge_fail(
		    ctx, "bit_count violates fixed length or capacity");
	for (size_t i = 0; i < 2; ++i) {
		yyjson_val *n = yyjson_obj_get(value, transforms[i]);

		if (n &&
		    (!yyjson_is_num(n) || !std::isfinite(yyjson_get_num(n)) ||
		     (!i && yyjson_get_num(n) == 0)))
			return bridge_fail(ctx, "invalid numeric transform");
	}
	yyjson_val *table = yyjson_obj_get(value, "values");

	if (table && !yyjson_is_arr(table))
		return bridge_fail(ctx, "values must be an array");
	if (binding->cot_id > 0 && kind == VMF_FIELD_SCALED &&
	    !binding->info.scale->factor.numerator && !yyjson_arr_size(table))
		return bridge_fail(ctx, "VMF scale is not invertible");
	return lookup_compile(ctx, binding, table);
}

static bool bindings(bridge_context *ctx, yyjson_val *array, bool constants)
{
	if (!array)
		return true;
	if (!yyjson_is_arr(array))
		return bridge_fail(ctx, "bindings must be arrays");
	static const char *const fields[] = {
	    "cot",    "vmf",	"occurrences", "factor",
	    "offset", "values", "encoding",    "bit_count"};
	static const char *const literals[] = {"vmf", "occurrences", "value",
					       "encoding", "bit_count"};

	for (size_t row = 0; row < yyjson_arr_size(array); ++row) {
		yyjson_val *entry = yyjson_arr_get(array, row);
		char location[80];

		std::snprintf(location, sizeof(location), "/%s/%zu",
			      constants ? "vmf_constants" : "fields", row);
		bridge_location(ctx, location, -1, nullptr, nullptr);
		if (!keys(ctx, entry, constants ? literals : fields,
			  constants ? 5 : 8))
			return false;
		bridge_binding binding = {};

		binding.cot_id = -1;
		binding.options = entry;
		binding.index = reference(ctx, yyjson_obj_get(entry, "vmf"));
		if (!binding.index ||
		    !parse_selector(ctx, yyjson_obj_get(entry, "occurrences"),
				    &binding.selector))
			return false;
		if (!constants) {
			yyjson_val *cot = yyjson_obj_get(entry, "cot");

			if (!string(cot) ||
			    !(binding.cot_id =
				  cot_field_resolve(yyjson_get_str(cot))))
				return bridge_fail(ctx,
						   "unknown CoT source path");
		}
		bridge_location(ctx, location, binding.cot_id, binding.index,
				&binding.selector);
		vmf_author_address address =
		    bridge_address(ctx, binding.index, {}, &binding.selector);
		vmf_status status =
		    vmf_author_validate_address(ctx->schemas, &address);

		if (status != VMF_OK)
			return bridge_fail(
			    ctx,
			    "invalid repeat ancestry or occurrence bound: %s",
			    vmf_status_string(status));
		if (vmf_schema_index_info(ctx->schemas, ctx->message,
					  binding.index,
					  &binding.info) != VMF_OK ||
		    !binding_options(ctx, &binding))
			return false;
		if (constants) {
			if (!bridge_json_value(ctx,
					       yyjson_obj_get(entry, "value"),
					       &binding.constant) ||
			    !bridge_field_encode(ctx, &binding, &binding.info,
						 &binding.constant,
						 &binding.raw) ||
			    !validate_raw(ctx, &binding, &binding.raw))
				return false;
		}
		for (size_t i = 0; i < ctx->binding_count; ++i)
			if (ctx->bindings[i].index == binding.index &&
			    bridge_selector_equal(&ctx->bindings[i].selector,
						  &binding.selector))
				return bridge_fail(ctx,
						   "duplicate VMF destination");
		std::snprintf(binding.config_path, sizeof(binding.config_path),
			      "%s", location);
		ctx->bindings[ctx->binding_count++] = binding;
	}
	return true;
}

static bool controls(bridge_context *ctx, yyjson_val *array, bool repeat)
{
	if (!array)
		return true;
	if (!yyjson_is_arr(array))
		return bridge_fail(ctx, "controls must be arrays");
	static const char *const presence[] = {"group", "occurrences",
					       "present"};
	static const char *const counts[] = {"repeat", "occurrences", "count"};

	for (size_t row = 0; row < yyjson_arr_size(array); ++row) {
		yyjson_val *entry = yyjson_arr_get(array, row);
		bridge_control control = {};
		char location[80];
		uint64_t id;

		std::snprintf(location, sizeof(location), "/%s/%zu",
			      repeat ? "repeat_counts" : "presence", row);
		bridge_location(ctx, location, -1, nullptr, nullptr);
		if (!keys(ctx, entry, repeat ? counts : presence, 3) ||
		    !uint_value(
			yyjson_obj_get(entry, repeat ? "repeat" : "group"),
			&id) ||
		    !id || id > UINT32_MAX ||
		    !parse_selector(ctx, yyjson_obj_get(entry, "occurrences"),
				    &control.selector))
			return bridge_fail(ctx, "invalid control");
		control.scope = {repeat ? VMF_SCOPE_REPEAT : VMF_SCOPE_GROUP,
				 static_cast<uint32_t>(id)};
		vmf_author_control native = {};

		native.address = bridge_address(ctx, nullptr, control.scope,
						&control.selector);
		if (repeat) {
			if (!uint_value(yyjson_obj_get(entry, "count"),
					&control.count))
				return bridge_fail(
				    ctx, "repeat count must be unsigned");
			native.kind = VMF_ENCODE_REQUEST_REPEAT_COUNT;
			native.as.repeat_count = control.count;
		} else {
			yyjson_val *present = yyjson_obj_get(entry, "present");

			if (!yyjson_is_bool(present))
				return bridge_fail(ctx,
						   "presence must be boolean");
			control.present = yyjson_get_bool(present);
			native.kind = VMF_ENCODE_REQUEST_PRESENCE;
			native.as.present = control.present;
		}
		vmf_status status =
		    vmf_author_validate_control(ctx->schemas, &native);

		if (status != VMF_OK)
			return bridge_fail(
			    ctx,
			    "invalid control ancestry/bound or unsupported "
			    "GPI/FRI/GRI assertion: %s",
			    vmf_status_string(status));
		for (size_t i = 0; i < ctx->control_count; ++i)
			if (ctx->controls[i].scope.kind == control.scope.kind &&
			    ctx->controls[i].scope.id == control.scope.id &&
			    bridge_selector_equal(&ctx->controls[i].selector,
						  &control.selector))
				return bridge_fail(
				    ctx, "duplicate structural control");
		std::snprintf(control.config_path, sizeof(control.config_path),
			      "%s", location);
		ctx->controls[ctx->control_count++] = control;
	}
	return true;
}

bool bridge_mapping_config_parse(bridge_context *ctx, const uint8_t *data,
			  size_t size)
{
	ctx->error_code = "mapping_config_invalid";
	if (!data || size > 16 * 1024 * 1024)
		return bridge_fail(ctx, "mapping config exceeds input limit");
	yyjson_read_err syntax = {};

	ctx->config = yyjson_read_opts(
	    const_cast<char *>(reinterpret_cast<const char *>(data)), size, 0,
	    nullptr, &syntax);
	if (!ctx->config)
		return bridge_fail(ctx, "mapping config JSON byte %zu: %s",
				   syntax.pos, syntax.msg);
	yyjson_val *root = yyjson_doc_get_root(ctx->config);

	if (!yyjson_is_obj(root))
		return bridge_fail(ctx, "expected configuration object");
	return unique_keys(ctx, root, 0);
}

static bool mapping_config_properties(bridge_context *ctx)
{
	yyjson_val *root = yyjson_doc_get_root(ctx->config);
	static const char *const allowed[] = {
	    "format", "name", "schema", "message", "envelope", "vmf_header",
	    "fields", "vmf_constants", "presence", "repeat_counts"};

	if (!keys(ctx, root, allowed, 10))
		return false;
	if (!yyjson_equals_str(yyjson_obj_get(root, "format"),
				       "cot-vmf-mapping-config/1"))
		return bridge_fail(ctx,
				   "expected format cot-vmf-mapping-config/1");
	yyjson_val *name = yyjson_obj_get(root, "name");

	if (name && !string(name))
		return bridge_fail(ctx, "name must be a string");
	yyjson_val *schema_path = yyjson_obj_get(root, "schema");

	if (!string(schema_path))
		return bridge_fail(
		    ctx, "schema must name a workspace schema");
	uint64_t ordinal = 0;

	bridge_location(ctx, "/message", -1, nullptr, nullptr);
	if (!uint_value(yyjson_obj_get(root, "message"), &ordinal) ||
	    ordinal > SIZE_MAX)
		return bridge_fail(ctx, "message must be a zero-based integer");
	ctx->message_ordinal = static_cast<size_t>(ordinal);
	yyjson_val *envelope = yyjson_obj_get(root, "envelope");
	static const char *const names[] = {"B", "C", "D", "D1"};

	bridge_location(ctx, "/envelope", -1, nullptr, nullptr);
	for (size_t i = 0; string(envelope) && i < 4; ++i)
		if (yyjson_equals_str(envelope, names[i])) {
			ctx->profile = static_cast<vmf_envelope_version>(i + 1);
			return true;
		}
	return bridge_fail(ctx, "envelope must be B, C, D or D1");
}

static bool mapping_header(bridge_context *ctx, yyjson_val *value,
			   const vmf_message_id *identity)
{
	if (value && !yyjson_is_obj(value))
		return bridge_fail(ctx, "vmf_header must be an object");
	yyjson_val *fields = yyjson_obj_get(value, "fields");

	if (fields && !yyjson_is_obj(fields))
		return bridge_fail(ctx, "vmf_header.fields must be an object");
	yyjson_val *messages = yyjson_obj_get(fields, "messages");

	if (messages &&
	    (!yyjson_is_arr(messages) || yyjson_arr_size(messages) != 1))
		return bridge_fail(ctx, "exactly one message is required");
	yyjson_val *message = yyjson_arr_get(messages, 0);

	if (message && !yyjson_is_obj(message))
		return bridge_fail(ctx, "message metadata must be an object");
	if (yyjson_obj_get(message, "id"))
		return bridge_fail(ctx, "message identity is derived, not metadata");
	vmf_header_json_options options = vmf_header_json_default_options();
	vmf_header_json_text *text = nullptr;
	vmf_status status = vmf_header_json_template(ctx->profile, identity, 1,
		&options, &text, nullptr);

	if (status != VMF_OK)
		return bridge_fail(ctx, "message %zu header template: %s",
			ctx->message_ordinal, vmf_status_string(status));
	yyjson_doc *generated = yyjson_read(vmf_header_json_text_data(text),
		vmf_header_json_text_size(text), 0);
	yyjson_val *generated_fields = yyjson_obj_get(
		yyjson_doc_get_root(generated), "fields");
	yyjson_val *generated_message = yyjson_arr_get(
		yyjson_obj_get(generated_fields, "messages"), 0);
	yyjson_val *generated_id = yyjson_obj_get(generated_message, "id");
	yyjson_mut_doc *document = yyjson_mut_doc_new(nullptr);
	yyjson_mut_val *root = document ? (value ?
		yyjson_val_mut_copy(document, value) :
		yyjson_mut_obj(document)) : nullptr;
	yyjson_mut_val *target_fields = yyjson_mut_obj_get(root, "fields");
	bool valid = root && generated_id;

	if (valid && !target_fields) {
		target_fields = yyjson_mut_obj(document);
		valid = target_fields && yyjson_mut_obj_add_val(document, root,
			"fields", target_fields);
	}
	yyjson_mut_val *target_messages = yyjson_mut_obj_get(target_fields,
		"messages");

	if (valid && !target_messages) {
		target_messages = yyjson_mut_arr(document);
		yyjson_mut_val *descriptor = yyjson_mut_obj(document);

		valid = target_messages && descriptor &&
			yyjson_mut_arr_add_val(target_messages, descriptor) &&
			yyjson_mut_obj_add_val(document, target_fields, "messages",
				target_messages);
	}
	yyjson_mut_val *target_id = valid ?
		yyjson_val_mut_copy(document, generated_id) : nullptr;

	valid = valid && target_id && yyjson_mut_obj_add_val(document,
		yyjson_mut_arr_get(target_messages, 0), "id", target_id);
	if (valid)
		yyjson_mut_doc_set_root(document, root);
	size_t size = 0;
	char *json = valid ? yyjson_mut_write(document, 0, &size) : nullptr;

	yyjson_mut_doc_free(document);
	yyjson_doc_free(generated);
	vmf_header_json_text_destroy(text);
	if (!json)
		return bridge_fail(ctx, "cannot prepare message header");
	vmf_header_json_error error = {};

	status = vmf_header_json_load(ctx->profile, json, size, &options,
		&ctx->header_owner, &error);
	std::free(json);
	if (status != VMF_OK) {
		std::snprintf(ctx->config_path, sizeof(ctx->config_path),
			"/vmf_header%s", error.path);
		return bridge_fail(ctx, "message %zu: %s: %s",
			ctx->message_ordinal, error.message,
			vmf_status_string(status));
	}
	ctx->header = *vmf_header_json_header(ctx->header_owner);
	return true;
}

static bool configure_mapping_config(bridge_context *ctx)
{
	yyjson_val *root = yyjson_doc_get_root(ctx->config);

	if (!ctx->schemas)
		return bridge_fail(ctx, "upload a VMF schema first");
	bridge_location(ctx, "/message", -1, nullptr, nullptr);
	ctx->registry = bridge_message_view(ctx->schemas, ctx->message_ordinal);
	if (!ctx->registry.messages)
		return bridge_fail(ctx, "message %zu is outside the schema list",
			ctx->message_ordinal);
	ctx->schemas = &ctx->registry;
	ctx->message = ctx->registry.messages;
	vmf_message_id identity = {};
	vmf_status status = vmf_schema_message_id_for_profile(ctx->schemas,
		ctx->message, ctx->profile, &identity);

	if (status != VMF_OK)
		return bridge_fail(ctx, "message %zu cannot use envelope %s: %s",
			ctx->message_ordinal,
			yyjson_get_str(yyjson_obj_get(root, "envelope")),
			vmf_status_string(status));
	ctx->error_code = "header_invalid";
	bridge_location(ctx, "/vmf_header", -1, nullptr, nullptr);
	if (!mapping_header(ctx, yyjson_obj_get(root, "vmf_header"), &identity))
		return false;
	vmf_header_fields *header = bridge_header_fields(ctx);

	if (header->message_count != 1 || !header->messages[0].has_body)
		return bridge_fail(
		    ctx, "exactly one VMF body descriptor is required");
	vmf_author_options author_options =
	    vmf_author_options_for_schemas(ctx->schemas);
	author_options.codec.profile = ctx->profile;
	vmf_envelope_event envelope = {
	    static_cast<uint8_t>(ctx->profile), &ctx->header,
	    vmf_header_layout(ctx->profile).size, VMF_LENGTH_UNKNOWN,
	    VMF_LENGTH_UNKNOWN};
	vmf_author_error author_error = {};

	status = vmf_author_validate_header(&author_options, &envelope,
					    &author_error);
	if (status != VMF_OK)
		return bridge_fail(
		    ctx,
		    "message %zu header is not valid for authoring "
		    "(authentication/compression unsupported): %s",
		    ctx->message_ordinal, vmf_status_string(status));
	ctx->error_code = "mapping_config_invalid";
	bridge_location(ctx, "", -1, nullptr, nullptr);
	yyjson_val *fields = yyjson_obj_get(root, "fields");
	yyjson_val *constants = yyjson_obj_get(root, "vmf_constants");
	size_t count = yyjson_arr_size(fields) + yyjson_arr_size(constants);

	ctx->bindings = static_cast<bridge_binding *>(
	    bridge_alloc(ctx, (count ? count : 1) * sizeof(bridge_binding)));
	if (!ctx->bindings || !bindings(ctx, fields, false) ||
	    !bindings(ctx, constants, true))
		return false;
	yyjson_val *presence = yyjson_obj_get(root, "presence");
	yyjson_val *repeats = yyjson_obj_get(root, "repeat_counts");

	count = yyjson_arr_size(presence) + yyjson_arr_size(repeats);
	ctx->controls = static_cast<bridge_control *>(
	    bridge_alloc(ctx, (count ? count : 1) * sizeof(bridge_control)));
	if (!ctx->controls || !controls(ctx, presence, false) ||
	    !controls(ctx, repeats, true))
		return false;
	bridge_location(ctx, "", -1, nullptr, nullptr);
	return true;
}

bool bridge_load_memory(bridge_context *ctx, const uint8_t *data, size_t size,
			const vmf_schema_set *schemas)
{
	ctx->schemas = schemas;
	return bridge_mapping_config_parse(ctx, data, size) &&
	       mapping_config_properties(ctx) && configure_mapping_config(ctx);
}

void bridge_destroy(bridge_context *ctx)
{
	vmf_author_result_destroy(ctx->result);
	cot_decoded_event_destroy(ctx->cot_owner);
	vmf_header_json_destroy(ctx->header_owner);
	vmf_schema_json_destroy(ctx->schema_owner);
	yyjson_doc_free(ctx->config);
	bridge_arena_destroy(&ctx->arena);
	*ctx = {};
}
