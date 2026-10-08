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

foreach(f "${NOVA_VST3_SDK_DIR}/pluginterfaces/base/funknown.h"
          "${NOVA_VST3_SDK_DIR}/public.sdk/source/vst/hosting/module.h"
          "${NOVA_ARA_SDK_DIR}/ARA_API/ARAInterface.h"
          "${NOVA_ARA_SDK_DIR}/ARA_Library/Dispatch/ARAHostDispatch.cpp")
    if(NOT EXISTS "${f}")
        message(FATAL_ERROR "Source introuvable : ${f} (voir build.bat pour les télécharger)")
    endif()
endforeach()

set(VST3 "${NOVA_VST3_SDK_DIR}")
set(ARA "${NOVA_ARA_SDK_DIR}")

# Sous-ensemble « hébergement » du SDK VST3 (le même que la cible sdk_hosting de Steinberg).
add_library(nova_vst3_hosting STATIC
    "${VST3}/pluginterfaces/base/coreiids.cpp"
    "${VST3}/pluginterfaces/base/funknown.cpp"
    "${VST3}/pluginterfaces/base/ustring.cpp"
    "${VST3}/pluginterfaces/base/conststringtable.cpp"
    "${VST3}/public.sdk/source/common/commoniids.cpp"
    "${VST3}/public.sdk/source/common/commonstringconvert.cpp"
    "${VST3}/public.sdk/source/common/memorystream.cpp"
    "${VST3}/public.sdk/source/common/threadchecker_win32.cpp"
    "${VST3}/public.sdk/source/vst/hosting/connectionproxy.cpp"
    "${VST3}/public.sdk/source/vst/hosting/eventlist.cpp"
    "${VST3}/public.sdk/source/vst/hosting/hostclasses.cpp"
    "${VST3}/public.sdk/source/vst/hosting/module.cpp"
    "${VST3}/public.sdk/source/vst/hosting/module_win32.cpp"
    "${VST3}/public.sdk/source/vst/hosting/parameterchanges.cpp"
    "${VST3}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp"
    "${VST3}/public.sdk/source/vst/utility/stringconvert.cpp"
    "${VST3}/public.sdk/source/vst/vstinitiids.cpp")
target_include_directories(nova_vst3_hosting PUBLIC "${VST3}")
target_compile_definitions(nova_vst3_hosting PUBLIC
    $<IF:$<CONFIG:Debug>,DEVELOPMENT=1,RELEASE=1> UNICODE _UNICODE NOMINMAX=1 _CRT_SECURE_NO_WARNINGS)
target_compile_options(nova_vst3_hosting PRIVATE /W1 /utf-8)

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
    Source/EditorWindow.cpp
    Source/WasapiOutput.cpp
    Source/NovaARAHost.rc)
target_compile_options(NovaARAHost PRIVATE /W3 /utf-8 /permissive-)
target_link_libraries(NovaARAHost PRIVATE nova_vst3_hosting nova_ara_host
    ole32 oleaut32 uuid user32 gdi32 shell32 windowscodecs avrt)
set_target_properties(NovaARAHost PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/NovaARAHost_artefacts/$<CONFIG>")
