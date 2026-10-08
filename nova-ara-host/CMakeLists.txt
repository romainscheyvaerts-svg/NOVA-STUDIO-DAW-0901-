# NovaARAHost : petit hôte ARA2 (Melodyne, VocAlign…) piloté par le pont Python de Nova Studio.
# SANS JUCE. Sources externes (dépôts officiels GitHub, jamais de binaires tiers) :
#   VST3 SDK https://github.com/steinbergmedia/vst3sdk  (v3.8.1_build_84, licence MIT)
#            sous-modules utilisés : base, pluginterfaces, public.sdk
#   ARA SDK  https://github.com/Celemony/ARA_SDK         (2.3, Apache 2.0) : ARA_API + ARA_Library
# Chemins par défaut : D:/1 WORK/CODE/_libs/ara-host-sources/{vst3sdk,ARA_SDK}
#   (à changer avec -DNOVA_VST3_SDK_DIR=... -DNOVA_ARA_SDK_DIR=...)
cmake_minimum_required(VERSION 3.22)
project(NovaARAHost VERSION 2.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# CRT statique : l'exe ne dépend que de DLL de Windows (rien à installer à côté).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(NOVA_LIBS "D:/1 WORK/CODE/_libs/ara-host-sources" CACHE PATH "Dossier des sources VST3 SDK + ARA SDK")
set(NOVA_VST3_SDK_DIR "${NOVA_LIBS}/vst3sdk" CACHE PATH "VST3 SDK (dossier contenant pluginterfaces, base, public.sdk)")
set(NOVA_ARA_SDK_DIR "${NOVA_LIBS}/ARA_SDK" CACHE PATH "ARA SDK (dossier contenant ARA_API et ARA_Library)")

foreach(f "${NOVA_ARA_SDK_DIR}/ARA_API/ARAInterface.h"
          "${NOVA_ARA_SDK_DIR}/ARA_Library/Dispatch/ARAHostDispatch.cpp")
    if(NOT EXISTS "${f}")
        message(FATAL_ERROR "Source introuvable : ${f} (voir build.bat pour les télécharger)")
    endif()
endforeach()

set(ARA "${NOVA_ARA_SDK_DIR}")

# Code commun des hôtes natifs (JSON, sortie, fenêtre du plugin) + sous-ensemble « hébergement »
# du SDK VST3 (cible nova_vst3_hosting), partagés avec NovaVSTHost : ../native-common.
include("${CMAKE_CURRENT_SOURCE_DIR}/../native-common/vst3_hosting.cmake")

# Bibliothèque hôte ARA (ARA_Library/Dispatch).
add_library(nova_ara_host STATIC
    "${ARA}/ARA_Library/Debug/ARADebug.c"
    "${ARA}/ARA_Library/Dispatch/ARAHostDispatch.cpp")
target_include_directories(nova_ara_host PUBLIC "${ARA}")
target_compile_definitions(nova_ara_host PUBLIC NOMINMAX=1 $<$<NOT:$<CONFIG:Debug>>:NDEBUG>)
target_compile_options(nova_ara_host PRIVATE /W1 /utf-8)

add_executable(NovaARAHost WIN32
    Source/Main.cpp
    Source/Vst3Plugin.cpp
    ${NOVA_EDITOR_SOURCES}
    Source/DockedEditor.cpp
    Source/AudioPipe.cpp
    Source/WasapiOutput.cpp
    Source/NovaARAHost.rc)
target_include_directories(NovaARAHost PRIVATE "${NOVA_COMMON_DIR}")
target_compile_options(NovaARAHost PRIVATE /W3 /utf-8 /permissive-)
target_link_libraries(NovaARAHost PRIVATE nova_vst3_hosting nova_ara_host
    ole32 oleaut32 uuid user32 gdi32 shell32 windowscodecs avrt)
set_target_properties(NovaARAHost PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/NovaARAHost_artefacts/$<CONFIG>")
