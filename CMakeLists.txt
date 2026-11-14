cmake_minimum_required(VERSION 3.16)
project(entrance_map C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_executable(entrance_map
    src/main.c
    src/map.c
    src/draw.c
    src/assets.c
)

target_include_directories(entrance_map PRIVATE
    vendor/sokol
    vendor/fontstash
    vendor/stb
)

target_compile_definitions(entrance_map PRIVATE
    SOKOL_GLCORE
    MAP_ASSET_DIR="${CMAKE_CURRENT_SOURCE_DIR}/assets"
)

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(entrance_map PRIVATE -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -Wno-sign-compare)
endif()

find_package(Threads REQUIRED)
find_package(OpenGL REQUIRED)
find_package(X11 REQUIRED)

target_link_libraries(entrance_map PRIVATE
    Threads::Threads
    OpenGL::GL
    X11::X11
    ${X11_Xi_LIB}
    ${X11_Xcursor_LIB}
    dl
    m
)

add_custom_command(TARGET entrance_map POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/assets"
        "$<TARGET_FILE_DIR:entrance_map>/assets"
)
