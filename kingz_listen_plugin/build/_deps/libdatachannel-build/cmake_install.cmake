# Install script for directory: /Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src

# Set the install prefix
if(NOT DEFINED CMAKE_INSTALL_PREFIX)
  set(CMAKE_INSTALL_PREFIX "/usr/local")
endif()
string(REGEX REPLACE "/$" "" CMAKE_INSTALL_PREFIX "${CMAKE_INSTALL_PREFIX}")

# Set the install configuration name.
if(NOT DEFINED CMAKE_INSTALL_CONFIG_NAME)
  if(BUILD_TYPE)
    string(REGEX REPLACE "^[^A-Za-z0-9_]+" ""
           CMAKE_INSTALL_CONFIG_NAME "${BUILD_TYPE}")
  else()
    set(CMAKE_INSTALL_CONFIG_NAME "")
  endif()
  message(STATUS "Install configuration: \"${CMAKE_INSTALL_CONFIG_NAME}\"")
endif()

# Set the component getting installed.
if(NOT CMAKE_INSTALL_COMPONENT)
  if(COMPONENT)
    message(STATUS "Install component: \"${COMPONENT}\"")
    set(CMAKE_INSTALL_COMPONENT "${COMPONENT}")
  else()
    set(CMAKE_INSTALL_COMPONENT)
  endif()
endif()

# Is this installation the result of a crosscompile?
if(NOT DEFINED CMAKE_CROSSCOMPILING)
  set(CMAKE_CROSSCOMPILING "FALSE")
endif()

# Set path to fallback-tool for dependency-resolution.
if(NOT DEFINED CMAKE_OBJDUMP)
  set(CMAKE_OBJDUMP "/usr/bin/objdump")
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib" TYPE STATIC_LIBRARY FILES "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/deps/usrsctp/usrsctplib/libusrsctp.a")
  if(EXISTS "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libusrsctp.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libusrsctp.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libusrsctp.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib" TYPE STATIC_LIBRARY FILES "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/deps/libsrtp/libsrtp2.a")
  if(EXISTS "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libsrtp2.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libsrtp2.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libsrtp2.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib" TYPE STATIC_LIBRARY FILES "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/deps/libjuice/libjuice.a")
  if(EXISTS "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libjuice.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libjuice.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libjuice.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib" TYPE STATIC_LIBRARY FILES "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/libdatachannel.a")
  if(EXISTS "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libdatachannel.a" AND
     NOT IS_SYMLINK "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libdatachannel.a")
    execute_process(COMMAND "/usr/bin/ranlib" "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/libdatachannel.a")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/include/rtc" TYPE FILE FILES
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/candidate.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/channel.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/configuration.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/datachannel.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/dependencydescriptor.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/description.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/iceudpmuxlistener.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/mediahandler.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtcpreceivingsession.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/common.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/global.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/message.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/frameinfo.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/peerconnection.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/reliability.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtc.h"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtc.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtp.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/track.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/websocket.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/websocketserver.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtppacketizationconfig.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtcpsrreporter.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtppacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtpdepacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/h264rtppacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/h264rtpdepacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/nalunit.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/h265rtppacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/h265rtpdepacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/h265nalunit.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/av1rtppacketizer.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rtcpnackresponder.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/utils.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/plihandler.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/pacinghandler.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/rembhandler.hpp"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-src/include/rtc/version.h"
    )
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  if(EXISTS "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel/LibDataChannelTargets.cmake")
    file(DIFFERENT _cmake_export_file_changed FILES
         "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel/LibDataChannelTargets.cmake"
         "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/CMakeFiles/Export/32c821eb1e7b36c3a3818aec162f7fd2/LibDataChannelTargets.cmake")
    if(_cmake_export_file_changed)
      file(GLOB _cmake_old_config_files "$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel/LibDataChannelTargets-*.cmake")
      if(_cmake_old_config_files)
        string(REPLACE ";" ", " _cmake_old_config_files_text "${_cmake_old_config_files}")
        message(STATUS "Old export file \"$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel/LibDataChannelTargets.cmake\" will be replaced.  Removing files [${_cmake_old_config_files_text}].")
        unset(_cmake_old_config_files_text)
        file(REMOVE ${_cmake_old_config_files})
      endif()
      unset(_cmake_old_config_files)
    endif()
    unset(_cmake_export_file_changed)
  endif()
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel" TYPE FILE FILES "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/CMakeFiles/Export/32c821eb1e7b36c3a3818aec162f7fd2/LibDataChannelTargets.cmake")
  if(CMAKE_INSTALL_CONFIG_NAME MATCHES "^()$")
    file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel" TYPE FILE FILES "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/CMakeFiles/Export/32c821eb1e7b36c3a3818aec162f7fd2/LibDataChannelTargets-noconfig.cmake")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib/cmake/LibDataChannel" TYPE FILE FILES
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/LibDataChannelConfig.cmake"
    "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/LibDataChannelConfigVersion.cmake"
    )
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for each subdirectory.

endif()

string(REPLACE ";" "\n" CMAKE_INSTALL_MANIFEST_CONTENT
       "${CMAKE_INSTALL_MANIFEST_FILES}")
if(CMAKE_INSTALL_LOCAL_ONLY)
  file(WRITE "/Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/build/_deps/libdatachannel-build/install_local_manifest.txt"
     "${CMAKE_INSTALL_MANIFEST_CONTENT}")
endif()
