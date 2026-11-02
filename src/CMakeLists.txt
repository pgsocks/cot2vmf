find_package(Threads REQUIRED)
add_library(cot2vmf STATIC core/core.cpp core/config.cpp core/values.cpp
	core/walker.cpp core/support.cpp core/cot_adapter.cpp core/catalog.cpp)
add_library(cot2vmf::cot2vmf ALIAS cot2vmf)
target_include_directories(cot2vmf PUBLIC
	"$<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/include>"
	"$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
target_link_libraries(cot2vmf PUBLIC cot::cot vmf::vmf vmf::schema_json
	vmf::header_json yyjson)

add_executable(cot-to-vmf main.cpp service.cpp workspace_store.cpp
	workspace_cli.cpp)
target_link_libraries(cot-to-vmf PRIVATE cot2vmf Threads::Threads)
target_compile_definitions(cot-to-vmf PRIVATE
	COT_VMF_VERSION="${PROJECT_VERSION}")
if(COT_VMF_ENABLE_WEB)
	foreach(asset HTML CSS JS)
		if(asset STREQUAL "HTML")
			set(asset_file index.html)
		elseif(asset STREQUAL "CSS")
			set(asset_file app.css)
		else()
			set(asset_file app.js)
		endif()
		file(READ "${CMAKE_CURRENT_SOURCE_DIR}/web/${asset_file}"
			WEB_${asset})
		set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
			"${CMAKE_CURRENT_SOURCE_DIR}/web/${asset_file}")
	endforeach()
	configure_file(web_assets.h.in web_assets.h @ONLY)
	target_sources(cot-to-vmf PRIVATE web_server.cpp)
	target_include_directories(cot-to-vmf PRIVATE
		"${CMAKE_CURRENT_BINARY_DIR}")
	target_link_libraries(cot-to-vmf PRIVATE civetweb-c-library)
	target_compile_definitions(cot-to-vmf PRIVATE COT_VMF_ENABLE_WEB=1)
endif()
foreach(target cot2vmf cot-to-vmf)
	target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic
		-Werror -fno-exceptions -fno-rtti)
endforeach()
install(TARGETS cot2vmf EXPORT cot2vmf-targets
	ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}")
install(TARGETS cot-to-vmf RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
install(DIRECTORY "${PROJECT_SOURCE_DIR}/include/cot2vmf"
	DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
