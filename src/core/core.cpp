#include "workspace.h"
#include "feedback.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

cv_status cv_fail(cv_error *error, cv_status status, const char *message)
{
	if (error) {
		*error = {};
		error->status = status;
		std::snprintf(error->message, sizeof(error->message), "%s",
			      message ? message : "");
	}
	return status;
}

static bool properties(bridge_context *ctx, yyjson_val *value,
		       const char *const *allowed, size_t count)
{
	if (!yyjson_is_obj(value))
		return bridge_fail(ctx, "expected workspace object");
	yyjson_obj_iter iter = yyjson_obj_iter_with(value);
	yyjson_val *key;

	while ((key = yyjson_obj_iter_next(&iter))) {
		bool known = false;

		for (size_t i = 0; i < count; ++i)
			known |= yyjson_equals_str(key, allowed[i]);
		if (!known)
			return bridge_fail(ctx, "unknown workspace property");
	}
	return true;
}

static bool id_valid(yyjson_val *value)
{
	return yyjson_is_str(value) && yyjson_get_len(value) &&
	       yyjson_get_len(value) <= 128 &&
	       std::strlen(yyjson_get_str(value)) == yyjson_get_len(value);
}

static bool entries(bridge_context *ctx, yyjson_val *array, bool schemas)
{
	static const char *const schema_keys[] = {"id", "document"};
	static const char *const output_keys[] = {"id", "enabled", "mapping"};

	if (!yyjson_is_arr(array) || yyjson_arr_size(array) > 128)
		return bridge_fail(ctx, "workspace array missing or too large");
	for (size_t i = 0; i < yyjson_arr_size(array); ++i) {
		yyjson_val *entry = yyjson_arr_get(array, i);
		yyjson_val *id = yyjson_obj_get(entry, "id");

		if (!properties(ctx, entry, schemas ? schema_keys : output_keys,
				schemas ? 2 : 3) ||
		    !id_valid(id))
			return bridge_fail(ctx, "invalid workspace entry");
		for (size_t j = 0; j < i; ++j)
			if (yyjson_equals_str(
				    yyjson_obj_get(yyjson_arr_get(array, j),
						   "id"),
				    yyjson_get_str(id)))
				return bridge_fail(
					ctx, "duplicate workspace entry id");
		if (schemas && !yyjson_obj_get(entry, "document"))
			return bridge_fail(ctx, "missing schema document");
		if (!schemas &&
		    (!yyjson_is_bool(yyjson_obj_get(entry, "enabled")) ||
		     !yyjson_is_obj(yyjson_obj_get(entry, "mapping"))))
			return bridge_fail(ctx, "invalid output draft");
	}
	return true;
}

bool cv_workspace_parse(bridge_context *source, const uint8_t *data,
			size_t size)
{
	if (!bridge_mapping_config_parse(source, data, size))
		return false;
	yyjson_val *root = yyjson_doc_get_root(source->config);
	static const char *const allowed[] = {"format", "schemas", "outputs",
					      "service"};
	yyjson_val *service = yyjson_obj_get(root, "service");
	static const char *const service_keys[] = {"cot_listen", "vmf_target",
						   "web_listen", "log_format"};

	if (service) {
		if (!properties(source, service, service_keys, 4))
			return false;
		for (size_t i = 0; i < 4; ++i) {
			yyjson_val *value =
				yyjson_obj_get(service, service_keys[i]);

			if (!value || (i == 2 && yyjson_is_null(value)))
				continue;
			if (!yyjson_is_str(value) ||
			    std::strlen(yyjson_get_str(value)) !=
				    yyjson_get_len(value))
				return bridge_fail(
					source,
					"service settings must be strings");
		}
	}

	return properties(source, root, allowed, 4) &&
	       (yyjson_equals_str(yyjson_obj_get(root, "format"),
				  "cot-vmf-workspace/1") ||
		bridge_fail(source, "expected format cot-vmf-workspace/1")) &&
	       entries(source, yyjson_obj_get(root, "schemas"), true) &&
	       entries(source, yyjson_obj_get(root, "outputs"), false);
}

bool cv_schema_load(yyjson_val *document, vmf_schema_json_document **owner,
		    cv_error *error)
{
	size_t size = 0;
	char *text = yyjson_val_write(document, 0, &size);

	if (!text) {
		cv_fail(error, CV_OUT_OF_MEMORY, "cannot copy schema document");
		return false;
	}
	auto options = vmf_schema_json_default_options();
	vmf_schema_json_error diagnostic = {};
	vmf_status status =
		vmf_schema_json_load(text, size, &options, owner, &diagnostic);

	std::free(text);
	if (status == VMF_OK)
		return true;
	char message[512];

	std::snprintf(message, sizeof(message),
		      "invalid VMF schema: %s (%s); message %zu, index %zu",
		      diagnostic.message, vmf_status_string(status),
		      diagnostic.schema_index, diagnostic.index_position);
	cv_fail(error,
		status == VMF_OUT_OF_MEMORY ? CV_OUT_OF_MEMORY
					    : CV_INVALID_CONFIG,
		message);
	return false;
}

