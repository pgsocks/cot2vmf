#ifndef COT_VMF_WORKSPACE_CLI_H
#define COT_VMF_WORKSPACE_CLI_H

/* Apply option/value edits to the saved draft under the workspace writer
 * lock. An explicit --config replaces the base before other edits in order.
 * initialize skips seed evaluation if either saved state envelope exists.
 * Each intermediate serialized document is bounded to 16 MiB; replaced
 * values are released between edits, before validating the final candidate.
 * Return 0 for active publication, 3 for a saved inactive draft, 2 for
 * malformed input/locking errors, or 1 for unsuccessful persistence.
 */
int workspace_config(const char *directory, bool initialize, int argc,
		     const char *const *argv);

/* Read a file or saved snapshot without creating state or taking the writer
 * lock. file selects validation input; otherwise active selects the saved
 * active document instead of the default draft. validate reports validity;
 * export writes bare workspace JSON to stdout. Missing state is empty.
 * Return 0 on success, 2 for invalid input/state, or 1 for output I/O failure.
 */
int workspace_inspect(const char *directory, const char *file, bool active,
		      bool validate);

#endif
