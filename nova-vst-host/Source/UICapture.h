/*
    Nova VST Host - UI Capture Module
    Captures plugin UI as JPEG frames for streaming to web DAW
*/

#pragma once

#include <JuceHeader.h>
#include <functional>

class UICapture
{
public:
    UICapture();
    ~UICapture();

    // Initialize capture for a plugin editor
    void setEditor(juce::AudioProcessorEditor* editor);
    
    // Capture current frame as base64 JPEG
    juce::String captureFrame(int quality = 75);
    
    // Check if an editor is attached
    bool hasEditor() const { return currentEditor != nullptr; }
    
    // Get editor size
    juce::Rectangle<int> getEditorBounds() const;

private:
    juce::AudioProcessorEditor* currentEditor = nullptr;
    juce::Image captureBuffer;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(UICapture)
};
