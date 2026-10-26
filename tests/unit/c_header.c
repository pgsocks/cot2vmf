#include <cot2vmf/core.h>

/* Compile the supported C11 interface without C++ compatibility extensions. */
cv_status c_header_check(const uint8_t *data, size_t size)
{
	cv_workspace *workspace = NULL;
	cv_error error = {0};
	cv_status status = cv_workspace_load(data, size, &workspace, &error);

	cv_workspace_destroy(workspace);
	return status;
}
