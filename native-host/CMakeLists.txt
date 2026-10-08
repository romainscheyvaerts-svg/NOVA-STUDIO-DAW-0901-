# NovaVSTHost : hôte VST3 natif de Nova Studio (remplace pedalboard dans le pont VST).
# SANS JUCE. Source externe (dépôt officiel GitHub, jamais de binaire tiers) :
#   VST3 SDK https://github.com/steinbergmedia/vst3sdk  (v3.8.1_build_84, licence MIT)
#            sous-modules utilisés : base, pluginterfaces, public.sdk
# Chemin par défaut : D:/1 WORK/CODE/_libs/ara-host-sources/vst3sdk (-DNOVA_VST3_SDK_DIR=... pour changer)
# Code partagé avec l'hôte ARA : ../native-common.
cmake_minimum_required(VERSION 3.22)
project(NovaVSTHost VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# CRT statique : l'exe ne dépend que de DLL de Windows (rien à installer à côté).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(NOVA_LIBS "D:/1 WORK/CODE/_libs/ara-host-sources" CACHE PATH "Dossier des sources du SDK VST3")
set(NOVA_VST3_SDK_DIR "${NOVA_LIBS}/vst3sdk" CACHE PATH "VST3 SDK (dossier contenant pluginterfaces, base, public.sdk)")

include("${CMAKE_CURRENT_SOURCE_DIR}/../native-common/vst3_hosting.cmake")

add_executable(NovaVSTHost WIN32
    Source/Main.cpp
    Source/VstInstance.cpp
    Source/Guard.cpp
    ${NOVA_EDITOR_SOURCES}
    Source/NovaVSTHost.rc)
target_include_directories(NovaVSTHost PRIVATE "${NOVA_COMMON_DIR}" Source)
# /EHsc : exceptions C++ ; les plantages des plugins (SEH) sont arrêtés par Guard.cpp.
target_compile_options(NovaVSTHost PRIVATE /W3 /utf-8 /permissive- /EHsc)
target_link_libraries(NovaVSTHost PRIVATE nova_vst3_hosting
    ole32 oleaut32 uuid user32 gdi32 shell32 avrt)
set_target_properties(NovaVSTHost PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/NovaVSTHost_artefacts/$<CONFIG>")
