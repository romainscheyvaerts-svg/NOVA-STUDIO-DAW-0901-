/*
  ==============================================================================
    Nova VST Host - Main Component Implementation
  ==============================================================================
*/

#include "MainComponent.h"
#include <thread>

MainComponent::MainComponent()
{
    // Initialize plugin manager
    pluginManager = std::make_unique<PluginManager>();
    
    // Setup UI first
    statusLabel.setText("Nova VST Host - Starting...", juce::dontSendNotification);
    statusLabel.setFont(juce::Font(14.0f, juce::Font::bold));
    addAndMakeVisible(statusLabel);
    
    logView.setMultiLine(true);
    logView.setReadOnly(true);
    logView.setCaretVisible(false);
    addAndMakeVisible(logView);
    
    setSize(400, 300);
    
    log("Nova VST Host started");
    
    // START WebSocket server FIRST (before scanning plugins)
    webSocketServer = std::make_unique<WebSocketServer>(8765);
    webSocketServer->addListener(this);
    webSocketServer->start();
    
    log("WebSocket server started on port 8765");
    statusLabel.setText("Nova VST Host - Listening on ws://localhost:8765 (scanning...)", juce::dontSendNotification);
    
    // Now scan plugins asynchronously (in background)
    log("Scanning VST3 plugins in background...");
    
    // Use async callback for plugin scanning
    std::thread([this]() {
        pluginManager->scanPlugins(nullptr);
        
        int pluginCount = pluginManager->getAvailablePlugins().size();
        
        juce::MessageManager::callAsync([this, pluginCount]() {
            log("Found " + juce::String(pluginCount) + " VST3 plugins");
            statusLabel.setText("Nova VST Host - Listening on ws://localhost:8765 (" + juce::String(pluginCount) + " plugins)", juce::dontSendNotification);
        });
    }).detach();
    
    // Start UI capture timer (30 FPS)
    startTimerHz(30);
}

MainComponent::~MainComponent()
{
    stopTimer();
    webSocketServer->stop();
}

void MainComponent::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour(0xff1a1a2e));
}

void MainComponent::resized()
{
    auto bounds = getLocalBounds().reduced(10);
    statusLabel.setBounds(bounds.removeFromTop(30));
    logView.setBounds(bounds);
}

void MainComponent::timerCallback()
{
    captureAndSendUI();
}

void MainComponent::log(const juce::String& message)
{
    auto time = juce::Time::getCurrentTime().toString(false, true);
    logView.moveCaretToEnd();
    logView.insertTextAtCaret("[" + time + "] " + message + "\n");
}

void MainComponent::onClientConnected(const juce::String& clientId)
{
    log("Client connected: " + clientId);
    
    // Automatically send the plugin list when a client connects
    juce::MessageManager::callAsync([this, clientId]() {
        sendPluginList(clientId);
        log("Plugin list sent to " + clientId + " (" + juce::String(pluginManager->getAvailablePlugins().size()) + " plugins)");
    });
}

void MainComponent::onClientDisconnected(const juce::String& clientId)
{
    log("Client disconnected: " + clientId);
    pluginManager->unloadAllForClient(clientId);
}

void MainComponent::onMessageReceived(const juce::String& clientId, const juce::var& message)
{
    auto action = message["action"].toString();
    
    if (action == "PING")
    {
        juce::DynamicObject::Ptr response = new juce::DynamicObject();
        response->setProperty("action", "PONG");
        response->setProperty("timestamp", juce::Time::currentTimeMillis());
        webSocketServer->send(clientId, juce::var(response.get()));
    }
    else if (action == "GET_PLUGIN_LIST")
    {
        sendPluginList(clientId);
    }
    else if (action == "LOAD_PLUGIN")
    {
        handleLoadPlugin(clientId, message);
    }
    else if (action == "UNLOAD_PLUGIN")
    {
        handleUnloadPlugin(clientId, message);
    }
    else if (action == "PROCESS_AUDIO")
    {
        handleProcessAudio(clientId, message);
    }
    else if (action == "SET_PARAM")
    {
        handleSetParam(clientId, message);
    }
    else if (action == "CLICK")
    {
        handleMouseEvent(clientId, message, "click");
    }
    else if (action == "DRAG")
    {
        handleMouseEvent(clientId, message, "drag");
    }
    else if (action == "SCROLL")
    {
        handleMouseEvent(clientId, message, "scroll");
    }
}

void MainComponent::sendPluginList(const juce::String& clientId)
{
    auto plugins = pluginManager->getAvailablePlugins();
    
    juce::Array<juce::var> pluginArray;
    for (int i = 0; i < plugins.size(); ++i)
    {
        auto& plugin = plugins[i];
        juce::DynamicObject::Ptr obj = new juce::DynamicObject();
        obj->setProperty("id", i);
        obj->setProperty("name", plugin.name);
        obj->setProperty("vendor", plugin.manufacturerName);
        obj->setProperty("category", plugin.category);
        obj->setProperty("path", plugin.fileOrIdentifier);
        pluginArray.add(juce::var(obj.get()));
    }
    
    juce::DynamicObject::Ptr response = new juce::DynamicObject();
    response->setProperty("action", "GET_PLUGIN_LIST");
    response->setProperty("plugins", pluginArray);
    
    webSocketServer->send(clientId, juce::var(response.get()));
}

