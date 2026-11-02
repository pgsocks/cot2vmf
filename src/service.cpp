#include "service.h"
#include "workspace_store.h"
#include "web_server.h"
#include "core/feedback.h"
#include <cot2vmf/core.h>
#include <yyjson.h>
#include <arpa/inet.h>
#include <cerrno>
#include <climits>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#define DOCUMENT_LIMIT WORKSPACE_DOCUMENT_LIMIT
#define ACTIVITY_HISTORY 256
#define OUTPUT_LIMIT 128

static volatile sig_atomic_t stopping;
static volatile sig_atomic_t reloading;

struct activity_record {
	uint64_t sequence;
	uint64_t revision;
	uint64_t fields;
};

/* Results belong to one active revision. Strings are copied before a core
 * job ends; no received values or borrowed schema/job storage survive here.
 */
struct output_record {
	char id[129];
	bool enabled;
	uint64_t revision;
	uint64_t event;
	const char *status;
	char code[64];
	char message[768];
	char config_path[768];
	char target_index[768];
	unsigned cot_field_id;
};

struct output_snapshot {
	size_t count;
	output_record records[OUTPUT_LIMIT];
};

struct service_state {
	pthread_mutex_t edit;
	pthread_mutex_t engine;
	pthread_mutex_t metadata;
	cv_workspace *active;
	char *draft;
	size_t draft_size;
	workspace_store store;
	uint64_t draft_revision;
	uint64_t active_revision;
	uint64_t sequence;
	uint64_t received;
	uint64_t decoded;
	uint64_t invalid;
	uint64_t succeeded;
	uint64_t failed;
	activity_record history[ACTIVITY_HISTORY];
	output_snapshot outputs;
	bool valid;
	bool json_log;
	bool ready;
	char error[768];
	int output;
};

static bool configure_outputs(output_snapshot *snapshot, const char *data,
			      size_t size, uint64_t revision)
{
	yyjson_doc *doc = yyjson_read(data, size, 0);

	if (!doc)
		return false;
	yyjson_val *root = yyjson_doc_get_root(doc);
	yyjson_val *outputs = yyjson_obj_get(root, "outputs");

	snapshot->count = yyjson_arr_size(outputs);
	if (snapshot->count > OUTPUT_LIMIT) {
		yyjson_doc_free(doc);
		return false;
	}
	for (size_t i = 0; i < snapshot->count; ++i) {
		yyjson_val *entry = yyjson_arr_get(outputs, i);
		output_record *record = snapshot->records + i;
		const char *id = yyjson_get_str(yyjson_obj_get(entry, "id"));

		if (!id) {
			yyjson_doc_free(doc);
			return false;
		}

		*record = {};
		std::snprintf(record->id, sizeof(record->id), "%s", id);
		record->enabled =
			yyjson_get_bool(yyjson_obj_get(entry, "enabled"));
		record->revision = revision;
		record->status = record->enabled ? "waiting" : "paused";
	}
	yyjson_doc_free(doc);
	return true;
}

static void collect_feedback(void *user, const cv_output_feedback *feedback)
{
	auto *pending = static_cast<output_snapshot *>(user);

	if (pending->count == OUTPUT_LIMIT)
		return;
	output_record *record = pending->records + pending->count++;

	*record = {};
	record->enabled = true;
	record->status = feedback->outcome == CV_OUTPUT_SENT
				 ? "sent"
				 : feedback->outcome == CV_OUTPUT_SEND_FAILED
					 ? "send_failed"
					 : "not_encoded";
	std::snprintf(record->id, sizeof(record->id), "%s",
		      feedback->output_id);
	std::snprintf(record->code, sizeof(record->code), "%s", feedback->code);
	std::snprintf(record->message, sizeof(record->message), "%s",
		      feedback->message);
	std::snprintf(record->config_path, sizeof(record->config_path), "%s",
		      feedback->config_path);
	std::snprintf(record->target_index, sizeof(record->target_index), "%s",
		      feedback->target_index);
	record->cot_field_id = feedback->cot_id > 0 && feedback->cot_id <= 64
				   ? static_cast<unsigned>(feedback->cot_id)
				   : 0;
}

