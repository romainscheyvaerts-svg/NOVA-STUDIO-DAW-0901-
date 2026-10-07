/*
    NovaARAHost — hôte ARA2 de Nova Studio (Melodyne, VocAlign et autres plugins ARA).

    Lancé (caché) par le pont Python (bridge-python/ara_host.py). Il dialogue en lignes JSON :
      stdin  ← {"id": 1, "cmd": "...", ...}
      stdout → {"id": 1, "ok": true, ...}   ou   {"event": "...", ...}

    Commandes
      ping
      load        plugin (chemin .vst3), sample_rate, block_size?
      setup       clips:[{id, path (wav), name, track, role: edit|dub|guide|context,
                  start (s, temps du morceau), persistent_id}], archive_b64?, tempo?, time_signature?
                  Crée le document ARA (un « clip » = source + modification + région) et restaure
                  l'état des retouches (archive ARA) quand il est fourni.
      analyze     timeout_s? → attend l'analyse (notes) de toutes les sources ; renvoie les notes
      notes       → notes actuelles (après retouches) de chaque clip
      show_editor title?, offscreen? (fenêtre hors écran, sans activation : captures de preuve)
      hide_editor
      snapshot    path (PNG de la fenêtre du plugin, même hors écran)
      render      out_dir, clip_ids? → rendu hors temps réel de chaque clip edit|dub en WAV
      archive     → archive ARA (base64) de tout le document : les retouches, pour rouvrir
      transport   playing, position? (s) → lecture temps réel sur la carte son
      quit
    Évènements
      editor_closed, transport_request {kind: start|stop|position|cycle, value}, analysis_progress,
      content_changed {clip}, playback {playing, position}, log
*/

#include <JuceHeader.h>
#include <ARA_API/ARAInterface.h>
#include <ARA_Library/Dispatch/ARAHostDispatch.h>

#if JUCE_WINDOWS
 #include <windows.h>
#endif

using namespace juce;

//==============================================================================
// Sortie JSON (stdout), protégée : plusieurs threads peuvent écrire.
namespace io
{
    static std::mutex outLock;

    static void writeLine (const var& v)
    {
        auto s = JSON::toString (v, true).replace ("\n", " ") + "\n";
        std::lock_guard<std::mutex> l (outLock);
       #if JUCE_WINDOWS
        auto h = GetStdHandle (STD_OUTPUT_HANDLE);
        DWORD written = 0;
        auto utf8 = s.toStdString();
        WriteFile (h, utf8.data(), (DWORD) utf8.size(), &written, nullptr);
        FlushFileBuffers (h);
       #else
        std::fputs (s.toRawUTF8(), stdout);
        std::fflush (stdout);
       #endif
    }

    static DynamicObject::Ptr obj() { return new DynamicObject(); }

    static void event (const String& name, DynamicObject::Ptr o = nullptr)
    {
        if (o == nullptr) o = obj();
        o->setProperty ("event", name);
        writeLine (var (o.get()));
    }

    static void log (const String& msg)
    {
        auto o = obj();
        o->setProperty ("message", msg);
        event ("log", o);
    }
}

//==============================================================================
// Modèle : un clip NOVA = une source audio ARA + une modification + une région de lecture.
struct HostClip
{
    String id, name, track, role;
    std::string persistentId, modificationId, nameUtf8;
    AudioBuffer<float> audio;
    double sampleRate = 44100.0;
    double start = 0.0;     // position dans le morceau (s)

    double duration() const { return audio.getNumSamples() / sampleRate; }

    std::unique_ptr<ARAHostModel::AudioSource> source;
    std::unique_ptr<ARAHostModel::AudioModification> modification;
    std::unique_ptr<ARAHostModel::PlaybackRegion> region;

    bool rendersThroughPlugin() const { return role == "edit" || role == "dub"; }

    using Converter = ARAHostModel::ConversionFunctions<HostClip*, ARA::ARAAudioSourceHostRef>;
};

struct HostTrack
{
    String name;
    std::string nameUtf8;
    int order = 0;
    std::unique_ptr<ARAHostModel::RegionSequence> sequence;
};

//==============================================================================
class AudioAccess final : public ARA::Host::AudioAccessControllerInterface
{
public:
    struct Reader { HostClip* clip; bool use64; };
    using Conv = ARAHostModel::ConversionFunctions<Reader*, ARA::ARAAudioReaderHostRef>;

    ARA::ARAAudioReaderHostRef createAudioReaderForSource (ARA::ARAAudioSourceHostRef src, bool use64) noexcept override
    {
        auto r = std::make_unique<Reader> (Reader { HostClip::Converter::fromHostRef (src), use64 });
        readersCreated++;
        auto ref = Conv::toHostRef (r.get());
        std::lock_guard<std::mutex> l (lock);
        readers.emplace (r.get(), std::move (r));
        return ref;
    }

    bool readAudioSamples (ARA::ARAAudioReaderHostRef ref, ARA::ARASamplePosition pos,
                           ARA::ARASampleCount count, void* const* buffers) noexcept override
    {
        auto* r = Conv::fromHostRef (ref);
        auto& a = r->clip->audio;
        const auto total = (ARA::ARASampleCount) a.getNumSamples();
        for (int ch = 0; ch < a.getNumChannels(); ++ch)
        {
            for (ARA::ARASampleCount i = 0; i < count; ++i)
            {
                const auto p = pos + i;
                const float v = (p >= 0 && p < total) ? a.getSample (ch, (int) p) : 0.0f;
                if (r->use64) static_cast<double*> (buffers[ch])[i] = v;
                else          static_cast<float*>  (buffers[ch])[i] = v;
            }
        }
        return true;
    }

    void destroyAudioReader (ARA::ARAAudioReaderHostRef ref) noexcept override
    {
        std::lock_guard<std::mutex> l (lock);
        readers.erase (Conv::fromHostRef (ref));
    }

    std::atomic<int> readersCreated { 0 };

private:
    std::mutex lock;
    std::map<Reader*, std::unique_ptr<Reader>> readers;
};

class Archiving final : public ARA::Host::ArchivingControllerInterface
{
public:
    using RConv = ARAHostModel::ConversionFunctions<MemoryBlock*, ARA::ARAArchiveReaderHostRef>;
    using WConv = ARAHostModel::ConversionFunctions<MemoryOutputStream*, ARA::ARAArchiveWriterHostRef>;

    ARA::ARASize getArchiveSize (ARA::ARAArchiveReaderHostRef r) noexcept override { return (ARA::ARASize) RConv::fromHostRef (r)->getSize(); }

    bool readBytesFromArchive (ARA::ARAArchiveReaderHostRef r, ARA::ARASize pos, ARA::ARASize len, ARA::ARAByte* buf) noexcept override
    {
        auto* m = RConv::fromHostRef (r);
        if (pos + len > m->getSize()) return false;
        std::memcpy (buf, addBytesToPointer (m->getData(), pos), len);
        return true;
    }

    bool writeBytesToArchive (ARA::ARAArchiveWriterHostRef w, ARA::ARASize pos, ARA::ARASize len, const ARA::ARAByte* buf) noexcept override
    {
        auto* s = WConv::fromHostRef (w);
        return s->setPosition ((int64) pos) && s->write (buf, len);
    }

    void notifyDocumentArchivingProgress (float) noexcept override {}
    void notifyDocumentUnarchivingProgress (float) noexcept override {}
    ARA::ARAPersistentID getDocumentArchiveID (ARA::ARAArchiveReaderHostRef) noexcept override { return archiveId.empty() ? nullptr : archiveId.c_str(); }

    std::string archiveId;
};

class ContentAccess final : public ARA::Host::ContentAccessControllerInterface
{
public:
    using Conv = ARAHostModel::ConversionFunctions<intptr_t, ARA::ARAContentReaderHostRef>;
    std::atomic<double> bpm { 120.0 };
    int sigNum = 4, sigDen = 4;

