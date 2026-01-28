/*
    Nova VST Host - UI Capture Module
    Captures plugin UI as JPEG frames for streaming to web DAW
*/

#include "UICapture.h"

UICapture::UICapture()
{
}

UICapture::~UICapture()
{
    currentEditor = nullptr;
}

void UICapture::setEditor(juce::AudioProcessorEditor* editor)
{
    currentEditor = editor;
    
    if (editor != nullptr)
    {
        // Pre-allocate capture buffer
        auto bounds = editor->getBounds();
        captureBuffer = juce::Image(juce::Image::RGB, 
                                     bounds.getWidth(), 
                                     bounds.getHeight(), 
                                     true);
    }
}

juce::String UICapture::captureFrame(int quality)
{
    if (currentEditor == nullptr)
        return {};

    auto bounds = currentEditor->getBounds();
    
    // Resize buffer if needed
    if (captureBuffer.getWidth() != bounds.getWidth() ||
        captureBuffer.getHeight() != bounds.getHeight())
    {
        captureBuffer = juce::Image(juce::Image::RGB,
                                     bounds.getWidth(),
                                     bounds.getHeight(),
                                     true);
    }

    // Render editor to image
    juce::Graphics g(captureBuffer);
    g.fillAll(juce::Colours::black);
    
    // Paint the component
    currentEditor->paintEntireComponent(g, true);

    // Encode to JPEG
    juce::MemoryOutputStream memStream;
    juce::JPEGImageFormat jpegFormat;
    jpegFormat.setQuality((float)quality / 100.0f);
    
    if (jpegFormat.writeImageToStream(captureBuffer, memStream))
    {
        // Convert to Base64
        return juce::Base64::toBase64(memStream.getData(), memStream.getDataSize());
    }

    return {};
}

juce::Rectangle<int> UICapture::getEditorBounds() const
{
    if (currentEditor != nullptr)
        return currentEditor->getBounds();
    
    return {};
}