/* engine and metadata are held, in that order. Feedback follows enabled
 * configuration order, and counts plus results become visible together.
 */
static void publish_feedback(service_state *state, output_snapshot *pending)
{
	size_t next = 0;

	for (size_t i = 0; i < state->outputs.count; ++i) {
		output_record *record = state->outputs.records + i;

		if (!record->enabled || next == pending->count)
			continue;
		output_record *result = pending->records + next;

		if (std::strcmp(record->id, result->id))
			continue;
		result->revision = state->active_revision;
		result->event = state->received;
		*record = *result;
		++next;
	}
}

static void signal_received(int number)
{
	if (number == SIGHUP)
		reloading = 1;
	else
		stopping = 1;
}

/* Validate endpoint grammar without DNS lookups or opening sockets. UDP may
 * use a DNS hostname; the embedded HTTP server accepts one numeric IPv4 bind.
 */
static bool endpoint_parts(const char *endpoint, char *host, size_t capacity,
			   const char **service, bool numeric)
{
	if (!endpoint)
		return false;
	const char *colon = std::strrchr(endpoint, ':');

	if (!colon || colon == endpoint ||
	    static_cast<size_t>(colon - endpoint) >= capacity)
		return false;
	std::memcpy(host, endpoint, colon - endpoint);
	host[colon - endpoint] = 0;
	unsigned port = 0;

	if (!colon[1])
		return false;
	for (const char *p = colon + 1; *p; ++p) {
		if (*p < '0' || *p > '9' || port > 6553)
			return false;
		port = port * 10 + static_cast<unsigned>(*p - '0');
	}
	if (!port || port > 65535)
		return false;
	in_addr address = {};

	if (inet_pton(AF_INET, host, &address) != 1) {
		if (numeric || std::strlen(host) > 253)
			return false;
		size_t label = 0;
		bool letters = false;
		char previous = '.';

		for (const char *p = host; *p; ++p) {
			bool letter = (*p >= 'a' && *p <= 'z') ||
				      (*p >= 'A' && *p <= 'Z');

			if (*p == '.') {
				if (!label || previous == '-')
					return false;
				label = 0;
			} else {
				if ((!letter && (*p < '0' || *p > '9') &&
				     *p != '-') ||
				    (!label && *p == '-') || ++label > 63)
					return false;
			}
			letters |= letter;
			previous = *p;
		}
		if (!letters || previous == '-')
			return false;
	}
	*service = colon + 1;
	return true;
}

static bool endpoint_valid(const char *value, bool numeric)
{
	char host[256];
	const char *port;

	return endpoint_parts(value, host, sizeof(host), &port, numeric);
}

static bool log_valid(const char *value)
{
	return value &&
	       (!std::strcmp(value, "human") || !std::strcmp(value, "json"));
}

/* edit serializes writers only. Validation and filesystem publication occur
 * without holding engine, so HTTP clients cannot stall UDP with file I/O.
 */
enum draft_result {
	DRAFT_SAVED,
	DRAFT_SAVE_FAILED,
	ACTIVE_SAVE_FAILED
};

static draft_result replace_draft(service_state *state, const char *data,
				  size_t size, uint64_t revision)
{
	char *copy = static_cast<char *>(std::malloc(size + 1));

	if (!copy)
		return DRAFT_SAVE_FAILED;
	std::memcpy(copy, data, size);
	copy[size] = 0;
	cv_workspace *candidate = nullptr;
	cv_error error = {};
	bool valid = workspace_validate(data, size, &candidate, &error);
	output_snapshot outputs = {};

	if (valid && !configure_outputs(&outputs, data, size, revision)) {
		valid = false;
		std::snprintf(error.message, sizeof(error.message),
			      "Cannot prepare output feedback");
	}

	workspace_publish_result published = workspace_publish(
		&state->store, data, size, revision, valid);

	if (published == WORKSPACE_DRAFT_FAILED) {
		cv_workspace_destroy(candidate);
		std::free(copy);
		return DRAFT_SAVE_FAILED;
	}
	draft_result result = DRAFT_SAVED;

	if (published == WORKSPACE_ACTIVE_FAILED) {
		result = ACTIVE_SAVE_FAILED;
		valid = false;
		std::snprintf(error.message, sizeof(error.message),
			      "Cannot persist active configuration");
	}
	pthread_mutex_lock(&state->engine);
	if (valid) {
		cv_workspace *old = state->active;

		state->active = candidate;
		candidate = nullptr;
		cv_workspace_destroy(old);
	}
	pthread_mutex_lock(&state->metadata);
	std::free(state->draft);
	state->draft = copy;
	state->draft_size = size;
	state->draft_revision = revision;
	state->valid = valid;
	if (valid) {
		state->active_revision = revision;
		state->outputs = outputs;
	}
	std::snprintf(state->error, sizeof(state->error), "%s",
		      valid ? "" : error.message);
	++state->sequence;
	pthread_mutex_unlock(&state->metadata);
	pthread_mutex_unlock(&state->engine);
	cv_workspace_destroy(candidate);
	return result;
}