void MainComponent::handleLoadPlugin(const juce::String& clientId, const juce::var& data)
{
    auto path = data["path"].toString();
    auto slotId = data["slot_id"].toString();
    auto sampleRate = (double)data["sample_rate"];
    
    if (sampleRate <= 0) sampleRate = 44100.0;
    
    log("Loading plugin: " + path + " (slot: " + slotId + ")");
    
    bool success = pluginManager->loadPlugin(clientId, slotId, path, sampleRate);
    
    juce::DynamicObject::Ptr response = new juce::DynamicObject();
    response->setProperty("action", "LOAD_PLUGIN");
    response->setProperty("success", success);
    response->setProperty("slot_id", slotId);
    
    if (success)
    {
        auto instance = pluginManager->getInstance(clientId, slotId);
        if (instance)
        {
            response->setProperty("name", instance->getName());
            
            // Get parameters
            juce::Array<juce::var> params;
            auto& processor = instance->getProcessor();
            for (int i = 0; i < processor.getNumParameters(); ++i)
            {
                juce::DynamicObject::Ptr param = new juce::DynamicObject();
                param->setProperty("name", processor.getParameterName(i));
                param->setProperty("value", processor.getParameter(i));
                param->setProperty("display_name", processor.getParameterName(i));
                params.add(juce::var(param.get()));
            }
            response->setProperty("parameters", params);
        }
        log("Plugin loaded: " + path);
    }
    else
    {
        response->setProperty("error", "Failed to load plugin");
        log("Failed to load plugin: " + path);
    }
    
    webSocketServer->send(clientId, juce::var(response.get()));
}

void MainComponent::handleUnloadPlugin(const juce::String& clientId, const juce::var& data)
{
    auto slotId = data["slot_id"].toString();
    
    pluginManager->unloadPlugin(clientId, slotId);
    
    juce::DynamicObject::Ptr response = new juce::DynamicObject();
    response->setProperty("action", "UNLOAD_PLUGIN");
    response->setProperty("success", true);
    response->setProperty("slot_id", slotId);
    
    webSocketServer->send(clientId, juce::var(response.get()));
    log("Plugin unloaded: " + slotId);
}

void MainComponent::handleProcessAudio(const juce::String& clientId, const juce::var& data)
{
    auto slotId = data["slot_id"].toString();
    auto channelsData = data["channels"];
    auto sampleRate = (double)data["sampleRate"];
    
    auto instance = pluginManager->getInstance(clientId, slotId);
    if (!instance || !channelsData.isArray())
    {
        // Return original audio
        juce::DynamicObject::Ptr response = new juce::DynamicObject();
        response->setProperty("action", "AUDIO_PROCESSED");
        response->setProperty("channels", channelsData);
        response->setProperty("slot_id", slotId);
        webSocketServer->send(clientId, juce::var(response.get()));
        return;
    }
    
    auto* channels = channelsData.getArray();
    int numChannels = channels->size();
    int numSamples = (*channels)[0].getArray()->size();
    
    // Convert to AudioBuffer
    juce::AudioBuffer<float> buffer(numChannels, numSamples);
    for (int ch = 0; ch < numChannels; ++ch)
    {
        auto* chData = (*channels)[ch].getArray();
        for (int s = 0; s < numSamples; ++s)
        {
            buffer.setSample(ch, s, (float)(*chData)[s]);
        }
    }
    
    // Process audio
    juce::MidiBuffer midi;
    instance->getProcessor().processBlock(buffer, midi);
    
    // Convert back to JSON array
    juce::Array<juce::var> outputChannels;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        juce::Array<juce::var> samples;
        for (int s = 0; s < numSamples; ++s)
        {
            samples.add(buffer.getSample(ch, s));
        }
        outputChannels.add(samples);
    }
    
    juce::DynamicObject::Ptr response = new juce::DynamicObject();
    response->setProperty("action", "AUDIO_PROCESSED");
    response->setProperty("channels", outputChannels);
    response->setProperty("slot_id", slotId);
    
    webSocketServer->send(clientId, juce::var(response.get()));
}

void MainComponent::handleSetParam(const juce::String& clientId, const juce::var& data)
{
    auto slotId = data["slot_id"].toString();
    auto paramName = data["name"].toString();
    auto value = (float)data["value"];
    
    auto instance = pluginManager->getInstance(clientId, slotId);
    if (instance)
    {
        auto& processor = instance->getProcessor();
        for (int i = 0; i < processor.getNumParameters(); ++i)
        {
            if (processor.getParameterName(i) == paramName)
            {
                processor.setParameter(i, value);
                break;
            }
        }
    }
    
    juce::DynamicObject::Ptr response = new juce::DynamicObject();
    response->setProperty("action", "PARAM_CHANGED");
    response->setProperty("name", paramName);
    response->setProperty("value", value);
    response->setProperty("slot_id", slotId);
    
    webSocketServer->send(clientId, juce::var(response.get()));
}

