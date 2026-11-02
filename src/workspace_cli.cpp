#include "workspace_cli.h"
#include "workspace_store.h"
#include <yyjson.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>

struct path_item {
	const char *key;
	size_t length;
	size_t index;
	bool array;
};

static bool put(yyjson_mut_doc *doc, yyjson_mut_val *object,
		const char *key, size_t length, yyjson_mut_val *value)
{
	yyjson_mut_val *name = yyjson_mut_strncpy(doc, key, length);

	return name && value && yyjson_mut_obj_put(object, name, value);
}

static yyjson_mut_doc *document(const char *bytes, size_t size)
{
	yyjson_doc *source = yyjson_read(bytes, size, 0);
	yyjson_mut_doc *result = nullptr;

	if (source && yyjson_is_obj(yyjson_doc_get_root(source)))
		result = yyjson_doc_mut_copy(source, nullptr);
	yyjson_doc_free(source);
	return result;
}

/* Drop replaced values from the arena between edits, without requiring an
 * intermediate document to activate. The serialized size is bounded too.
 */
static bool compact(yyjson_mut_doc **doc)
{
	size_t size = 0;
	char *bytes = yyjson_mut_write(*doc, 0, &size);
	yyjson_mut_doc *next = bytes && size <= WORKSPACE_DOCUMENT_LIMIT
				   ? document(bytes, size) : nullptr;

	std::free(bytes);
	if (!next)
		return false;
	yyjson_mut_doc_free(*doc);
	*doc = next;
	return true;
}

static bool parse_path(const char *path, size_t length, path_item *items,
		       size_t *count)
{
	*count = 0;
	if (!length || length > 4096 || path[0] == '[')
		return false;
	size_t at = 0;
	bool key = true;

	while (at < length && *count < 64) {
		path_item *item = items + (*count)++;

		*item = {};
		if (key) {
			size_t start = at;

			while (at < length && path[at] != '.' &&
			       path[at] != '[' && path[at] != ']')
				++at;
			if (at == start)
				return false;
			item->key = path + start;
			item->length = at - start;
		} else {
			item->array = true;
			++at;
			size_t start = at;

			while (at < length && path[at] >= '0' &&
			       path[at] <= '9') {
				if (item->index > 6553)
					return false;
				item->index = item->index * 10 +
					      path[at++] - '0';
			}
			if (at == start || at == length || path[at++] != ']' ||
			    item->index > 65536)
				return false;
		}
		if (at == length)
			return true;
		if (path[at] == '.') {
			++at;
			key = true;
		} else if (path[at] == '[') {
			key = false;
		} else {
			return false;
		}
	}
	return false;
}

static bool assign(yyjson_mut_doc *doc, const char *assignment)
{
	const char *equal = std::strchr(assignment, '=');
	path_item path[64];
	size_t count = 0;

	if (!equal || !parse_path(assignment, equal - assignment, path, &count))
		return false;
	size_t size = std::strlen(equal + 1);

	if (size > WORKSPACE_DOCUMENT_LIMIT)
		return false;
	yyjson_doc *source = yyjson_read(equal + 1, size, 0);
	yyjson_mut_val *value =
	    source ? yyjson_val_mut_copy(doc, yyjson_doc_get_root(source))
		   : nullptr;

	yyjson_doc_free(source);
	if (!value)
		return false;
	yyjson_mut_val *parent = yyjson_mut_doc_get_root(doc);

	for (size_t i = 0; i < count; ++i) {
		const path_item *item = path + i;
		bool last = i + 1 == count;
		yyjson_mut_val *child;

		if (item->array) {
			if (!yyjson_mut_is_arr(parent) ||
			    item->index > yyjson_mut_arr_size(parent))
				return false;
			child = yyjson_mut_arr_get(parent, item->index);
		} else {
			if (!yyjson_mut_is_obj(parent))
				return false;
			child = yyjson_mut_obj_getn(parent, item->key,
						   item->length);
		}
		if (last || !child) {
			yyjson_mut_val *next = last ? value
				: path[i + 1].array ? yyjson_mut_arr(doc)
						    : yyjson_mut_obj(doc);
			bool good;

			if (item->array) {
				good = child
					? yyjson_mut_arr_replace(parent,
						item->index, next) != nullptr
					: yyjson_mut_arr_append(parent, next);
			} else {
				good = put(doc, parent, item->key, item->length,
					   next);
			}
			if (!good)
				return false;
			child = next;
		}
		parent = child;
	}
	return true;
}

static size_t find_id(yyjson_mut_val *array, const char *id)
{
	for (size_t i = 0; i < yyjson_mut_arr_size(array); ++i) {
		yyjson_mut_val *entry = yyjson_mut_arr_get(array, i);

		if (yyjson_mut_equals_str(yyjson_mut_obj_get(entry, "id"), id))
			return i;
	}
	return SIZE_MAX;
}

