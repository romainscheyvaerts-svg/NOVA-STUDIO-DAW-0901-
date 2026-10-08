/*
    NovaVSTHost — instance de plugin VST3 (SDK VST3 Steinberg, licence MIT), sans JUCE.
    (c) Make Music.
*/
#include "VstInstance.h"
#include "Guard.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace nova
{
    //==========================================================================
    class VstInstance::HostContext final : public HostApplication
    {
    public:
        tresult PLUGIN_API getName (String128 n) override
        {
            return StringConvert::convert ("Nova Studio", n) ? kResultTrue : kInternalError;
        }
    };

    //==========================================================================
    // IComponentHandler : gestes faits dans la fenêtre du plugin.
    class VstInstance::ComponentHandler final : public U::Implements<U::Directly<IComponentHandler, IComponentHandler2>>
    {
    public:
        explicit ComponentHandler (VstInstance& p) : owner (p) {}
        tresult PLUGIN_API beginEdit (ParamID id) override
        {
            if (owner.reportEdits && owner.emit)
            {
                auto o = json::Value::object();
                o.set ("id", (double) id);
                owner.emit ("begin_edit", o);
            }
            return kResultOk;
        }
        tresult PLUGIN_API performEdit (ParamID id, ParamValue v) override
        {
            const int idx = owner.indexOf (id);
            if (idx >= 0) owner.cache[(size_t) idx].store ((float) v);
            {
                std::lock_guard<std::mutex> l (owner.paramLock);
                owner.pendingToProcessor[id] = (double) (float) v;
            }
            if (owner.reportEdits && owner.emit)
            {
                auto o = json::Value::object();
                o.set ("id", (double) id);
                o.set ("index", idx);
                o.set ("value", (double) (float) v);
                owner.emit ("edit", o);
            }
            return kResultOk;
        }
        tresult PLUGIN_API endEdit (ParamID id) override
        {
            if (owner.reportEdits && owner.emit)
            {
                auto o = json::Value::object();
                o.set ("id", (double) id);
                owner.emit ("end_edit", o);
            }
            return kResultOk;
        }
        tresult PLUGIN_API restartComponent (int32 flags) override
        {
            // Comme JUCE : traité plus tard sur le fil principal (le plugin peut appeler d'ailleurs).
            if (owner.postToMain)
            {
                auto* self = &owner;
                owner.postToMain ([self, flags] { self->handleRestart (flags); });
            }
            return kResultTrue;
        }
        tresult PLUGIN_API setDirty (TBool) override { return kResultOk; }
        tresult PLUGIN_API requestOpenEditor (FIDString) override { return kResultFalse; }
        tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
        tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }

    private:
        VstInstance& owner;
    };

    //==========================================================================
    static int channelCount (SpeakerArrangement a) { return SpeakerArr::getChannelCount (a); }

    static std::string lowerAscii (std::string s)
    {
        for (auto& c : s) if (c >= 'A' && c <= 'Z') c = (char) (c - 'A' + 'a');
        return s;
    }

    static std::string compactName (const std::string& s)
    {
        std::string o;
        for (char c : lowerAscii (s)) if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) o.push_back (c);
        return o;
    }

    std::string uidString (const VST3::UID& u) { return u.toString(); }

    std::vector<ClassEntry> listClasses (const VST3::Hosting::PluginFactory& f)
    {
        std::vector<ClassEntry> out;
        for (auto& ci : f.classInfos())
        {
            ClassEntry e;
            e.cid = uidString (ci.ID());
            e.name = ci.name();
            e.category = ci.category();
            e.subCategories = ci.subCategoriesString();
            e.vendor = ci.vendor();
            e.version = ci.version();
            e.sdkVersion = ci.sdkVersion();
            e.cardinality = ci.cardinality();
            e.classFlags = ci.classFlags();
            out.push_back (std::move (e));
        }
        return out;
    }

    VST3::Hosting::Module::Ptr openModule (const std::string& path, std::string& error)
    {
        auto m = VST3::Hosting::Module::create (path, error);
        if (m) return m;
        // Dossier .vst3 dont le binaire interne porte un autre nom (UADx : uaudio_*.vst3).
        const auto w = widen (path);
        const DWORD attr = GetFileAttributesW (w.c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY))
        {
            const auto dir = w + L"\\Contents\\x86_64-win\\";
            WIN32_FIND_DATAW fd {};
            HANDLE h = FindFirstFileW ((dir + L"*.vst3").c_str(), &fd);
            std::vector<std::wstring> found;
            if (h != INVALID_HANDLE_VALUE)
            {
                do { if (! (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) found.push_back (dir + fd.cFileName); }
                while (FindNextFileW (h, &fd));
                FindClose (h);
            }
            if (found.size() == 1)
            {
                std::string err2;
                m = VST3::Hosting::Module::create (narrow (found[0]), err2);
                if (m) { error.clear(); return m; }
                error += " ; " + err2;
            }
        }
        return nullptr;
    }

    //==========================================================================
    VstInstance::VstInstance() = default;

    VstInstance::~VstInstance()
    {
        {
            std::lock_guard<std::mutex> l (processLock);
            deactivate();
        }
        if (componentCP && controllerCP)
        {
            componentCP->disconnect (controllerCP.get());
            controllerCP->disconnect (componentCP.get());
        }
        componentCP = nullptr;
        controllerCP = nullptr;
        midiMapping = nullptr;
        if (controller)
        {
            controller->setComponentHandler (nullptr);
            if (! singleComponent) controller->terminate();
        }
        controller = nullptr;
        processor = nullptr;
        if (component) component->terminate();
        component = nullptr;
        handler = nullptr;
        // Le module reste chargé jusqu'à la fin du processus : certains plugins plantent en se déchargeant.
        if (module) new VST3::Hosting::Module::Ptr (module);
        module.reset();
    }

    int VstInstance::indexOf (ParamID id) const
    {
        auto it = idToIndex.find (id);
        return it == idToIndex.end() ? -1 : it->second;
    }

    void VstInstance::load (const std::string& path, const std::string& className, const std::string& cid)
    {
        std::string err;
        module = openModule (path, err);
        if (! module)
            throw std::runtime_error ("Plugin introuvable ou illisible : " + path + (err.empty() ? "" : " (" + err + ")"));

        hostContext = owned (static_cast<IHostApplication*> (new HostContext()));
        const auto& factory = module->getFactory();
        factory.setHostContext (hostContext.get());

        const auto infos = factory.classInfos();
        const VST3::Hosting::ClassInfo* chosen = nullptr;
        std::vector<const VST3::Hosting::ClassInfo*> audio;
        for (auto& ci : infos)
            if (ci.category() == kVstAudioEffectClass) audio.push_back (&ci);
        numClasses = (int) audio.size();
        if (audio.empty()) throw std::runtime_error ("Aucun plugin audio dans ce fichier : " + path);
        if (! cid.empty())
            for (auto* ci : audio) if (lowerAscii (uidString (ci->ID())) == lowerAscii (cid)) { chosen = ci; break; }
        if (chosen == nullptr && ! className.empty())
        {
            for (auto* ci : audio) if (ci->name() == className) { chosen = ci; break; }
            if (chosen == nullptr)
                for (auto* ci : audio) if (lowerAscii (ci->name()) == lowerAscii (className)) { chosen = ci; break; }
            if (chosen == nullptr)
                for (auto* ci : audio) if (compactName (ci->name()) == compactName (className)) { chosen = ci; break; }
            if (chosen == nullptr && audio.size() > 1)
                throw std::runtime_error ("Plugin « " + className + " » absent de " + path);
        }
        if (chosen == nullptr) chosen = audio.front();

        name = chosen->name();
        vendor = chosen->vendor().empty() ? factory.info().vendor() : chosen->vendor();
        version = chosen->version();
        category = chosen->category();
        subCategories = chosen->subCategoriesString();
        sdkVersion = chosen->sdkVersion();
        classId = uidString (chosen->ID());
        // Comme JUCE (PluginDescription::isInstrument) : sous-catégories contenant « Instrument ».
        instrument = lowerAscii (subCategories).find ("instrument") != std::string::npos;

        component = factory.createInstance<IComponent> (chosen->ID());
        if (! component) throw std::runtime_error ("Chargement impossible : le plugin refuse de créer son composant");
        if (component->initialize (hostContext.get()) != kResultOk)
            throw std::runtime_error ("Chargement impossible : initialisation du composant refusée");

        processor = U::cast<IAudioProcessor> (component);
        if (! processor) throw std::runtime_error ("Chargement impossible : pas de processeur audio");

        if (auto c = U::cast<IEditController> (component))
        {
            controller = c;
            singleComponent = true;
        }
        else
        {
            TUID tcid;
            if (component->getControllerClassId (tcid) == kResultTrue)
            {
                controller = factory.createInstance<IEditController> (VST3::UID::fromTUID (tcid));
                if (controller && controller->initialize (hostContext.get()) != kResultOk)
                    controller = nullptr;
            }
        }

        if (controller)
        {
            handler = owned (static_cast<IComponentHandler*> (new ComponentHandler (*this)));
            controller->setComponentHandler (handler.get());
            if (! singleComponent)
            {
                auto compICP = U::cast<IConnectionPoint> (component);
                auto ctrlICP = U::cast<IConnectionPoint> (controller);
                if (compICP && ctrlICP)
                {
                    // Liaison directe (comme JUCE) : des plugins envoient des messages depuis
                    // d'autres fils que l'interface.
                    componentCP = compICP;
                    controllerCP = ctrlICP;
                    compICP->connect (ctrlICP);
                    ctrlICP->connect (compICP);
                }
            }
            // État du composant → contrôleur (synchronisation initiale, comme les DAW).
            IPtr<MemoryStream> state = owned (new MemoryStream());
            if (component->getState (state.get()) == kResultTrue)
            {
                state->seek (0, IBStream::kIBSeekSet, nullptr);
                controller->setComponentState (state.get());
            }
            midiMapping = U::cast<IMidiMapping> (controller);
        }
        updateMidiMappings();
        readBuses();
        refreshParamInfo();
        refreshValuesFromController();
        cachedLatency = std::max (0, (int) processor->getLatencySamples());
    }

    //==========================================================================
    void VstInstance::refreshParamInfo()
    {
        params.clear();
        idToIndex.clear();
        const int32 n = controller ? controller->getParameterCount() : 0;
        for (int32 i = 0; i < n; ++i)
        {
            ParameterInfo info {};
            if (controller->getParameterInfo (i, info) != kResultOk) info = {};
            ParamInfo p;
            p.id = info.id;
            p.title = StringConvert::convert (info.title);
            p.shortTitle = StringConvert::convert (info.shortTitle);
            p.units = StringConvert::convert (info.units);
            p.stepCount = info.stepCount;
            p.defaultValue = info.defaultNormalizedValue;
            p.flags = info.flags;
            p.unitId = info.unitId;
            idToIndex.emplace (p.id, (int) params.size());
            params.push_back (std::move (p));
        }
        auto fresh = std::make_unique<std::atomic<float>[]> (std::max<size_t> (1, params.size()));
        for (size_t i = 0; i < params.size(); ++i) fresh[i].store (0.0f);
        cache = std::move (fresh);
    }

    void VstInstance::refreshValuesFromController()
    {
        for (size_t i = 0; i < params.size(); ++i)
            cache[i].store ((float) controller->getParamNormalized (params[i].id));
    }

    json::Value VstInstance::paramsJson() const
    {
        auto arr = json::Value::array();
        for (size_t i = 0; i < params.size(); ++i)
        {
            const auto& p = params[i];
            auto o = json::Value::object();
            o.set ("id", (double) p.id);
            o.set ("title", p.title);
            o.set ("short", p.shortTitle);
            o.set ("units", p.units);
            o.set ("steps", p.stepCount);
            o.set ("default", p.defaultValue);
            o.set ("flags", p.flags);
            o.set ("unit", p.unitId);
            o.set ("value", (double) cache[i].load());
            arr.push (o);
        }
        return arr;
    }

    json::Value VstInstance::unitsJson()
    {
        auto arr = json::Value::array();
        IPtr<IUnitInfo> ui = U::cast<IUnitInfo> (component);
        if (! ui && controller) ui = U::cast<IUnitInfo> (controller);
        if (! ui) return arr;
        const int32 n = ui->getUnitCount();
        for (int32 i = 0; i < n; ++i)
        {
            UnitInfo u {};
            if (ui->getUnitInfo (i, u) != kResultOk) continue;
            auto o = json::Value::object();
            o.set ("index", i);
            o.set ("id", u.id);
            o.set ("parent", u.parentUnitId);
            o.set ("name", StringConvert::convert (u.name));
            arr.push (o);
        }
        return arr;
    }

    bool VstInstance::textFor (int index, double v, std::string& out)
    {
        if (! controller || index < 0 || index >= (int) params.size()) return false;
        if ((size_t) index < textBroken.size() && textBroken[(size_t) index]) return false;
        String128 s {};
        tresult r = kResultFalse;
        const ParamID id = params[(size_t) index].id;
        auto* c = controller.get();
        if (! guard::call ([&] { r = c->getParamStringByValue (id, v, s); }))
        {
            // Lecture fautive dans la fonction d'affichage (RUBY2 : violation d'accès en lecture) :
            // ce réglage prend le texte de repli ; au-delà de 64 plantages, l'instance est perdue.
            if (textBroken.size() < params.size()) textBroken.resize (params.size(), false);
            textBroken[(size_t) index] = true;
            if (++textCrashes > 64)
                throw guard::Crash ("Le plugin a planté en affichant ses réglages (getParamStringByValue)");
            if (emit)
            {
                auto o = json::Value::object();
                o.set ("message", "texte du réglage « " + params[(size_t) index].title + " » indisponible (le plugin plante)");
                emit ("log", o);
            }
            return false;
        }
        if (r != kResultOk) return false;
        s[127] = 0;
        out = StringConvert::convert (s);
        return true;
    }

    bool VstInstance::valueForText (int index, const std::string& text, double& out)
    {
        if (! controller || index < 0 || index >= (int) params.size()) return false;
        String128 s {};
        StringConvert::convert (text, s);
        ParamValue v = 0;
        tresult r = kResultFalse;
        const ParamID id = params[(size_t) index].id;
        auto* c = controller.get();
        if (! guard::call ([&] { r = c->getParamValueByString (id, s, v); }))
            throw guard::Crash ("Le plugin a planté en lisant un texte de réglage (getParamValueByString)");
        if (r != kResultOk) return false;
        out = v;
        return true;
    }

    void VstInstance::setValue (int index, float v)
    {
        if (index < 0 || index >= (int) params.size()) return;
        const ParamID id = params[(size_t) index].id;
        cache[(size_t) index].store (v);
        if (controller) controller->setParamNormalized (id, (double) v);
        std::lock_guard<std::mutex> l (paramLock);
        pendingToProcessor[id] = (double) v;
    }

    // Texte de repli de JUCE (AudioPluginInstance::Parameter::getText) : le nombre lui-même.
    static std::string fallbackText (float v)
    {
        char buf[48];
        for (int prec = 1; prec <= 9; ++prec)
        {
            std::snprintf (buf, sizeof (buf), "%.*g", prec, (double) v);
            if ((float) std::strtod (buf, nullptr) == v) break;
        }
        return buf;
    }

    json::Value VstInstance::ranges (int index, int steps, bool slow)
    {
        auto arr = json::Value::array();
        if (index < 0 || index >= (int) params.size() || steps <= 0) return arr;
        const float original = cache[(size_t) index].load();
        std::string prev;
        bool havePrev = false;
        for (int x = 0; x <= steps; ++x)
        {
            const float v = (float) ((double) x / (double) steps);
            std::string t;
            if (slow)
            {
                // Repli de pedalboard : la valeur est posée, puis son texte relu.
                setValue (index, v);
                if (! textFor (index, (double) cache[(size_t) index].load(), t)) t = fallbackText (v);
            }
            else if (! textFor (index, (double) v, t))
                t = fallbackText (v);
            if (! havePrev || t != prev)
            {
                auto pair = json::Value::array();
                pair.push (x);
                pair.push (t);
                arr.push (pair);
                prev = t;
                havePrev = true;
            }
        }
        if (slow) setValue (index, original);
        return arr;
    }

    void VstInstance::updateMidiMappings()
    {
        ccMap.assign (16 * 130, kNoParamId);
        if (! midiMapping) return;
        for (int16 ch = 0; ch < 16; ++ch)
            for (CtrlNumber c = 0; c < 130; ++c)
            {
                ParamID pid = kNoParamId;
                if (midiMapping->getMidiControllerAssignment (0, ch, c, pid) == kResultTrue)
                    ccMap[(size_t) ch * 130 + (size_t) c] = pid;
            }
    }

    void VstInstance::flushToController()
    {
        std::map<ParamID, double> todo;
        {
            std::lock_guard<std::mutex> l (paramLock);
            todo.swap (pendingToController);
        }
        if (controller)
            for (auto& [id, v] : todo) controller->setParamNormalized (id, v);
    }

    void VstInstance::handleRestart (int32_t flags)
    {
        if (! component || ! processor) return;
        if (flags & kReloadComponent) reset();
        if ((flags & kIoChanged) && prepared)
        {
            const double sr = currentRate;
            const int mb = maxBlockSize, ch = preparedChannels;
            const bool off = offlineMode, sc = sidechainOn;
            release();
            prepare (sr, mb, off, ch, sc);
        }
        if (flags & kLatencyChanged) cachedLatency = std::max (0, (int) processor->getLatencySamples());
        if (flags & kMidiCCAssignmentChanged) updateMidiMappings();
        if (flags & kParamValuesChanged) refreshValuesFromController();
        if (flags & kParamTitlesChanged)
        {
            refreshParamInfo();
            refreshValuesFromController();
        }
        if (emit)
        {
            auto o = json::Value::object();
            o.set ("flags", flags);
            o.set ("latency", cachedLatency.load());
            emit ("restart", o);
        }
    }

    //==========================================================================
    void VstInstance::readBuses()
    {
        auto read = [&] (BusDirection dir, std::vector<Bus>& list)
        {
            list.clear();
            const auto n = component->getBusCount (kAudio, dir);
            for (int32 i = 0; i < n; ++i)
            {
                BusInfo info {};
                component->getBusInfo (kAudio, dir, i, info);
                Bus b;
                b.name = StringConvert::convert (info.name);
                b.busType = info.busType;
                b.defaultActive = (info.flags & BusInfo::kDefaultActive) != 0;
                b.active = b.defaultActive;
                SpeakerArrangement a = 0;
                if (processor->getBusArrangement (dir, i, a) != kResultTrue || (a == 0 && info.channelCount > 0))
                    a = info.channelCount <= 0 ? 0 : info.channelCount == 1 ? SpeakerArr::kMono
                      : info.channelCount == 2 ? SpeakerArr::kStereo : (SpeakerArrangement) ((1ull << info.channelCount) - 1);
                b.arr = b.defArr = a;
                list.push_back (std::move (b));
            }
        };
        read (kInput, ins);
        read (kOutput, outs);
    }

    int VstInstance::mainInChannels() const { return ins.empty() ? 0 : channelCount (ins[0].arr); }
    int VstInstance::mainOutChannels() const { return outs.empty() ? 0 : channelCount (outs[0].arr); }
    bool VstInstance::hasSidechainBus() const { return ins.size() > 1; }
    bool VstInstance::sidechainActive() const { return ins.size() > 1 && ins[1].active; }

    json::Value VstInstance::busesJson() const
    {
        auto one = [] (const std::vector<Bus>& list)
        {
            auto arr = json::Value::array();
            for (auto& b : list)
            {
                auto o = json::Value::object();
                o.set ("name", b.name);
                o.set ("channels", channelCount (b.arr));
                o.set ("default_channels", channelCount (b.defArr));
                o.set ("type", b.busType == kMain ? "main" : "aux");
                o.set ("active", b.active);
                arr.push (o);
            }
            return arr;
        };
        auto o = json::Value::object();
        o.set ("in", one (ins));
        o.set ("out", one (outs));
        return o;
    }

    bool VstInstance::applyArrangements (int channels, bool sidechain)
    {
        const SpeakerArrangement mainArr = channels == 1 ? SpeakerArr::kMono : SpeakerArr::kStereo;
        std::vector<SpeakerArrangement> inA, outA;
        for (size_t i = 0; i < ins.size(); ++i)
        {
            SpeakerArrangement a = ins[i].defArr;
            if (i == 0) a = mainArr;
            else if (i == 1 && sidechain && a == 0) a = SpeakerArr::kStereo;
            inA.push_back (a);
        }
        for (size_t i = 0; i < outs.size(); ++i)
            outA.push_back (i == 0 ? (ins.empty() ? SpeakerArr::kStereo : mainArr) : outs[i].defArr);
        if (ins.empty() && channels == 1 && ! outA.empty()) outA[0] = SpeakerArr::kMono;

        // Des plugins plantent si on leur passe nullptr (JUCE fait de même).
        SpeakerArrangement none = 0;
        const tresult r = processor->setBusArrangements (inA.empty() ? &none : inA.data(), (int32) inA.size(),
                                                         outA.empty() ? &none : outA.data(), (int32) outA.size());
        // Ce que le plugin a vraiment retenu.
        for (int32 i = 0; i < (int32) ins.size(); ++i)
        {
            SpeakerArrangement a = 0;
            if (processor->getBusArrangement (kInput, i, a) == kResultTrue) ins[(size_t) i].arr = a;
        }
        for (int32 i = 0; i < (int32) outs.size(); ++i)
        {
            SpeakerArrangement a = 0;
            if (processor->getBusArrangement (kOutput, i, a) == kResultTrue) outs[(size_t) i].arr = a;
        }
        // Bus actifs : principaux ; side-chain seulement si demandée (comme pedalboard, qui coupe
        // tous les bus secondaires qui l'acceptent).
        for (size_t i = 0; i < ins.size(); ++i) ins[i].active = i == 0 || (i == 1 && sidechain);
        for (size_t i = 0; i < outs.size(); ++i) outs[i].active = i == 0;

        bool ok = r == kResultTrue || r == kNotImplemented;
        if (! ins.empty() && channelCount (ins[0].arr) != channelCount (mainArr)) ok = false;
        if (! outs.empty() && channelCount (outs[0].arr) != channelCount (outA[0])) ok = false;
        return ok;
    }

    void VstInstance::deactivate()
    {
        if (! prepared) return;
        processor->setProcessing (false);
        component->setActive (false);
        prepared = false;
    }

    json::Value VstInstance::prepare (double sampleRate, int maxBlock, bool offline, int channels, bool sidechain)
    {
        std::lock_guard<std::mutex> l (processLock);
        maxBlock = std::max (1, std::min (maxBlock, shm::kMaxFrames));
        channels = channels == 1 ? 1 : 2;
        sidechain = sidechain && hasSidechainBus();
        const bool same = prepared && currentRate == sampleRate && maxBlockSize == maxBlock && offlineMode == offline
                       && preparedChannels == channels && sidechainOn == sidechain;
        bool ok = true;
        if (! same)
        {
            deactivate();
            ProcessSetup setup { offline ? kOffline : kRealtime, kSample32, maxBlock, sampleRate };
            processor->setupProcessing (setup);
            ok = applyArrangements (channels, sidechain);
            if (ok)
            {
                for (int32 i = 0; i < (int32) ins.size(); ++i) component->activateBus (kAudio, kInput, i, ins[(size_t) i].active);
                for (int32 i = 0; i < (int32) outs.size(); ++i) component->activateBus (kAudio, kOutput, i, outs[(size_t) i].active);
                for (auto dir : { kInput, kOutput })
                    for (int32 i = component->getBusCount (kEvent, dir); --i >= 0;)
                        component->activateBus (kEvent, dir, i, true);
                cachedLatency = std::max (0, (int) processor->getLatencySamples());

                // Un tampon de secours par canal de chaque bus (entrées muettes, sorties ignorées).
                int total = 0;
                for (auto& b : ins) total += channelCount (b.arr);
                for (auto& b : outs) total += channelCount (b.arr);
                scratch.assign ((size_t) total, std::vector<float> ((size_t) maxBlock, 0.0f));
                inBus.assign (ins.size(), AudioBusBuffers {});
                outBus.assign (outs.size(), AudioBusBuffers {});
                int nin = 0, nout = 0;
                for (auto& b : ins) nin += channelCount (b.arr);
                for (auto& b : outs) nout += channelCount (b.arr);
                inPtrs.assign ((size_t) nin, nullptr);
                outPtrs.assign ((size_t) nout, nullptr);

                component->setActive (true);
                processor->setProcessing (true);
                prepared = true;
                currentRate = sampleRate;
                maxBlockSize = maxBlock;
                offlineMode = offline;
                preparedChannels = channels;
                sidechainOn = sidechain;
                continuous = 0;
            }
        }
        auto o = json::Value::object();
        o.set ("ok", ok);
        o.set ("main_in", mainInChannels());
        o.set ("main_out", mainOutChannels());
        o.set ("sidechain", sidechainActive());
        o.set ("latency", cachedLatency.load());
        o.set ("buses", busesJson());
        return o;
    }

    void VstInstance::release()
    {
        std::lock_guard<std::mutex> l (processLock);
        deactivate();
    }

    void VstInstance::reset()
    {
        std::lock_guard<std::mutex> l (processLock);
        if (! prepared) return;
        processor->setProcessing (false);
        component->setActive (false);
        component->setActive (true);
        processor->setProcessing (true);
        continuous = 0;
    }

    //==========================================================================
    namespace
    {
        // MIDI (octets) → événement VST3, comme JUCE (note on à vélocité 0 = note off).
        bool toEvent (const shm::MidiEvent& m, int offset, Event& e)
        {
            const uint8_t st = m.data[0] & 0xF0, ch = m.data[0] & 0x0F;
            e = {};
            e.busIndex = 0;
            e.sampleOffset = offset;
            e.ppqPosition = 0;
            e.flags = Event::kIsLive;
            if (st == 0x90 && m.size >= 3 && m.data[2] > 0)
            {
                e.type = Event::kNoteOnEvent;
                e.noteOn.channel = ch;
                e.noteOn.pitch = m.data[1] & 0x7F;
                e.noteOn.velocity = (float) (m.data[2] & 0x7F) / 127.0f;
                e.noteOn.length = 0;
                e.noteOn.tuning = 0;
                e.noteOn.noteId = -1;
                return true;
            }
            if (st == 0x80 || (st == 0x90 && m.size >= 3))
            {
                e.type = Event::kNoteOffEvent;
                e.noteOff.channel = ch;
                e.noteOff.pitch = m.data[1] & 0x7F;
                e.noteOff.velocity = (float) (m.data[2] & 0x7F) / 127.0f;
                e.noteOff.tuning = 0;
                e.noteOff.noteId = -1;
                return true;
            }
            if (st == 0xA0 && m.size >= 3)
            {
                e.type = Event::kPolyPressureEvent;
                e.polyPressure.channel = ch;
                e.polyPressure.pitch = m.data[1] & 0x7F;
                e.polyPressure.pressure = (float) (m.data[2] & 0x7F) / 127.0f;
                e.polyPressure.noteId = -1;
                return true;
            }
            return false;
        }
    }

    void VstInstance::processRequest (shm::Header& h, float* in, float* key, float* out)
    {
        std::lock_guard<std::mutex> l (processLock);
        h.status = 0;
        h.nOutChanges = 0;
        h.error[0] = 0;
        h.processUs = 0;
        if (! prepared)
        {
            h.status = -1;
            std::snprintf (h.error, sizeof (h.error), "plugin non préparé");
            return;
        }
        const int nframes = (int) std::min<uint32_t> (h.nframes, (uint32_t) shm::kMaxFrames);
        int block = h.blockSize > 0 ? (int) h.blockSize : maxBlockSize;
        block = std::max (1, std::min (block, maxBlockSize));
        const int inCh = (int) std::min<uint32_t> (h.inChannels, (uint32_t) shm::kMaxChannels);
        const int keyCh = (int) std::min<uint32_t> (h.keyChannels, (uint32_t) shm::kMaxKeyChannels);

        if (h.flags & shm::kResetFirst)
        {
            processor->setProcessing (false);
            component->setActive (false);
            component->setActive (true);
            processor->setProcessing (true);
            continuous = 0;
        }

        std::map<ParamID, double> pending;
        {
            std::lock_guard<std::mutex> pl (paramLock);
            pending.swap (pendingToProcessor);
        }

        const int nChanges = (int) std::min<uint32_t> (h.nChanges, (uint32_t) shm::kMaxChanges);
        const int nEvents = (int) std::min<uint32_t> (h.nEvents, (uint32_t) shm::kMaxEvents);
        int ci = 0, ei = 0;
        std::map<ParamID, double> lastOut;
        LARGE_INTEGER f, t0, t1;
        QueryPerformanceFrequency (&f);
        double us = 0;

        for (int start = 0; start < nframes; start += block)
        {
            const int n = std::min (block, nframes - start);

            // Tampons : bus principaux et side-chain dans la mémoire partagée, le reste en secours.
            int sIdx = 0, flat = 0;
            for (size_t b = 0; b < ins.size(); ++b)
            {
                const int nch = channelCount (ins[b].arr);
                for (int c = 0; c < nch; ++c, ++sIdx, ++flat)
                {
                    float* p = nullptr;
                    if (b == 0 && ins[b].active)
                    {
                        if (c < inCh) p = in + (size_t) c * shm::kMaxFrames + start;
                        else if (inCh == 1) p = in + start;   // entrée mono → toutes les voies
                    }
                    else if (b == 1 && ins[b].active && keyCh > 0)
                        p = key + (size_t) std::min (c, keyCh - 1) * shm::kMaxFrames + start;
                    if (p == nullptr)
                    {
                        auto& s = scratch[(size_t) sIdx];
                        std::fill (s.begin(), s.begin() + n, 0.0f);
                        p = s.data();
                    }
                    inPtrs[(size_t) flat] = p;
                }
                inBus[b].numChannels = nch;
                inBus[b].silenceFlags = 0;
                inBus[b].channelBuffers32 = nch > 0 ? &inPtrs[(size_t) (flat - nch)] : nullptr;
            }
            flat = 0;
            for (size_t b = 0; b < outs.size(); ++b)
            {
                const int nch = channelCount (outs[b].arr);
                for (int c = 0; c < nch; ++c, ++sIdx, ++flat)
                {
                    float* p;
                    if (b == 0 && c < shm::kMaxChannels) p = out + (size_t) c * shm::kMaxFrames + start;
                    else p = scratch[(size_t) sIdx].data();
                    std::fill (p, p + n, 0.0f);
                    outPtrs[(size_t) flat] = p;
                }
                outBus[b].numChannels = nch;
                outBus[b].silenceFlags = 0;
                outBus[b].channelBuffers32 = nch > 0 ? &outPtrs[(size_t) (flat - nch)] : nullptr;
            }

            inChanges.clearQueue();
            outChanges.clearQueue();
            inEvents.clear();
            outEvents.clear();
            if (start == 0)
                for (auto& [id, v] : pending)
                {
                    int32 qi = 0, pi = 0;
                    if (auto* q = inChanges.addParameterData (id, qi)) q->addPoint (0, v, pi);
                }
            while (ci < nChanges && h.changes[ci].offset < start + n)
            {
                const auto& c = h.changes[ci++];
                const int off = std::max (0, c.offset - start);
                int32 qi = 0, pi = 0;
                if (auto* q = inChanges.addParameterData (c.id, qi)) q->addPoint (off, c.value, pi);
                // Le cache (valeur affichée par l'hôte) suit l'automation.
                const int idx = indexOf (c.id);
                if (idx >= 0) cache[(size_t) idx].store ((float) c.value);
                std::lock_guard<std::mutex> pl (paramLock);
                pendingToController[c.id] = c.value;
            }
            while (ei < nEvents && h.events[ei].offset < start + n)
            {
                const auto& m = h.events[ei++];
                const int off = std::max (0, m.offset - start);
                Event e {};
                if (toEvent (m, off, e)) { inEvents.addEvent (e); continue; }
                // Contrôleurs → réglages (IMidiMapping), comme JUCE.
                const uint8_t st = m.data[0] & 0xF0, ch = m.data[0] & 0x0F;
                CtrlNumber ctrl = -1;
                double v = 0;
                if (st == 0xB0 && m.size >= 3) { ctrl = m.data[1] & 0x7F; v = (m.data[2] & 0x7F) / 127.0; }
                else if (st == 0xD0 && m.size >= 2) { ctrl = kAfterTouch; v = (m.data[1] & 0x7F) / 127.0; }
                else if (st == 0xE0 && m.size >= 3) { ctrl = kPitchBend; v = (double) (((m.data[2] & 0x7F) << 7) | (m.data[1] & 0x7F)) / 16383.0; }
                if (ctrl < 0) continue;
                const ParamID pid = ccMap.empty() ? kNoParamId : ccMap[(size_t) ch * 130 + (size_t) ctrl];
                if (pid != kNoParamId)
                {
                    int32 qi = 0, pi = 0;
                    if (auto* q = inChanges.addParameterData (pid, qi)) q->addPoint (off, v, pi);
                }
            }

            ProcessContext ctx {};
            ctx.sampleRate = currentRate;
            if (h.flags & shm::kTransportValid)
            {
                const double bpm = h.tempo > 0 ? h.tempo : 120.0;
                const int num = h.sigNum > 0 ? h.sigNum : 4, den = h.sigDen > 0 ? h.sigDen : 4;
                ctx.projectTimeSamples = h.projectTimeSamples + start;
                ctx.continousTimeSamples = continuous;
                ctx.tempo = bpm;
                ctx.timeSigNumerator = num;
                ctx.timeSigDenominator = den;
                ctx.projectTimeMusic = (double) ctx.projectTimeSamples / currentRate * bpm / 60.0;
                const double barLen = 4.0 * (double) num / (double) den;
                ctx.barPositionMusic = std::floor (ctx.projectTimeMusic / barLen) * barLen;
                ctx.systemTime = (int64) (nowMs() * 1.0e6);
                ctx.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid
                          | ProcessContext::kBarPositionValid | ProcessContext::kSystemTimeValid | ProcessContext::kContTimeValid
                          | ((h.flags & shm::kPlaying) ? ProcessContext::kPlaying : 0);
            }

            ProcessData data;
            data.processMode = offlineMode ? kOffline : kRealtime;
            data.symbolicSampleSize = kSample32;
            data.numSamples = n;
            data.numInputs = (int32) inBus.size();
            data.numOutputs = (int32) outBus.size();
            data.inputs = inBus.empty() ? nullptr : inBus.data();
            data.outputs = outBus.empty() ? nullptr : outBus.data();
            data.inputParameterChanges = &inChanges;
            data.outputParameterChanges = &outChanges;
            data.inputEvents = &inEvents;
            data.outputEvents = &outEvents;
            data.processContext = &ctx;

            QueryPerformanceCounter (&t0);
            auto* proc = processor.get();
            const bool fine = guard::call ([&] { proc->process (data); });
            QueryPerformanceCounter (&t1);
            us += 1.0e6 * (double) (t1.QuadPart - t0.QuadPart) / (double) f.QuadPart;
            if (! fine)
            {
                prepared = false;   // instance inutilisable : le pont la remplace
                h.status = -2;
                std::snprintf (h.error, sizeof (h.error), "le plugin a planté pendant le traitement (code 0x%08X)", guard::lastCode());
                return;
            }
            continuous += n;

            const auto nOut = outChanges.getParameterCount();
            for (int32 i = 0; i < nOut; ++i)
                if (auto* q = outChanges.getParameterData (i); q != nullptr && q->getPointCount() > 0)
                {
                    int32 off = 0;
                    ParamValue v = 0;
                    if (q->getPoint (q->getPointCount() - 1, off, v) == kResultTrue)
                        lastOut[q->getParameterId()] = v;
                }
        }

        if (! lastOut.empty())
        {
            {
                std::lock_guard<std::mutex> pl (paramLock);
                for (auto& [id, v] : lastOut) pendingToController[id] = v;
            }
            uint32_t k = 0;
            for (auto& [id, v] : lastOut)
            {
                const int idx = indexOf (id);
                if (idx >= 0) cache[(size_t) idx].store ((float) v);
                if (k < (uint32_t) shm::kMaxOutChanges) h.outChanges[k++] = { id, 0, v };
            }
            h.nOutChanges = k;
        }
        h.latency = cachedLatency.load();
        h.outFrames = (uint32_t) nframes;
        h.outChannelsWritten = (uint32_t) mainOutChannels();
        h.processUs = us;
    }

    //==========================================================================
    bool VstInstance::getState (std::vector<uint8_t>& comp, std::vector<uint8_t>& ctrl, bool& hasController)
    {
        flushToController();
        comp.clear();
        ctrl.clear();
        hasController = false;
        bool hasComponent = false;
        {
            IPtr<MemoryStream> s = owned (new MemoryStream());
            if (component->getState (s.get()) == kResultTrue)
            {
                comp.assign ((uint8_t*) s->getData(), (uint8_t*) s->getData() + s->getSize());
                hasComponent = true;
            }
        }
        if (controller)
        {
            IPtr<MemoryStream> s = owned (new MemoryStream());
            if (controller->getState (s.get()) == kResultTrue)
            {
                ctrl.assign ((uint8_t*) s->getData(), (uint8_t*) s->getData() + s->getSize());
                hasController = true;
            }
        }
        return hasComponent;
    }

    void VstInstance::setState (const std::vector<uint8_t>* comp, const std::vector<uint8_t>* ctrl)
    {
        flushToController();
        if (comp != nullptr)
        {
            IPtr<MemoryStream> s = owned (new MemoryStream());
            int32 w = 0;
            s->write ((void*) comp->data(), (int32) comp->size(), &w);
            s->seek (0, IBStream::kIBSeekSet, nullptr);
            component->setState (s.get());
            if (controller)
            {
                s->seek (0, IBStream::kIBSeekSet, nullptr);
                controller->setComponentState (s.get());
                refreshValuesFromController();
            }
        }
        if (ctrl != nullptr && controller)
        {
            IPtr<MemoryStream> s = owned (new MemoryStream());
            int32 w = 0;
            s->write ((void*) ctrl->data(), (int32) ctrl->size(), &w);
            s->seek (0, IBStream::kIBSeekSet, nullptr);
            controller->setState (s.get());
        }
    }

    //==========================================================================
    bool VstInstance::hasEditor()
    {
        if (! controller) return false;
        IPtr<IPlugView> v = owned (controller->createView (ViewType::kEditor));
        return v != nullptr;
    }

    IPtr<IPlugView> VstInstance::createView()
    {
        if (! controller) return nullptr;
        return owned (controller->createView (ViewType::kEditor));
    }
}