cv_status cv_workspace_load(const uint8_t *data, size_t size,
			    cv_workspace **result, cv_error *error)
{
	cv_error local = {};

	if (!error)
		error = &local;
	cv_fail(error, CV_OK, "");
	if (result)
		*result = nullptr;
	if (!result || !data)
		return cv_fail(error, CV_INVALID_ARGUMENT,
			       "workspace input and result are required");
	auto *workspace = static_cast<cv_workspace *>(
		std::calloc(1, sizeof(cv_workspace)));

	if (!workspace)
		return cv_fail(error, CV_OUT_OF_MEMORY,
			       "cannot allocate workspace");
	bridge_context *source = &workspace->source;
	bool valid = cv_workspace_parse(source, data, size);

	if (!valid)
		cv_fail(error, CV_INVALID_CONFIG, source->error);
	yyjson_val *root =
		source->config ? yyjson_doc_get_root(source->config) : nullptr;
	yyjson_val *schemas = yyjson_obj_get(root, "schemas");
	yyjson_val *outputs = yyjson_obj_get(root, "outputs");

	if (valid) {
		workspace->schema_count = yyjson_arr_size(schemas);
		workspace->output_count = yyjson_arr_size(outputs);
		workspace->schemas = static_cast<cv_schema *>(
			bridge_alloc(source, (workspace->schema_count + 1) *
						     sizeof(cv_schema)));
		workspace->outputs = static_cast<cv_output *>(
			bridge_alloc(source, (workspace->output_count + 1) *
						     sizeof(cv_output)));
		valid = workspace->schemas && workspace->outputs;
		if (!valid)
			cv_fail(error, CV_OUT_OF_MEMORY,
				"workspace budget exhausted");
	}
	for (size_t i = 0; valid && i < workspace->schema_count; ++i) {
		yyjson_val *entry = yyjson_arr_get(schemas, i);
		cv_schema *schema = &workspace->schemas[i];

		schema->id = yyjson_get_str(yyjson_obj_get(entry, "id"));
		valid = cv_schema_load(yyjson_obj_get(entry, "document"),
				       &schema->owner, error);
	}
	for (size_t i = 0; valid && i < workspace->output_count; ++i) {
		yyjson_val *entry = yyjson_arr_get(outputs, i);
		cv_output *output = &workspace->outputs[i];

		output->id = yyjson_get_str(yyjson_obj_get(entry, "id"));
		output->enabled =
			yyjson_get_bool(yyjson_obj_get(entry, "enabled"));
		if (!output->enabled)
			continue;
		yyjson_val *mapping = yyjson_obj_get(entry, "mapping");
		yyjson_val *id = yyjson_obj_get(mapping, "schema");
		const vmf_schema_set *set = nullptr;

		for (size_t j = 0; j < workspace->schema_count; ++j)
			if (yyjson_equals_str(id, workspace->schemas[j].id))
				set = vmf_schema_json_schemas(
					workspace->schemas[j].owner);
		if (!set) {
			valid = false;
			cv_fail(error, CV_INVALID_CONFIG,
				"output refers to an unknown schema id");
			break;
		}
		size_t length = 0;
		char *json = yyjson_val_write(mapping, 0, &length);

		valid = json && bridge_load_memory(
					&output->mapping,
					reinterpret_cast<const uint8_t *>(json),
					length, set);
		std::free(json);
		if (!valid)
			cv_fail(error, CV_INVALID_CONFIG,
				output->mapping.error[0]
					? output->mapping.error
					: "cannot compile output mapping");
	}
	if (!valid) {
		cv_workspace_destroy(workspace);
		return error ? error->status : CV_INVALID_CONFIG;
	}
	*result = workspace;
	return CV_OK;
}

void cv_workspace_destroy(cv_workspace *workspace)
{
	if (!workspace)
		return;
	for (size_t i = 0; workspace->outputs && i < workspace->output_count;
	     ++i)
		bridge_destroy(&workspace->outputs[i].mapping);
	for (size_t i = 0; workspace->schemas && i < workspace->schema_count;
	     ++i)
		vmf_schema_json_destroy(workspace->schemas[i].owner);
	bridge_destroy(&workspace->source);
	std::free(workspace);
}

/* The compiled mapping remains immutable. Only transient binding/control
 * activity and value allocations belong to a fresh job for this one event.
 */
static bool job_begin(const bridge_context *compiled,
		      const bridge_context *received, bridge_context *job)
{
	*job = {};
	job->schemas = compiled->schemas;
	job->message = compiled->message;
	job->header = compiled->header;
	job->binding_count = compiled->binding_count;
	job->control_count = compiled->control_count;
	job->cot_owner = received->cot_owner;
	std::memcpy(job->cot, received->cot, sizeof(job->cot));
	job->bindings = static_cast<bridge_binding *>(bridge_alloc(
		job, (job->binding_count + 1) * sizeof(bridge_binding)));
	job->controls = static_cast<bridge_control *>(bridge_alloc(
		job, (job->control_count + 1) * sizeof(bridge_control)));
	if (!job->bindings || !job->controls)
		return false;
	std::memcpy(job->bindings, compiled->bindings,
		    job->binding_count * sizeof(bridge_binding));
	std::memcpy(job->controls, compiled->controls,
		    job->control_count * sizeof(bridge_control));
	return true;
}

