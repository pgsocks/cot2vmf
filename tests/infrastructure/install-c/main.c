#include <cot2vmf/core.h>

int main(void)
{
	const char json[] = "{\"format\":\"cot-vmf-workspace/1\","
		"\"schemas\":[],\"outputs\":[]}";
	const char xml[] =
		"<event version=\"2.0\" uid=\"install\" type=\"a-f-G\" "
		"time=\"2026-01-01T00:00:00Z\" start=\"2026-01-01T00:00:00Z\" "
		"stale=\"2026-01-01T00:01:00Z\" how=\"m-g\">"
		"<point lat=\"0\" lon=\"0\" hae=\"0\" ce=\"0\" le=\"0\"/>"
		"<detail/></event>";
	cv_workspace *workspace = NULL;
	cv_error error;
	cv_activity activity;
	cv_status status = cv_workspace_load((const uint8_t *)json,
		sizeof(json) - 1, &workspace, &error);

	if (status == CV_OK)
		status = cv_process(workspace, (const uint8_t *)xml,
			sizeof(xml) - 1, NULL, NULL, &activity, &error);
	cv_workspace_destroy(workspace);
	return status != CV_OK;
}