static yyjson_mut_val *output_document(service_state *state,
				      yyjson_mut_doc *doc)
{
	yyjson_mut_val *outputs = yyjson_mut_arr(doc);

	if (!outputs)
		return nullptr;
	for (size_t i = 0; i < state->outputs.count; ++i) {
		const output_record *record = state->outputs.records + i;
		yyjson_mut_val *row = yyjson_mut_obj(doc);

		if (!row ||
		    !yyjson_mut_obj_add_strcpy(doc, row, "id", record->id) ||
		    !yyjson_mut_obj_add_bool(doc, row, "enabled",
					    record->enabled) ||
		    !yyjson_mut_obj_add_uint(doc, row, "revision",
					    record->revision) ||
		    !yyjson_mut_obj_add_uint(doc, row, "event",
					    record->event) ||
		    !yyjson_mut_obj_add_strcpy(doc, row, "status",
					  record->status) ||
		    !yyjson_mut_obj_add_strcpy(doc, row, "code",
					  record->code) ||
		    !yyjson_mut_obj_add_strcpy(doc, row, "message",
					  record->message) ||
		    !yyjson_mut_obj_add_strcpy(doc, row, "config_path",
					  record->config_path) ||
		    !yyjson_mut_obj_add_strcpy(doc, row, "target_index",
					  record->target_index) ||
		    !yyjson_mut_obj_add_uint(doc, row, "cot_field_id",
					   record->cot_field_id) ||
		    !yyjson_mut_arr_add_val(outputs, row))
			return nullptr;
	}
	return outputs;
}

static yyjson_mut_val *activity_document(service_state *state,
					 yyjson_mut_doc *doc, uint64_t since)
{
	yyjson_mut_val *root = yyjson_mut_obj(doc);
	yyjson_mut_val *fields = yyjson_mut_arr(doc);
	yyjson_mut_val *outputs = output_document(state, doc);
	uint64_t present = 0;
	uint64_t revision = state->active_revision;

	if (!root || !fields || !outputs)
		return nullptr;
	for (size_t i = 0; i < ACTIVITY_HISTORY; ++i) {
		const activity_record *record = &state->history[i];

		if (record->sequence && record->revision == revision &&
		    (since == UINT64_MAX || record->sequence > since))
			present |= record->fields;
	}
	for (unsigned id = 1; id <= 64; ++id)
		if (present & (UINT64_C(1) << (id - 1)))
			yyjson_mut_arr_add_uint(doc, fields, id);
	yyjson_mut_obj_add_uint(doc, root, "sequence", state->sequence);
	yyjson_mut_obj_add_uint(doc, root, "active_revision", revision);
	yyjson_mut_obj_add_uint(doc, root, "draft_revision",
				state->draft_revision);
	yyjson_mut_obj_add_val(doc, root, "fields", fields);
	yyjson_mut_obj_add_uint(doc, root, "received", state->received);
	yyjson_mut_obj_add_uint(doc, root, "decoded", state->decoded);
	yyjson_mut_obj_add_uint(doc, root, "invalid", state->invalid);
	yyjson_mut_obj_add_uint(doc, root, "outputs_succeeded",
				state->succeeded);
	yyjson_mut_obj_add_uint(doc, root, "outputs_failed", state->failed);
	yyjson_mut_obj_add_val(doc, root, "outputs", outputs);
	return root;
}

