/*
  ==============================================================================
    Nova VST Host - Plugin Manager Implementation
  ==============================================================================
*/

#include "PluginManager.h"

PluginManager::PluginManager()
{
    // Register VST3 format explicitly for JUCE 8
    formatManager.addFormat(new juce::VST3PluginFormat());
}

PluginManager::~PluginManager()
{
    juce::ScopedLock lock(instanceLock);
    activeInstances.clear();
}

void PluginManager::scanPlugins(std::function<void(int)> onComplete)
{
    // Scan VST3 folders
    juce::StringArray paths;
    
    #if JUCE_WINDOWS
        paths.add("C:\\Program Files\\Common Files\\VST3");
        paths.add("C:\\Program Files (x86)\\Common Files\\VST3");
        
        auto localAppData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
        paths.add(localAppData.getFullPathName() + "\\VST3");
    #elif JUCE_MAC
        paths.add("/Library/Audio/Plug-Ins/VST3");
        paths.add("~/Library/Audio/Plug-Ins/VST3");
    #endif
    
    availablePlugins.clear();
    
    // Scan each path using VST3 format
    juce::VST3PluginFormat vst3Format;
    
    DBG("=== Starting VST3 Plugin Scan ===");
    
    for (auto& path : paths)
    {
        juce::File folder(path);
        DBG("Checking folder: " + path);
        
        if (folder.exists() && folder.isDirectory())
        {
            // Direct file scan approach for reliability
            auto vst3Files = folder.findChildFiles(juce::File::findDirectories, true, "*.vst3");
            
            DBG("Found " + juce::String(vst3Files.size()) + " .vst3 files in " + path);
            
            for (auto& vst3File : vst3Files)
            {
                juce::OwnedArray<juce::PluginDescription> results;
                vst3Format.findAllTypesForFile(results, vst3File.getFullPathName());
                
                for (auto* desc : results)
                {
                    availablePlugins.add(*desc);
                    DBG("  + " + desc->name + " (" + desc->manufacturerName + ")");
                }
            }
        }
    }
    
    DBG("=== Scan Complete: " + juce::String(availablePlugins.size()) + " plugins ===");
    
    // Also add to knownPlugins for future reference
    for (auto& plugin : availablePlugins)
    {
        knownPlugins.addType(plugin);
    }
    
    if (onComplete)
    {
        onComplete(availablePlugins.size());
    }
}

bool PluginManager::loadPlugin(const juce::String& clientId, const juce::String& slotId,
                                const juce::String& path, double sampleRate)
{
    juce::String errorMessage;
    
    // Find plugin description by path
    juce::PluginDescription desc;
    bool found = false;
    
    for (auto& plugin : availablePlugins)
    {
        if (plugin.fileOrIdentifier == path)
        {
            desc = plugin;
            found = true;
            break;
        }
    }
    
    if (!found)
    {
        // Try to create description from path directly
        juce::VST3PluginFormat vst3Format;
        juce::OwnedArray<juce::PluginDescription> results;
        vst3Format.findAllTypesForFile(results, path);
        
        if (results.size() > 0)
        {
            desc = *results[0];
            found = true;
        }
    }
    
    if (!found)
    {
        DBG("Plugin not found: " + path);
        return false;
    }
    
    // Create plugin instance
    auto instance = formatManager.createPluginInstance(desc, sampleRate, 512, errorMessage);
    
    if (!instance)
    {
        DBG("Failed to create plugin: " + errorMessage);
        return false;
    }
    
    // Prepare the plugin
    instance->prepareToPlay(sampleRate, 512);
    instance->setNonRealtime(false);
    
    // Create our wrapper
    auto pluginInstance = std::make_unique<PluginInstance>(std::move(instance), desc.name);
    
    // Store in map
    auto key = makeKey(clientId, slotId);
    
    {
        juce::ScopedLock lock(instanceLock);
        activeInstances[key] = std::move(pluginInstance);
    }
    
    DBG("Plugin loaded: " + desc.name + " (key: " + key + ")");
    return true;
}

void PluginManager::unloadPlugin(const juce::String& clientId, const juce::String& slotId)
{
    auto key = makeKey(clientId, slotId);
    
    juce::ScopedLock lock(instanceLock);
    activeInstances.erase(key);
    
    DBG("Plugin unloaded: " + key);
}

void PluginManager::unloadAllForClient(const juce::String& clientId)
{
    juce::ScopedLock lock(instanceLock);
    
    auto prefix = clientId + "_";
    
    for (auto it = activeInstances.begin(); it != activeInstances.end(); )
    {
        if (it->first.startsWith(prefix))
        {
            it = activeInstances.erase(it);
        }
        else
        {
            ++it;
        }
    }
    
    DBG("All plugins unloaded for client: " + clientId);
}

PluginInstance* PluginManager::getInstance(const juce::String& clientId, const juce::String& slotId)
{
    auto key = makeKey(clientId, slotId);
    
    juce::ScopedLock lock(instanceLock);
    
    auto it = activeInstances.find(key);
    if (it != activeInstances.end())
    {
        return it->second.get();
    }
    
    return nullptr;
}

std::map<juce::String, PluginInstance*> PluginManager::getAllActiveInstances()
{
    std::map<juce::String, PluginInstance*> result;
    
    juce::ScopedLock lock(instanceLock);
    
    for (auto& [key, instance] : activeInstances)
    {
        result[key] = instance.get();
    }
    
    return result;
}
