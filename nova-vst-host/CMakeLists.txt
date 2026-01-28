cmake_minimum_required(VERSION 3.21)

project(NovaVSTHost VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find JUCE
add_subdirectory(JUCE)

# Define the plugin host application
juce_add_gui_app(NovaVSTHost
    PRODUCT_NAME "Nova VST Host"
    COMPANY_NAME "Nova Studio"
    BUNDLE_ID com.novastudio.vsthost
)

# Add source files
target_sources(NovaVSTHost PRIVATE
    Source/Main.cpp
    Source/MainComponent.cpp
    Source/PluginManager.cpp
    Source/WebSocketServer.cpp
    Source/UICapture.cpp
)

# Generate JuceHeader.h
juce_generate_juce_header(NovaVSTHost)

# Link JUCE modules
target_link_libraries(NovaVSTHost PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_cryptography
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
    juce::juce_opengl
)

# Define JUCE project settings
target_compile_definitions(NovaVSTHost PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_AU=0
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_MODAL_LOOPS_PERMITTED=1
)

# Enable VST3 hosting
if(WIN32)
    target_compile_definitions(NovaVSTHost PRIVATE
        JUCE_VST3_CAN_REPLACE_VST2=0
    )
endif()
