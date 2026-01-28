/*
  ==============================================================================
    Nova VST Host - Main Component Header
  ==============================================================================
*/

#pragma once

#include <JuceHeader.h>
#include "PluginManager.h"
#include "WebSocketServer.h"

class MainComponent : public juce::Component,
                      public juce::Timer,
                      public WebSocketServer::Listener
{
public:
    MainComponent();
    ~MainComponent() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    
    // Timer callback for UI capture
    void timerCallback() override;
    
    // WebSocket message handler
    void onMessageReceived(const juce::String& clientId, const juce::var& message) override;
    void onClientConnected(const juce::String& clientId) override;
    void onClientDisconnected(const juce::String& clientId) override;

private:
    std::unique_ptr<PluginManager> pluginManager;
    std::unique_ptr<WebSocketServer> webSocketServer;
    
    juce::Label statusLabel;
    juce::TextEditor logView;
    
    void log(const juce::String& message);
    void handleLoadPlugin(const juce::String& clientId, const juce::var& data);
    void handleUnloadPlugin(const juce::String& clientId, const juce::var& data);
    void handleProcessAudio(const juce::String& clientId, const juce::var& data);
    void handleSetParam(const juce::String& clientId, const juce::var& data);
    void handleMouseEvent(const juce::String& clientId, const juce::var& data, const juce::String& type);
    void sendPluginList(const juce::String& clientId);
    void captureAndSendUI();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