void MainComponent::handleMouseEvent(const juce::String& clientId, const juce::var& data, const juce::String& type)
{
    auto slotId = data["slot_id"].toString();
    auto instance = pluginManager->getInstance(clientId, slotId);
    
    if (!instance) return;
    
    auto editor = instance->getEditor();
    if (!editor) return;
    
    // Simplified mouse event handling for JUCE 8
    if (type == "click")
    {
        int x = (int)data["x"];
        int y = (int)data["y"];
        
        // Use simplified approach - direct component interaction
        editor->mouseDown(juce::MouseEvent(
            juce::Desktop::getInstance().getMainMouseSource(),
            juce::Point<float>((float)x, (float)y),
            juce::ModifierKeys(),
            0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            editor, editor,
            juce::Time::getCurrentTime(),
            juce::Point<float>((float)x, (float)y),
            juce::Time::getCurrentTime(),
            1, false
        ));
        
        editor->mouseUp(juce::MouseEvent(
            juce::Desktop::getInstance().getMainMouseSource(),
            juce::Point<float>((float)x, (float)y),
            juce::ModifierKeys(),
            0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            editor, editor,
            juce::Time::getCurrentTime(),
            juce::Point<float>((float)x, (float)y),
            juce::Time::getCurrentTime(),
            1, false
        ));
    }
    else if (type == "drag")
    {
        int x1 = (int)data["x1"];
        int y1 = (int)data["y1"];
        int x2 = (int)data["x2"];
        int y2 = (int)data["y2"];
        
        editor->mouseDown(juce::MouseEvent(
            juce::Desktop::getInstance().getMainMouseSource(),
            juce::Point<float>((float)x1, (float)y1),
            juce::ModifierKeys::leftButtonModifier,
            0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            editor, editor,
            juce::Time::getCurrentTime(),
            juce::Point<float>((float)x1, (float)y1),
            juce::Time::getCurrentTime(),
            1, false
        ));
        
        editor->mouseDrag(juce::MouseEvent(
            juce::Desktop::getInstance().getMainMouseSource(),
            juce::Point<float>((float)x2, (float)y2),
            juce::ModifierKeys::leftButtonModifier,
            0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            editor, editor,
            juce::Time::getCurrentTime(),
            juce::Point<float>((float)x1, (float)y1),
            juce::Time::getCurrentTime(),
            1, false
        ));
        
        editor->mouseUp(juce::MouseEvent(
            juce::Desktop::getInstance().getMainMouseSource(),
            juce::Point<float>((float)x2, (float)y2),
            juce::ModifierKeys(),
            0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            editor, editor,
            juce::Time::getCurrentTime(),
            juce::Point<float>((float)x1, (float)y1),
            juce::Time::getCurrentTime(),
            1, false
        ));
    }
    else if (type == "scroll")
    {
        int x = (int)data["x"];
        int y = (int)data["y"];
        int delta = (int)data["delta"];
        
        juce::MouseWheelDetails wheel;
        wheel.deltaY = (float)delta * 0.1f;
        wheel.deltaX = 0.0f;
        wheel.isReversed = false;
        wheel.isSmooth = false;
        wheel.isInertial = false;
        
        editor->mouseWheelMove(juce::MouseEvent(
            juce::Desktop::getInstance().getMainMouseSource(),
            juce::Point<float>((float)x, (float)y),
            juce::ModifierKeys(),
            0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            editor, editor,
            juce::Time::getCurrentTime(),
            juce::Point<float>((float)x, (float)y),
            juce::Time::getCurrentTime(),
            1, false
        ), wheel);
    }
}

void MainComponent::captureAndSendUI()
{
    auto activeInstances = pluginManager->getAllActiveInstances();
    
    for (auto& [key, instance] : activeInstances)
    {
        if (!instance->hasEditor()) continue;
        
        // Use the new captureImage method
        auto image = instance->captureImage();
        if (!image.isValid()) continue;
        
        // Encode to JPEG base64
        juce::MemoryOutputStream stream;
        juce::JPEGImageFormat format;
        format.setQuality(0.75f);
        format.writeImageToStream(image, stream);
        
        auto base64 = juce::Base64::toBase64(stream.getData(), stream.getDataSize());
        
        // Parse key to get clientId and slotId
        auto parts = juce::StringArray::fromTokens(key, "_", "");
        if (parts.size() >= 2)
        {
            auto clientId = parts[0];
            auto slotId = key.substring(clientId.length() + 1);
            
            juce::DynamicObject::Ptr response = new juce::DynamicObject();
            response->setProperty("action", "UI_FRAME");
            response->setProperty("image", base64);
            response->setProperty("slot_id", slotId);
            
            webSocketServer->send(clientId, juce::var(response.get()));
        }
    }
}
