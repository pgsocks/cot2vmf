#include <cot2vmf/core.hpp>

int main()
{
	const char json[] = "{\"format\":\"cot-vmf-workspace/1\","
		"\"schemas\":[],\"outputs\":[]}";
	cot2vmf::workspace *workspace = nullptr;
	cot2vmf::error error = {};
	cot2vmf::status status = cot2vmf::cv_workspace_load(
		reinterpret_cast<const uint8_t *>(json), sizeof(json) - 1,
		&workspace, &error);

	cot2vmf::cv_workspace_destroy(workspace);
	return status != CV_OK;
}
