# NovaARAHost : petit hôte ARA2 (Melodyne, VocAlign…) piloté par le pont Python de Nova Studio.
# Sources externes (téléchargées depuis leurs dépôts officiels, jamais de binaires tiers) :
#   JUCE    https://github.com/juce-framework/JUCE   (utilisé sous AGPLv3, voir LICENCES.md)
#   ARA SDK https://github.com/Celemony/ARA_SDK       (Apache 2.0)
# Chemins par défaut : D:/1 WORK/CODE/_libs/ara-host-sources/{JUCE,ARA_SDK}
#   (à changer avec -DNOVA_JUCE_DIR=... -DNOVA_ARA_SDK_DIR=...)
cmake_minimum_required(VERSION 3.22)
project(NovaARAHost VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(NOVA_LIBS "D:/1 WORK/CODE/_libs/ara-host-sources" CACHE PATH "Dossier des sources JUCE + ARA SDK")
set(NOVA_JUCE_DIR "${NOVA_LIBS}/JUCE" CACHE PATH "Sources JUCE")
set(NOVA_ARA_SDK_DIR "${NOVA_LIBS}/ARA_SDK" CACHE PATH "ARA SDK (dossier contenant ARA_API et ARA_Library)")

add_subdirectory("${NOVA_JUCE_DIR}" juce EXCLUDE_FROM_ALL)
juce_set_ara_sdk_path("${NOVA_ARA_SDK_DIR}")

juce_add_gui_app(NovaARAHost
    PRODUCT_NAME "NovaARAHost"
    COMPANY_NAME "Make Music"
    BUNDLE_ID com.makemusic.nova.arahost
    NEEDS_WEB_BROWSER FALSE
    NEEDS_CURL FALSE)

juce_generate_juce_header(NovaARAHost)
target_sources(NovaARAHost PRIVATE Source/Main.cpp)

target_compile_definitions(NovaARAHost PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_AU=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_PLUGINHOST_LV2=0
    JUCE_PLUGINHOST_ARA=1
    JUCE_USE_CURL=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_WEB_BROWSER=0
    JUCE_WASAPI=1
    JUCE_ASIO=0
    JUCE_DIRECTSOUND=0
    JUCE_USE_FLAC=0
    JUCE_USE_OGGVORBIS=0
    JUCE_USE_MP3AUDIOFORMAT=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:NovaARAHost,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:NovaARAHost,JUCE_VERSION>")

target_link_libraries(NovaARAHost
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_audio_formats
        juce::juce_audio_devices
        juce::juce_gui_basics
        juce_ara_sdk
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