cv_status cv_process(const cv_workspace *workspace, const uint8_t *data,
		     size_t size, cv_output_callback callback, void *context,
		     cv_activity *activity, cv_error *error)
{
	return cv_process_with_feedback(
		workspace, data, size, callback, context, activity, error,
		nullptr, nullptr);
}

static void feedback_index(const vmf_index_schema *index, char *text,
			   size_t capacity)
{
	text[0] = 0;
	if (!index)
		return;
	size_t used = 0;

	for (size_t i = 0; i < index->index_number.count; ++i) {
		int length = std::snprintf(text + used, capacity - used, "%s%u",
					   i ? "." : "",
					   index->index_number.parts[i]);

		if (length < 0 ||
		    static_cast<size_t>(length) >= capacity - used) {
			text[0] = 0;
			return;
		}
		used += length;
	}
}

static void output_feedback(const cv_output *output, bridge_context *job,
			    bool valid, bool publication_failed,
			    cv_feedback_callback callback, void *context)
{
	if (!callback)
		return;
	char index[768] = {};
	cv_output_feedback result = {output->id, CV_OUTPUT_SENT, "", "", "", "",
				     -1};

	if (!valid) {
		result.outcome = publication_failed ? CV_OUTPUT_SEND_FAILED
						    : CV_OUTPUT_NOT_ENCODED;
		result.code = job->error_code ? job->error_code : "processing";
		if (publication_failed)
			result.code = "publication";
		result.message = job->error;
		if (!publication_failed) {
			feedback_index(job->current_index, index,
				       sizeof(index));
			result.target_index = index;
			result.config_path = job->config_path;
			int last_cot = static_cast<int>(cot_field_count());

			if (job->current_cot > 0 &&
			    job->current_cot <= last_cot)
				result.cot_id = job->current_cot;
		}
	}
	/* Publish borrowed metadata before the per-output job is destroyed. */
	callback(context, &result);
}

cv_status cv_process_with_feedback(const cv_workspace *workspace,
				   const uint8_t *data, size_t size,
				   cv_output_callback callback, void *context,
				   cv_activity *activity, cv_error *error,
				   cv_feedback_callback feedback,
				   void *feedback_context)
{
	cv_fail(error, CV_OK, "");
	if (activity)
		*activity = {};
	if (!activity || !data || !size || size > 65507)
		return cv_fail(error, CV_INVALID_ARGUMENT,
			       "CoT input must contain 1..65507 bytes");
	for (size_t i = 0; workspace && i < workspace->output_count; ++i)
		if (workspace->outputs[i].enabled && !callback)
			return cv_fail(error, CV_INVALID_ARGUMENT,
				       "enabled outputs require a callback");
	bridge_context received = {};

	if (!bridge_cot_load(&received, COT_FORMAT_XML, data, size)) {
		cv_fail(error, CV_INVALID_COT, received.error);
		bridge_destroy(&received);
		return CV_INVALID_COT;
	}
	activity->decoded = true;
	const cot_event *event = cot_decoded_event_get(received.cot_owner);

	for (size_t id = 1; id <= cot_field_count(); ++id) {
		cot_field_value field = {};

		if (id <= 64 &&
		    cot_field_get(event, static_cast<cot_field_id>(id),
				  &field) == COT_STATUS_OK &&
		    field.available)
			activity->present_fields |= UINT64_C(1) << (id - 1);
	}
	for (size_t i = 0; workspace && i < workspace->output_count; ++i) {
		const cv_output *output = &workspace->outputs[i];

		if (!output->enabled)
			continue;
		bridge_context job = {};
		bool valid = job_begin(&output->mapping, &received, &job) &&
			     bridge_vmf_encode(&job);
		bool publication_failed = false;

		if (valid && vmf_author_result_size(job.result) > 65507) {
			valid = false;
			bridge_fail(&job,
				    "VMF output exceeds UDP payload limit");
		}
		if (valid && !callback(context, output->id,
				       vmf_author_result_data(job.result),
				       vmf_author_result_size(job.result))) {
			valid = false;
			publication_failed = true;
			bridge_fail(&job, "VMF output publication failed");
		}
		if (valid)
			++activity->outputs_succeeded;
		else {
			++activity->outputs_failed;
			if (!error || error->status == CV_OK)
				cv_fail(error, CV_OUTPUT_ERROR, job.error);
		}
		output_feedback(output, &job, valid, publication_failed,
				feedback, feedback_context);
		vmf_author_result_destroy(job.result);
		bridge_arena_destroy(&job.arena);
	}
	bridge_destroy(&received);
	return activity->outputs_failed ? CV_OUTPUT_ERROR : CV_OK;
}

void cv_buffer_destroy(cv_buffer *buffer)
{
	if (!buffer)
		return;
	std::free(buffer->data);
	*buffer = {};
}
