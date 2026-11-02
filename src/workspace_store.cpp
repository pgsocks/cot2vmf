#include "workspace_store.h"
#include <yyjson.h>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

const char workspace_empty[] =
	"{\"format\":\"cot-vmf-workspace/1\",\"schemas\":[],\"outputs\":[]}";

bool workspace_read_file(const char *path, char **data, size_t *size,
			size_t limit)
{
	*data = nullptr;
	*size = 0;
	int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);

	if (fd < 0)
		return false;
	struct stat info = {};

	if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size < 1 ||
	    static_cast<uint64_t>(info.st_size) > limit) {
		close(fd);
		errno = EINVAL;
		return false;
	}
	char *bytes = static_cast<char *>(std::malloc(info.st_size + 1));

	if (!bytes) {
		close(fd);
		errno = ENOMEM;
		return false;
	}
	size_t used = 0;

	while (used < static_cast<size_t>(info.st_size)) {
		ssize_t count = read(fd, bytes + used, info.st_size - used);

		if (count < 0 && errno == EINTR)
			continue;
		if (count <= 0) {
			std::free(bytes);
			close(fd);
			errno = EIO;
			return false;
		}
		used += count;
	}
	close(fd);
	bytes[used] = 0;
	*data = bytes;
	*size = used;
	return true;
}

static bool make_directory(const char *path)
{
	char buffer[PATH_MAX];

	if (!path || !*path || std::strlen(path) >= sizeof(buffer))
		return false;
	std::strcpy(buffer, path);
	for (char *p = buffer + 1;; ++p) {
		if (*p && *p != '/')
			continue;
		char saved = *p;

		*p = 0;
		if (mkdir(buffer, 0700) && errno != EEXIST)
			return false;
		struct stat info = {};

		if (lstat(buffer, &info) || !S_ISDIR(info.st_mode))
			return false;
		*p = saved;
		if (!saved)
			return true;
	}
}

bool workspace_open(workspace_store *store, const char *selector, bool writer)
{
	*store = {};
	store->lock_file = -1;
	const char *directory = selector;

	if (!directory || !*directory)
		directory = std::getenv("COT_VMF_WORKSPACE");
	int length;

	if (directory && *directory) {
		length = std::snprintf(store->directory,
				       sizeof(store->directory), "%s",
				       directory);
	} else {
		const char *xdg = std::getenv("XDG_STATE_HOME");
		const char *home = std::getenv("HOME");

		if (xdg && *xdg)
			length = std::snprintf(store->directory,
				       sizeof(store->directory),
				       "%s/cot-to-vmf", xdg);
		else
			length = std::snprintf(store->directory,
				       sizeof(store->directory),
				       "%s/.local/state/cot-to-vmf",
				       home && *home ? home : ".");
	}
	if (length < 0 || length >= static_cast<int>(sizeof(store->directory)))
		return false;
	if (!writer)
		return true;
	if (!make_directory(store->directory))
		return false;
	char path[PATH_MAX];

	if (std::snprintf(path, sizeof(path), "%s/.lock", store->directory) >=
	    static_cast<int>(sizeof(path)))
		return false;
	store->lock_file = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
			       0600);
	if (store->lock_file < 0)
		return false;
	if (flock(store->lock_file, LOCK_EX | LOCK_NB)) {
		workspace_close(store);
		return false;
	}
	return true;
}

void workspace_close(workspace_store *store)
{
	if (store->lock_file >= 0)
		close(store->lock_file);
	store->lock_file = -1;
}

