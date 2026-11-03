add_executable(unit_tests main.cpp core.cpp catalog.cpp)
target_link_libraries(unit_tests PRIVATE GTest::gtest cot2vmf)
add_library(c_header_check OBJECT c_header.c)
target_link_libraries(c_header_check PRIVATE cot2vmf)

include(register.cmake)