static bool activity(void *user, uint64_t since, uint64_t *sequence,
		     char **json, size_t *size)
{
	auto *state = static_cast<service_state *>(user);

	pthread_mutex_lock(&state->metadata);
	if (since != UINT64_MAX && since >= state->sequence) {
		pthread_mutex_unlock(&state->metadata);
		return false;
	}
	yyjson_mut_doc *doc = yyjson_mut_doc_new(nullptr);

	if (!doc) {
		pthread_mutex_unlock(&state->metadata);
		return false;
	}
	yyjson_mut_doc_set_root(doc, activity_document(state, doc, since));
	*sequence = state->sequence;
	pthread_mutex_unlock(&state->metadata);
	*json = yyjson_mut_write(doc, 0, size);
	yyjson_mut_doc_free(doc);
	return *json != nullptr;
}

static char *state_document(service_state *state, size_t *size)
{
	yyjson_doc *draft = yyjson_read(state->draft, state->draft_size, 0);
	yyjson_mut_doc *doc = yyjson_mut_doc_new(nullptr);
	cv_buffer catalog = {};
	cv_error error = {};

	if (!draft || !doc) {
		yyjson_doc_free(draft);
		yyjson_mut_doc_free(doc);
		return nullptr;
	}
	cv_catalog(reinterpret_cast<const uint8_t *>(state->draft),
		   state->draft_size, &catalog, &error);
	yyjson_doc *index =
		catalog.data ? yyjson_read(reinterpret_cast<const char *>(
						   catalog.data),
					   catalog.size, 0)
			     : nullptr;
	yyjson_mut_val *root = yyjson_mut_obj(doc);

	yyjson_mut_doc_set_root(doc, root);
	yyjson_mut_obj_add_val(
		doc, root, "draft",
		yyjson_val_mut_copy(doc, yyjson_doc_get_root(draft)));
	if (index)
		yyjson_mut_obj_add_val(
			doc, root, "catalog",
			yyjson_val_mut_copy(doc, yyjson_doc_get_root(index)));
	else
		yyjson_mut_obj_add_null(doc, root, "catalog");
	pthread_mutex_lock(&state->metadata);
	yyjson_mut_obj_add_uint(doc, root, "draft_revision",
				state->draft_revision);
	yyjson_mut_obj_add_uint(doc, root, "active_revision",
				state->active_revision);
	yyjson_mut_obj_add_bool(doc, root, "valid", state->valid);
	yyjson_mut_obj_add_strcpy(doc, root, "error", state->error);
	yyjson_mut_val *live = activity_document(state, doc, UINT64_MAX);
	bool complete = live &&
			yyjson_mut_obj_add_val(doc, root, "activity", live);
	pthread_mutex_unlock(&state->metadata);
	char *serialized = complete ? yyjson_mut_write(doc, 0, size) : nullptr;

	yyjson_doc_free(index);
	cv_buffer_destroy(&catalog);
	yyjson_doc_free(draft);
	yyjson_mut_doc_free(doc);
	return serialized;
}

static void response_error(web_response *response, int status,
			   const char *message)
{
	yyjson_mut_doc *doc = yyjson_mut_doc_new(nullptr);

	response->status = status;
	if (!doc)
		return;
	yyjson_mut_val *root = yyjson_mut_obj(doc);

	yyjson_mut_doc_set_root(doc, root);
	yyjson_mut_obj_add_strcpy(doc, root, "error", message);
	response->data = reinterpret_cast<uint8_t *>(
		yyjson_mut_write(doc, 0, &response->size));
	yyjson_mut_doc_free(doc);
}

