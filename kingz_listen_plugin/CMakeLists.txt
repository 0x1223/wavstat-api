cmake_minimum_required(VERSION 3.22)

project(KingzListenPlugin VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(JUCE CONFIG QUIET)

if(NOT TARGET juce::juce_audio_processors)
    include(FetchContent)
    FetchContent_Declare(
        JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.7
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(JUCE)
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build dependencies as static libraries" FORCE)
set(NO_EXAMPLES ON CACHE BOOL "Disable libdatachannel examples" FORCE)
set(NO_TESTS ON CACHE BOOL "Disable libdatachannel tests" FORCE)
set(NO_MEDIA OFF CACHE BOOL "Enable libdatachannel media transport" FORCE)
set(USE_GNUTLS OFF CACHE BOOL "Prefer OpenSSL/MbedTLS over GnuTLS for plugin builds" FORCE)
set(USE_NICE OFF CACHE BOOL "Use libjuice ICE backend for lighter static builds" FORCE)

include(FetchContent)
FetchContent_Declare(
    libdatachannel
    GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
    GIT_TAG v0.24.3
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(libdatachannel)

juce_add_plugin(KingzListenPlugin
    COMPANY_NAME "Kingzbreadent"
    PLUGIN_NAME "Kingz Listen"
    PLUGIN_MANUFACTURER_CODE KbEn
    PLUGIN_CODE KzLi
    FORMATS VST3 AU
    PRODUCT_NAME "Kingz Listen"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    COPY_PLUGIN_AFTER_BUILD TRUE
)

target_sources(KingzListenPlugin
    PRIVATE
        Source/AudioFifoWorker.h
        Source/NetworkTransmitter.h
        Source/NetworkTransmitter.cpp
        Source/WebSocketManager.h
        Source/PluginEditor.h
        Source/PluginEditor.cpp
        Source/PluginProcessor.h
        Source/PluginProcessor.cpp
)

if(WIN32)
    target_link_libraries(KingzListenPlugin PRIVATE ws2_32 iphlpapi)
endif()

target_compile_definitions(KingzListenPlugin
    PUBLIC
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2=1
        JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(KingzListenPlugin
    PRIVATE
        juce::juce_audio_processors
        juce::juce_audio_utils
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
)

if(TARGET LibDataChannel::LibDataChannelStatic)
    target_link_libraries(KingzListenPlugin PRIVATE LibDataChannel::LibDataChannelStatic)
elseif(TARGET datachannel-static)
    target_link_libraries(KingzListenPlugin PRIVATE datachannel-static)
elseif(TARGET datachannel)
    target_link_libraries(KingzListenPlugin PRIVATE datachannel)
else()
    message(FATAL_ERROR "libdatachannel target was not generated")
endif()
