#ifndef COT_VMF_WORKSPACE_STORE_H
#define COT_VMF_WORKSPACE_STORE_H

#include <cot2vmf/core.h>
#include <cstddef>
#include <cstdint>
#include <limits.h>

#define WORKSPACE_DOCUMENT_LIMIT (16u * 1024u * 1024u)

extern const char workspace_empty[];

struct workspace_store {
	char directory[PATH_MAX];
	int lock_file;
};

/* Select CLI, COT_VMF_WORKSPACE, then per-user state. Writers create private
 * directories and hold the service's exclusive lock. Readers create nothing.
 * Failed opens leave a closeable store; close is also safe after success.
 */
bool workspace_open(workspace_store *store, const char *selector, bool writer);
void workspace_close(workspace_store *store);

/* Read an owned, NUL-terminated regular-file buffer. Failure clears outputs. */
bool workspace_read_file(const char *path, char **data, size_t *size,
			size_t limit = WORKSPACE_DOCUMENT_LIMIT);

/* Restore raw documents, including invalid drafts. Return 1 for a saved
 * envelope, 0 for absent state, -1 for damaged state. Outputs start empty.
 */
int workspace_restore(workspace_store *store, const char *name, char **data,
		      size_t *size, uint64_t *revision);

/* Persist one private envelope with same-directory atomic rename. */
bool workspace_persist(workspace_store *store, const char *name,
		       const char *data, size_t size, uint64_t revision);

enum workspace_publish_result {
	WORKSPACE_SAVED,
	WORKSPACE_DRAFT_FAILED,
	WORKSPACE_ACTIVE_FAILED
};

/* Save the draft first, then active only when activate is true. An active
 * failure retains the new inactive draft and the previous active snapshot.
 */
workspace_publish_result workspace_publish(workspace_store *store,
	const char *data, size_t size, uint64_t revision, bool activate);

/* The sole activation validator; no transport settings belong in documents. */
bool workspace_validate(const char *data, size_t size, cv_workspace **result,
			cv_error *error);

#endif
