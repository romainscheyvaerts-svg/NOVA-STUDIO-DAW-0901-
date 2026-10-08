/*
    NovaARAHost — hébergement VST3 sans JUCE (SDK VST3 Steinberg, licence MIT).
    (c) Make Music.
*/
#include "Vst3Plugin.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

DEF_CLASS_IID (ARA::IMainFactory)
DEF_CLASS_IID (ARA::IPlugInEntryPoint)
DEF_CLASS_IID (ARA::IPlugInEntryPoint2)

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace nova
{
    //==========================================================================
    // Contexte hôte (IHostApplication) : nom de l'hôte + fabrique d'IMessage / IAttributeList.
    class Vst3Plugin::HostContext final : public HostApplication
    {
    public:
        tresult PLUGIN_API getName (String128 n) override
        {
            return StringConvert::convert ("NovaARAHost", n) ? kResultTrue : kInternalError;
        }
    };

    //==========================================================================
    // IComponentHandler : les retouches de paramètres faites dans la fenêtre du plugin sont
    // transmises au processeur au bloc suivant (le contrôleur et le processeur VST3 ne se parlent
    // que par l'hôte).
    class Vst3Plugin::ComponentHandler final : public U::Implements<U::Directly<IComponentHandler, IComponentHandler2>>
    {
    public:
        explicit ComponentHandler (Vst3Plugin& p) : owner (p) {}
        tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
        tresult PLUGIN_API performEdit (ParamID id, ParamValue v) override
        {
            std::lock_guard<std::mutex> l (owner.paramLock);
            owner.pendingToProcessor.emplace_back (id, v);
            return kResultOk;
        }
        tresult PLUGIN_API endEdit (ParamID) override { return kResultOk; }
        tresult PLUGIN_API restartComponent (int32 flags) override
        {
            owner.restartFlags |= flags;
            return kResultOk;
        }
        tresult PLUGIN_API setDirty (TBool) override { return kResultOk; }
        tresult PLUGIN_API requestOpenEditor (FIDString) override { return kResultFalse; }
        tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
        tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }

    private:
        Vst3Plugin& owner;
    };

    //==========================================================================
    static int channelCount (SpeakerArrangement a)
    {
        return SpeakerArr::getChannelCount (a);
    }

    static std::string arrangementName (SpeakerArrangement a)
    {
        if (a == SpeakerArr::kMono) return "Mono";
        if (a == SpeakerArr::kStereo) return "Stereo";
        if (a == SpeakerArr::kEmpty) return "aucun";
        return std::to_string (channelCount (a)) + " canaux";
    }

    Vst3Plugin::Vst3Plugin() = default;

    Vst3Plugin::~Vst3Plugin()
    {
        terminateInstance();
        araMainFactories.clear();
        module.reset();
    }

    void Vst3Plugin::terminateInstance()
    {
        if (prepared) release();
        if (componentCP && controllerCP)
        {
            componentCP->disconnect (controllerCP.get());
            controllerCP->disconnect (componentCP.get());
        }
        componentCP = nullptr;
        controllerCP = nullptr;
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
    }

    void Vst3Plugin::load (const std::string& path)
    {
        std::string err;
        module = VST3::Hosting::Module::create (path, err);
        if (! module)
            throw std::runtime_error ("Plugin introuvable ou illisible : " + path + (err.empty() ? "" : " (" + err + ")"));

        hostContext = owned (static_cast<IHostApplication*> (new HostContext()));
        const auto& factory = module->getFactory();
        factory.setHostContext (hostContext.get());

        const VST3::Hosting::ClassInfo* effect = nullptr;
        const auto infos = factory.classInfos();
        for (auto& ci : infos)
        {
            if (ci.category() == kVstAudioEffectClass && effect == nullptr) effect = &ci;
            if (ci.category() == kARAMainFactoryClass)
                if (auto mf = factory.createInstance<ARA::IMainFactory> (ci.ID()))
                    araMainFactories.push_back (mf);
        }
        if (effect == nullptr) throw std::runtime_error ("Plugin introuvable ou illisible : " + path);

        name = effect->name();
        vendor = effect->vendor().empty() ? factory.info().vendor() : effect->vendor();
        version = effect->version();

        component = factory.createInstance<IComponent> (effect->ID());
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
            TUID cid;
            if (component->getControllerClassId (cid) == kResultTrue)
            {
                controller = factory.createInstance<IEditController> (VST3::UID::fromTUID (cid));
                if (controller && controller->initialize (hostContext.get()) != kResultOk)
                    controller = nullptr;
            }
        }

        if (controller)
        {
            handler = owned (static_cast<IComponentHandler*> (new ComponentHandler (*this)));
            if (! singleComponent)
            {
                auto compICP = U::cast<IConnectionPoint> (component);
                auto ctrlICP = U::cast<IConnectionPoint> (controller);
                if (compICP && ctrlICP)
                {
                    // Liaison directe (comme JUCE) : le ConnectionProxy du SDK refuse les messages
                    // envoyés depuis un autre fil que l'interface, ce que font certains plugins
                    // (VocAlign : fin de capture annoncée par son fil de travail).
                    componentCP = compICP;
                    controllerCP = ctrlICP;
                    compICP->connect (ctrlICP);
                    ctrlICP->connect (compICP);
                }
            }
            controller->setComponentHandler (handler.get());
            // État du composant → contrôleur (synchronisation initiale, comme les DAW).
            IPtr<MemoryStream> state = owned (new MemoryStream());
            if (component->getState (state.get()) == kResultTrue)
            {
                state->seek (0, IBStream::kIBSeekSet, nullptr);
                controller->setComponentState (state.get());
            }
        }
        refreshBuses();
    }

    const ARA::ARAFactory* Vst3Plugin::araFactory() const
    {
        if (araMainFactories.empty()) return nullptr;
        for (auto& mf : araMainFactories)
            if (auto* f = mf->getFactory(); f != nullptr && f->plugInName != nullptr && name == f->plugInName)
                return f;
        return araMainFactories.front()->getFactory();
    }

    const ARA::ARAPlugInExtensionInstance* Vst3Plugin::bindToARA (ARA::ARADocumentControllerRef dc,
                                                                  ARA::ARAPlugInInstanceRoleFlags known,
                                                                  ARA::ARAPlugInInstanceRoleFlags assigned)
    {
        if (auto entry2 = U::cast<ARA::IPlugInEntryPoint2> (component))
            return entry2->bindToDocumentControllerWithRoles (dc, known, assigned);
        return nullptr;
    }

    //==========================================================================
    void Vst3Plugin::refreshBuses()
    {
        auto read = [&] (BusDirection dir, std::vector<Bus>& list)
        {
            const auto n = component->getBusCount (kAudio, dir);
            std::vector<Bus> fresh ((size_t) std::max (0, (int) n));
            for (int32 i = 0; i < n; ++i)
            {
                BusInfo info {};
                component->getBusInfo (kAudio, dir, i, info);
                auto& b = fresh[(size_t) i];
                b.name = StringConvert::convert (info.name);
                b.busType = info.busType;
                b.active = i < (int32) list.size() ? list[(size_t) i].active : (info.flags & BusInfo::kDefaultActive) != 0;
                SpeakerArrangement a = 0;
                if (processor->getBusArrangement (dir, i, a) != kResultTrue)
                    a = info.channelCount <= 0 ? 0 : info.channelCount == 1 ? SpeakerArr::kMono : info.channelCount == 2 ? SpeakerArr::kStereo
                      : (SpeakerArrangement) ((1ull << info.channelCount) - 1);   // repli
                if (a == 0 && info.channelCount > 0) a = info.channelCount == 1 ? SpeakerArr::kMono : SpeakerArr::kStereo;
                b.arr = a;
            }
            list = std::move (fresh);
        };
        read (kInput, ins);
        read (kOutput, outs);
    }

    int Vst3Plugin::busChannels (bool input, int index) const
    {
        auto& l = input ? ins : outs;
        return index >= 0 && index < (int) l.size() ? channelCount (l[(size_t) index].arr) : 0;
    }

    bool Vst3Plugin::busActive (bool input, int index) const
    {
        auto& l = input ? ins : outs;
        return index >= 0 && index < (int) l.size() && l[(size_t) index].active;
    }

    std::string Vst3Plugin::busDescription (bool input, int index) const
    {
        auto& l = input ? ins : outs;
        if (index < 0 || index >= (int) l.size() || ! l[(size_t) index].active) return "aucun";
        return arrangementName (l[(size_t) index].arr);
    }

    int Vst3Plugin::totalInputChannels() const
    {
        int n = 0;
        for (auto& b : ins) if (b.active) n += channelCount (b.arr);
        return n;
    }

    int Vst3Plugin::totalOutputChannels() const
    {
        int n = 0;
        for (auto& b : outs) if (b.active) n += channelCount (b.arr);
        return n;
    }

    bool Vst3Plugin::setInputArrangements (const std::vector<SpeakerArrangement>& arrs)
    {
        if (prepared) release();
        std::vector<SpeakerArrangement> inA, outA;
        for (size_t i = 0; i < ins.size(); ++i) inA.push_back (i < arrs.size() ? arrs[i] : ins[i].arr);
        for (auto& b : outs) outA.push_back (b.arr);
        if (processor->setBusArrangements (inA.data(), (int32) inA.size(), outA.data(), (int32) outA.size()) != kResultTrue)
            return false;
        // Le plugin peut accepter en adaptant : on vérifie ce qu'il a vraiment retenu.
        for (size_t i = 0; i < arrs.size() && i < ins.size(); ++i)
        {
            SpeakerArrangement got = 0;
            if (processor->getBusArrangement (kInput, (int32) i, got) != kResultTrue || got != arrs[i])
            {
                refreshBuses();
                return false;
            }
        }
        for (size_t i = 0; i < arrs.size() && i < ins.size(); ++i) ins[i].active = true;
        refreshBuses();
        return true;
    }

    void Vst3Plugin::enableAllBuses()
    {
        if (prepared) release();
        for (auto& b : ins) b.active = true;
        for (auto& b : outs) b.active = true;
    }

    bool Vst3Plugin::applyArrangements()
    {
        std::vector<SpeakerArrangement> inA, outA;
        for (auto& b : ins) inA.push_back (b.arr);
        for (auto& b : outs) outA.push_back (b.arr);
        const bool ok = processor->setBusArrangements (inA.data(), (int32) inA.size(), outA.data(), (int32) outA.size()) == kResultTrue;
        refreshBuses();
        return ok;
    }

    //==========================================================================
    void Vst3Plugin::prepare (double sampleRate, int maxBlock, bool offline)
    {
        if (prepared) release();
        ProcessSetup setup { offline ? kOffline : kRealtime, kSample32, maxBlock, sampleRate };
        processor->setupProcessing (setup);
        applyArrangements();
        for (int32 i = 0; i < (int32) ins.size(); ++i) component->activateBus (kAudio, kInput, i, ins[(size_t) i].active);
        for (int32 i = 0; i < (int32) outs.size(); ++i) component->activateBus (kAudio, kOutput, i, outs[(size_t) i].active);
        for (auto dir : { kInput, kOutput })
            for (int32 i = 0; i < component->getBusCount (kEvent, dir); ++i)
                component->activateBus (kEvent, dir, i, true);

        // Tampons : un par canal de chaque bus (actif ou non : certains plugins lisent tout).
        auto alloc = [&] (const std::vector<Bus>& list, std::vector<std::vector<float>>& scratch,
                          std::vector<float*>& ptrs, std::vector<AudioBusBuffers>& bufs)
        {
            int total = 0;
            for (auto& b : list) total += channelCount (b.arr);
            scratch.assign ((size_t) total, std::vector<float> ((size_t) maxBlock, 0.0f));
            ptrs.assign ((size_t) total, nullptr);
            bufs.assign (list.size(), AudioBusBuffers {});
        };
        alloc (ins, inScratch, inPtrs, inBusBufs);
        alloc (outs, outScratch, outPtrs, outBusBufs);

        component->setActive (true);
        processor->setProcessing (true);
        prepared = true;
        offlineMode = offline;
        maxBlockSize = maxBlock;
        currentRate = sampleRate;
        continuous = 0;
    }

    void Vst3Plugin::release()
    {
        if (! prepared) return;
        processor->setProcessing (false);
        component->setActive (false);
        prepared = false;
    }

    int Vst3Plugin::latencySamples() const
    {
        return processor ? (int) processor->getLatencySamples() : 0;
    }

    void Vst3Plugin::process (float* const* chans, int numChans, int numSamples, const Transport& t)
    {
        if (! prepared || numSamples <= 0) return;
        numSamples = std::min (numSamples, maxBlockSize);

        // Entrées : les canaux des bus actifs se suivent dans chans ; le reste est du silence.
        int flat = 0, scratchIndex = 0;
        for (size_t b = 0; b < ins.size(); ++b)
        {
            const int nch = channelCount (ins[b].arr);
            for (int c = 0; c < nch; ++c, ++scratchIndex)
            {
                auto& s = inScratch[(size_t) scratchIndex];
                if (ins[b].active && flat < numChans && chans[flat] != nullptr)
                    std::memcpy (s.data(), chans[flat], sizeof (float) * (size_t) numSamples);
                else
                    std::fill (s.begin(), s.begin() + numSamples, 0.0f);
                if (ins[b].active) ++flat;
                inPtrs[(size_t) scratchIndex] = s.data();
            }
            inBusBufs[b].numChannels = nch;
            inBusBufs[b].silenceFlags = 0;
            inBusBufs[b].channelBuffers32 = nch > 0 ? &inPtrs[(size_t) (scratchIndex - nch)] : nullptr;
        }
        scratchIndex = 0;
        for (size_t b = 0; b < outs.size(); ++b)
        {
            const int nch = channelCount (outs[b].arr);
            for (int c = 0; c < nch; ++c, ++scratchIndex)
            {
                auto& s = outScratch[(size_t) scratchIndex];
                std::fill (s.begin(), s.begin() + numSamples, 0.0f);
                outPtrs[(size_t) scratchIndex] = s.data();
            }
            outBusBufs[b].numChannels = nch;
            outBusBufs[b].silenceFlags = 0;
            outBusBufs[b].channelBuffers32 = nch > 0 ? &outPtrs[(size_t) (scratchIndex - nch)] : nullptr;
        }

        // Paramètres venus de la fenêtre du plugin.
        inChanges.clearQueue();
        outChanges.clearQueue();
        {
            std::unique_lock<std::mutex> l (paramLock, std::try_to_lock);
            if (l.owns_lock() && ! pendingToProcessor.empty())
            {
                for (auto& [id, v] : pendingToProcessor)
                {
                    int32 idx = 0;
                    if (auto* q = inChanges.addParameterData (id, idx))
                    {
                        int32 pi = 0;
                        q->addPoint (0, v, pi);
                    }
                }
                pendingToProcessor.clear();
            }
            // Réglages tenus par l'hôte (comme une voie d'automation) : redonnés à chaque bloc.
            if (l.owns_lock())
                for (auto& [id, v] : heldParams)
                {
                    int32 idx = 0;
                    if (auto* q = inChanges.addParameterData (id, idx))
                    {
                        int32 pi = 0;
                        q->addPoint (0, v, pi);
                    }
                }
        }
        inEvents.clear();
        outEvents.clear();

        ProcessContext ctx {};
        const double sr = t.sampleRate > 0 ? t.sampleRate : currentRate;
        ctx.sampleRate = sr;
        ctx.projectTimeSamples = t.timeInSamples;
        ctx.continousTimeSamples = continuous;
        ctx.systemTime = (int64) (nowMs() * 1.0e6);
        ctx.tempo = t.bpm;
        ctx.timeSigNumerator = t.sigNum;
        ctx.timeSigDenominator = t.sigDen;
        ctx.projectTimeMusic = (double) t.timeInSamples / sr * t.bpm / 60.0;
        const double barLen = 4.0 * (double) t.sigNum / (double) std::max (1, t.sigDen);
        ctx.barPositionMusic = std::floor (ctx.projectTimeMusic / barLen) * barLen;
        if (t.musicPos >= 0.0) { ctx.projectTimeMusic = t.musicPos; ctx.barPositionMusic = t.barPos >= 0.0 ? t.barPos : ctx.barPositionMusic; }
        ctx.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid
                  | ProcessContext::kBarPositionValid | ProcessContext::kSystemTimeValid | ProcessContext::kContTimeValid
                  | (t.playing ? ProcessContext::kPlaying : 0);

        ProcessData data;
        data.processMode = offlineMode ? kOffline : kRealtime;
        data.symbolicSampleSize = kSample32;
        data.numSamples = numSamples;
        data.numInputs = (int32) inBusBufs.size();
        data.numOutputs = (int32) outBusBufs.size();
        data.inputs = inBusBufs.empty() ? nullptr : inBusBufs.data();
        data.outputs = outBusBufs.empty() ? nullptr : outBusBufs.data();
        data.inputParameterChanges = &inChanges;
        data.outputParameterChanges = &outChanges;
        data.inputEvents = &inEvents;
        data.outputEvents = &outEvents;
        data.processContext = &ctx;
        processor->process (data);
        continuous += numSamples;

        // Sorties des bus actifs → chans (à la suite) ; les canaux restants gardent l'entrée (JUCE).
        flat = 0;
        scratchIndex = 0;
        for (size_t b = 0; b < outs.size(); ++b)
        {
            const int nch = channelCount (outs[b].arr);
            for (int c = 0; c < nch; ++c, ++scratchIndex)
            {
                if (! outs[b].active) continue;
                if (flat < numChans && chans[flat] != nullptr)
                    std::memcpy (chans[flat], outScratch[(size_t) scratchIndex].data(), sizeof (float) * (size_t) numSamples);
                ++flat;
            }
        }

        // Paramètres renvoyés par le processeur (vu-mètres, etc.) → contrôleur, plus tard.
        const auto n = outChanges.getParameterCount();
        if (n > 0)
        {
            std::unique_lock<std::mutex> l (paramLock, std::try_to_lock);
            if (l.owns_lock())
                for (int32 i = 0; i < n; ++i)
                    if (auto* q = outChanges.getParameterData (i); q != nullptr && q->getPointCount() > 0)
                    {
                        int32 off = 0;
                        ParamValue v = 0;
                        if (q->getPoint (q->getPointCount() - 1, off, v) == kResultTrue)
                            pendingToController.emplace_back (q->getParameterId(), v);
                    }
        }
    }

    std::vector<uint8_t> Vst3Plugin::getState()
    {
        std::vector<uint8_t> out;
        if (! component) return out;
        IPtr<MemoryStream> s = owned (new MemoryStream());
        if (component->getState (s.get()) != kResultTrue) return out;
        const auto* p = reinterpret_cast<const uint8_t*> (s->getData());
        out.assign (p, p + s->getSize());
        return out;
    }

    bool Vst3Plugin::setState (const std::vector<uint8_t>& data)
    {
        if (! component || data.empty()) return false;
        IPtr<MemoryStream> s = owned (new MemoryStream());
        int32 written = 0;
        int64 at = 0;
        s->write (const_cast<uint8_t*> (data.data()), (int32) data.size(), &written);
        s->seek (0, IBStream::kIBSeekSet, &at);
        const bool ok = component->setState (s.get()) == kResultTrue;
        if (controller)
        {
            s->seek (0, IBStream::kIBSeekSet, &at);
            controller->setComponentState (s.get());
        }
        return ok;
    }

    void Vst3Plugin::flushOutputParameters()
    {
        std::vector<std::pair<ParamID, double>> todo;
        {
            std::lock_guard<std::mutex> l (paramLock);
            todo.swap (pendingToController);
        }
        if (controller)
            for (auto& [id, v] : todo)
            {
                // Réglage posé par l'hôte il y a peu : la valeur renvoyée par le processeur est périmée.
                auto it = hostEdits.find (id);
                if (it != hostEdits.end() && nowMs() - it->second < 500.0) continue;
                controller->setParamNormalized (id, v);
            }
    }

    //==========================================================================
    bool Vst3Plugin::hasEditor()
    {
        if (! controller) return false;
        IPtr<IPlugView> v = owned (controller->createView (ViewType::kEditor));
        return v != nullptr;
    }

    IPtr<IPlugView> Vst3Plugin::createView()
    {
        if (! controller) return nullptr;
        return owned (controller->createView (ViewType::kEditor));
    }
}
