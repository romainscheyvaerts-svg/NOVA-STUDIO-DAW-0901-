/*
    NovaARAHost — hébergement d'un plugin VST3 avec le SDK VST3 de Steinberg (licence MIT),
    sans JUCE : module, composant + contrôleur reliés, bus audio (dont sidechain), traitement
    avec transport (ProcessContext), fenêtre IPlugView, extension ARA (ARA SDK, Apache 2.0).
    (c) Make Music.
*/
#pragma once

#include "Common.h"

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "public.sdk/source/vst/hosting/connectionproxy.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"

#include "ARA_API/ARAVST3.h"

namespace nova
{
    // Position de lecture transmise au plugin à chaque bloc (comme l'AudioPlayHead de JUCE).
    struct Transport
    {
        int64_t timeInSamples = 0;
        double sampleRate = 44100.0;
        double bpm = 120.0;
        int sigNum = 4, sigDen = 4;
        bool playing = false;
        // Piste tempo (insert ARA) : position musicale (noires) et début de mesure ; < 0 : tempo constant.
        double musicPos = -1.0, barPos = -1.0;
    };

    class Vst3Plugin
    {
    public:
        Vst3Plugin();
        ~Vst3Plugin();

        // Chargement (module + composant + contrôleur). Lève std::runtime_error si impossible.
        void load (const std::string& path);
        // Termine composant + contrôleur, garde le module chargé (uninitializeARA vient ensuite).
        void terminateInstance();

        std::string name, vendor, version;
        bool hasARAFactory() const { return ! araMainFactories.empty(); }
        const ARA::ARAFactory* araFactory() const;
        const ARA::ARAPlugInExtensionInstance* bindToARA (ARA::ARADocumentControllerRef dc,
                                                          ARA::ARAPlugInInstanceRoleFlags known,
                                                          ARA::ARAPlugInInstanceRoleFlags assigned);

        // Bus audio
        int numBuses (bool input) const { return (int) (input ? ins.size() : outs.size()); }
        int busChannels (bool input, int index) const;
        bool busActive (bool input, int index) const;
        std::string busDescription (bool input, int index) const;
        // Arrangements des bus d'entrée (les premiers) ; les bus concernés sont activés. Vrai si accepté.
        bool setInputArrangements (const std::vector<Steinberg::Vst::SpeakerArrangement>& arrs);
        void enableAllBuses();
        int totalInputChannels() const;
        int totalOutputChannels() const;

        // Traitement
        void prepare (double sampleRate, int maxBlock, bool offline);
        void release();
        bool isPrepared() const { return prepared; }
        int latencySamples() const;
        // Comme AudioBuffer de JUCE : entrées lues dans chans (bus d'entrée actifs à la suite),
        // sorties écrites dans chans (bus de sortie actifs à la suite).
        void process (float* const* chans, int numChans, int numSamples, const Transport& t);

        // Fenêtre
        bool hasEditor();
        Steinberg::IPtr<Steinberg::IPlugView> createView();
        Steinberg::Vst::IEditController* getController() const { return controller.get(); }

        // Paramètres renvoyés par le processeur : à appliquer au contrôleur (fil de l'interface).
        void flushOutputParameters();

        // État du plugin (IComponent::getState / setState, puis contrôleur) : réglages hors ARA.
        std::vector<uint8_t> getState();
        bool setState (const std::vector<uint8_t>& data);

    private:
        struct Bus
        {
            std::string name;
            Steinberg::Vst::SpeakerArrangement arr = 0;
            int busType = 0;
            bool active = false;
        };

        class HostContext;
        class ComponentHandler;

        void refreshBuses();
        bool applyArrangements();

        VST3::Hosting::Module::Ptr module;
        Steinberg::IPtr<Steinberg::Vst::IHostApplication> hostContext;
        Steinberg::IPtr<Steinberg::Vst::IComponent> component;
        Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor;
        Steinberg::IPtr<Steinberg::Vst::IEditController> controller;
        Steinberg::IPtr<Steinberg::Vst::IConnectionPoint> componentCP, controllerCP;
        Steinberg::IPtr<Steinberg::Vst::IComponentHandler> handler;
        std::vector<Steinberg::IPtr<ARA::IMainFactory>> araMainFactories;
        bool singleComponent = false;

        std::vector<Bus> ins, outs;
        bool prepared = false, offlineMode = false;
        int maxBlockSize = 0;
        double currentRate = 44100.0;
        int64_t continuous = 0;

        std::vector<std::vector<float>> inScratch, outScratch;
        std::vector<float*> inPtrs, outPtrs;
        std::vector<Steinberg::Vst::AudioBusBuffers> inBusBufs, outBusBufs;
        Steinberg::Vst::ParameterChanges inChanges { 64 }, outChanges { 64 };
        Steinberg::Vst::EventList inEvents { 64 }, outEvents { 64 };

    public:
        // File des changements de paramètres (contrôleur → processeur, processeur → contrôleur).
        std::mutex paramLock;
        std::vector<std::pair<Steinberg::Vst::ParamID, double>> pendingToProcessor, pendingToController;
        std::atomic<int> restartFlags { 0 };
        // Réglages posés par l'hôte (set_param) : instant (ms), fil de l'interface seulement.
        std::map<Steinberg::Vst::ParamID, double> hostEdits;
        // Réglages tenus (sous paramLock) : donnés au processeur à chaque bloc.
        std::map<Steinberg::Vst::ParamID, double> heldParams;
    };
}
