# Code commun des hôtes natifs de Nova Studio (NovaARAHost, NovaVSTHost), SANS JUCE.
#
# Définit :
#   NOVA_COMMON_DIR        ce dossier (Json.h, Common.h, EditorWindow.*)
#   nova_vst3_hosting      bibliothèque statique : sous-ensemble « hébergement » du SDK VST3
#                          de Steinberg (licence MIT), le même que la cible sdk_hosting du SDK.
#   NOVA_EDITOR_SOURCES    sources de la fenêtre Win32 des plugins (à ajouter à l'exécutable)
#
# Variable attendue : NOVA_VST3_SDK_DIR (dossier contenant pluginterfaces, base, public.sdk).
# Fichiers du SDK compilés tels quels, jamais copiés dans le dépôt.

set(NOVA_COMMON_DIR "${CMAKE_CURRENT_LIST_DIR}")

foreach(f "${NOVA_VST3_SDK_DIR}/pluginterfaces/base/funknown.h"
          "${NOVA_VST3_SDK_DIR}/public.sdk/source/vst/hosting/module.h")
    if(NOT EXISTS "${f}")
        message(FATAL_ERROR "Source introuvable : ${f} (voir build.bat pour télécharger le SDK VST3)")
    endif()
endforeach()

if(NOT TARGET nova_vst3_hosting)
    set(_V "${NOVA_VST3_SDK_DIR}")
    add_library(nova_vst3_hosting STATIC
        "${_V}/pluginterfaces/base/coreiids.cpp"
        "${_V}/pluginterfaces/base/funknown.cpp"
        "${_V}/pluginterfaces/base/ustring.cpp"
        "${_V}/pluginterfaces/base/conststringtable.cpp"
        "${_V}/public.sdk/source/common/commoniids.cpp"
        "${_V}/public.sdk/source/common/commonstringconvert.cpp"
        "${_V}/public.sdk/source/common/memorystream.cpp"
        "${_V}/public.sdk/source/common/threadchecker_win32.cpp"
        "${_V}/public.sdk/source/vst/hosting/connectionproxy.cpp"
        "${_V}/public.sdk/source/vst/hosting/eventlist.cpp"
        "${_V}/public.sdk/source/vst/hosting/hostclasses.cpp"
        "${_V}/public.sdk/source/vst/hosting/module.cpp"
        "${_V}/public.sdk/source/vst/hosting/module_win32.cpp"
        "${_V}/public.sdk/source/vst/hosting/parameterchanges.cpp"
        "${_V}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp"
        "${_V}/public.sdk/source/vst/utility/stringconvert.cpp"
        "${_V}/public.sdk/source/vst/vstinitiids.cpp")
    target_include_directories(nova_vst3_hosting PUBLIC "${_V}")
    target_compile_definitions(nova_vst3_hosting PUBLIC
        $<IF:$<CONFIG:Debug>,DEVELOPMENT=1,RELEASE=1> UNICODE _UNICODE NOMINMAX=1 _CRT_SECURE_NO_WARNINGS)
    target_compile_options(nova_vst3_hosting PRIVATE /W1 /utf-8)
endif()

set(NOVA_EDITOR_SOURCES "${NOVA_COMMON_DIR}/EditorWindow.cpp")
