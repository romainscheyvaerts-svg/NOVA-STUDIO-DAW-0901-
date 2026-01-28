/*
  ==============================================================================
    Nova VST Host - Plugin Manager Header
    
    Gère le scan, chargement et instances des plugins VST3
  ==============================================================================
*/

#pragma once

#include <JuceHeader.h>
#include <map>
#include <functional>

class PluginInstance : public juce::Component
{
public:
    PluginInstance(std::unique_ptr<juce::AudioPluginInstance> processor, 
                   const juce::String& name)
        : audioProcessor(std::move(processor)), pluginName(name)
    {
        if (audioProcessor && audioProcessor->hasEditor())
        {
            pluginEditor.reset(audioProcessor->createEditor());
            if (pluginEditor)
            {
                // Set proper size
                auto editorWidth = juce::jmax(400, pluginEditor->getWidth());
                auto editorHeight = juce::jmax(300, pluginEditor->getHeight());
                pluginEditor->setSize(editorWidth, editorHeight);
                
                // Add editor as child and make visible
                addAndMakeVisible(pluginEditor.get());
                setSize(editorWidth, editorHeight);
                
                // Add to desktop as invisible window for off-screen rendering
                addToDesktop(juce::ComponentPeer::windowIsTemporary);
                setVisible(true);
                
                DBG("Editor created for " + name + " (" + juce::String(editorWidth) + "x" + juce::String(editorHeight) + ")");
            }
        }
    }
    
    ~PluginInstance()
    {
        removeFromDesktop();
        pluginEditor = nullptr;
        audioProcessor = nullptr;
    }
    
    void resized() override
    {
        if (pluginEditor)
            pluginEditor->setBounds(getLocalBounds());
    }
    
    juce::AudioProcessor& getProcessor() { return *audioProcessor; }
    juce::AudioProcessorEditor* getEditor() { return pluginEditor.get(); }
    const juce::String& getName() const { return pluginName; }
    
    bool hasEditor() const { return pluginEditor != nullptr; }
    
    // Capture the editor to an image
    juce::Image captureImage()
    {
        if (!pluginEditor) return {};
        
        auto bounds = pluginEditor->getBounds();
        juce::Image image(juce::Image::RGB, bounds.getWidth(), bounds.getHeight(), true);
        juce::Graphics g(image);
        
        // Paint the editor
        pluginEditor->paintEntireComponent(g, false);
        
        return image;
    }
    
private:
    std::unique_ptr<juce::AudioPluginInstance> audioProcessor;
    std::unique_ptr<juce::AudioProcessorEditor> pluginEditor;
    juce::String pluginName;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginInstance)
};

class PluginManager
{
public:
    PluginManager();
    ~PluginManager();
    
    // Scan for available plugins
    void scanPlugins(std::function<void(int)> onComplete);
    
    // Get list of available plugins
    const juce::Array<juce::PluginDescription>& getAvailablePlugins() const { return availablePlugins; }
    
    // Load a plugin for a client/slot
    bool loadPlugin(const juce::String& clientId, const juce::String& slotId, 
                    const juce::String& path, double sampleRate);
    
    // Unload a plugin
    void unloadPlugin(const juce::String& clientId, const juce::String& slotId);
    
    // Unload all plugins for a client
    void unloadAllForClient(const juce::String& clientId);
    
    // Get a plugin instance
    PluginInstance* getInstance(const juce::String& clientId, const juce::String& slotId);
    
    // Get all active instances (for UI capture)
    std::map<juce::String, PluginInstance*> getAllActiveInstances();
    
private:
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPlugins;
    juce::Array<juce::PluginDescription> availablePlugins;
    
    // Map: "clientId_slotId" -> PluginInstance
    std::map<juce::String, std::unique_ptr<PluginInstance>> activeInstances;
    juce::CriticalSection instanceLock;
    
    juce::String makeKey(const juce::String& clientId, const juce::String& slotId)
    {
        return clientId + "_" + slotId;
    }
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginManager)
};