static bool import_entry(yyjson_mut_doc *doc, const char *argument, bool schema)
{
	const char *equal = std::strchr(argument, '=');

	if (!equal || equal == argument || equal - argument > 128 || !equal[1])
		return false;
	char id[129];

	std::memcpy(id, argument, equal - argument);
	id[equal - argument] = 0;
	char *bytes = nullptr;
	size_t size = 0;

	if (!workspace_read_file(equal + 1, &bytes, &size))
		return false;
	yyjson_doc *source = yyjson_read(bytes, size, 0);
	yyjson_val *root = source ? yyjson_doc_get_root(source) : nullptr;
	yyjson_mut_val *value = yyjson_is_obj(root)
					? yyjson_val_mut_copy(doc, root)
					: nullptr;

	yyjson_doc_free(source);
	std::free(bytes);
	if (!value)
		return false;
	yyjson_mut_val *workspace = yyjson_mut_doc_get_root(doc);
	const char *name = schema ? "schemas" : "outputs";
	yyjson_mut_val *array = yyjson_mut_obj_get(workspace, name);

	if (!array) {
		array = yyjson_mut_arr(doc);
		if (!put(doc, workspace, name, std::strlen(name), array))
			return false;
	}
	if (!yyjson_mut_is_arr(array))
		return false;
	size_t index = find_id(array, id);
	yyjson_mut_val *old = yyjson_mut_arr_get(array, index);
	yyjson_mut_val *entry = yyjson_mut_obj(doc);
	yyjson_mut_val *enabled = yyjson_mut_obj_get(old, "enabled");
	const char *field = schema ? "document" : "mapping";
	bool good = entry && yyjson_mut_obj_add_strcpy(doc, entry, "id", id) &&
		    yyjson_mut_obj_add_val(doc, entry, field, value);

	if (!schema)
		good = good && yyjson_mut_obj_add_bool(doc, entry, "enabled",
			!yyjson_mut_is_bool(enabled) ||
			yyjson_mut_get_bool(enabled));
	return good && (index == SIZE_MAX
		? yyjson_mut_arr_append(array, entry)
		: yyjson_mut_arr_replace(array, index, entry) != nullptr);
}

static bool remove_entry(yyjson_mut_doc *doc, const char *id, bool schema)
{
	yyjson_mut_val *root = yyjson_mut_doc_get_root(doc);
	yyjson_mut_val *array =
	    yyjson_mut_obj_get(root, schema ? "schemas" : "outputs");
	size_t index = find_id(array, id);

	if (index == SIZE_MAX || !yyjson_mut_arr_remove(array, index))
		return false;
	if (schema) {
		yyjson_mut_val *outputs = yyjson_mut_obj_get(root, "outputs");

		for (size_t i = yyjson_mut_arr_size(outputs); i > 0; --i) {
			yyjson_mut_val *output =
			    yyjson_mut_arr_get(outputs, i - 1);
			yyjson_mut_val *mapping =
			    yyjson_mut_obj_get(output, "mapping");

			if (yyjson_mut_equals_str(
				    yyjson_mut_obj_get(mapping, "schema"), id))
				yyjson_mut_arr_remove(outputs, i - 1);
		}
	}
	return true;
}

static yyjson_mut_doc *compose(const char *base, size_t size, int argc,
			      const char *const *argv)
{
	yyjson_mut_doc *doc = nullptr;
	bool imported = false;

	for (int i = 0; i < argc; i += 2) {
		if (std::strcmp(argv[i], "--config"))
			continue;
		char *bytes = nullptr;
		size_t length = 0;

		if (!workspace_read_file(argv[i + 1], &bytes, &length))
			return nullptr;
		doc = document(bytes, length);
		std::free(bytes);
		imported = true;
		break;
	}
	if (!imported)
		doc = document(base, size);
	if (!doc)
		return nullptr;
	for (int i = 0; i < argc; i += 2) {
		const char *option = argv[i];
		const char *value = argv[i + 1];
		bool good = true;

		if (!std::strcmp(option, "--schema"))
			good = import_entry(doc, value, true);
		else if (!std::strcmp(option, "--mapping"))
			good = import_entry(doc, value, false);
		else if (!std::strcmp(option, "--remove-schema"))
			good = remove_entry(doc, value, true);
		else if (!std::strcmp(option, "--remove-mapping"))
			good = remove_entry(doc, value, false);
		else if (!std::strcmp(option, "--set"))
			good = assign(doc, value);
		if (good && std::strcmp(option, "--config"))
			good = compact(&doc);
		if (!good) {
			std::fprintf(stderr, "Cannot apply %s\n", option);
			yyjson_mut_doc_free(doc);
			return nullptr;
		}
	}
	return doc;
}

