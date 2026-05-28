if(NOT DEFINED BUNDLE_DIR OR BUNDLE_DIR STREQUAL "")
    message(FATAL_ERROR "BUNDLE_DIR was not provided")
endif()

if(NOT DEFINED EXECUTABLE_NAME OR EXECUTABLE_NAME STREQUAL "")
    message(FATAL_ERROR "EXECUTABLE_NAME was not provided")
endif()

set(contents_dir "${BUNDLE_DIR}/Contents")
set(info_plist "${contents_dir}/Info.plist")
set(pkg_info "${contents_dir}/PkgInfo")
set(bundle_binary "${contents_dir}/MacOS/${EXECUTABLE_NAME}")

if(NOT IS_DIRECTORY "${BUNDLE_DIR}")
    message(FATAL_ERROR "Expected macOS plugin bundle directory does not exist: ${BUNDLE_DIR}")
endif()

if(NOT EXISTS "${info_plist}")
    message(FATAL_ERROR "Expected bundle Info.plist is missing: ${info_plist}")
endif()

if(NOT EXISTS "${pkg_info}")
    message(FATAL_ERROR "Expected bundle PkgInfo is missing: ${pkg_info}")
endif()

if(NOT EXISTS "${bundle_binary}")
    message(FATAL_ERROR "Expected bundle executable is missing: ${bundle_binary}")
endif()

message(STATUS "Verified macOS plugin bundle: ${BUNDLE_DIR}")
