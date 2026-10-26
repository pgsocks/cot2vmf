cmake_minimum_required(VERSION 3.24)
project(cot2vmf VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)
option(BUILD_UNIT_TESTS "Build GoogleTest unit tests" ON)
option(BUILD_ACCEPTANCE_TESTS "Build Cucumber acceptance tests" OFF)
option(COT_VMF_ENABLE_WEB "Build the embedded browser interface" ON)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
	message(FATAL_ERROR "The service currently supports Linux")
endif()

if(BUILD_TESTING AND BUILD_ACCEPTANCE_TESTS)
	include(cmake/AcceptancePrerequisites.cmake)
endif()
add_subdirectory(cmake/dependencies)

add_subdirectory(src)
install(DIRECTORY "${PROJECT_BINARY_DIR}/licenses/"
	DESTINATION "${CMAKE_INSTALL_DATADIR}/cot-to-vmf/licenses")

configure_package_config_file(cmake/cot2vmf-config.cmake.in
	"${PROJECT_BINARY_DIR}/cot2vmf-config.cmake"
	INSTALL_DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/cot2vmf")
install(FILES "${PROJECT_BINARY_DIR}/cot2vmf-config.cmake"
	DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/cot2vmf")
install(EXPORT cot2vmf-targets NAMESPACE cot2vmf::
	DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/cot2vmf")

if(BUILD_TESTING AND (BUILD_UNIT_TESTS OR BUILD_ACCEPTANCE_TESTS))
	add_subdirectory(tests)
endif()