    bool isMusicalContextContentAvailable (ARA::ARAMusicalContextHostRef, ARA::ARAContentType t) noexcept override
    {
        return t == ARA::kARAContentTypeTempoEntries || t == ARA::kARAContentTypeBarSignatures;
    }
    ARA::ARAContentGrade getMusicalContextContentGrade (ARA::ARAMusicalContextHostRef, ARA::ARAContentType) noexcept override { return ARA::kARAContentGradeAdjusted; }
    ARA::ARAContentReaderHostRef createMusicalContextContentReader (ARA::ARAMusicalContextHostRef, ARA::ARAContentType t, const ARA::ARAContentTimeRange*) noexcept override { return Conv::toHostRef ((intptr_t) t); }
    bool isAudioSourceContentAvailable (ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept override { return false; }
    ARA::ARAContentGrade getAudioSourceContentGrade (ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept override { return ARA::kARAContentGradeInitial; }
    ARA::ARAContentReaderHostRef createAudioSourceContentReader (ARA::ARAAudioSourceHostRef, ARA::ARAContentType, const ARA::ARAContentTimeRange*) noexcept override { return nullptr; }

    ARA::ARAInt32 getContentReaderEventCount (ARA::ARAContentReaderHostRef r) noexcept override
    {
        const auto t = (ARA::ARAContentType) Conv::fromHostRef (r);
        if (t == ARA::kARAContentTypeTempoEntries) return 2;
        if (t == ARA::kARAContentTypeBarSignatures) return 1;
        return 0;
    }

    const void* getContentReaderDataForEvent (ARA::ARAContentReaderHostRef r, ARA::ARAInt32 i) noexcept override
    {
        const auto t = (ARA::ARAContentType) Conv::fromHostRef (r);
        if (t == ARA::kARAContentTypeTempoEntries)
        {
            // Deux points suffisent pour un tempo constant : 0 s = noire 0, 1 mesure plus loin.
            const double q = i == 0 ? 0.0 : 4.0;
            tempo.quarterPosition = q;
            tempo.timePosition = q * 60.0 / bpm.load();
            return &tempo;
        }
        bar.position = 0.0;
        bar.numerator = sigNum;
        bar.denominator = sigDen;
        return &bar;
    }

    void destroyContentReader (ARA::ARAContentReaderHostRef) noexcept override {}

private:
    ARA::ARAContentTempoEntry tempo {};
    ARA::ARAContentBarSignature bar {};
};

struct HostCallbacks
{
    std::function<void (HostClip*, int, float)> analysisProgress;
    std::function<void (const String&, const String&)> contentChanged;
    std::function<void (const String&, double)> transportRequest;
};

class ModelUpdates final : public ARA::Host::ModelUpdateControllerInterface
{
public:
    explicit ModelUpdates (HostCallbacks& c) : cb (c) {}

    void notifyAudioSourceAnalysisProgress (ARA::ARAAudioSourceHostRef src, ARA::ARAAnalysisProgressState state, float value) noexcept override
    {
        if (cb.analysisProgress) cb.analysisProgress (HostClip::Converter::fromHostRef (src), (int) state, value);
    }
    void notifyAudioSourceContentChanged (ARA::ARAAudioSourceHostRef src, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
    {
        if (cb.contentChanged) cb.contentChanged ("source", HostClip::Converter::fromHostRef (src)->id);
    }
    void notifyAudioModificationContentChanged (ARA::ARAAudioModificationHostRef m, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
    {
        auto* clip = ARAHostModel::ConversionFunctions<HostClip*, ARA::ARAAudioModificationHostRef>::fromHostRef (m);
        if (cb.contentChanged) cb.contentChanged ("modification", clip->id);
    }
    void notifyPlaybackRegionContentChanged (ARA::ARAPlaybackRegionHostRef r, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
    {
        auto* clip = ARAHostModel::ConversionFunctions<HostClip*, ARA::ARAPlaybackRegionHostRef>::fromHostRef (r);
        if (cb.contentChanged) cb.contentChanged ("region", clip->id);
    }
    void notifyDocumentDataChanged() noexcept override
    {
        if (cb.contentChanged) cb.contentChanged ("document", {});
    }

private:
    HostCallbacks& cb;
};

class PlaybackRequests final : public ARA::Host::PlaybackControllerInterface
{
public:
    explicit PlaybackRequests (HostCallbacks& c) : cb (c) {}
    void requestStartPlayback() noexcept override { if (cb.transportRequest) cb.transportRequest ("start", 0); }
    void requestStopPlayback() noexcept override { if (cb.transportRequest) cb.transportRequest ("stop", 0); }
    void requestSetPlaybackPosition (ARA::ARATimePosition t) noexcept override { if (cb.transportRequest) cb.transportRequest ("position", t); }
    void requestSetCycleRange (ARA::ARATimePosition, ARA::ARATimeDuration) noexcept override {}
    void requestEnableCycle (bool) noexcept override {}
private:
    HostCallbacks& cb;
};

//==============================================================================
struct NovaPlayHead final : public AudioPlayHead
{
    Optional<PositionInfo> getPosition() const override
    {
        PositionInfo p;
        const auto sr = sampleRate.load();
        const auto t = timeInSamples.load();
        const auto b = bpm.load();
        p.setTimeInSamples (t);
        p.setTimeInSeconds ((double) t / sr);
        p.setBpm (b);
        p.setTimeSignature (TimeSignature { 4, 4 });
        p.setPpqPosition ((double) t / sr * b / 60.0);
        p.setIsPlaying (playing.load());
        return p;
    }
    std::atomic<int64> timeInSamples { 0 };
    std::atomic<bool> playing { false };
    std::atomic<double> sampleRate { 44100.0 };
    std::atomic<double> bpm { 120.0 };
};

//==============================================================================
static const ARA::ARAPlugInExtensionInstance* rawExtension (const ARAHostModel::PlugInExtensionInstance& e)
{
    // PlugInExtensionInstance ne donne pas accès au rôle « vue d'éditeur » (sélection) : son seul
    // membre est le pointeur ARA d'origine.
    static_assert (sizeof (ARAHostModel::PlugInExtensionInstance) == sizeof (void*));
    return *reinterpret_cast<const ARA::ARAPlugInExtensionInstance* const*> (&e);
}

//==============================================================================
class EditorWindow final : public DocumentWindow
{
public:
    EditorWindow (const String& title, bool offscreenIn, std::function<void()> onCloseIn)
        : DocumentWindow (title, Colour (0xff15161c), DocumentWindow::closeButton | DocumentWindow::minimiseButton, false),
          offscreen (offscreenIn), onClose (std::move (onCloseIn))
    {
        setUsingNativeTitleBar (true);
        setResizable (true, false);
    }

    int getDesktopWindowStyleFlags() const override
    {
        auto f = DocumentWindow::getDesktopWindowStyleFlags();
        if (offscreen)
            f = (f & ~ComponentPeer::windowAppearsOnTaskbar) | ComponentPeer::windowIgnoresKeyPresses;
        return f;
    }

    void closeButtonPressed() override
    {
        setVisible (false);
        if (onClose) onClose();
    }

    bool offscreen;
    std::function<void()> onClose;
};

//==============================================================================
class AraSession final : private Timer, private AudioIODeviceCallback
{
public:
    AraSession()
    {
        callbacks.analysisProgress = [this] (HostClip* c, int state, float value)
        {
            auto o = io::obj();
            o->setProperty ("clip", c->id);
            o->setProperty ("state", state == ARA::kARAAnalysisProgressCompleted ? "done" : (state == ARA::kARAAnalysisProgressStarted ? "start" : "progress"));
            o->setProperty ("value", value);
            io::event ("analysis_progress", o);
        };
        callbacks.contentChanged = [] (const String& scope, const String& clip)
        {
            auto o = io::obj();
            o->setProperty ("scope", scope);
            o->setProperty ("clip", clip);
            io::event ("content_changed", o);
        };
        callbacks.transportRequest = [this] (const String& kind, double value)
        {
            auto o = io::obj();
            o->setProperty ("kind", kind);
            o->setProperty ("value", value);
            io::event ("transport_request", o);
            // L'hôte suit aussi la demande lui-même (lecture du clip dans la fenêtre du plugin).
            MessageManager::callAsync ([this, kind, value]
            {
                if (kind == "start") startPlayback (-1);
                else if (kind == "stop") stopPlayback();
                else if (kind == "position") setPosition (value);
            });
        };
        startTimer (40);
    }

    ~AraSession() override
    {
        stopTimer();
        shutdownAudio();
        editorWindow.reset();
        clearDocument();
        if (instance != nullptr) instance->releaseResources();
        documentController.reset();
        instance.reset();
    }

    //==========================================================================
    var load (const var& req)
    {
        if (instance != nullptr) throw std::runtime_error ("Un plugin est déjà chargé dans cet hôte");
        const auto path = req["plugin"].toString();
        sampleRate = (double) req.getProperty ("sample_rate", 44100.0);
        blockSize = (int) req.getProperty ("block_size", 1024);

        addDefaultFormatsToManager (formats);
        OwnedArray<PluginDescription> types;
        for (auto* f : formats.getFormats())
            if (f->getName() == "VST3")
                f->findAllTypesForFile (types, path);
        if (types.isEmpty()) throw std::runtime_error (("Plugin introuvable ou illisible : " + path).toStdString());

        description = *types[0];
        String err;
        instance = formats.createPluginInstance (description, sampleRate, blockSize, err);
        if (instance == nullptr) throw std::runtime_error (("Chargement impossible : " + err).toStdString());

        instance->setPlayHead (&playHead);
        playHead.sampleRate = sampleRate;

        if (! (bool) req.getProperty ("ara", true))
        {
            // Mode sans ARA (capture) : plugin seul, entrées principale + sidechain.
            auto out = io::obj();
            out->setProperty ("name", description.name);
            out->setProperty ("vendor", description.manufacturerName);
            out->setProperty ("ara", false);
            out->setProperty ("has_ara_extension", description.hasARAExtension);
            out->setProperty ("input_buses", instance->getBusCount (true));
            out->setProperty ("editor", instance->hasEditor());
            return var (out.get());
        }
        ARAFactoryWrapper factory;
        bool done = false;
        createARAFactoryAsync (*instance, [&] (ARAFactoryWrapper f) { factory = std::move (f); done = true; });
        // VST3 : la fabrique ARA est donnée tout de suite (pas d'attente asynchrone réelle).
        if (! done || factory.get() == nullptr)
            throw std::runtime_error ("Ce plugin n'a pas d'extension ARA2");

        const auto* fac = factory.get();
        auto out = io::obj();
        out->setProperty ("name", description.name);
        out->setProperty ("vendor", description.manufacturerName);
        out->setProperty ("version", description.version);
        out->setProperty ("ara", true);
        out->setProperty ("ara_plugin_name", String (fac->plugInName));
        out->setProperty ("ara_manufacturer", String (fac->manufacturerName));
        out->setProperty ("ara_version", String (fac->version));
        out->setProperty ("ara_api_generation", (int) fac->highestSupportedApiGeneration);
        Array<var> analyzable;
        for (ARA::ARASize i = 0; i < fac->analyzeableContentTypesCount; ++i)
            analyzable.add (contentTypeName (fac->analyzeableContentTypes[i]));
        out->setProperty ("analyzable", analyzable);
        out->setProperty ("transformations", (int) fac->supportedPlaybackTransformationFlags);
        canAnalyzeNotes = false;
        for (ARA::ARASize i = 0; i < fac->analyzeableContentTypesCount; ++i)
            if (fac->analyzeableContentTypes[i] == ARA::kARAContentTypeNotes) canAnalyzeNotes = true;

        auto audio = std::make_unique<AudioAccess>();
        audioAccess = audio.get();
        auto arch = std::make_unique<Archiving>();
        archiving = arch.get();
        // Identifiant des archives écrites par ce plugin : demandé par le plugin à la restauration.
        archiving->archiveId = fac->documentArchiveID != nullptr ? fac->documentArchiveID : "";
        out->setProperty ("archive_id", String (archiving->archiveId));
        auto content = std::make_unique<ContentAccess>();
        contentAccess = content.get();
        documentController = ARAHostDocumentController::create (std::move (factory), "Nova Studio",
                                                                std::move (audio), std::move (arch), std::move (content),
                                                                std::make_unique<ModelUpdates> (callbacks),
                                                                std::make_unique<PlaybackRequests> (callbacks));
        if (documentController == nullptr) throw std::runtime_error ("Le plugin refuse de créer un document ARA");

        const auto roles = ARA::kARAPlaybackRendererRole | ARA::kARAEditorRendererRole | ARA::kARAEditorViewRole;
        extension = documentController->bindDocumentToPluginInstance (*instance, roles, roles);
        if (! extension.isValid()) throw std::runtime_error ("Liaison ARA refusée par le plugin");
        playbackRenderer = extension.getPlaybackRendererInterface();
        editorRenderer = extension.getEditorRendererInterface();

        auto& dc = dcRef();
        {
            const ARAEditGuard g (dc);
            auto props = ARAHostModel::MusicalContext::getEmptyProperties();
            props.name = "Morceau";
            props.orderIndex = 0;
            musicalContext = std::make_unique<ARAHostModel::MusicalContext> (ARA::ARAMusicalContextHostRef {}, dc, props);
        }
        out->setProperty ("editor", instance->hasEditor());
        out->setProperty ("latency_samples", instance->getLatencySamples());
        return var (out.get());
    }

    //==========================================================================
    var setup (const var& req)
    {
        requireLoaded();
        auto& dc = dcRef();
        clearDocument();
        contentAccess->bpm = (double) req.getProperty ("tempo", 120.0);
        playHead.bpm = contentAccess->bpm.load();
        if (auto* ts = req["time_signature"].getArray(); ts != nullptr && ts->size() == 2)
        {
            contentAccess->sigNum = (int) (*ts)[0];
            contentAccess->sigDen = (int) (*ts)[1];
        }

        WavAudioFormat wav;
        AudioFormatManager afm;
        afm.registerBasicFormats();
        auto* list = req["clips"].getArray();
        if (list == nullptr || list->isEmpty()) throw std::runtime_error ("Aucun clip à ouvrir");

        for (auto& c : *list)
        {
            auto clip = std::make_unique<HostClip>();
            clip->id = c["id"].toString();
            clip->name = c.getProperty ("name", clip->id).toString();
            clip->track = c.getProperty ("track", clip->name).toString();
            clip->role = c.getProperty ("role", "edit").toString();
            clip->start = (double) c.getProperty ("start", 0.0);
            clip->persistentId = c.getProperty ("persistent_id", clip->id).toString().toStdString();
            clip->modificationId = clip->persistentId + "/modif";
            clip->nameUtf8 = clip->name.toStdString();
            File f (c["path"].toString());
            std::unique_ptr<AudioFormatReader> reader (afm.createReaderFor (f));
            if (reader == nullptr) throw std::runtime_error (("Audio illisible : " + f.getFullPathName()).toStdString());
            clip->sampleRate = reader->sampleRate;
            clip->audio.setSize ((int) jmax (1u, reader->numChannels), (int) reader->lengthInSamples);
            reader->read (&clip->audio, 0, (int) reader->lengthInSamples, 0, true, true);
            clips.push_back (std::move (clip));
        }

        {
            const ARAEditGuard g (dc);
            int order = 0;
            for (auto& clip : clips)
            {
                auto* track = trackFor (clip->track, order);
                auto sp = ARAHostModel::AudioSource::getEmptyProperties();
                sp.name = clip->nameUtf8.c_str();
                sp.persistentID = clip->persistentId.c_str();
                sp.sampleCount = clip->audio.getNumSamples();
                sp.sampleRate = clip->sampleRate;
                sp.channelCount = clip->audio.getNumChannels();
                sp.merits64BitSamples = false;
                clip->source = std::make_unique<ARAHostModel::AudioSource> (HostClip::Converter::toHostRef (clip.get()), dc, sp);

                auto mp = ARAHostModel::AudioModification::getEmptyProperties();
                mp.name = clip->nameUtf8.c_str();
                mp.persistentID = clip->modificationId.c_str();
                clip->modification = std::make_unique<ARAHostModel::AudioModification> (
                    ARAHostModel::ConversionFunctions<HostClip*, ARA::ARAAudioModificationHostRef>::toHostRef (clip.get()), dc, *clip->source, mp);

                auto rp = ARAHostModel::PlaybackRegion::getEmptyProperties();
                rp.transformationFlags = ARA::kARAPlaybackTransformationNoChanges;
                rp.startInModificationTime = 0.0;
                rp.durationInModificationTime = clip->duration();
                rp.startInPlaybackTime = clip->start;
                rp.durationInPlaybackTime = clip->duration();
                rp.musicalContextRef = musicalContext->getPluginRef();
                rp.regionSequenceRef = track->sequence->getPluginRef();
                rp.name = clip->nameUtf8.c_str();
                rp.color = nullptr;
                clip->region = std::make_unique<ARAHostModel::PlaybackRegion> (
                    ARAHostModel::ConversionFunctions<HostClip*, ARA::ARAPlaybackRegionHostRef>::toHostRef (clip.get()), dc, *clip->modification, rp);
            }

            dc.updateMusicalContextContent (musicalContext->getPluginRef(), nullptr, ARA::ContentUpdateScopes::timelineIsAffected());
            restored = false;
            const auto archiveB64 = req["archive_b64"].toString();
            if (archiveB64.isNotEmpty())
            {
                MemoryBlock m;
                if (m.fromBase64Encoding (archiveB64) && m.getSize() > 0)
                    restored = dc.restoreObjectsFromArchive (Archiving::RConv::toHostRef (&m), nullptr);
            }
        }

        for (auto& clip : clips)
            clip->source->enableAudioSourceSamplesAccess (true);

        instance->releaseResources();
        prepared = Prepared::none;
        assignRenderers (nullptr);

        auto out = io::obj();
        out->setProperty ("clips", (int) clips.size());
        out->setProperty ("restored", restored);
        return var (out.get());
    }

    //==========================================================================
    // Analyse : réponse différée (le timer la termine).
    void analyze (const var& req, std::function<void (var, String)> reply)
    {
        requireLoaded();
        if (clips.empty()) throw std::runtime_error ("Aucun clip : appelle setup d'abord");
        auto& dc = dcRef();
        if (canAnalyzeNotes)
        {
            const ARA::ARAContentType types[] { ARA::kARAContentTypeNotes };
            for (auto& c : clips)
                if (dc.isAudioSourceContentAnalysisIncomplete (c->source->getPluginRef(), ARA::kARAContentTypeNotes))
                    dc.requestAudioSourceContentAnalysis (c->source->getPluginRef(), 1, types);
        }
        pendingAnalysis = std::make_unique<PendingAnalysis>();
        pendingAnalysis->reply = std::move (reply);
        pendingAnalysis->started = Time::getMillisecondCounterHiRes();
        pendingAnalysis->timeoutMs = 1000.0 * (double) req.getProperty ("timeout_s", 120.0);
    }

    var notes()
    {
        requireLoaded();
        auto out = io::obj();
        Array<var> arr;
        for (auto& c : clips)
        {
            auto o = io::obj();
            o->setProperty ("id", c->id);
            o->setProperty ("role", c->role);
            o->setProperty ("duration", c->duration());
            o->setProperty ("source_notes", readNotes (*c, false));
            o->setProperty ("notes", readNotes (*c, true));
            arr.add (var (o.get()));
        }
        out->setProperty ("clips", arr);
        out->setProperty ("can_analyze_notes", canAnalyzeNotes);
        out->setProperty ("audio_readers", audioAccess != nullptr ? audioAccess->readersCreated.load() : 0);
        return var (out.get());
    }

    //==========================================================================
    var showEditor (const var& req)
    {
        if (instance == nullptr) throw std::runtime_error ("Aucun plugin chargé");
        if (! instance->hasEditor()) throw std::runtime_error ("Ce plugin n'a pas de fenêtre");
        const bool offscreen = (bool) req.getProperty ("offscreen", false);
        if (editorWindow == nullptr || editorWindow->offscreen != offscreen)
        {
            editorWindow.reset();
            auto* ed = instance->createEditorIfNeeded();
            if (ed == nullptr) throw std::runtime_error ("Fenêtre du plugin indisponible");
            editorWindow = std::make_unique<EditorWindow> (req.getProperty ("title", description.name).toString(), offscreen,
                                                           [] { io::event ("editor_closed"); });
            editorWindow->setContentOwned (ed, true);
        }
        if (documentController != nullptr) notifySelection();
        if (offscreen)
        {
            editorWindow->setTopLeftPosition (-20000, -20000);
            editorWindow->addToDesktop (editorWindow->getDesktopWindowStyleFlags());
            editorWindow->setVisible (true);
        }
        else
        {
            editorWindow->centreWithSize (editorWindow->getWidth(), editorWindow->getHeight());
            editorWindow->setVisible (true);
            editorWindow->toFront (true);
        }
        auto out = io::obj();
        out->setProperty ("width", editorWindow->getWidth());
        out->setProperty ("height", editorWindow->getHeight());
        return var (out.get());
    }

    var select()
    {
        requireLoaded();
        notifySelection();
        return notes();
    }

    var hideEditor()
    {
        if (editorWindow != nullptr)
        {
            editorWindow->setVisible (false);
            editorWindow.reset();
        }
        return var (io::obj().get());
    }

    var snapshot (const var& req)
    {
        if (editorWindow == nullptr || ! editorWindow->isVisible()) throw std::runtime_error ("Aucune fenêtre ouverte");
        File f (req["path"].toString());
       #if JUCE_WINDOWS
        auto* peer = editorWindow->getPeer();
        if (peer == nullptr) throw std::runtime_error ("Fenêtre sans peer");
        auto hwnd = (HWND) peer->getNativeHandle();
        RECT rc;
        GetWindowRect (hwnd, &rc);
        const int w = rc.right - rc.left, h = rc.bottom - rc.top;
        HDC screen = GetDC (nullptr);
        HDC mem = CreateCompatibleDC (screen);
        BITMAPINFO bi {};
        bi.bmiHeader.biSize = sizeof (BITMAPINFOHEADER);
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        void* bits = nullptr;
        HBITMAP bmp = CreateDIBSection (screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
        auto old = SelectObject (mem, bmp);
        const BOOL okPrint = PrintWindow (hwnd, mem, 2 /* PW_RENDERFULLCONTENT */);
        Image img (Image::RGB, w, h, false);
        {
            Image::BitmapData bd (img, Image::BitmapData::writeOnly);
            for (int y = 0; y < h; ++y)
                for (int x = 0; x < w; ++x)
                {
                    auto* p = static_cast<uint8*> (bits) + (y * w + x) * 4;
                    bd.setPixelColour (x, y, Colour (p[2], p[1], p[0]));
                }
        }
        SelectObject (mem, old);
        DeleteObject (bmp);
        DeleteDC (mem);
        ReleaseDC (nullptr, screen);
        f.deleteFile();
        FileOutputStream os (f);
        PNGImageFormat png;
        if (! os.openedOk() || ! png.writeImageToStream (img, os)) throw std::runtime_error ("Écriture PNG impossible");
        auto out = io::obj();
        out->setProperty ("path", f.getFullPathName());
        out->setProperty ("width", w);
        out->setProperty ("height", h);
        out->setProperty ("print_window", okPrint != 0);
        return var (out.get());
       #else
        throw std::runtime_error ("Capture disponible sous Windows seulement");
       #endif
    }

    //==========================================================================
    // Touches clavier envoyées directement à la fenêtre du plugin (sans la mettre au premier plan) :
    // l'état des modificateurs (Ctrl, Maj) est celui du fil de l'interface, qui est le nôtre.
    var keys (const var& req)
    {
        if (editorWindow == nullptr || ! editorWindow->isVisible()) throw std::runtime_error ("Aucune fenêtre ouverte");
       #if JUCE_WINDOWS
        auto top = (HWND) editorWindow->getPeer()->getNativeHandle();
        std::vector<HWND> kids;
        EnumChildWindows (top, [] (HWND h, LPARAM lp) -> BOOL { reinterpret_cast<std::vector<HWND>*> (lp)->push_back (h); return TRUE; }, (LPARAM) &kids);
        Array<var> list;
        HWND target = top;
        long bestArea = -1;
        for (size_t i = 0; i < kids.size(); ++i)
        {
            RECT r; GetWindowRect (kids[i], &r);
            char cls[128] {}; GetClassNameA (kids[i], cls, 127);
            const long area = (long) (r.right - r.left) * (long) (r.bottom - r.top);
            auto o = io::obj();
            o->setProperty ("class", String (cls));
            o->setProperty ("w", (int) (r.right - r.left));
            o->setProperty ("h", (int) (r.bottom - r.top));
            list.add (var (o.get()));
            if (IsWindowVisible (kids[i]) && area > bestArea) { bestArea = area; target = kids[i]; }
        }
        if (req.hasProperty ("target_index"))
        {
            const int ti = (int) req["target_index"];
            if (ti >= 0 && ti < (int) kids.size()) target = kids[(size_t) ti];
        }
        SetFocus (target);
        if (auto* arr = req["keys"].getArray())
        {
            for (auto& k : *arr)
            {
                if (auto* pt = k["click"].getArray(); pt != nullptr && pt->size() == 2)
                {
                    // Descend jusqu'à la fenêtre enfant la plus profonde sous le point (boutons MFC…).
                    POINT p { (int) (*pt)[0], (int) (*pt)[1] };
                    HWND hit = target;
                    for (int depth = 0; depth < 16; ++depth)
                    {
                        HWND c = ChildWindowFromPointEx (hit, p, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
                        if (c == nullptr || c == hit) break;
                        MapWindowPoints (hit, c, &p, 1);
                        hit = c;
                    }
                    const LPARAM xy = MAKELPARAM (p.x, p.y);
                    auto* savedTarget = target;
                    target = hit;
                    const bool post = (bool) req.getProperty ("post", false);
                    auto send = [&] (UINT m, WPARAM w) { if (post) PostMessageA (target, m, w, xy); else SendMessageA (target, m, w, xy); };
                    send (WM_MOUSEACTIVATE, 0);
                    send (WM_MOUSEMOVE, 0);
                    MessageManager::getInstance()->runDispatchLoopUntil (40);
                    send (WM_LBUTTONDOWN, MK_LBUTTON);
                    MessageManager::getInstance()->runDispatchLoopUntil (60);
                    send (WM_LBUTTONUP, 0);
                    MessageManager::getInstance()->runDispatchLoopUntil (80);
                    target = savedTarget;
                    continue;
                }
                const int vk = (int) k["vk"];
                BYTE saved[256], ks[256];
                GetKeyboardState (saved);
                std::memcpy (ks, saved, sizeof (ks));
                if ((bool) k.getProperty ("ctrl", false)) ks[VK_CONTROL] = ks[VK_LCONTROL] = 0x80;
                if ((bool) k.getProperty ("shift", false)) ks[VK_SHIFT] = ks[VK_LSHIFT] = 0x80;
                if ((bool) k.getProperty ("alt", false)) ks[VK_MENU] = ks[VK_LMENU] = 0x80;
                ks[vk & 0xff] = 0x80;
                SetKeyboardState (ks);
                const UINT sc = MapVirtualKeyA ((UINT) vk, MAPVK_VK_TO_VSC);
                const bool ext = vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT || vk == VK_DELETE || vk == VK_HOME || vk == VK_END;
                const LPARAM down = 1 | ((LPARAM) sc << 16) | (ext ? (1 << 24) : 0);
                const LPARAM up = down | (1u << 30) | (1u << 31);
                SendMessageA (target, WM_KEYDOWN, (WPARAM) vk, down);
                if (k.hasProperty ("char")) SendMessageA (target, WM_CHAR, (WPARAM) (int) k["char"], down);
                SendMessageA (target, WM_KEYUP, (WPARAM) vk, up);
                std::memcpy (ks, saved, sizeof (ks));
                SetKeyboardState (saved);
                MessageManager::getInstance()->runDispatchLoopUntil (60);
            }
        }
        auto out = io::obj();
        out->setProperty ("children", list);
        return var (out.get());
       #else
        throw std::runtime_error ("Windows seulement");
       #endif
    }

    //==========================================================================
    var render (const var& req)
    {
        requireLoaded();
        File dir (req["out_dir"].toString());
        dir.createDirectory();
        StringArray only;
        if (auto* ids = req["clip_ids"].getArray())
            for (auto& v : *ids) only.add (v.toString());

        const bool wasPlaying = playHead.playing.load();
        stopPlayback();
        Array<var> results;
        {
            const SpinLock::ScopedLockType sl (renderLock);
            for (auto& c : clips)
            {
                if (! c->rendersThroughPlugin()) continue;
                if (! only.isEmpty() && ! only.contains (c->id)) continue;
                results.add (renderClip (*c, dir));
            }
            instance->releaseResources();
            prepared = Prepared::none;
            assignRenderers (nullptr);
        }
        if (wasPlaying) startPlayback (-1);
        auto out = io::obj();
        out->setProperty ("rendered", results);
        return var (out.get());
    }

    var archive()
    {
        requireLoaded();
        MemoryOutputStream os;
        const bool ok = dcRef().storeObjectsToArchive (Archiving::WConv::toHostRef (&os), nullptr);
        if (! ok) throw std::runtime_error ("Le plugin n'a pas pu sauvegarder ses retouches");
        auto out = io::obj();
        out->setProperty ("archive_b64", os.getMemoryBlock().toBase64Encoding());
        out->setProperty ("size", (int) os.getDataSize());
        return var (out.get());
    }

    var transport (const var& req)
    {
        requireLoaded();
        if (req.hasProperty ("tempo"))
        {
            contentAccess->bpm = (double) req["tempo"];
            playHead.bpm = contentAccess->bpm.load();
            const ARAEditGuard g (dcRef());
            dcRef().updateMusicalContextContent (musicalContext->getPluginRef(), nullptr, ARA::ContentUpdateScopes::timelineIsAffected());
        }
        if (req.hasProperty ("position")) setPosition ((double) req["position"]);
        if (req.hasProperty ("playing"))
        {
            if ((bool) req["playing"]) startPlayback (-1);
            else stopPlayback();
        }
        auto out = io::obj();
        out->setProperty ("playing", playHead.playing.load());
        out->setProperty ("position", (double) playHead.timeInSamples.load() / playHead.sampleRate.load());
        out->setProperty ("audio_device", deviceName);
        return var (out.get());
    }

private:
    enum class Prepared { none, offline, realtime };

    struct PendingAnalysis
    {
        std::function<void (var, String)> reply;
        double started = 0, timeoutMs = 120000;
    };

    ARA::Host::DocumentController& dcRef() { return documentController->getDocumentController(); }

    void requireLoaded() const
    {
        if (instance == nullptr || documentController == nullptr) throw std::runtime_error ("Aucun plugin ARA chargé");
    }

public:
    //==========================================================================
    // Mode capture (sans ARA), comme VocAlign dans un hôte sans ARA : le double sur l'entrée
    // principale, le guide sur l'entrée sidechain, transport en lecture. Passe 1 = capture,
    // attente de l'alignement, passe 2 = sortie alignée.
    var captureAlign (const var& req)
    {
        if (instance == nullptr) throw std::runtime_error ("Aucun plugin chargé");
        AudioFormatManager afm;
        afm.registerBasicFormats();
        auto readAll = [&] (const String& path, AudioBuffer<float>& b) -> double
        {
            std::unique_ptr<AudioFormatReader> r (afm.createReaderFor (File (path)));
            if (r == nullptr) throw std::runtime_error (("Audio illisible : " + path).toStdString());
            b.setSize ((int) r->numChannels, (int) r->lengthInSamples);
            r->read (&b, 0, (int) r->lengthInSamples, 0, true, true);
            return r->sampleRate;
        };
        AudioBuffer<float> dub, guide;
        const double sr = readAll (req["dub"].toString(), dub);
        readAll (req["guide"].toString(), guide);
        instance->releaseResources();
        auto layout = instance->getBusesLayout();
        bool sidechain = false;
        if (instance->getBusCount (true) > 1)
        {
            const AudioChannelSet sets[] { AudioChannelSet::stereo(), AudioChannelSet::mono() };
            for (auto& a : sets)
            {
                for (auto& b : sets)
                {
                    auto l2 = layout;
                    l2.inputBuses.getReference (0) = a;
                    l2.inputBuses.getReference (1) = b;
                    if (instance->checkBusesLayoutSupported (l2) && instance->setBusesLayout (l2)) { sidechain = true; layout = l2; break; }
                }
                if (sidechain) break;
            }
            if (! sidechain)
            {
                instance->enableAllBuses();
                layout = instance->getBusesLayout();
                sidechain = layout.inputBuses.size() > 1 && layout.getNumChannels (true, 1) > 0;
            }
        }
        const int mainIn = layout.getNumChannels (true, 0);
        const int scIn = sidechain ? layout.getNumChannels (true, 1) : 0;
        const int totalIn = instance->getTotalNumInputChannels();
        const int totalOut = instance->getTotalNumOutputChannels();
        const bool realtime = (bool) req.getProperty ("realtime", false);
        instance->setNonRealtime (! realtime);
        instance->prepareToPlay (sr, blockSize);
        playHead.sampleRate = sr;
        // Clics dans la fenêtre du plugin une fois prêt (ex. armer « Capture » du Dub).
        if (req.hasProperty ("clicks"))
        {
            auto k = io::obj();
            k->setProperty ("keys", req["clicks"]);
            k->setProperty ("target_index", req.getProperty ("target_index", 1));
            keys (var (k.get()));
        }
        const int passes = (int) req.getProperty ("passes", 2);
        const double waitS = (double) req.getProperty ("wait_s", 3.0);
        const int64 len = dub.getNumSamples();
        AudioBuffer<float> out (jmax (1, jmin (2, totalOut)), (int) len);
        AudioBuffer<float> block (jmax (totalIn, totalOut, 2), blockSize);
        MidiBuffer midi;
        for (int pass = 0; pass < passes; ++pass)
        {
            playHead.playing = true;
            for (int64 pos = 0; pos < len; pos += blockSize)
            {
                const int n = (int) jmin ((int64) blockSize, len - pos);
                block.setSize (block.getNumChannels(), n, false, false, true);
                block.clear();
                for (int ch = 0; ch < mainIn; ++ch)
                    block.copyFrom (ch, 0, dub, jmin (ch, dub.getNumChannels() - 1), (int) pos, n);
                for (int ch = 0; ch < scIn; ++ch)
                    if (pos < guide.getNumSamples())
                        block.copyFrom (mainIn + ch, 0, guide, jmin (ch, guide.getNumChannels() - 1), (int) pos, (int) jmin ((int64) n, guide.getNumSamples() - pos));
                playHead.timeInSamples = pos;
                instance->processBlock (block, midi);
                if (pass == passes - 1)
                    for (int ch = 0; ch < out.getNumChannels(); ++ch)
                        out.copyFrom (ch, (int) pos, block, ch, 0, n);
                if (realtime) Thread::sleep ((int) (1000.0 * n / sr));
            }
            playHead.playing = false;
            // Quelques blocs à l'arrêt, puis le temps que le plugin aligne (fil de fond du plugin).
            for (int i = 0; i < 8; ++i) { block.clear(); instance->processBlock (block, midi); }
            if (pass < passes - 1) MessageManager::getInstance()->runDispatchLoopUntil ((int) (waitS * 1000));
        }
        instance->releaseResources();
        File f (req["out"].toString());
        f.deleteFile();
        WavAudioFormat wav;
        std::unique_ptr<OutputStream> os (f.createOutputStream().release());
        auto opts = AudioFormatWriterOptions{}.withSampleRate (sr).withNumChannels (out.getNumChannels()).withBitsPerSample (32)
                        .withSampleFormat (AudioFormatWriterOptions::SampleFormat::floatingPoint);
        auto writer = wav.createWriterFor (os, opts);
        if (writer == nullptr) throw std::runtime_error ("Encodeur WAV indisponible");
        writer->writeFromAudioSampleBuffer (out, 0, out.getNumSamples());
        writer.reset();
        auto o = io::obj();
        o->setProperty ("path", f.getFullPathName());
        o->setProperty ("sidechain", sidechain);
        o->setProperty ("main_in", mainIn);
        o->setProperty ("sidechain_in", scIn);
        o->setProperty ("layout", layout.getMainInputChannelSet().getDescription() + " / bus 2 : "
                                    + (layout.inputBuses.size() > 1 ? layout.inputBuses[1].getDescription() : String ("aucun")));
        o->setProperty ("peak", out.getMagnitude (0, out.getNumSamples()));
        return var (o.get());
    }

private:

    static String contentTypeName (ARA::ARAContentType t)
    {
        switch (t)
        {
            case ARA::kARAContentTypeNotes: return "notes";
            case ARA::kARAContentTypeTempoEntries: return "tempo";
            case ARA::kARAContentTypeBarSignatures: return "bar_signatures";
            case ARA::kARAContentTypeStaticTuning: return "tuning";
            case ARA::kARAContentTypeKeySignatures: return "key_signatures";
            case ARA::kARAContentTypeSheetChords: return "chords";
            default: return "type_" + String ((int) t);
        }
    }

    HostTrack* trackFor (const String& name, int& order)
    {
        for (auto& t : tracks)
            if (t->name == name) return t.get();
        auto t = std::make_unique<HostTrack>();
        t->name = name;
        t->nameUtf8 = name.toStdString();
        t->order = order++;
        auto p = ARAHostModel::RegionSequence::getEmptyProperties();
        p.name = t->nameUtf8.c_str();
        p.orderIndex = t->order;
        p.musicalContextRef = musicalContext->getPluginRef();
        p.color = nullptr;
        t->sequence = std::make_unique<ARAHostModel::RegionSequence> (
            ARAHostModel::ConversionFunctions<HostTrack*, ARA::ARARegionSequenceHostRef>::toHostRef (t.get()), dcRef(), p);
        tracks.push_back (std::move (t));
        return tracks.back().get();
    }

    void clearDocument()
    {
        if (documentController == nullptr) { clips.clear(); tracks.clear(); return; }
        if (instance != nullptr) instance->releaseResources();
        prepared = Prepared::none;
        for (auto& c : clips)
        {
            if (inPlayback.count (c.get())) playbackRenderer.remove (*c->region);
            if (inEditor.count (c.get())) editorRenderer.remove (*c->region);
        }
        inPlayback.clear();
        inEditor.clear();
        const ARAEditGuard g (dcRef());
        clips.clear();      // régions → modifications → sources (ordre des membres)
        tracks.clear();
    }

    // Régions confiées au rendu du plugin (doit être appelé plugin non préparé).
    void assignRenderers (HostClip* only)
    {
        for (auto& c : clips)
        {
            const bool wantPlay = only != nullptr ? (c.get() == only) : c->rendersThroughPlugin();
            const bool inPlay = inPlayback.count (c.get()) > 0;
            if (wantPlay && ! inPlay) { playbackRenderer.add (*c->region); inPlayback.insert (c.get()); }
            if (! wantPlay && inPlay) { playbackRenderer.remove (*c->region); inPlayback.erase (c.get()); }
            if (! inEditor.count (c.get())) { editorRenderer.add (*c->region); inEditor.insert (c.get()); }
        }
    }

    void notifySelection()
    {
        const auto* ext = rawExtension (extension);
        if (ext == nullptr || ext->editorViewInterface == nullptr || ext->editorViewRef == nullptr) return;
        std::vector<ARA::ARAPlaybackRegionRef> regions;
        std::vector<ARA::ARARegionSequenceRef> seqs;
        for (auto& c : clips)
            if (c->role != "context") regions.push_back (c->region->getPluginRef());
        for (auto& t : tracks) seqs.push_back (t->sequence->getPluginRef());
        auto sel = makeARASizedStruct (&ARA::ARAViewSelection::timeRange);
        sel.playbackRegionRefsCount = regions.size();
        sel.playbackRegionRefs = regions.data();
        sel.regionSequenceRefsCount = seqs.size();
        sel.regionSequenceRefs = seqs.data();
        sel.timeRange = nullptr;
        ext->editorViewInterface->notifySelection (ext->editorViewRef, &sel);
    }

    var readNotes (HostClip& c, bool modification)
    {
        Array<var> arr;
        auto& dc = dcRef();
        const auto type = ARA::kARAContentTypeNotes;
        ARA::ARAContentReaderRef reader = nullptr;
        if (modification)
        {
            if (! dc.isAudioModificationContentAvailable (c.modification->getPluginRef(), type)) return arr;
            reader = dc.createAudioModificationContentReader (c.modification->getPluginRef(), type, nullptr);
        }
        else
        {
            if (! dc.isAudioSourceContentAvailable (c.source->getPluginRef(), type)) return arr;
            reader = dc.createAudioSourceContentReader (c.source->getPluginRef(), type, nullptr);
        }
        if (reader == nullptr) return arr;
        const auto n = dc.getContentReaderEventCount (reader);
        for (ARA::ARAInt32 i = 0; i < n; ++i)
        {
            const auto* note = static_cast<const ARA::ARAContentNote*> (dc.getContentReaderDataForEvent (reader, i));
            if (note == nullptr) continue;
            Array<var> row;
            row.add (note->frequency);
            row.add ((int) note->pitchNumber);
            row.add (note->volume);
            row.add (note->startPosition);
            row.add (note->noteDuration);
            arr.add (row);
        }
        dc.destroyContentReader (reader);
        return arr;   // [fréquence Hz, n° MIDI, volume, début s, durée s]
    }

    var renderClip (HostClip& c, const File& dir)
    {
        auto& dc = dcRef();
        instance->releaseResources();
        prepared = Prepared::none;
        assignRenderers (&c);
        const double sr = c.sampleRate;
        instance->setNonRealtime (true);
        instance->prepareToPlay (sr, blockSize);
        prepared = Prepared::offline;
        playHead.sampleRate = sr;

        ARA::ARATimeDuration head = 0, tail = 0;
        dc.getPlaybackRegionHeadAndTailTime (c.region->getPluginRef(), &head, &tail);
        tail = jmin (tail, 10.0);
        head = jmin (head, 10.0);
        const int latency = instance->getLatencySamples();
        const int64 startS = (int64) std::floor ((c.start - head) * sr);
        const int64 wantS = (int64) std::llround (c.start * sr);
        const int64 lenS = c.audio.getNumSamples();
        const int64 endS = wantS + lenS + (int64) std::ceil (tail * sr) + latency;
        const int nch = jmax (2, instance->getTotalNumInputChannels(), instance->getTotalNumOutputChannels());
        const int outCh = jmax (1, instance->getTotalNumOutputChannels());

        AudioBuffer<float> outBuf (jmin (2, outCh), (int) (lenS + (int64) std::ceil (tail * sr)));
        outBuf.clear();
        AudioBuffer<float> block (nch, blockSize);
        MidiBuffer midi;
        playHead.playing = true;
        double peak = 0;
        for (int64 pos = startS; pos < endS; pos += blockSize)
        {
            const int n = (int) jmin ((int64) blockSize, endS - pos);
            block.setSize (nch, n, false, false, true);
            block.clear();
            playHead.timeInSamples = pos;
            instance->processBlock (block, midi);
            // Échantillon de sortie « pos + i - latence » du morceau → index dans le clip.
            for (int i = 0; i < n; ++i)
            {
                const int64 songPos = pos + i - latency;
                const int64 idx = songPos - wantS;
                if (idx < 0 || idx >= outBuf.getNumSamples()) continue;
                for (int ch = 0; ch < outBuf.getNumChannels(); ++ch)
                {
                    const float v = block.getSample (jmin (ch, outCh - 1), i);
                    outBuf.setSample (ch, (int) idx, v);
                    peak = jmax (peak, (double) std::abs (v));
                }
            }
        }
        playHead.playing = false;
        instance->releaseResources();
        instance->setNonRealtime (false);
        prepared = Prepared::none;

        auto f = dir.getChildFile (File::createLegalFileName (c.id) + ".wav");
        f.deleteFile();
        WavAudioFormat wav;
        std::unique_ptr<OutputStream> os (f.createOutputStream().release());
        if (os == nullptr) throw std::runtime_error ("Écriture du rendu impossible");
        auto opts = AudioFormatWriterOptions{}.withSampleRate (sr).withNumChannels (outBuf.getNumChannels()).withBitsPerSample (32)
                        .withSampleFormat (AudioFormatWriterOptions::SampleFormat::floatingPoint);
        auto writer = wav.createWriterFor (os, opts);
        if (writer == nullptr) throw std::runtime_error ("Encodeur WAV indisponible");
        writer->writeFromAudioSampleBuffer (outBuf, 0, outBuf.getNumSamples());
        writer.reset();

        auto o = io::obj();
        o->setProperty ("id", c.id);
        o->setProperty ("path", f.getFullPathName());
        o->setProperty ("sample_rate", sr);
        o->setProperty ("samples", outBuf.getNumSamples());
        o->setProperty ("tail_s", tail);
        o->setProperty ("latency", latency);
        o->setProperty ("peak", peak);
        return var (o.get());
    }

    //==========================================================================
    void timerCallback() override
    {
        if (documentController == nullptr) return;
        dcRef().notifyModelUpdates();
        if (pendingAnalysis == nullptr) return;
        bool incomplete = false;
        if (canAnalyzeNotes)
            for (auto& c : clips)
                if (dcRef().isAudioSourceContentAnalysisIncomplete (c->source->getPluginRef(), ARA::kARAContentTypeNotes))
                    incomplete = true;
        const auto elapsed = Time::getMillisecondCounterHiRes() - pendingAnalysis->started;
        if (incomplete && elapsed < pendingAnalysis->timeoutMs) return;
        auto p = std::move (pendingAnalysis);
        auto res = notes();
        if (auto* o = res.getDynamicObject())
        {
            o->setProperty ("analysis_seconds", elapsed / 1000.0);
            o->setProperty ("complete", ! incomplete);
        }
        p->reply (res, {});
    }

    //==========================================================================
    // Lecture temps réel (carte son par défaut, WASAPI partagé).
    void ensureAudio()
    {
        if (deviceOpen) return;
        auto err = deviceManager.initialiseWithDefaultDevices (0, 2);
        if (err.isNotEmpty()) throw std::runtime_error (("Carte son : " + err).toStdString());
        if (auto* d = deviceManager.getCurrentAudioDevice()) deviceName = d->getName();
        deviceManager.addAudioCallback (this);
        deviceOpen = true;
    }

    void shutdownAudio()
    {
        if (! deviceOpen) return;
        deviceManager.removeAudioCallback (this);
        deviceManager.closeAudioDevice();
        deviceOpen = false;
    }

    void prepareRealtime()
    {
        if (prepared == Prepared::realtime) return;
        auto* d = deviceManager.getCurrentAudioDevice();
        if (d == nullptr) return;
        const SpinLock::ScopedLockType sl (renderLock);
        instance->releaseResources();
        assignRenderers (nullptr);
        deviceRate = d->getCurrentSampleRate();
        deviceBlock = d->getCurrentBufferSizeSamples();
        instance->setNonRealtime (false);
        instance->prepareToPlay (deviceRate, deviceBlock);
        rtBuffer.setSize (jmax (2, instance->getTotalNumInputChannels(), instance->getTotalNumOutputChannels()), deviceBlock * 2);
        playHead.sampleRate = deviceRate;
        prepared = Prepared::realtime;
    }

    void startPlayback (double positionSeconds)
    {
        try { ensureAudio(); } catch (const std::exception& e) { io::log (e.what()); return; }
        const double keep = (double) playHead.timeInSamples.load() / playHead.sampleRate.load();
        prepareRealtime();
        setPosition (positionSeconds >= 0 ? positionSeconds : keep);
        playHead.playing = true;
        sendPlaybackEvent();
    }

    void stopPlayback()
    {
        if (! playHead.playing.load()) return;
        playHead.playing = false;
        sendPlaybackEvent();
    }

    void setPosition (double seconds)
    {
        playHead.timeInSamples = (int64) std::llround (jmax (0.0, seconds) * playHead.sampleRate.load());
        sendPlaybackEvent();
    }

    void sendPlaybackEvent()
    {
        auto o = io::obj();
        o->setProperty ("playing", playHead.playing.load());
        o->setProperty ("position", (double) playHead.timeInSamples.load() / playHead.sampleRate.load());
        io::event ("playback", o);
    }

    void audioDeviceIOCallbackWithContext (const float* const*, int, float* const* out, int numOut, int n,
                                           const AudioIODeviceCallbackContext&) override
    {
        for (int ch = 0; ch < numOut; ++ch) if (out[ch] != nullptr) FloatVectorOperations::clear (out[ch], n);
        const SpinLock::ScopedTryLockType sl (renderLock);
        if (! sl.isLocked() || prepared != Prepared::realtime || ! playHead.playing.load()) return;
        if (n > rtBuffer.getNumSamples()) return;
        AudioBuffer<float> buf (rtBuffer.getArrayOfWritePointers(), rtBuffer.getNumChannels(), n);
        buf.clear();
        MidiBuffer midi;
        const auto pos = playHead.timeInSamples.load();
        instance->processBlock (buf, midi);
        for (int ch = 0; ch < numOut; ++ch)
            if (out[ch] != nullptr) FloatVectorOperations::copy (out[ch], buf.getReadPointer (jmin (ch, buf.getNumChannels() - 1)), n);
        // Guide / contexte : joués tels quels, à leur place dans le morceau.
        for (auto& c : clips)
        {
            if (c->rendersThroughPlugin()) continue;
            const double ratio = c->sampleRate / deviceRate;
            for (int i = 0; i < n; ++i)
            {
                const int64 idx = (int64) ((double) (pos + i) * ratio - c->start * c->sampleRate);
                if (idx < 0 || idx >= c->audio.getNumSamples()) continue;
                for (int ch = 0; ch < numOut; ++ch)
                    if (out[ch] != nullptr) out[ch][i] += c->audio.getSample (jmin (ch, c->audio.getNumChannels() - 1), (int) idx);
            }
        }
        playHead.timeInSamples = pos + n;
    }

    void audioDeviceAboutToStart (AudioIODevice*) override {}
    void audioDeviceStopped() override {}

    //==========================================================================
    HostCallbacks callbacks;
    AudioPluginFormatManager formats;
    PluginDescription description;
    std::unique_ptr<AudioPluginInstance> instance;
    std::unique_ptr<ARAHostDocumentController> documentController;
    ARAHostModel::PlugInExtensionInstance extension;
    ARAHostModel::PlaybackRendererInterface playbackRenderer;
    ARAHostModel::EditorRendererInterface editorRenderer;
    Archiving* archiving = nullptr;
    AudioAccess* audioAccess = nullptr;
    ContentAccess* contentAccess = nullptr;
    std::unique_ptr<ARAHostModel::MusicalContext> musicalContext;
    std::vector<std::unique_ptr<HostTrack>> tracks;
    std::vector<std::unique_ptr<HostClip>> clips;
    std::set<HostClip*> inPlayback, inEditor;
    std::unique_ptr<EditorWindow> editorWindow;
    std::unique_ptr<PendingAnalysis> pendingAnalysis;
    NovaPlayHead playHead;
    SpinLock renderLock;
    Prepared prepared = Prepared::none;
    AudioDeviceManager deviceManager;
    AudioBuffer<float> rtBuffer;
    String deviceName;
    bool deviceOpen = false, canAnalyzeNotes = false, restored = false;
    double sampleRate = 44100.0, deviceRate = 48000.0;
    int blockSize = 1024, deviceBlock = 512;
};

//==============================================================================
class NovaARAHostApp final : public JUCEApplication
{
public:
    const String getApplicationName() override { return "NovaARAHost"; }
    const String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise (const String&) override
    {
        session = std::make_unique<AraSession>();
        reader = std::thread ([this] { readLoop(); });
        auto o = io::obj();
        o->setProperty ("version", getApplicationVersion());
        o->setProperty ("juce", SystemStats::getJUCEVersion());
        io::event ("ready", o);
    }

    void shutdown() override
    {
        session.reset();
        if (reader.joinable()) reader.detach();
    }

    void systemRequestedQuit() override { quit(); }

private:
    void readLoop()
    {
        std::string line;
       #if JUCE_WINDOWS
        auto h = GetStdHandle (STD_INPUT_HANDLE);
        char buf[65536];
        std::string pending;
        for (;;)
        {
            DWORD got = 0;
            if (! ReadFile (h, buf, sizeof (buf), &got, nullptr) || got == 0) break;
            pending.append (buf, got);
            size_t nl;
            while ((nl = pending.find ('\n')) != std::string::npos)
            {
                auto one = pending.substr (0, nl);
                pending.erase (0, nl + 1);
                post (one);
            }
        }
       #else
        while (std::getline (std::cin, line)) post (line);
       #endif
        // Le pont s'est arrêté : on quitte aussi.
        MessageManager::callAsync ([] { JUCEApplication::getInstance()->systemRequestedQuit(); });
    }

    void post (const std::string& line)
    {
        auto text = String::fromUTF8 (line.c_str()).trim();
        if (text.isEmpty()) return;
        MessageManager::callAsync ([this, text] { handle (text); });
    }

    static void replyOk (const var& id, var payload)
    {
        if (! payload.isObject()) payload = var (io::obj().get());
        payload.getDynamicObject()->setProperty ("id", id);
        payload.getDynamicObject()->setProperty ("ok", true);
        io::writeLine (payload);
    }

    static void replyErr (const var& id, const String& err)
    {
        auto o = io::obj();
        o->setProperty ("id", id);
        o->setProperty ("ok", false);
        o->setProperty ("error", err);
        io::writeLine (var (o.get()));
    }

    void handle (const String& text)
    {
        const auto req = JSON::parse (text);
        const auto id = req["id"];
        const auto cmd = req["cmd"].toString();
        try
        {
            if (cmd == "ping") replyOk (id, {});
            else if (cmd == "load") replyOk (id, session->load (req));
            else if (cmd == "setup") replyOk (id, session->setup (req));
            else if (cmd == "analyze")
                session->analyze (req, [id] (var res, String err) { if (err.isEmpty()) replyOk (id, res); else replyErr (id, err); });
            else if (cmd == "notes") replyOk (id, session->notes());
            else if (cmd == "show_editor") replyOk (id, session->showEditor (req));
            else if (cmd == "hide_editor") replyOk (id, session->hideEditor());
            else if (cmd == "snapshot") replyOk (id, session->snapshot (req));
            else if (cmd == "capture_align") replyOk (id, session->captureAlign (req));
            else if (cmd == "select") replyOk (id, session->select());
            else if (cmd == "keys") replyOk (id, session->keys (req));
            else if (cmd == "render") replyOk (id, session->render (req));
            else if (cmd == "archive") replyOk (id, session->archive());
            else if (cmd == "transport") replyOk (id, session->transport (req));
            else if (cmd == "quit") { replyOk (id, {}); systemRequestedQuit(); }
            else replyErr (id, "Commande inconnue : " + cmd);
        }
        catch (const std::exception& e) { replyErr (id, String::fromUTF8 (e.what())); }
        catch (...) { replyErr (id, "Erreur inconnue dans l'hôte ARA"); }
    }

    std::unique_ptr<AraSession> session;
    std::thread reader;
};

START_JUCE_APPLICATION (NovaARAHostApp)
