#ifndef COT_VMF_BRIDGE_H
#define COT_VMF_BRIDGE_H

#include <cot/inspect.h>
#include <vmf/author.h>
#include <vmf/header_json.h>
#include <vmf/schema_json.h>
#include <yyjson.h>

#define BRIDGE_MAX_DEPTH 64
#define BRIDGE_COT_FIELDS 64

enum bridge_kind {
	BRIDGE_MISSING,
	BRIDGE_BOOL,
	BRIDGE_UINT,
	BRIDGE_INT,
	BRIDGE_REAL,
	BRIDGE_TEXT
};

struct bridge_value {
	bridge_kind kind;
	bool boolean;
	uint64_t u;
	int64_t i;
	double real;
	const char *text;
	size_t size;
};

struct bridge_selector {
	vmf_repeat_occurrence items[BRIDGE_MAX_DEPTH];
	size_t count;
};

struct bridge_lookup_entry {
	bridge_value key;
	uint64_t code;
};

struct bridge_binding {
	const vmf_index_schema *index;
	vmf_index_info info;
	char config_path[768];
	bridge_selector selector;
	int cot_id;
	yyjson_val *options;
	const bridge_lookup_entry *lookup;
	size_t lookup_count;
	bridge_value constant;
	vmf_field_event raw;
	size_t author_entry;
	bool supplied;
	bool used;
};

struct bridge_control {
	vmf_scope_ref scope;
	char config_path[768];
	bridge_selector selector;
	bool present;
	uint64_t count;
	bool used;
};

struct bridge_blob {
	uint8_t *data;
	size_t size;
};

struct bridge_arena {
	void *blocks;
	size_t used;
};

struct bridge_notice {
	const char *code;
	bool warning;
	char message[384];
	char config_path[768];
	int cot_id;
	const vmf_index_schema *index;
	bridge_selector selector;
	bridge_notice *next;
};

struct bridge_context {
	vmf_schema_json_document *schema_owner;
	vmf_header_json_document *header_owner;
	vmf_schema_set registry;
	const vmf_schema_set *schemas;
	const vmf_message_schema *message;
	vmf_envelope_version profile;
	size_t message_ordinal;
	vmf_header header;
	yyjson_doc *config;
	bridge_arena arena;
	bridge_binding *bindings;
	size_t binding_count;
	bridge_control *controls;
	size_t control_count;
	bridge_value cot[BRIDGE_COT_FIELDS];
	cot_decoded_event *cot_owner;
	cot_diagnostic cot_error;
	vmf_author_result *result;
	bridge_notice *first_notice;
	bridge_notice *last_notice;
	size_t warnings;
	const char *error_code;
	char error[768];
	char config_path[768];
	int current_cot;
	const vmf_index_schema *current_index;
	bridge_selector current_selector;
};

bool bridge_fail(bridge_context *ctx, const char *format, ...);
void bridge_warn(bridge_context *ctx, const char *format, ...);
void bridge_note(bridge_context *ctx, const char *code, bool warning,
		 const char *format, ...);
void *bridge_alloc(bridge_context *ctx, size_t size);
void bridge_arena_destroy(bridge_arena *arena);
vmf_header_fields *bridge_header_fields(bridge_context *ctx);
/* Borrow one message and its canonical arrays from a validated source.
 * Materializes its effective standard while preserving the raw-code origin.
 * The source owner outlives the view. Invalid source/bounds return a zero view.
 */
vmf_schema_set bridge_message_view(const vmf_schema_set *source,
				 size_t ordinal);
bool bridge_selector_equal(const bridge_selector *a, const bridge_selector *b);
vmf_author_address bridge_address(bridge_context *ctx,
				  const vmf_index_schema *index,
				  vmf_scope_ref scope,
				  const bridge_selector *selector);
void bridge_location(bridge_context *ctx, const char *path, int cot_id,
		     const vmf_index_schema *index,
		     const bridge_selector *selector);
/* Parse a bounded JSON object, rejecting duplicate keys and deep nesting.
 * Does not require a complete mapping config. ctx owns the document.
 */
bool bridge_mapping_config_parse(bridge_context *ctx, const uint8_t *data,
			  size_t size);
/* Validate a complete mapping config with borrowed, validated schemas.
 * Does not resolve or open its schema path. Schemas must survive ctx,
 * and a fresh context is required for each call.
 */
bool bridge_load_memory(bridge_context *ctx, const uint8_t *data, size_t size,
			const vmf_schema_set *schemas);
void bridge_destroy(bridge_context *ctx);
bool bridge_json_value(bridge_context *ctx, yyjson_val *json,
		       bridge_value *value);
bool bridge_value_equal(const bridge_value *a, const bridge_value *b);
/* Compare normalized native source keys; real keys must be finite. */
int bridge_lookup_compare(const bridge_value *a, const bridge_value *b);
bool bridge_source_value_valid(bridge_context *ctx, int id,
			       const bridge_value *value);
bool bridge_code_encode(bridge_context *ctx, const vmf_index_info *info,
			uint64_t code, vmf_field_event *event);
bool bridge_field_encode(bridge_context *ctx, const bridge_binding *binding,
			 const vmf_index_info *info, const bridge_value *value,
			 vmf_field_event *event);
bool bridge_cot_load(bridge_context *ctx, cot_format format,
		     const uint8_t *data, size_t size);
bool bridge_vmf_encode(bridge_context *ctx);

#endif
