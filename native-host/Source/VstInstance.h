/*
    NovaVSTHost — une instance de plugin VST3, hébergée avec le SDK VST3 de Steinberg (licence MIT),
    sans JUCE.

    Fils :
      - fil principal (interface) : chargement, contrôleur (réglages, textes, état), fenêtre ;
      - fil audio : process(), une demande à la fois (voir SharedAudio.h).
    processLock protège ce qui ne doit pas croiser process() (préparation, remise à zéro, état
    du composant, disposition des bus). Les réglages posés par le pont ou la fenêtre du plugin
    rejoignent le processeur au bloc suivant (décalage 0, comme JUCE) ; ceux qui arrivent avec
    l'audio sont posés à l'échantillon près (IParameterChanges).

    Valeurs des réglages gardées en float, comme le cache de JUCE (même arrondi que pedalboard).

    (c) Make Music.
*/
#pragma once

#include "Common.h"
#include "SharedAudio.h"

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"

namespace nova
{
    struct ParamInfo
    {
        Steinberg::Vst::ParamID id = 0;
        std::string title, shortTitle, units;
        int32_t stepCount = 0;
        double defaultValue = 0;
        int32_t flags = 0;
        int32_t unitId = 0;
    };

    struct ClassEntry
    {
        std::string cid, name, category, subCategories, vendor, version, sdkVersion;
        int32_t cardinality = 0;
        uint32_t classFlags = 0;
    };

    // Inventaire d'une fabrique (sans créer d'instance).
    std::vector<ClassEntry> listClasses (const VST3::Hosting::PluginFactory& f);
    std::string uidString (const VST3::UID& u);

    // Module VST3 chargé depuis un dossier .vst3 ou son binaire interne (UADx : nom différent).
    VST3::Hosting::Module::Ptr openModule (const std::string& path, std::string& error);

    class VstInstance
    {
    public:
        VstInstance();
        ~VstInstance();

        // Chargement par chemin + nom de classe (ou CID). Lève std::runtime_error.
        void load (const std::string& path, const std::string& className, const std::string& cid);

        std::string name, vendor, version, category, subCategories, classId, sdkVersion;
        bool instrument = false;
        int numClasses = 0;

        // ---- bus
        struct Bus
        {
            std::string name;
            Steinberg::Vst::SpeakerArrangement arr = 0;     // disposition actuelle
            Steinberg::Vst::SpeakerArrangement defArr = 0;  // disposition d'origine
            int busType = 0;
            bool active = false;
            bool defaultActive = false;
        };
        std::vector<Bus> ins, outs;
        int mainInChannels() const;
        int mainOutChannels() const;
        bool sidechainActive() const;
        bool hasSidechainBus() const;
        json::Value busesJson() const;

        // ---- traitement
        // Comme prepareToPlay de JUCE : rien si déjà actif avec les mêmes réglages.
        json::Value prepare (double sampleRate, int maxBlock, bool offline, int channels, bool sidechain);
        void release();
        void reset();                    // setActive off/on (comme AudioPluginInstance::reset de JUCE)
        bool isPrepared() const { return prepared; }
        int latency() const { return cachedLatency.load(); }
        void processRequest (shm::Header& h, float* in, float* key, float* out);

        // ---- réglages
        std::vector<ParamInfo> params;
        json::Value paramsJson() const;
        // Unités (IUnitInfo, du composant sinon du contrôleur) : JUCE range les réglages par unité.
        json::Value unitsJson();
        float value (int index) const { return cache[(size_t) index].load(); }
        int indexOf (Steinberg::Vst::ParamID id) const;
        // Texte affiché pour une valeur (getParamStringByValue) ; faux si le plugin refuse.
        bool textFor (int index, double v, std::string& out);
        bool valueForText (int index, const std::string& text, double& out);
        // Pose une valeur (cache + contrôleur + processeur au bloc suivant), comme setValue de JUCE.
        void setValue (int index, float v);
        // Plages de texte : [premier pas, texte] pour 0, 1/steps, … 1 (fast : getParamStringByValue ;
        // slow : valeur posée puis texte, comme le repli de pedalboard).
        json::Value ranges (int index, int steps, bool slow);
        void refreshValuesFromController();
        void refreshParamInfo();
        void flushToController();        // réglages renvoyés par le processeur → contrôleur

