#include "bridge.h"
#include <cstdio>

bool bridge_vmf_encode(bridge_context *ctx)
{
	auto *fields = static_cast<vmf_author_field *>(
	    bridge_alloc(ctx, (ctx->binding_count ? ctx->binding_count : 1) *
				  sizeof(vmf_author_field)));
	auto *controls = static_cast<vmf_author_control *>(
	    bridge_alloc(ctx, (ctx->control_count ? ctx->control_count : 1) *
				  sizeof(vmf_author_control)));

	if (!fields || !controls)
		return false;
	size_t count = 0;

	ctx->error_code = "mapped_value";
	for (size_t i = 0; i < ctx->binding_count; ++i) {
		bridge_binding *binding = &ctx->bindings[i];
		bridge_location(ctx, binding->config_path, binding->cot_id,
				binding->index, &binding->selector);
		const bridge_value *value = binding->cot_id < 0
						? &binding->constant
						: &ctx->cot[binding->cot_id];

		if (value->kind == BRIDGE_MISSING) {
			bridge_note(ctx, "missing_source", false,
				    "source is unavailable; optional target "
				    "may be absent");
			continue;
		}
		if (binding->cot_id >= 0 &&
		    !bridge_field_encode(ctx, binding, &binding->info, value,
					 &binding->raw))
			return false;
		binding->author_entry = count;
		binding->supplied = true;
		fields[count++] = {
		    bridge_address(ctx, binding->index, {}, &binding->selector),
		    binding->info.kind, binding->raw.value};
		if (vmf_author_validate_field(ctx->schemas, &fields[count - 1],
					      nullptr) != VMF_OK)
			return bridge_fail(
			    ctx,
			    "mapped raw value violates VMF field constraints");
	}
	for (size_t i = 0; i < ctx->control_count; ++i) {
		bridge_control *control = &ctx->controls[i];

		controls[i].address = bridge_address(
		    ctx, nullptr, control->scope, &control->selector);
		controls[i].kind = control->scope.kind == VMF_SCOPE_GROUP
				       ? VMF_ENCODE_REQUEST_PRESENCE
				       : VMF_ENCODE_REQUEST_REPEAT_COUNT;
		if (controls[i].kind == VMF_ENCODE_REQUEST_PRESENCE)
			controls[i].as.present = control->present;
		else
			controls[i].as.repeat_count = control->count;
	}
	bridge_location(ctx, "", -1, nullptr, nullptr);
	ctx->error_code = "vmf_encode";
	vmf_author_options options =
	    vmf_author_options_for_schemas(ctx->schemas);
	options.codec.profile = ctx->profile;
	vmf_envelope_event envelope = {
	    static_cast<uint8_t>(ctx->profile), &ctx->header,
	    vmf_header_layout(ctx->profile).size, VMF_LENGTH_UNKNOWN,
	    VMF_LENGTH_UNKNOWN};
	vmf_author_error error = {};
	vmf_status status =
	    vmf_author_encode(&options, &envelope, fields, count, controls,
			      ctx->control_count, &ctx->result, &error);

	if (status != VMF_OK) {
		bridge_selector selector = {};

		selector.count = error.path_count < BRIDGE_MAX_DEPTH
				     ? error.path_count
				     : BRIDGE_MAX_DEPTH;
		for (size_t i = 0; i < selector.count; ++i)
			selector.items[i] = error.path[i];
		const vmf_index_schema *index = error.index;
		vmf_scope_info scope = {};

		if (!index && error.schema &&
		    error.scope.kind != VMF_SCOPE_NONE &&
		    vmf_schema_scope_info(ctx->schemas, error.schema,
					  error.scope, &scope) == VMF_OK)
			index = scope.controller;
		bridge_location(ctx, "", -1, index, &selector);
		return bridge_fail(
		    ctx, "VMF %s; message %zu, descriptor %zu, bit %llu",
		    vmf_status_string(status), ctx->message_ordinal,
		    error.descriptor_index,
		    static_cast<unsigned long long>(error.codec.offset));
	}
	for (size_t i = 0; i < ctx->binding_count; ++i) {
		bridge_binding *binding = &ctx->bindings[i];

		if (!binding->supplied)
			continue;
		binding->used = vmf_author_result_field_active(
		    ctx->result, binding->author_entry);
		bridge_location(ctx, binding->config_path, binding->cot_id,
				binding->index, &binding->selector);
		if (!binding->used)
			bridge_note(
			    ctx,
			    binding->cot_id < 0 ? "dormant_constant"
						: "inactive_target",
			    binding->cot_id >= 0,
			    "configured target is inactive for this event");
	}
	for (size_t i = 0; i < ctx->control_count; ++i) {
		bridge_control *control = &ctx->controls[i];

		control->used =
		    vmf_author_result_control_active(ctx->result, i);
		bridge_location(ctx, control->config_path, -1, nullptr,
				&control->selector);
		if (!control->used)
			bridge_note(
			    ctx, "dormant_control", false,
			    "structural control is inside an inactive region");
	}
	for (size_t id = 1; id <= cot_field_count(); ++id) {
		bool configured = false;

		for (size_t i = 0; i < ctx->binding_count; ++i)
			configured |=
			    ctx->bindings[i].cot_id == static_cast<int>(id);
		if (ctx->cot[id].kind == BRIDGE_MISSING || configured)
			continue;
		bridge_location(ctx, "", static_cast<int>(id), nullptr,
				nullptr);
		bridge_note(ctx, "unmapped_source", true,
			    "available source field is not mapped");
	}
	const cot_event *event = cot_decoded_event_get(ctx->cot_owner);

	bridge_location(ctx, "", COT_FIELD_EXTENSIONS, nullptr, nullptr);
	if (event->detail && event->detail->extension_count)
		bridge_note(ctx, "opaque_extensions", true,
			    "omitted %zu opaque CoT extensions",
			    event->detail->extension_count);
	bridge_location(ctx, "", -1, nullptr, nullptr);
	return !ctx->error[0];
}