int workspace_config(const char *directory, bool initialize, int argc,
		     const char *const *argv)
{
	workspace_store store = {};

	if (!workspace_open(&store, directory, true)) {
		std::fputs("Cannot open or lock workspace\n", stderr);
		return 2;
	}
	char *draft = nullptr, *active = nullptr, *bytes = nullptr;
	size_t draft_size = 0, active_size = 0, size = 0;
	uint64_t draft_revision = 0, active_revision = 0;
	yyjson_mut_doc *doc = nullptr;
	cv_workspace *candidate = nullptr;
	cv_error error = {};
	int result = 2;

	do {
		int has_draft = workspace_restore(&store, "draft", &draft,
			&draft_size, &draft_revision);
		int has_active = workspace_restore(&store, "active", &active,
			&active_size, &active_revision);

		if (has_draft < 0 || has_active < 0) {
			std::fputs("Cannot read saved workspace\n", stderr);
			break;
		}
		if (initialize && (has_draft || has_active)) {
			std::puts("Workspace is already initialized");
			result = 0;
			break;
		}
		const char *base = draft ? draft : active ? active
							 : workspace_empty;
		size_t length = draft ? draft_size : active ? active_size
						: std::strlen(workspace_empty);

		doc = compose(base, length, argc, argv);
		if (!doc) {
			std::fputs("Invalid config command or JSON input\n",
				   stderr);
			break;
		}
		bytes = yyjson_mut_write(doc, 0, &size);
		if (!bytes || size > WORKSPACE_DOCUMENT_LIMIT) {
			std::fputs("Workspace exceeds saved size limit\n",
				   stderr);
			break;
		}
		uint64_t revision = draft_revision > active_revision
					    ? draft_revision : active_revision;

		if (revision == UINT64_MAX) {
			std::fputs("Workspace revision exhausted\n", stderr);
			break;
		}
		++revision;
		bool valid = workspace_validate(bytes, size, &candidate,
						&error);
		workspace_publish_result saved = workspace_publish(
			&store, bytes, size, revision, valid);

		if (saved != WORKSPACE_SAVED) {
			const char *message = saved == WORKSPACE_DRAFT_FAILED
				? "Cannot persist draft\n"
				: "Draft saved; active publication failed\n";

			std::fputs(message, stderr);
			result = 1;
			break;
		}
		if (valid) {
			std::printf("Saved active configuration revision "
				    "%llu\n",
				    static_cast<unsigned long long>(revision));
			result = 0;
		} else {
			std::fprintf(stderr,
				"Saved inactive draft revision %llu: %s\n",
				static_cast<unsigned long long>(revision),
				error.message);
			result = 3;
		}
	} while (false);
	cv_workspace_destroy(candidate);
	yyjson_mut_doc_free(doc);
	std::free(bytes);
	std::free(draft);
	std::free(active);
	workspace_close(&store);
	return result;
}

int workspace_inspect(const char *directory, const char *file, bool active,
		      bool validate)
{
	workspace_store store = {};
	char *bytes = nullptr;
	size_t size = 0;
	uint64_t revision = 0;
	int result = 2;

	store.lock_file = -1;
	do {
		if (file) {
			if (!workspace_read_file(file, &bytes, &size)) {
				std::fputs("Cannot read configuration\n",
					   stderr);
				break;
			}
		} else {
			if (!workspace_open(&store, directory, false)) {
				std::fputs("Cannot open workspace\n", stderr);
				break;
			}
			int restored = workspace_restore(&store,
				active ? "active" : "draft", &bytes, &size,
				&revision);

			if (!restored && !active)
				restored = workspace_restore(&store, "active",
					&bytes, &size, &revision);
			if (restored < 0) {
				std::fputs("Cannot read saved workspace\n",
					   stderr);
				break;
			}
		}
		const char *data = bytes ? bytes : workspace_empty;
		size_t length = bytes ? size : std::strlen(workspace_empty);

		if (validate) {
			cv_workspace *candidate = nullptr;
			cv_error error = {};
			bool valid = workspace_validate(data, length,
						&candidate, &error);

			cv_workspace_destroy(candidate);
			if (!valid) {
				std::fprintf(stderr,
					     "Invalid configuration: %s\n",
					     error.message);
				break;
			}
			std::puts("Configuration is valid");
			result = 0;
		} else {
			size_t written = std::fwrite(data, 1, length, stdout);

			bool good = written == length;

			good = good && std::putchar('\n') != EOF;
			result = good && !std::fflush(stdout) ? 0 : 1;
		}
	} while (false);
	std::free(bytes);
	workspace_close(&store);
	return result;
}
