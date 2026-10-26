#ifndef COT2VMF_WORKSPACE_H_INCLUDED
#define COT2VMF_WORKSPACE_H_INCLUDED

#include <cot2vmf/core.h>
#include "bridge.h"

struct cv_schema {
	const char *id;
	vmf_schema_json_document *owner;
};

struct cv_output {
	const char *id;
	bool enabled;
	bridge_context mapping;
};

struct cv_workspace {
	bridge_context source;
	cv_schema *schemas;
	size_t schema_count;
	cv_output *outputs;
	size_t output_count;
};

cv_status cv_fail(cv_error *error, cv_status status, const char *message);
/* Validates workspace framing and ids, without interpreting embedded schemas
 * or draft mappings. The source context owns the parsed document/allocations.
 */
bool cv_workspace_parse(bridge_context *source, const uint8_t *data,
			size_t size);
bool cv_schema_load(yyjson_val *document, vmf_schema_json_document **owner,
		    cv_error *error);

#endif
