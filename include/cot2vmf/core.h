#ifndef COT2VMF_CORE_H_INCLUDED
#define COT2VMF_CORE_H_INCLUDED

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Outcomes are independent of errno; no API throws or changes global state. */
typedef enum cv_status {
	CV_OK,
	CV_INVALID_ARGUMENT,
	CV_INVALID_CONFIG,
	CV_INVALID_COT,
	CV_OUT_OF_MEMORY,
	CV_OUTPUT_ERROR
} cv_status;

/* Optional diagnostic, initialized on every return. Messages describe only
 * configuration/codec failures and never include received payload values.
 */
typedef struct cv_error {
	cv_status status;
	char message[768];
} cv_error;

/* An immutable validated workspace. Independent calls may share it; destroy
 * only after all calls and output callbacks have completed. No file I/O.
 */
typedef struct cv_workspace cv_workspace;

/* Owned bytes; successful catalog output is NUL-terminated UTF-8 JSON, with
 * size excluding that terminator. Release with cv_buffer_destroy.
 */
typedef struct cv_buffer {
	uint8_t *data;
	size_t size;
} cv_buffer;

/* Synchronous publication of one complete VMF PDU. All arguments are borrowed
 * until return; copy bytes to retain them. Return true only if publication
 * succeeded. Outputs run in configured order; failures do not stop later
 * outputs. The callback must not destroy its workspace during a call.
 */
typedef bool (*cv_output_callback)(void *context, const char *output_id,
				   const uint8_t *data, size_t size);

/* Metadata only: bit (CoT catalog id - 1) is set for every available field,
 * including opaque extensions. Counts concern enabled outputs for this event.
 */
typedef struct cv_activity {
	bool decoded;
	uint64_t present_fields;
	size_t outputs_succeeded;
	size_t outputs_failed;
} cv_activity;

/* Load strict cot-vmf-workspace/1 JSON from size readable bytes (max 16 MiB).
 * Input is copied, never modified/retained. Schemas embed native vmf-schema/1
 * documents; each mapping's schema string refers to its workspace schema id.
 * Mapping format cot-vmf-mapping-config/1 requires a zero-based message ordinal
 * and explicit B/C/D/D1 envelope. Identity is derived from that selected
 * message; optional vmf_header metadata must not contain an explicit id.
 * No schema paths are resolved. Duplicate ids/keys and unknown properties fail.
 * Enabled outputs must be completely valid; disabled outputs may be drafts.
 * Arrays contain at most 128 entries; ids contain 1..128 UTF-8 bytes, no NUL.
 * Workspaces contain format, schemas, and outputs only. Runtime settings are
 * not workspace properties. An empty workspace is valid.
 * result is required, cleared on all failures. Input/output storage must not
 * overlap and result must not overwrite an existing live owner.
 * Owned storage is bounded; callers release the successful owner with destroy.
 */
cv_status cv_workspace_load(const uint8_t *data, size_t size,
			    cv_workspace **result, cv_error *error);

/* NULL-safe. No concurrent caller may still borrow workspace storage. */
void cv_workspace_destroy(cv_workspace *workspace);

/* Decode one XML CoT event (1..65507 bytes) and translate enabled outputs.
 * NULL workspace provides receive-only inspection. activity is required and
 * cleared on every call. callback may be NULL only with no enabled outputs.
 * All inputs are immutable/borrowed and must not overlap output storage.
 * Fresh per-event state prevents absent fields inheriting prior values.
 * Every successful encoded PDU is <=65507 bytes. Encoding/publication failure
 * returns CV_OUTPUT_ERROR after attempting all outputs; counts remain valid.
 * Invalid XML returns CV_INVALID_COT without calling callback. Separate calls
 * are reentrant when callbacks and their caller state permit it.
 */
cv_status cv_process(const cv_workspace *workspace, const uint8_t *data,
		     size_t size, cv_output_callback callback, void *context,
		     cv_activity *activity, cv_error *error);

/* Inspect workspace JSON independently of output validity for authoring UIs.
 * NULL data with size zero selects an empty workspace. Structural/syntax errors
 * fail; invalid embedded schemas become per-schema diagnostics. The returned
 * cot-vmf-catalog/1 JSON includes all CoT fields and each valid message
 * ordinal with shared canonical field metadata. Its profiles object contains
 * B/C/D/D1 availability, diagnostics, exact identities and header previews;
 * unavailable profiles retain the message and expose null identity/header.
 * Availability binds only the selected message, not unrelated definitions.
 * result is required and cleared on every failure. Input limits match load.
 */
cv_status cv_catalog(const uint8_t *data, size_t size, cv_buffer *result,
		     cv_error *error);

/* NULL-safe; frees owned bytes and clears the struct. */
void cv_buffer_destroy(cv_buffer *buffer);

#ifdef __cplusplus
}
#endif
#endif