static void request(void *user, const char *method, const char *path,
		    const uint8_t *body, size_t size, web_response *response)
{
	auto *state = static_cast<service_state *>(user);

	*response = {200, "application/json", nullptr, 0};
	if (!std::strcmp(path, "/health") && !std::strcmp(method, "GET")) {
		response->data =
			reinterpret_cast<uint8_t *>(strdup("{\"ready\":true}"));
		response->size = response->data
					 ? std::strlen(reinterpret_cast<char *>(
						   response->data))
					 : 0;
		return;
	}
	if (std::strcmp(path, "/api/state")) {
		response_error(response, 404, "Unknown endpoint");
		return;
	}
	if (std::strcmp(method, "GET") && std::strcmp(method, "POST")) {
		response_error(response, 405, "Method not allowed");
		return;
	}
	pthread_mutex_lock(&state->edit);
	if (!std::strcmp(method, "POST")) {
		yyjson_doc *doc = yyjson_read(
			reinterpret_cast<const char *>(body), size, 0);
		yyjson_val *root = doc ? yyjson_doc_get_root(doc) : nullptr;
		yyjson_val *revision = yyjson_obj_get(root, "revision");
		yyjson_val *workspace = yyjson_obj_get(root, "workspace");
		int failure = 0;

		if (!yyjson_is_obj(root) || yyjson_obj_size(root) != 2 ||
		    !yyjson_is_uint(revision) || !yyjson_is_obj(workspace))
			failure = 400;
		else if (yyjson_get_uint(revision) != state->draft_revision)
			failure = 409;
		else if (state->draft_revision == UINT64_MAX)
			failure = 500;
		if (!failure) {
			size_t length = 0;
			char *data = yyjson_val_write(workspace, 0, &length);

			if (!data || length > DOCUMENT_LIMIT) {
				failure = 500;
			} else {
				draft_result saved = replace_draft(
					state, data, length,
					state->draft_revision + 1);

				if (saved == DRAFT_SAVE_FAILED)
					failure = 500;
				else if (saved == ACTIVE_SAVE_FAILED)
					response->status = 500;
			}
			std::free(data);
		}
		yyjson_doc_free(doc);
		if (failure) {
			response_error(
				response, failure,
				failure == 409 ? "Stale draft revision"
				: failure == 400
					? "Expected revision and workspace"
					: "Cannot persist draft");
			pthread_mutex_unlock(&state->edit);
			return;
		}
	}
	response->data = reinterpret_cast<uint8_t *>(
		state_document(state, &response->size));
	if (!response->data)
		response_error(response, 500, "Cannot build state response");
	pthread_mutex_unlock(&state->edit);
}

static int udp_socket(const char *endpoint, bool listener)
{
	char host[256];
	const char *port;

	if (!endpoint_parts(endpoint, host, sizeof(host), &port, false))
		return -1;
	addrinfo hints = {};
	addrinfo *addresses = nullptr;

	hints.ai_family = AF_INET;
	hints.ai_socktype = SOCK_DGRAM;
	hints.ai_flags = AI_NUMERICSERV;
	if (getaddrinfo(host, port, &hints, &addresses))
		return -1;
	int result = -1;

	for (addrinfo *item = addresses; item; item = item->ai_next) {
		int fd = socket(item->ai_family,
				SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);

		if (fd < 0)
			continue;
		int status =
			listener ? bind(fd, item->ai_addr, item->ai_addrlen)
				 : connect(fd, item->ai_addr, item->ai_addrlen);

		if (!status) {
			result = fd;
			break;
		}
		close(fd);
	}
	freeaddrinfo(addresses);
	return result;
}

static bool publish(void *user, const char *, const uint8_t *data, size_t size)
{
	auto *state = static_cast<service_state *>(user);
	ssize_t count;

	do {
		count = send(state->output, data, size, MSG_NOSIGNAL);
	} while (count < 0 && errno == EINTR);
	return count >= 0 && static_cast<size_t>(count) == size;
}

