# The upstream cucumber-cpp library supplies the native wire-server main.
add_executable(acceptance_steps steps.cpp)
target_link_libraries(acceptance_steps PRIVATE cucumber-cpp GTest::gtest)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
target_compile_definitions(acceptance_steps PRIVATE
	CV_PYTHON="${Python3_EXECUTABLE}"
	CV_PROBE="${PROJECT_SOURCE_DIR}/tests/service/probe.py"
	CV_BINARY="$<TARGET_FILE:cot-to-vmf>")
add_dependencies(acceptance_steps cot-to-vmf)
set(acceptance_arguments)
if(NOT COT_VMF_ENABLE_WEB)
	list(APPEND acceptance_arguments --tags "not @web")
endif()

add_test(NAME acceptance
	COMMAND "${RUBY_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/run.rb"
		$<TARGET_FILE:acceptance_steps> ${acceptance_arguments}
)
set_tests_properties(acceptance PROPERTIES
	LABELS acceptance
	WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
)