bool workspace_persist(workspace_store *store, const char *name,
		       const char *data, size_t size, uint64_t revision)
{
	yyjson_doc *source = yyjson_read(data, size, 0);
	size_t workspace_size = 0;
	char *workspace = source ? yyjson_write(source, 0, &workspace_size)
				 : nullptr;

	yyjson_doc_free(source);
	/* Numeric tokens can grow during serialization. Bound the saved
	 * representation before publishing either state file.
	 */
	if (!workspace || workspace_size > WORKSPACE_DOCUMENT_LIMIT) {
		std::free(workspace);
		return false;
	}
	yyjson_mut_doc *doc = yyjson_mut_doc_new(nullptr);

	if (!doc) {
		std::free(workspace);
		return false;
	}
	yyjson_mut_val *root = yyjson_mut_obj(doc);

	bool complete =
		root &&
		yyjson_mut_obj_add_uint(doc, root, "revision", revision) &&
		yyjson_mut_obj_add_val(
			doc, root, "workspace",
			yyjson_mut_rawn(doc, workspace, workspace_size));

	yyjson_mut_doc_set_root(doc, root);
	size_t length = 0;
	char *serialized =
		complete ? yyjson_mut_write(doc, 0, &length) : nullptr;
	char destination[PATH_MAX];
	char temporary[PATH_MAX];
	bool good = serialized &&
		    std::snprintf(destination, sizeof(destination),
				  "%s/%s.json", store->directory, name) <
			    static_cast<int>(sizeof(destination)) &&
		    std::snprintf(temporary, sizeof(temporary), "%s/.%s-XXXXXX",
				  store->directory,
				  name) < static_cast<int>(sizeof(temporary));
	int fd = good ? mkstemp(temporary) : -1;

	good = fd >= 0;
	size_t used = 0;

	while (good && used < length) {
		ssize_t count = write(fd, serialized + used, length - used);

		if (count < 0 && errno == EINTR)
			continue;
		if (count <= 0)
			good = false;
		else
			used += count;
	}
	if (fd >= 0) {
		if (good && fsync(fd))
			good = false;
		if (close(fd))
			good = false;
		if (good && rename(temporary, destination))
			good = false;
		if (!good)
			unlink(temporary);
	}
	std::free(serialized);
	yyjson_mut_doc_free(doc);
	std::free(workspace);
	return good;
}

/* Missing state is distinct from damaged state. Never silently fall back
 * to an invalid draft or receive-only mode after a saved-state error.
 */
int workspace_restore(workspace_store *store, const char *name, char **data,
		      size_t *size, uint64_t *revision)
{
	*data = nullptr;
	*size = 0;
	*revision = 0;
	char path[PATH_MAX];

	if (std::snprintf(path, sizeof(path), "%s/%s.json", store->directory,
			  name) >= static_cast<int>(sizeof(path)))
		return -1;
	char *bytes = nullptr;
	size_t length = 0;

	/* Saved revision metadata wraps a full-size workspace document. */
	if (!workspace_read_file(path, &bytes, &length,
				 WORKSPACE_DOCUMENT_LIMIT + 128))
		return errno == ENOENT ? 0 : -1;
	yyjson_doc *doc = yyjson_read(bytes, length, 0);
	yyjson_val *root = doc ? yyjson_doc_get_root(doc) : nullptr;
	yyjson_val *rev = yyjson_obj_get(root, "revision");
	yyjson_val *workspace = yyjson_obj_get(root, "workspace");
	bool valid = yyjson_is_obj(root) && yyjson_is_uint(rev) &&
		     yyjson_is_obj(workspace) && yyjson_obj_size(root) == 2;

	if (valid) {
		*revision = yyjson_get_uint(rev);
		*data = yyjson_val_write(workspace, 0, size);
		valid = *data != nullptr;
	}
	yyjson_doc_free(doc);
	std::free(bytes);
	return valid ? 1 : -1;
}

workspace_publish_result workspace_publish(workspace_store *store,
	const char *data, size_t size, uint64_t revision, bool activate)
{
	if (!workspace_persist(store, "draft", data, size, revision))
		return WORKSPACE_DRAFT_FAILED;
	if (activate &&
	    !workspace_persist(store, "active", data, size, revision))
		return WORKSPACE_ACTIVE_FAILED;
	return WORKSPACE_SAVED;
}

bool workspace_validate(const char *data, size_t size, cv_workspace **result,
			cv_error *error)
{
	return cv_workspace_load(reinterpret_cast<const uint8_t *>(data), size,
				 result, error) == CV_OK;
}
