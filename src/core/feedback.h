#ifndef COT2VMF_FEEDBACK_H_INCLUDED
#define COT2VMF_FEEDBACK_H_INCLUDED

#include <cot2vmf/core.h>

enum cv_output_outcome {
	CV_OUTPUT_SENT,
	CV_OUTPUT_NOT_ENCODED,
	CV_OUTPUT_SEND_FAILED
};

/* Private processing metadata. Every string is non-NULL and borrowed only
 * during the callback. Locations are empty when unknown or irrelevant;
 * cot_id is a native source id, or -1. Successful results have no diagnostic.
 */
struct cv_output_feedback {
	const char *output_id;
	cv_output_outcome outcome;
	const char *code;
	const char *message;
	const char *config_path;
	const char *target_index;
	int cot_id;
};

typedef void (*cv_feedback_callback)(void *context,
				     const cv_output_feedback *feedback);

/* Internal extension of cv_process, with identical validation, publication,
 * counts, and first-error behavior. Optional feedback runs synchronously once
 * after each enabled output is attempted, before its job storage is released.
 * Invalid CoT and disabled outputs produce no feedback. The callback must not
 * destroy the workspace; independent calls may use independent caller state.
 * Copy metadata during the callback to retain it. No payload bytes or values
 * are exposed, and the immutable workspace retains no observer state.
 */
cv_status cv_process_with_feedback(const cv_workspace *workspace,
				   const uint8_t *data, size_t size,
				   cv_output_callback callback, void *context,
				   cv_activity *activity, cv_error *error,
				   cv_feedback_callback feedback,
				   void *feedback_context);

#endif