static bool initialize(service_state *state, const service_options *options,
		       char **initial, size_t *initial_size)
{
	if (!workspace_open(&state->store, options->workspace, true))
		return false;
	int restored = workspace_restore(&state->store, "active", initial,
					 initial_size, &state->active_revision);

	if (restored < 0)
		return false;
	if (!restored) {
		*initial = strdup(workspace_empty);
		*initial_size = std::strlen(workspace_empty);
	}
	cv_error error = {};

	if (!*initial || !workspace_validate(*initial, *initial_size,
					      &state->active, &error)) {
		std::snprintf(state->error, sizeof(state->error), "%s",
			      error.message);
		return false;
	}
	if (!configure_outputs(&state->outputs, *initial, *initial_size,
			       state->active_revision)) {
		std::snprintf(state->error, sizeof(state->error),
			      "Cannot prepare output feedback");
		return false;
	}
	restored = workspace_restore(&state->store, "draft", &state->draft,
				     &state->draft_size,
				     &state->draft_revision);
	if (restored < 0)
		return false;
	if (!restored) {
		state->draft = strdup(*initial);
		state->draft_size = *initial_size;
		state->draft_revision = state->active_revision;
	}
	if (!state->draft)
		return false;
	cv_workspace *draft = nullptr;

	state->valid = workspace_validate(state->draft, state->draft_size,
					 &draft, &error);
	cv_workspace_destroy(draft);
	/* A saved draft can outlive an interrupted or failed publication. */
	if (state->valid && state->draft_revision != state->active_revision) {
		state->valid = false;
		std::snprintf(error.message, sizeof(error.message),
			      "Saved draft has not been activated");
	}
	std::snprintf(state->error, sizeof(state->error), "%s",
		      state->valid ? "" : error.message);
	return true;
}

/* Reload the saved active snapshot without publishing an edit or replacing
 * a pending draft. Run options and the workspace writer lock stay in force.
 */
static bool reload_active(service_state *state)
{
	char *data = nullptr;
	size_t size = 0;
	uint64_t revision = 0;
	cv_workspace *candidate = nullptr;
	cv_error error = {};
	output_snapshot outputs = {};
	bool valid = workspace_restore(&state->store, "active", &data, &size,
				       &revision) == 1 &&
		     workspace_validate(data, size, &candidate, &error) &&
		     configure_outputs(&outputs, data, size, revision);

	if (valid) {
		pthread_mutex_lock(&state->engine);
		cv_workspace *old = state->active;

		state->active = candidate;
		candidate = nullptr;
		cv_workspace_destroy(old);
		pthread_mutex_lock(&state->metadata);
		state->active_revision = revision;
		state->outputs = outputs;
		if (state->valid && state->draft_revision != revision) {
			state->valid = false;
			std::snprintf(state->error, sizeof(state->error),
				      "Saved draft has not been activated");
		}
		++state->sequence;
		pthread_mutex_unlock(&state->metadata);
		pthread_mutex_unlock(&state->engine);
	}
	cv_workspace_destroy(candidate);
	std::free(data);
	return valid;
}

