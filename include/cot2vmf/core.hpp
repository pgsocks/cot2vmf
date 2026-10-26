#ifndef COT2VMF_CORE_HPP_INCLUDED
#define COT2VMF_CORE_HPP_INCLUDED

#include <cot2vmf/core.h>

/* Procedural C++17 spelling of the C ownership/status contract. */
namespace cot2vmf
{
using status = cv_status;
using error = cv_error;
using workspace = cv_workspace;
using buffer = cv_buffer;
using activity = cv_activity;
using output_callback = cv_output_callback;
using ::cv_buffer_destroy;
using ::cv_catalog;
using ::cv_process;
using ::cv_workspace_destroy;
using ::cv_workspace_load;
} // namespace cot2vmf
#endif
