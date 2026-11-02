#include <gtest/gtest.h>
#include <cucumber-cpp/autodetect.hpp>
#include <cstdlib>
#include <string>

static int workflow_status;

WHEN("^the \"(monitor|translation|editing|publication|persistence-size|"
	"revisions|authorities|large-lookup|feedback|entrypoint|"
	"entrypoint-arguments|configuration)\" "
	"service workflow is exercised$")
{
	REGEX_PARAM(std::string, workflow);
	std::string command = "\"" CV_PYTHON "\" \"" CV_PROBE "\" \"";

	command += CV_BINARY;
	command += "\" " + workflow;
	workflow_status = std::system(command.c_str());
}

THEN("^all service assertions succeed$")
{
	ASSERT_EQ(workflow_status, 0);
}