int service_run(const service_options *options)
{
	service_state state = {};

	pthread_mutex_init(&state.edit, nullptr);
	pthread_mutex_init(&state.engine, nullptr);
	pthread_mutex_init(&state.metadata, nullptr);
	state.output = -1;
	state.store.lock_file = -1;
	char *initial = nullptr;
	size_t initial_size = 0;
	int result = 2;
	int input = -1;
	web_server *web = nullptr;

	if ((options->cot_listen &&
	     !endpoint_valid(options->cot_listen, false)) ||
	    (options->vmf_target &&
	     !endpoint_valid(options->vmf_target, false)) ||
	    (options->web_listen &&
	     !endpoint_valid(options->web_listen, true)) ||
	    (options->log_format && !log_valid(options->log_format))) {
		std::fputs("Invalid endpoint or log format\n", stderr);
		goto cleanup;
	}
	if (!initialize(&state, options, &initial, &initial_size)) {
		const char *error =
			*state.error ? state.error : "read or write failure";

		std::fprintf(stderr, "Cannot initialize workspace: %s\n",
			     error);
		goto cleanup;
	}
	{
		const char *cot = options->cot_listen;
		const char *vmf = options->vmf_target;
		const char *web_listen = options->web_listen;

		state.json_log = options->log_format &&
				 !std::strcmp(options->log_format, "json");
		input = udp_socket(cot ? cot : "0.0.0.0:9001", true);
		state.output = udp_socket(vmf ? vmf : "127.0.0.1:9002", false);
		if (input < 0 || state.output < 0) {
			std::fputs("Cannot configure UDP sockets\n", stderr);
			result = 1;
			goto cleanup;
		}
		stopping = 0;
		reloading = 0;
		struct sigaction action = {};

		action.sa_handler = signal_received;
		sigemptyset(&action.sa_mask);
		sigaction(SIGINT, &action, nullptr);
		sigaction(SIGTERM, &action, nullptr);
		sigaction(SIGHUP, &action, nullptr);
		if (web_listen) {
#ifdef COT_VMF_ENABLE_WEB
			web_host host = {&state, request, activity};
			char error[256] = {};

			if (web_server_start(web_listen, &host, &web, error,
					     sizeof(error))) {
				std::fprintf(stderr, "Web listener: %s\n",
					     error);
				result = 1;
				goto cleanup;
			}
#else
			std::fputs("Web support disabled at build time\n",
				   stderr);
			goto cleanup;
#endif
		}
	}
	state.ready = true;
	std::puts(state.json_log ? "{\"event\":\"ready\"}"
				 : "Ready: receiving Gateway CoT over UDP");
	std::fflush(stdout);
	result = 0;
	while (!stopping) {
		if (reloading) {
			reloading = 0;
			pthread_mutex_lock(&state.edit);
			bool valid = reload_active(&state);

			pthread_mutex_unlock(&state.edit);
			std::puts(state.json_log
					  ? (valid ? "{\"event\":\"reloaded\"}"
						   : "{\"event\":\"reload_"
						     "rejected\"}")
					  : (valid ? "Configuration reloaded"
						   : "Reload rejected; active "
						     "configuration retained"));
			std::fflush(stdout);
		}
		pollfd ready = {input, POLLIN, 0};
		int status = poll(&ready, 1, 100);

		if (status < 0 && errno == EINTR)
			continue;
		if (status < 0 || (ready.revents & (POLLERR | POLLNVAL))) {
			result = 1;
			break;
		}
		if (!status)
			continue;
		uint8_t bytes[65507];
		ssize_t count = recv(input, bytes, sizeof(bytes), MSG_TRUNC);

		if (count < 0 && (errno == EAGAIN || errno == EINTR))
			continue;
		if (count < 0) {
			result = 1;
			break;
		}
		cv_activity event = {};
		cv_error error = {};
		output_snapshot pending;

		pending.count = 0;

		pthread_mutex_lock(&state.engine);
		if (count > 0 && static_cast<size_t>(count) <= sizeof(bytes))
			cv_process_with_feedback(state.active, bytes, count,
					 publish, &state, &event, &error,
					 collect_feedback, &pending);
		pthread_mutex_lock(&state.metadata);
		++state.received;
		state.decoded += event.decoded;
		state.invalid += !event.decoded;
		state.succeeded += event.outputs_succeeded;
		state.failed += event.outputs_failed;
		publish_feedback(&state, &pending);
		++state.sequence;
		activity_record *record =
			&state.history[state.sequence % ACTIVITY_HISTORY];

		*record = {state.sequence, state.active_revision,
			   event.present_fields};
		pthread_mutex_unlock(&state.metadata);
		pthread_mutex_unlock(&state.engine);
		if (state.json_log)
			std::printf("{\"event\":\"received\",\"decoded\":%s,"
				    "\"outputs_succeeded\":%zu,"
				    "\"outputs_failed\":%zu}\n",
				    event.decoded ? "true" : "false",
				    event.outputs_succeeded,
				    event.outputs_failed);
		else
			std::printf("CoT: %s; VMF sent %zu, failed %zu\n",
				    event.decoded ? "decoded"
						  : "invalid/unsupported",
				    event.outputs_succeeded,
				    event.outputs_failed);
		std::fflush(stdout);
	}
cleanup:
#ifdef COT_VMF_ENABLE_WEB
	web_server_stop(web);
#else
	(void)web;
	(void)request;
	(void)activity;
#endif
	if (input >= 0)
		close(input);
	if (state.output >= 0)
		close(state.output);
	workspace_close(&state.store);
	cv_workspace_destroy(state.active);
	std::free(initial);
	std::free(state.draft);
	pthread_mutex_destroy(&state.metadata);
	pthread_mutex_destroy(&state.engine);
	pthread_mutex_destroy(&state.edit);
	return result;
}
