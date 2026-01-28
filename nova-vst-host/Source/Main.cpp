/*
  ==============================================================================
    Nova VST Host - Main Entry Point
    
    Application hôte VST3 native pour Nova Studio DAW
    Supporte TOUS les plugins VST3 (y compris iLok, Waves, etc.)
  ==============================================================================
*/

#include <JuceHeader.h>
#include "MainComponent.h"

class NovaVSTHostApplication : public juce::JUCEApplication
{
public:
    NovaVSTHostApplication() {}

    const juce::String getApplicationName() override { return "Nova VST Host"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise(const juce::String& commandLine) override
    {
        juce::ignoreUnused(commandLine);
        mainWindow.reset(new MainWindow(getApplicationName()));
        
        DBG("Nova VST Host started on port 8765");
    }

    void shutdown() override
    {
        mainWindow = nullptr;
    }

    void systemRequestedQuit() override
    {
        quit();
    }

    void anotherInstanceStarted(const juce::String& commandLine) override
    {
        juce::ignoreUnused(commandLine);
    }

    class MainWindow : public juce::DocumentWindow
    {
    public:
        MainWindow(juce::String name)
            : DocumentWindow(name,
                            juce::Desktop::getInstance().getDefaultLookAndFeel()
                                .findColour(juce::ResizableWindow::backgroundColourId),
                            DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar(true);
            setContentOwned(new MainComponent(), true);
            
            // Mode headless pour fonctionner en arrière-plan
            #if JUCE_WINDOWS
                setVisible(true);
                setMinimised(true);
            #else
                setVisible(false);
            #endif
            
            centreWithSize(getWidth(), getHeight());
        }

        void closeButtonPressed() override
        {
            JUCEApplication::getInstance()->systemRequestedQuit();
        }

    private:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainWindow)
    };

private:
    std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION(NovaVSTHostApplication)