        // ---- remise à neuf (comme pedalboard pour un plugin qui garde du son après setActive off/on)
        // Instance recréée (même classe), état et valeurs des réglages restaurés (deux passes), préparée
        // de nouveau si elle l'était.
        void reinstantiate();
        // Test de pedalboard (detectReloadType) : du bruit, une remise à zéro, du silence ; vrai si le
        // silence qui suit sort plus fort que 5 × le bruit de fond. Instrument (pas d'entrée) : vrai.
        bool persistsAudioOnReset();

        // ---- état
        bool getState (std::vector<uint8_t>& component, std::vector<uint8_t>& controller, bool& hasController);
        void setState (const std::vector<uint8_t>* component, const std::vector<uint8_t>* controller);

        // ---- fenêtre
        Steinberg::IPtr<Steinberg::IPlugView> createView();
        bool hasEditor();

        // Événements vers le pont (fil quelconque).
        std::function<void (const std::string&, json::Value)> emit;
        // Exécute fn sur le fil principal (posé par Main).
        std::function<void (std::function<void()>)> postToMain;

        // Réglages bougés dans la fenêtre du plugin : envoyés au pont si vrai.
        std::atomic<bool> reportEdits { true };
        int textCrashes = 0;

    private:
        class HostContext;
        class ComponentHandler;
        friend class ComponentHandler;

        void readBuses();
        void createInstance();
        void teardownInstance();
        void runSilenceOrNoise (int channels, int frames, bool noise, float& magnitude);
        bool applyArrangements (int channels, bool sidechain);
        void deactivate();
        void handleRestart (int32_t flags);
        void updateMidiMappings();

        VST3::Hosting::Module::Ptr module;
        Steinberg::IPtr<Steinberg::Vst::IHostApplication> hostContext;
        Steinberg::IPtr<Steinberg::Vst::IComponent> component;
        Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor;
        Steinberg::IPtr<Steinberg::Vst::IEditController> controller;
        Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping;
        Steinberg::IPtr<Steinberg::Vst::IConnectionPoint> componentCP, controllerCP;
        Steinberg::IPtr<Steinberg::Vst::IComponentHandler> handler;
        bool singleComponent = false;
        VST3::UID chosenId;

        std::unique_ptr<std::atomic<float>[]> cache;
        std::unordered_map<Steinberg::Vst::ParamID, int> idToIndex;
        // Réglages dont le texte fait planter le plugin (RUBY2) : texte de repli, plus d'appel.
        std::vector<bool> textBroken;
        // Contrôleurs MIDI → réglages (IMidiMapping), relus sur le fil principal : 16 canaux × 130.
        std::vector<Steinberg::Vst::ParamID> ccMap;

        // Préparation en cours
        bool prepared = false, offlineMode = true, sidechainOn = false;
        int maxBlockSize = 0, preparedChannels = 2;
        double currentRate = 44100.0;
        std::atomic<int> cachedLatency { 0 };
        int64_t continuous = 0;

        // Tampons de traitement
        std::vector<std::vector<float>> scratch;
        std::vector<float*> inPtrs, outPtrs;
        std::vector<Steinberg::Vst::AudioBusBuffers> inBus, outBus;
        Steinberg::Vst::ParameterChanges inChanges { 256 }, outChanges { 256 };
        Steinberg::Vst::EventList inEvents { shm::kMaxEvents }, outEvents { 256 };

    public:
        std::mutex processLock;
        std::mutex paramLock;
        std::map<Steinberg::Vst::ParamID, double> pendingToProcessor;    // dernière valeur par réglage
        std::map<Steinberg::Vst::ParamID, double> pendingToController;
    };
}
