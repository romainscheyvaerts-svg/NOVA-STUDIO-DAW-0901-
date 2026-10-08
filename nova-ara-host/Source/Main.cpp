/*
    NovaARAHost — hôte ARA2 de Nova Studio (Melodyne, VocAlign et autres plugins ARA), SANS JUCE :
    SDK VST3 de Steinberg (licence MIT) + SDK ARA de Celemony (Apache 2.0) + API Windows.

    Lancé (caché) par le pont Python (bridge-python/ara_host.py). Il dialogue en lignes JSON :
      stdin  ← {"id": 1, "cmd": "...", ...}
      stdout → {"id": 1, "ok": true, ...}   ou   {"event": "...", ...}

    Commandes
      ping
      load        plugin (chemin .vst3), sample_rate, block_size?, ara? (false : plugin seul, mode capture)
      setup       clips:[{id, path (wav), name, track, role: edit|dub|guide|context,
                  start (s, temps du morceau), persistent_id}], archive_b64?, tempo?, time_signature?
                  Crée le document ARA (un « clip » = source + modification + région) et restaure
                  l'état des retouches (archive ARA) quand il est fourni.
      analyze     timeout_s? → attend l'analyse (notes) de toutes les sources ; renvoie les notes
      notes       → notes actuelles (après retouches) de chaque clip
      select      → sélection ARA (régions + pistes) envoyée à la fenêtre, puis notes
      show_editor title?, offscreen? (fenêtre hors écran, sans activation : captures de preuve)
      hide_editor
      snapshot    path (PNG de la fenêtre du plugin, même hors écran)
      keys        keys:[{vk, ctrl?, shift?, alt?, char?} | {click:[x, y]}], target_index?, post?
      render      out_dir, clip_ids? → rendu hors temps réel de chaque clip edit|dub en WAV
      archive     → archive ARA (base64) de tout le document : les retouches, pour rouvrir
      restore     archive_b64 → restaure une archive dans le document ouvert (sinon : setup archive_b64)
      transport   playing?, position? (s), tempo? → lecture temps réel sur la carte son
      capture_align  dub, guide, out, passes?, wait_s?, realtime?, keep?, clicks?, target_index?
                  (sans ARA : double sur l'entrée principale, guide sur la sidechain, transport en lecture)
      capture_output out, realtime?, keep? → passe de sortie après capture_align keep=true
      quit
    Évènements
      ready, editor_closed, transport_request {kind: start|stop|position, value}, analysis_progress,
      content_changed {scope, clip}, playback {playing, position}, audio_error, log
*/

#include "Common.h"
#include "AudioFile.h"
#include "EditorWindow.h"
#include "Vst3Plugin.h"
#include "WasapiOutput.h"

#include "ARA_API/ARAInterface.h"
#include "ARA_Library/Dispatch/ARAHostDispatch.h"

#include <ole2.h>
#include <wincodec.h>

#include <algorithm>
#include <cmath>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <thread>

using nova::json::Value;
using nova::AudioData;

namespace nova
{
    //==========================================================================
    // Boucle de messages (fil principal = fil de l'interface, comme le MessageManager de JUCE).
    namespace app
    {
        static HWND msgWindow = nullptr;
        static std::mutex queueLock;
        static std::deque<std::function<void()>> queue;
        static int nesting = 0;          // > 0 : à l'intérieur de pumpFor (les tâches attendent)
        static bool processing = false;  // une tâche (commande) est en cours
        static constexpr UINT WM_NOVA_TASK = WM_APP + 1;
        static constexpr UINT_PTR kTimerId = 1;

        // Depuis n'importe quel fil : exécute fn plus tard sur le fil principal.
        static void post (std::function<void()> fn)
        {
            {
                std::lock_guard<std::mutex> l (queueLock);
                queue.push_back (std::move (fn));
            }
            PostMessageW (msgWindow, WM_NOVA_TASK, 0, 0);
        }

        static void runQueue()
        {
            if (processing || nesting > 0) return;
            processing = true;
            for (;;)
            {
                std::function<void()> fn;
                {
                    std::lock_guard<std::mutex> l (queueLock);
                    if (queue.empty()) break;
                    fn = std::move (queue.front());
                    queue.pop_front();
                }
                fn();
            }
            processing = false;
        }

        // Laisse vivre l'interface (fenêtres des plugins, minuteries) pendant ms millisecondes.
        static void pumpFor (int ms)
        {
            const double end = nowMs() + ms;
            ++nesting;
            for (;;)
            {
                MSG m;
                while (PeekMessageW (&m, nullptr, 0, 0, PM_REMOVE))
                {
                    if (m.message == WM_QUIT) { PostQuitMessage ((int) m.wParam); --nesting; return; }
                    TranslateMessage (&m);
                    DispatchMessageW (&m);
                }
                const double left = end - nowMs();
                if (left <= 0) break;
                MsgWaitForMultipleObjectsEx (0, nullptr, (DWORD) std::max (1.0, left), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            }
            --nesting;
            if (nesting == 0) PostMessageW (msgWindow, WM_NOVA_TASK, 0, 0);
        }
    }

    //==========================================================================
    // Modèle : un clip NOVA = une source audio ARA + une modification + une région de lecture.
    struct HostClip
    {
        std::string id, name, track, role, persistentId, modificationId;
        AudioData audio;
        double start = 0.0;     // position dans le morceau (s)
        ARA::ARAAudioSourceRef source = nullptr;
        ARA::ARAAudioModificationRef modification = nullptr;
        ARA::ARAPlaybackRegionRef region = nullptr;

        double sampleRate() const { return audio.sampleRate; }
        double duration() const { return (double) audio.numFrames() / audio.sampleRate; }
        bool rendersThroughPlugin() const { return role == "edit" || role == "dub"; }
    };

    struct HostTrack
    {
        std::string name;
        int order = 0;
        ARA::ARARegionSequenceRef sequence = nullptr;
    };

    template <typename Ref, typename T> static Ref toRef (T* p) { return reinterpret_cast<Ref> (p); }
    template <typename T, typename Ref> static T* fromRef (Ref r) { return reinterpret_cast<T*> (r); }

    //==========================================================================
    class AudioAccess final : public ARA::Host::AudioAccessControllerInterface
    {
    public:
        struct Reader { HostClip* clip; bool use64; };

        ARA::ARAAudioReaderHostRef createAudioReaderForSource (ARA::ARAAudioSourceHostRef src, bool use64) noexcept override
        {
            auto r = std::make_unique<Reader> (Reader { fromRef<HostClip> (src), use64 });
            readersCreated++;
            auto ref = toRef<ARA::ARAAudioReaderHostRef> (r.get());
            std::lock_guard<std::mutex> l (lock);
            readers.emplace (r.get(), std::move (r));
            return ref;
        }

        bool readAudioSamples (ARA::ARAAudioReaderHostRef ref, ARA::ARASamplePosition pos,
                               ARA::ARASampleCount count, void* const* buffers) noexcept override
        {
            auto* r = fromRef<Reader> (ref);
            auto& a = r->clip->audio;
            const auto total = (ARA::ARASampleCount) a.numFrames();
            for (int ch = 0; ch < a.numChannels(); ++ch)
            {
                const float* src = a.channels[(size_t) ch].data();
                for (ARA::ARASampleCount i = 0; i < count; ++i)
                {
                    const auto p = pos + i;
                    const float v = (p >= 0 && p < total) ? src[p] : 0.0f;
                    if (r->use64) static_cast<double*> (buffers[ch])[i] = v;
                    else          static_cast<float*>  (buffers[ch])[i] = v;
                }
            }
            return true;
        }

        void destroyAudioReader (ARA::ARAAudioReaderHostRef ref) noexcept override
        {
            std::lock_guard<std::mutex> l (lock);
            readers.erase (fromRef<Reader> (ref));
        }

        std::atomic<int> readersCreated { 0 };

    private:
        std::mutex lock;
        std::map<Reader*, std::unique_ptr<Reader>> readers;
    };

    class Archiving final : public ARA::Host::ArchivingControllerInterface
    {
    public:
        using Bytes = std::vector<uint8_t>;

        ARA::ARASize getArchiveSize (ARA::ARAArchiveReaderHostRef r) noexcept override { return (ARA::ARASize) fromRef<Bytes> (r)->size(); }

        bool readBytesFromArchive (ARA::ARAArchiveReaderHostRef r, ARA::ARASize pos, ARA::ARASize len, ARA::ARAByte* buf) noexcept override
        {
            auto* m = fromRef<Bytes> (r);
            if (pos + len > m->size()) return false;
            std::memcpy (buf, m->data() + pos, len);
            return true;
        }

        bool writeBytesToArchive (ARA::ARAArchiveWriterHostRef w, ARA::ARASize pos, ARA::ARASize len, const ARA::ARAByte* buf) noexcept override
        {
            auto* m = fromRef<Bytes> (w);
            if (pos + len > m->size()) m->resize (pos + len);
            std::memcpy (m->data() + pos, buf, len);
            return true;
        }

        void notifyDocumentArchivingProgress (float) noexcept override {}
        void notifyDocumentUnarchivingProgress (float) noexcept override {}
        ARA::ARAPersistentID getDocumentArchiveID (ARA::ARAArchiveReaderHostRef) noexcept override { return archiveId.empty() ? nullptr : archiveId.c_str(); }

        std::string archiveId;
    };

    class ContentAccess final : public ARA::Host::ContentAccessControllerInterface
    {
    public:
        std::atomic<double> bpm { 120.0 };
        int sigNum = 4, sigDen = 4;

        bool isMusicalContextContentAvailable (ARA::ARAMusicalContextHostRef, ARA::ARAContentType t) noexcept override
        {
            return t == ARA::kARAContentTypeTempoEntries || t == ARA::kARAContentTypeBarSignatures;
        }
        ARA::ARAContentGrade getMusicalContextContentGrade (ARA::ARAMusicalContextHostRef, ARA::ARAContentType) noexcept override { return ARA::kARAContentGradeAdjusted; }
        ARA::ARAContentReaderHostRef createMusicalContextContentReader (ARA::ARAMusicalContextHostRef, ARA::ARAContentType t, const ARA::ARAContentTimeRange*) noexcept override
        {
            return reinterpret_cast<ARA::ARAContentReaderHostRef> ((intptr_t) t);
        }
        bool isAudioSourceContentAvailable (ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept override { return false; }
        ARA::ARAContentGrade getAudioSourceContentGrade (ARA::ARAAudioSourceHostRef, ARA::ARAContentType) noexcept override { return ARA::kARAContentGradeInitial; }
        ARA::ARAContentReaderHostRef createAudioSourceContentReader (ARA::ARAAudioSourceHostRef, ARA::ARAContentType, const ARA::ARAContentTimeRange*) noexcept override { return nullptr; }

        ARA::ARAInt32 getContentReaderEventCount (ARA::ARAContentReaderHostRef r) noexcept override
        {
            const auto t = (ARA::ARAContentType) reinterpret_cast<intptr_t> (r);
            if (t == ARA::kARAContentTypeTempoEntries) return 2;
            if (t == ARA::kARAContentTypeBarSignatures) return 1;
            return 0;
        }

        const void* getContentReaderDataForEvent (ARA::ARAContentReaderHostRef r, ARA::ARAInt32 i) noexcept override
        {
            const auto t = (ARA::ARAContentType) reinterpret_cast<intptr_t> (r);
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
        std::function<void (const std::string&, const std::string&)> contentChanged;
        std::function<void (const std::string&, double)> transportRequest;
    };

    class ModelUpdates final : public ARA::Host::ModelUpdateControllerInterface
    {
    public:
        explicit ModelUpdates (HostCallbacks& c) : cb (c) {}

        void notifyAudioSourceAnalysisProgress (ARA::ARAAudioSourceHostRef src, ARA::ARAAnalysisProgressState state, float value) noexcept override
        {
            if (cb.analysisProgress) cb.analysisProgress (fromRef<HostClip> (src), (int) state, value);
        }
        void notifyAudioSourceContentChanged (ARA::ARAAudioSourceHostRef src, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
        {
            if (cb.contentChanged) cb.contentChanged ("source", fromRef<HostClip> (src)->id);
        }
        void notifyAudioModificationContentChanged (ARA::ARAAudioModificationHostRef m, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
        {
            if (cb.contentChanged) cb.contentChanged ("modification", fromRef<HostClip> (m)->id);
        }
        void notifyPlaybackRegionContentChanged (ARA::ARAPlaybackRegionHostRef r, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
        {
            if (cb.contentChanged) cb.contentChanged ("region", fromRef<HostClip> (r)->id);
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

    struct PlayHead
    {
        std::atomic<int64_t> timeInSamples { 0 };
        std::atomic<bool> playing { false };
        std::atomic<double> sampleRate { 44100.0 };
        std::atomic<double> bpm { 120.0 };

        Transport get() const
        {
            Transport t;
            t.timeInSamples = timeInSamples.load();
            t.sampleRate = sampleRate.load();
            t.bpm = bpm.load();
            t.playing = playing.load();
            return t;
        }
    };

    static void dummyAssert (ARA::ARAAssertCategory, const void*, const char*) {}
    static ARA::ARAAssertFunction assertFunction = &dummyAssert;

    // Nom de fichier sans caractères interdits (comme File::createLegalFileName de JUCE).
    static std::string legalFileName (const std::string& s)
    {
        std::string out;
        for (char c : s)
            if ((unsigned char) c >= 32 && std::string ("\"#@,;:<>*^|?\\/").find (c) == std::string::npos) out.push_back (c);
        while (! out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
        return out.empty() ? "clip" : out;
    }

    static std::string joinPath (const std::string& dir, const std::string& file)
    {
        if (dir.empty()) return file;
        const char last = dir.back();
        return dir + ((last == '\\' || last == '/') ? "" : "\\") + file;
    }

    // Image BGRA (haut en bas) → PNG par WIC (composant de Windows).
    static bool savePng (const std::string& pathUtf8, int w, int h, const uint8_t* bgra)
    {
        IWICImagingFactory* f = nullptr;
        if (FAILED (CoCreateInstance (CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS (&f)))) return false;
        bool ok = false;
        IWICStream* s = nullptr;
        IWICBitmapEncoder* e = nullptr;
        IWICBitmapFrameEncode* fr = nullptr;
        IPropertyBag2* bag = nullptr;
        DeleteFileW (widen (pathUtf8).c_str());
        if (SUCCEEDED (f->CreateStream (&s)) && SUCCEEDED (s->InitializeFromFilename (widen (pathUtf8).c_str(), GENERIC_WRITE))
            && SUCCEEDED (f->CreateEncoder (GUID_ContainerFormatPng, nullptr, &e)) && SUCCEEDED (e->Initialize (s, WICBitmapEncoderNoCache))
            && SUCCEEDED (e->CreateNewFrame (&fr, &bag)) && SUCCEEDED (fr->Initialize (bag)) && SUCCEEDED (fr->SetSize ((UINT) w, (UINT) h)))
        {
            WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
            if (SUCCEEDED (fr->SetPixelFormat (&fmt)) && fmt == GUID_WICPixelFormat24bppBGR)
            {
                const UINT stride = (UINT) w * 3;
                std::vector<uint8_t> rgb ((size_t) stride * (size_t) h);
                for (int y = 0; y < h; ++y)
                    for (int x = 0; x < w; ++x)
                    {
                        const uint8_t* p = bgra + ((size_t) y * (size_t) w + (size_t) x) * 4;
                        uint8_t* q = rgb.data() + (size_t) y * stride + (size_t) x * 3;
                        q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
                    }
                ok = SUCCEEDED (fr->WritePixels ((UINT) h, stride, (UINT) rgb.size(), rgb.data()))
                  && SUCCEEDED (fr->Commit()) && SUCCEEDED (e->Commit());
            }
        }
        if (bag) bag->Release();
        if (fr) fr->Release();
        if (e) e->Release();
        if (s) s->Release();
        f->Release();
        return ok;
    }

    //==========================================================================
    class AraSession
    {
    public:
        AraSession()
        {
            callbacks.analysisProgress = [] (HostClip* c, int state, float value)
            {
                auto o = Value::object();
                o.set ("clip", c->id);
                o.set ("state", state == ARA::kARAAnalysisProgressCompleted ? "done" : (state == ARA::kARAAnalysisProgressStarted ? "start" : "progress"));
                o.set ("value", (double) value);
                io::event ("analysis_progress", o);
            };
            callbacks.contentChanged = [] (const std::string& scope, const std::string& clip)
            {
                auto o = Value::object();
                o.set ("scope", scope);
                o.set ("clip", clip);
                io::event ("content_changed", o);
            };
            callbacks.transportRequest = [this] (const std::string& kind, double value)
            {
                auto o = Value::object();
                o.set ("kind", kind);
                o.set ("value", value);
                io::event ("transport_request", o);
                // L'hôte suit aussi la demande lui-même (lecture du clip dans la fenêtre du plugin).
                app::post ([this, kind, value]
                {
                    if (kind == "start") startPlayback (-1);
                    else if (kind == "stop") stopPlayback();
                    else if (kind == "position") setPosition (value);
                });
            };
        }

        ~AraSession()
        {
            shutdownAudio();
            editorWindow.reset();
            clearDocument();
            if (plugin) plugin->release();
            if (dc)
            {
                dc->beginEditing();
                if (musicalContext) dc->destroyMusicalContext (musicalContext);
                dc->endEditing();
                dc->destroyDocumentController();
                dc.reset();
            }
            playbackRenderer.reset();
            editorRenderer.reset();
            if (plugin) plugin->terminateInstance();
            if (factory != nullptr && factory->uninitializeARA != nullptr) factory->uninitializeARA();
            factory = nullptr;
            plugin.reset();
        }

        //======================================================================
        Value load (const Value& req)
        {
            if (plugin) throw std::runtime_error ("Un plugin est déjà chargé dans cet hôte");
            const auto path = req["plugin"].asString();
            sampleRate = req["sample_rate"].asDouble (44100.0);
            blockSize = std::max (16, req["block_size"].asInt (1024));

            plugin = std::make_unique<Vst3Plugin>();
            try { plugin->load (path); }
            catch (...) { plugin.reset(); throw; }
            playHead.sampleRate = sampleRate;

            if (! req["ara"].asBool (true))
            {
                // Mode sans ARA (capture) : plugin seul, entrées principale + sidechain.
                auto out = Value::object();
                out.set ("name", plugin->name);
                out.set ("vendor", plugin->vendor);
                out.set ("ara", false);
                out.set ("has_ara_extension", plugin->hasARAFactory());
                out.set ("input_buses", plugin->numBuses (true));
                out.set ("editor", plugin->hasEditor());
                return out;
            }

            const auto* fac = plugin->araFactory();
            if (fac == nullptr) throw std::runtime_error ("Ce plugin n'a pas d'extension ARA2");
            {
                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAInterfaceConfiguration, assertFunctionAddress)> cfg {
                    std::min (fac->highestSupportedApiGeneration, (ARA::ARAAPIGeneration) ARA::kARAAPIGeneration_2_X_Draft),
                    &assertFunction };
                fac->initializeARAWithConfiguration (&cfg);
                factory = fac;
            }

            auto out = Value::object();
            out.set ("name", plugin->name);
            out.set ("vendor", plugin->vendor);
            out.set ("version", plugin->version);
            out.set ("ara", true);
            out.set ("ara_plugin_name", std::string (fac->plugInName ? fac->plugInName : ""));
            out.set ("ara_manufacturer", std::string (fac->manufacturerName ? fac->manufacturerName : ""));
            out.set ("ara_version", std::string (fac->version ? fac->version : ""));
            out.set ("ara_api_generation", (int) fac->highestSupportedApiGeneration);
            auto analyzable = Value::array();
            canAnalyzeNotes = false;
            for (ARA::ARASize i = 0; i < fac->analyzeableContentTypesCount; ++i)
            {
                analyzable.push (contentTypeName (fac->analyzeableContentTypes[i]));
                if (fac->analyzeableContentTypes[i] == ARA::kARAContentTypeNotes) canAnalyzeNotes = true;
            }
            out.set ("analyzable", analyzable);
            out.set ("transformations", (int) fac->supportedPlaybackTransformationFlags);

            audioAccess = std::make_unique<AudioAccess>();
            archiving = std::make_unique<Archiving>();
            // Identifiant des archives écrites par ce plugin : demandé par le plugin à la restauration.
            archiving->archiveId = fac->documentArchiveID != nullptr ? fac->documentArchiveID : "";
            out.set ("archive_id", archiving->archiveId);
            contentAccess = std::make_unique<ContentAccess>();
            modelUpdates = std::make_unique<ModelUpdates> (callbacks);
            playbackRequests = std::make_unique<PlaybackRequests> (callbacks);
            hostInstance = std::make_unique<ARA::Host::DocumentControllerHostInstance> (
                audioAccess.get(), archiving.get(), contentAccess.get(), modelUpdates.get(), playbackRequests.get());

            const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARADocumentProperties, name)> docProps { "Nova Studio" };
            const auto* dci = fac->createDocumentControllerWithDocument (hostInstance.get(), &docProps);
            if (dci == nullptr) throw std::runtime_error ("Le plugin refuse de créer un document ARA");
            dc = std::make_unique<ARA::Host::DocumentController> (dci);

            const auto roles = ARA::kARAPlaybackRendererRole | ARA::kARAEditorRendererRole | ARA::kARAEditorViewRole;
            extension = plugin->bindToARA (dci->documentControllerRef, roles, roles);
            if (extension == nullptr) throw std::runtime_error ("Liaison ARA refusée par le plugin");
            if (extension->playbackRendererInterface != nullptr && extension->playbackRendererRef != nullptr)
                playbackRenderer = std::make_unique<ARA::Host::PlaybackRenderer> (extension);
            if (extension->editorRendererInterface != nullptr && extension->editorRendererRef != nullptr)
                editorRenderer = std::make_unique<ARA::Host::EditorRenderer> (extension);

            {
                dc->beginEditing();
                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAMusicalContextProperties, color)> props { "Morceau", 0, nullptr };
                musicalContext = dc->createMusicalContext (toRef<ARA::ARAMusicalContextHostRef> (this), &props);
                dc->endEditing();
            }
            out.set ("editor", plugin->hasEditor());
            out.set ("latency_samples", plugin->latencySamples());
            return out;
        }

        //======================================================================
        Value setup (const Value& req)
        {
            requireLoaded();
            clearDocument();
            contentAccess->bpm = req["tempo"].asDouble (120.0);
            playHead.bpm = contentAccess->bpm.load();
            const auto& ts = req["time_signature"];
            if (ts.isArray() && ts.size() == 2)
            {
                contentAccess->sigNum = ts.at (0).asInt (4);
                contentAccess->sigDen = ts.at (1).asInt (4);
            }

            const auto& list = req["clips"];
            if (! list.isArray() || list.size() == 0) throw std::runtime_error ("Aucun clip à ouvrir");

            for (size_t i = 0; i < list.size(); ++i)
            {
                const auto& c = list.at (i);
                auto clip = std::make_unique<HostClip>();
                clip->id = c["id"].asString();
                clip->name = c.has ("name") ? c["name"].asString() : clip->id;
                clip->track = c.has ("track") ? c["track"].asString() : clip->name;
                clip->role = c.has ("role") ? c["role"].asString() : "edit";
                clip->start = c["start"].asDouble (0.0);
                clip->persistentId = c.has ("persistent_id") ? c["persistent_id"].asString() : clip->id;
                clip->modificationId = clip->persistentId + "/modif";
                const auto path = c["path"].asString();
                if (! readWav (path, clip->audio)) throw std::runtime_error ("Audio illisible : " + path);
                if (clip->audio.numChannels() == 0) clip->audio.setSize (1, 0);
                clips.push_back (std::move (clip));
            }

            dc->beginEditing();
            int order = 0;
            for (auto& clip : clips)
            {
                auto* track = trackFor (clip->track, order);
                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAAudioSourceProperties, channelArrangement)> sp {
                    clip->name.c_str(), clip->persistentId.c_str(), (ARA::ARASampleCount) clip->audio.numFrames(),
                    clip->sampleRate(), (ARA::ARAChannelCount) clip->audio.numChannels(), (ARA::ARABool) false,
                    ARA::kARAChannelArrangementUndefined, nullptr };
                clip->source = dc->createAudioSource (toRef<ARA::ARAAudioSourceHostRef> (clip.get()), &sp);

                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAAudioModificationProperties, persistentID)> mp {
                    clip->name.c_str(), clip->modificationId.c_str() };
                clip->modification = dc->createAudioModification (clip->source, toRef<ARA::ARAAudioModificationHostRef> (clip.get()), &mp);

                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, color)> rp {
                    (ARA::ARAPlaybackTransformationFlags) ARA::kARAPlaybackTransformationNoChanges,
                    0.0, clip->duration(), clip->start, clip->duration(),
                    musicalContext, track->sequence, clip->name.c_str(), nullptr };
                clip->region = dc->createPlaybackRegion (clip->modification, toRef<ARA::ARAPlaybackRegionHostRef> (clip.get()), &rp);
            }

            dc->updateMusicalContextContent (musicalContext, nullptr, ARA::ContentUpdateScopes::timelineIsAffected());
            restored = false;
            const auto archiveB64 = req["archive_b64"].asString();
            if (! archiveB64.empty())
            {
                std::vector<uint8_t> m;
                if (base64::decode (archiveB64, m) && ! m.empty())
                    restored = dc->restoreObjectsFromArchive (toRef<ARA::ARAArchiveReaderHostRef> (&m), nullptr);
            }
            dc->endEditing();

            for (auto& clip : clips)
                dc->enableAudioSourceSamplesAccess (clip->source, true);

            plugin->release();
            prepared = Prepared::none;
            assignRenderers (nullptr);

            auto out = Value::object();
            out.set ("clips", (int) clips.size());
            out.set ("restored", restored);
            return out;
        }

        Value restore (const Value& req)
        {
            requireLoaded();
            std::vector<uint8_t> m;
            if (! base64::decode (req["archive_b64"].asString(), m) || m.empty()) throw std::runtime_error ("Archive ARA illisible");
            dc->beginEditing();
            restored = dc->restoreObjectsFromArchive (toRef<ARA::ARAArchiveReaderHostRef> (&m), nullptr);
            dc->endEditing();
            auto out = Value::object();
            out.set ("restored", restored);
            return out;
        }

        //======================================================================
        // Analyse : réponse différée (la minuterie la termine).
        void analyze (const Value& req, std::function<void (Value, std::string)> reply)
        {
            requireLoaded();
            if (clips.empty()) throw std::runtime_error ("Aucun clip : appelle setup d'abord");
            if (canAnalyzeNotes)
            {
                const ARA::ARAContentType types[] { ARA::kARAContentTypeNotes };
                for (auto& c : clips)
                    if (dc->isAudioSourceContentAnalysisIncomplete (c->source, ARA::kARAContentTypeNotes))
                        dc->requestAudioSourceContentAnalysis (c->source, 1, types);
            }
            pendingAnalysis = std::make_unique<PendingAnalysis>();
            pendingAnalysis->reply = std::move (reply);
            pendingAnalysis->started = nowMs();
            pendingAnalysis->timeoutMs = 1000.0 * req["timeout_s"].asDouble (120.0);
        }

        Value notes()
        {
            requireLoaded();
            auto out = Value::object();
            auto arr = Value::array();
            for (auto& c : clips)
            {
                auto o = Value::object();
                o.set ("id", c->id);
                o.set ("role", c->role);
                o.set ("duration", c->duration());
                o.set ("source_notes", readNotes (*c, false));
                o.set ("notes", readNotes (*c, true));
                arr.push (o);
            }
            out.set ("clips", arr);
            out.set ("can_analyze_notes", canAnalyzeNotes);
            out.set ("audio_readers", audioAccess != nullptr ? audioAccess->readersCreated.load() : 0);
            return out;
        }

        //======================================================================
        Value showEditor (const Value& req)
        {
            if (! plugin) throw std::runtime_error ("Aucun plugin chargé");
            if (! plugin->hasEditor()) throw std::runtime_error ("Ce plugin n'a pas de fenêtre");
            const bool offscreen = req["offscreen"].asBool (false);
            if (editorWindow == nullptr || editorWindow->offscreen != offscreen)
            {
                editorWindow.reset();
                auto view = plugin->createView();
                if (view == nullptr) throw std::runtime_error ("Fenêtre du plugin indisponible");
                const auto title = req.has ("title") ? req["title"].asString() : plugin->name;
                editorWindow = std::make_unique<EditorWindow> (view, title, offscreen, [] { io::event ("editor_closed"); });
            }
            if (dc) notifySelection();
            editorWindow->show();
            auto out = Value::object();
            out.set ("width", editorWindow->clientWidth());
            out.set ("height", editorWindow->clientHeight());
            return out;
        }

        Value select()
        {
            requireLoaded();
            notifySelection();
            return notes();
        }

        Value hideEditor()
        {
            if (editorWindow != nullptr)
            {
                editorWindow->hide();
                editorWindow.reset();
            }
            return Value::object();
        }

        Value snapshot (const Value& req)
        {
            if (editorWindow == nullptr || ! editorWindow->isVisible()) throw std::runtime_error ("Aucune fenêtre ouverte");
            const auto path = req["path"].asString();
            HWND hwnd = editorWindow->handle();
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
            GdiFlush();
            const bool okPng = bits != nullptr && savePng (path, w, h, static_cast<const uint8_t*> (bits));
            SelectObject (mem, old);
            DeleteObject (bmp);
            DeleteDC (mem);
            ReleaseDC (nullptr, screen);
            if (! okPng) throw std::runtime_error ("Écriture PNG impossible");
            auto out = Value::object();
            out.set ("path", path);
            out.set ("width", w);
            out.set ("height", h);
            out.set ("print_window", okPrint != 0);
            return out;
        }

        //======================================================================
        // Touches clavier et clics envoyés directement à la fenêtre du plugin (sans la mettre au
        // premier plan) : l'état des modificateurs (Ctrl, Maj) est celui du fil de l'interface.
        Value keys (const Value& req)
        {
            if (editorWindow == nullptr || ! editorWindow->isVisible()) throw std::runtime_error ("Aucune fenêtre ouverte");
            HWND top = editorWindow->handle();
            std::vector<HWND> kids;
            EnumChildWindows (top, [] (HWND h, LPARAM lp) -> BOOL { reinterpret_cast<std::vector<HWND>*> (lp)->push_back (h); return TRUE; }, (LPARAM) &kids);
            auto list = Value::array();
            HWND target = top;
            long bestArea = -1;
            for (size_t i = 0; i < kids.size(); ++i)
            {
                RECT r; GetWindowRect (kids[i], &r);
                char cls[128] {}; GetClassNameA (kids[i], cls, 127);
                const long area = (long) (r.right - r.left) * (long) (r.bottom - r.top);
                auto o = Value::object();
                o.set ("class", std::string (cls));
                o.set ("w", (int) (r.right - r.left));
                o.set ("h", (int) (r.bottom - r.top));
                list.push (o);
                if (IsWindowVisible (kids[i]) && area > bestArea) { bestArea = area; target = kids[i]; }
            }
            if (req.has ("target_index"))
            {
                const int ti = req["target_index"].asInt (-1);
                if (ti >= 0 && ti < (int) kids.size()) target = kids[(size_t) ti];
            }
            SetFocus (target);
            const auto& arr = req["keys"];
            for (size_t ki = 0; arr.isArray() && ki < arr.size(); ++ki)
            {
                const auto& k = arr.at (ki);
                const auto& pt = k["click"];
                if (pt.isArray() && pt.size() == 2)
                {
                    // Descend jusqu'à la fenêtre enfant la plus profonde sous le point (boutons MFC…).
                    // Valeurs < 1 : fractions de la taille de la fenêtre (indépendant de l'échelle d'affichage).
                    RECT cr; GetClientRect (target, &cr);
                    const double fx = pt.at (0).asDouble(), fy = pt.at (1).asDouble();
                    POINT p { (int) (fx < 1.0 ? fx * (cr.right - cr.left) : fx), (int) (fy < 1.0 ? fy * (cr.bottom - cr.top) : fy) };
                    HWND hit = target;
                    for (int depth = 0; depth < 16; ++depth)
                    {
                        HWND c = ChildWindowFromPointEx (hit, p, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
                        if (c == nullptr || c == hit) break;
                        MapWindowPoints (hit, c, &p, 1);
                        hit = c;
                    }
                    const LPARAM xy = MAKELPARAM (p.x, p.y);
                    const bool post = req["post"].asBool (false);
                    auto send = [&] (UINT m, WPARAM w) { if (post) PostMessageA (hit, m, w, xy); else SendMessageA (hit, m, w, xy); };
                    send (WM_MOUSEACTIVATE, 0);
                    send (WM_MOUSEMOVE, 0);
                    app::pumpFor (40);
                    send (WM_LBUTTONDOWN, MK_LBUTTON);
                    app::pumpFor (60);
                    send (WM_LBUTTONUP, 0);
                    app::pumpFor (80);
                    continue;
                }
                const int vk = k["vk"].asInt (0);
                BYTE saved[256], ks[256];
                GetKeyboardState (saved);
                std::memcpy (ks, saved, sizeof (ks));
                if (k["ctrl"].asBool (false)) ks[VK_CONTROL] = ks[VK_LCONTROL] = 0x80;
                if (k["shift"].asBool (false)) ks[VK_SHIFT] = ks[VK_LSHIFT] = 0x80;
                if (k["alt"].asBool (false)) ks[VK_MENU] = ks[VK_LMENU] = 0x80;
                ks[vk & 0xff] = 0x80;
                SetKeyboardState (ks);
                const UINT sc = MapVirtualKeyA ((UINT) vk, MAPVK_VK_TO_VSC);
                const bool ext = vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT || vk == VK_DELETE || vk == VK_HOME || vk == VK_END;
                const LPARAM down = 1 | ((LPARAM) sc << 16) | (ext ? (1 << 24) : 0);
                const LPARAM up = down | (1u << 30) | (1u << 31);
                SendMessageA (target, WM_KEYDOWN, (WPARAM) vk, down);
                if (k.has ("char")) SendMessageA (target, WM_CHAR, (WPARAM) k["char"].asInt (0), down);
                SendMessageA (target, WM_KEYUP, (WPARAM) vk, up);
                SetKeyboardState (saved);
                app::pumpFor (60);
            }
            auto out = Value::object();
            out.set ("children", list);
            return out;
        }

        //======================================================================
        Value render (const Value& req)
        {
            requireLoaded();
            const auto dir = req["out_dir"].asString();
            CreateDirectoryW (widen (dir).c_str(), nullptr);
            std::set<std::string> only;
            const auto& ids = req["clip_ids"];
            for (size_t i = 0; ids.isArray() && i < ids.size(); ++i) only.insert (ids.at (i).asString());

            const bool wasPlaying = playHead.playing.load();
            stopPlayback();
            auto results = Value::array();
            {
                std::lock_guard<std::mutex> sl (renderLock);
                for (auto& c : clips)
                {
                    if (! c->rendersThroughPlugin()) continue;
                    if (! only.empty() && ! only.count (c->id)) continue;
                    results.push (renderClip (*c, dir));
                }
                plugin->release();
                prepared = Prepared::none;
                assignRenderers (nullptr);
            }
            if (wasPlaying) startPlayback (-1);
            auto out = Value::object();
            out.set ("rendered", results);
            return out;
        }

        Value archive()
        {
            requireLoaded();
            std::vector<uint8_t> bytes;
            const bool ok = dc->storeObjectsToArchive (toRef<ARA::ARAArchiveWriterHostRef> (&bytes), nullptr);
            if (! ok) throw std::runtime_error ("Le plugin n'a pas pu sauvegarder ses retouches");
            auto out = Value::object();
            out.set ("archive_b64", base64::encode (bytes.data(), bytes.size()));
            out.set ("size", (int) bytes.size());
            return out;
        }

        Value transport (const Value& req)
        {
            requireLoaded();
            if (req.has ("tempo"))
            {
                contentAccess->bpm = req["tempo"].asDouble (120.0);
                playHead.bpm = contentAccess->bpm.load();
                dc->beginEditing();
                dc->updateMusicalContextContent (musicalContext, nullptr, ARA::ContentUpdateScopes::timelineIsAffected());
                dc->endEditing();
            }
            if (req.has ("position")) setPosition (req["position"].asDouble (0.0));
            if (req.has ("playing"))
            {
                if (req["playing"].asBool (false)) startPlayback (-1);
                else stopPlayback();
            }
            auto out = Value::object();
            out.set ("playing", playHead.playing.load());
            out.set ("position", (double) playHead.timeInSamples.load() / playHead.sampleRate.load());
            out.set ("audio_device", deviceName);
            return out;
        }

        //======================================================================
        // Mode capture (sans ARA), comme VocAlign dans un hôte sans ARA : le double sur l'entrée
        // principale, le guide sur l'entrée sidechain, transport en lecture. Passe 1 = capture,
        // attente de l'alignement, passe 2 = sortie alignée.
        Value captureAlign (const Value& req)
        {
            if (! plugin) throw std::runtime_error ("Aucun plugin chargé");
            AudioData dub, guide;
            const auto dubPath = req["dub"].asString(), guidePath = req["guide"].asString();
            if (! readWav (dubPath, dub)) throw std::runtime_error ("Audio illisible : " + dubPath);
            if (! readWav (guidePath, guide)) throw std::runtime_error ("Audio illisible : " + guidePath);
            const double sr = dub.sampleRate;
            plugin->release();

            using namespace Steinberg::Vst;
            bool sidechain = false;
            if (plugin->numBuses (true) > 1)
            {
                const SpeakerArrangement sets[] { SpeakerArr::kStereo, SpeakerArr::kMono };
                for (auto a : sets)
                {
                    for (auto b : sets)
                        if (plugin->setInputArrangements ({ a, b })) { sidechain = true; break; }
                    if (sidechain) break;
                }
                if (! sidechain)
                {
                    plugin->enableAllBuses();
                    sidechain = plugin->numBuses (true) > 1 && plugin->busChannels (true, 1) > 0;
                }
            }
            const int mainIn = plugin->busActive (true, 0) ? plugin->busChannels (true, 0) : 0;
            const int scIn = sidechain ? plugin->busChannels (true, 1) : 0;
            const int totalIn = plugin->totalInputChannels();
            const int totalOut = plugin->totalOutputChannels();
            const bool realtime = req["realtime"].asBool (false);
            plugin->prepare (sr, blockSize, ! realtime);
            playHead.sampleRate = sr;
            // Clics dans la fenêtre du plugin une fois prêt (ex. armer « Capture » du Dub).
            if (req.has ("clicks"))
            {
                auto k = Value::object();
                k.set ("keys", req["clicks"]);
                k.set ("target_index", req.has ("target_index") ? req["target_index"] : Value (1));
                keys (k);
            }
            const int passes = req["passes"].asInt (2);
            const double waitS = req["wait_s"].asDouble (3.0);
            cap.dub = std::move (dub);
            cap.guide = std::move (guide);
            cap.sr = sr; cap.mainIn = mainIn; cap.scIn = scIn; cap.totalIn = totalIn; cap.totalOut = totalOut; cap.ready = true;
            AudioData out;
            for (int pass = 0; pass < passes; ++pass)
            {
                capturePass (realtime, pass == passes - 1 ? &out : nullptr);
                if (pass < passes - 1) app::pumpFor ((int) (waitS * 1000));
            }
            const bool keep = req["keep"].asBool (false);
            if (! keep) { plugin->release(); cap.ready = false; }
            const auto outPath = req["out"].asString();
            if (passes > 0 && ! outPath.empty()) writeWavFloat (outPath, out);
            auto o = Value::object();
            o.set ("path", outPath);
            o.set ("sidechain", sidechain);
            o.set ("main_in", mainIn);
            o.set ("sidechain_in", scIn);
            o.set ("layout", plugin->busDescription (true, 0) + " / bus 2 : "
                                 + (plugin->numBuses (true) > 1 ? plugin->busDescription (true, 1) : std::string ("aucun")));
            o.set ("peak", (double) out.magnitude());
            return o;
        }

        // Passe de sortie après la capture (fenêtre éventuellement retouchée par l'utilisateur).
        Value captureOutput (const Value& req)
        {
            if (! plugin || ! cap.ready) throw std::runtime_error ("Rien de capturé : lance d'abord capture_align avec keep=true");
            AudioData out;
            capturePass (req["realtime"].asBool (true), &out);
            const auto outPath = req["out"].asString();
            writeWavFloat (outPath, out);
            if (! req["keep"].asBool (true)) { plugin->release(); cap.ready = false; }
            auto o = Value::object();
            o.set ("path", outPath);
            o.set ("peak", (double) out.magnitude());
            return o;
        }

        //======================================================================
        void timer()
        {
            if (plugin) plugin->flushOutputParameters();
            if (! dc) return;
            dc->notifyModelUpdates();
            if (pendingAnalysis == nullptr) return;
            bool incomplete = false;
            if (canAnalyzeNotes)
                for (auto& c : clips)
                    if (dc->isAudioSourceContentAnalysisIncomplete (c->source, ARA::kARAContentTypeNotes))
                        incomplete = true;
            const auto elapsed = nowMs() - pendingAnalysis->started;
            if (incomplete && elapsed < pendingAnalysis->timeoutMs) return;
            auto p = std::move (pendingAnalysis);
            try
            {
                auto res = notes();
                res.set ("analysis_seconds", elapsed / 1000.0);
                res.set ("complete", ! incomplete);
                p->reply (res, {});
            }
            catch (const std::exception& e) { p->reply ({}, e.what()); }
        }

    private:
        enum class Prepared { none, offline, realtime };

        struct PendingAnalysis
        {
            std::function<void (Value, std::string)> reply;
            double started = 0, timeoutMs = 120000;
        };

        struct CaptureState
        {
            AudioData dub, guide;
            double sr = 44100;
            int mainIn = 1, scIn = 0, totalIn = 2, totalOut = 2;
            bool ready = false;
        } cap;

        void requireLoaded() const
        {
            if (! plugin || ! dc) throw std::runtime_error ("Aucun plugin ARA chargé");
        }

        static std::string contentTypeName (ARA::ARAContentType t)
        {
            switch (t)
            {
                case ARA::kARAContentTypeNotes: return "notes";
                case ARA::kARAContentTypeTempoEntries: return "tempo";
                case ARA::kARAContentTypeBarSignatures: return "bar_signatures";
                case ARA::kARAContentTypeStaticTuning: return "tuning";
                case ARA::kARAContentTypeKeySignatures: return "key_signatures";
                case ARA::kARAContentTypeSheetChords: return "chords";
                default: return "type_" + std::to_string ((int) t);
            }
        }

        // À appeler pendant une édition (beginEditing / endEditing).
        HostTrack* trackFor (const std::string& name, int& order)
        {
            for (auto& t : tracks)
                if (t->name == name) return t.get();
            auto t = std::make_unique<HostTrack>();
            t->name = name;
            t->order = order++;
            const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARARegionSequenceProperties, color)> p {
                t->name.c_str(), (ARA::ARAInt32) t->order, musicalContext, nullptr };
            t->sequence = dc->createRegionSequence (toRef<ARA::ARARegionSequenceHostRef> (t.get()), &p);
            tracks.push_back (std::move (t));
            return tracks.back().get();
        }

        void clearDocument()
        {
            if (! dc) { clips.clear(); tracks.clear(); return; }
            if (plugin) plugin->release();
            prepared = Prepared::none;
            for (auto& c : clips)
            {
                if (inPlayback.count (c.get()) && playbackRenderer) playbackRenderer->removePlaybackRegion (c->region);
                if (inEditor.count (c.get()) && editorRenderer) editorRenderer->removePlaybackRegion (c->region);
            }
            inPlayback.clear();
            inEditor.clear();
            for (auto& c : clips)
                if (c->source != nullptr) dc->enableAudioSourceSamplesAccess (c->source, false);
            dc->beginEditing();
            for (auto& c : clips)   // régions → modifications → sources
            {
                if (c->region != nullptr) dc->destroyPlaybackRegion (c->region);
                if (c->modification != nullptr) dc->destroyAudioModification (c->modification);
                if (c->source != nullptr) dc->destroyAudioSource (c->source);
            }
            for (auto& t : tracks)
                if (t->sequence != nullptr) dc->destroyRegionSequence (t->sequence);
            dc->endEditing();
            clips.clear();
            tracks.clear();
        }

        // Régions confiées au rendu du plugin (doit être appelé plugin non préparé).
        void assignRenderers (HostClip* only)
        {
            for (auto& c : clips)
            {
                const bool wantPlay = only != nullptr ? (c.get() == only) : c->rendersThroughPlugin();
                const bool inPlay = inPlayback.count (c.get()) > 0;
                if (playbackRenderer)
                {
                    if (wantPlay && ! inPlay) { playbackRenderer->addPlaybackRegion (c->region); inPlayback.insert (c.get()); }
                    if (! wantPlay && inPlay) { playbackRenderer->removePlaybackRegion (c->region); inPlayback.erase (c.get()); }
                }
                if (editorRenderer && ! inEditor.count (c.get())) { editorRenderer->addPlaybackRegion (c->region); inEditor.insert (c.get()); }
            }
        }

        void notifySelection()
        {
            if (extension == nullptr || extension->editorViewInterface == nullptr || extension->editorViewRef == nullptr) return;
            std::vector<ARA::ARAPlaybackRegionRef> regions;
            std::vector<ARA::ARARegionSequenceRef> seqs;
            for (auto& c : clips)
                if (c->role != "context") regions.push_back (c->region);
            for (auto& t : tracks) seqs.push_back (t->sequence);
            ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAViewSelection, timeRange)> sel;
            sel.playbackRegionRefsCount = regions.size();
            sel.playbackRegionRefs = regions.data();
            sel.regionSequenceRefsCount = seqs.size();
            sel.regionSequenceRefs = seqs.data();
            sel.timeRange = nullptr;
            ARA::Host::EditorView view (extension);
            view.notifySelection (&sel);
        }

        Value readNotes (HostClip& c, bool modification)
        {
            auto arr = Value::array();
            const auto type = ARA::kARAContentTypeNotes;
            ARA::ARAContentReaderRef reader = nullptr;
            if (modification)
            {
                if (! dc->isAudioModificationContentAvailable (c.modification, type)) return arr;
                reader = dc->createAudioModificationContentReader (c.modification, type, nullptr);
            }
            else
            {
                if (! dc->isAudioSourceContentAvailable (c.source, type)) return arr;
                reader = dc->createAudioSourceContentReader (c.source, type, nullptr);
            }
            if (reader == nullptr) return arr;
            const auto n = dc->getContentReaderEventCount (reader);
            for (ARA::ARAInt32 i = 0; i < n; ++i)
            {
                const auto* note = static_cast<const ARA::ARAContentNote*> (dc->getContentReaderDataForEvent (reader, i));
                if (note == nullptr) continue;
                auto row = Value::array();
                row.push ((double) note->frequency);
                row.push ((int) note->pitchNumber);
                row.push ((double) note->volume);
                row.push ((double) note->startPosition);
                row.push ((double) note->noteDuration);
                arr.push (row);
            }
            dc->destroyContentReader (reader);
            return arr;   // [fréquence Hz, n° MIDI, volume, début s, durée s]
        }

        Value renderClip (HostClip& c, const std::string& dir)
        {
            plugin->release();
            prepared = Prepared::none;
            assignRenderers (&c);
            const double sr = c.sampleRate();
            plugin->prepare (sr, blockSize, true);
            prepared = Prepared::offline;
            playHead.sampleRate = sr;

            ARA::ARATimeDuration head = 0, tail = 0;
            dc->getPlaybackRegionHeadAndTailTime (c.region, &head, &tail);
            tail = std::min (tail, 10.0);
            head = std::min (head, 10.0);
            const int latency = plugin->latencySamples();
            const int64_t startS = (int64_t) std::floor ((c.start - head) * sr);
            const int64_t wantS = (int64_t) std::llround (c.start * sr);
            const int64_t lenS = c.audio.numFrames();
            const int64_t endS = wantS + lenS + (int64_t) std::ceil (tail * sr) + latency;
            const int nch = std::max ({ 2, plugin->totalInputChannels(), plugin->totalOutputChannels() });
            const int outCh = std::max (1, plugin->totalOutputChannels());

            AudioData outBuf;
            outBuf.sampleRate = sr;
            outBuf.setSize (std::min (2, outCh), lenS + (int64_t) std::ceil (tail * sr));
            std::vector<std::vector<float>> block ((size_t) nch, std::vector<float> ((size_t) blockSize, 0.0f));
            std::vector<float*> ptrs ((size_t) nch);
            for (int ch = 0; ch < nch; ++ch) ptrs[(size_t) ch] = block[(size_t) ch].data();
            playHead.playing = true;
            double peak = 0;
            for (int64_t pos = startS; pos < endS; pos += blockSize)
            {
                const int n = (int) std::min ((int64_t) blockSize, endS - pos);
                for (auto& b : block) std::fill (b.begin(), b.begin() + n, 0.0f);
                playHead.timeInSamples = pos;
                plugin->process (ptrs.data(), nch, n, playHead.get());
                // Échantillon de sortie « pos + i - latence » du morceau → index dans le clip.
                for (int i = 0; i < n; ++i)
                {
                    const int64_t songPos = pos + i - latency;
                    const int64_t idx = songPos - wantS;
                    if (idx < 0 || idx >= outBuf.numFrames()) continue;
                    for (int ch = 0; ch < outBuf.numChannels(); ++ch)
                    {
                        const float v = block[(size_t) std::min (ch, outCh - 1)][(size_t) i];
                        outBuf.channels[(size_t) ch][(size_t) idx] = v;
                        peak = std::max (peak, (double) std::abs (v));
                    }
                }
            }
            playHead.playing = false;
            plugin->release();
            prepared = Prepared::none;

            const auto f = joinPath (dir, legalFileName (c.id) + ".wav");
            writeWavFloat (f, outBuf);

            auto o = Value::object();
            o.set ("id", c.id);
            o.set ("path", f);
            o.set ("sample_rate", sr);
            o.set ("samples", (double) outBuf.numFrames());
            o.set ("tail_s", tail);
            o.set ("latency", latency);
            o.set ("peak", peak);
            return o;
        }

        void capturePass (bool realtime, AudioData* out)
        {
            const int64_t len = cap.dub.numFrames();
            if (out != nullptr) { out->sampleRate = cap.sr; out->setSize (std::max (1, std::min (2, cap.totalOut)), len); }
            const int nch = std::max ({ cap.totalIn, cap.totalOut, 2 });
            std::vector<std::vector<float>> block ((size_t) nch, std::vector<float> ((size_t) blockSize, 0.0f));
            std::vector<float*> ptrs ((size_t) nch);
            for (int ch = 0; ch < nch; ++ch) ptrs[(size_t) ch] = block[(size_t) ch].data();
            playHead.sampleRate = cap.sr;
            playHead.playing = true;
            const double t0 = nowMs();
            for (int64_t pos = 0; pos < len; pos += blockSize)
            {
                const int n = (int) std::min ((int64_t) blockSize, len - pos);
                for (auto& b : block) std::fill (b.begin(), b.end(), 0.0f);
                for (int ch = 0; ch < cap.mainIn && ch < nch; ++ch)
                {
                    const auto& src = cap.dub.channels[(size_t) std::min (ch, cap.dub.numChannels() - 1)];
                    std::copy (src.begin() + pos, src.begin() + pos + n, block[(size_t) ch].begin());
                }
                for (int ch = 0; ch < cap.scIn && cap.mainIn + ch < nch; ++ch)
                    if (pos < cap.guide.numFrames())
                    {
                        const auto& src = cap.guide.channels[(size_t) std::min (ch, cap.guide.numChannels() - 1)];
                        const int64_t m = std::min ((int64_t) n, cap.guide.numFrames() - pos);
                        std::copy (src.begin() + pos, src.begin() + pos + m, block[(size_t) (cap.mainIn + ch)].begin());
                    }
                playHead.timeInSamples = pos;
                plugin->process (ptrs.data(), nch, n, playHead.get());
                if (out != nullptr)
                    for (int ch = 0; ch < out->numChannels(); ++ch)
                        std::copy (block[(size_t) ch].begin(), block[(size_t) ch].begin() + n, out->channels[(size_t) ch].begin() + pos);
                if (realtime)
                {
                    // Au rythme de la lecture (VocAlign ne capture qu'en temps réel), interface vivante.
                    const double due = t0 + 1000.0 * (double) (pos + n) / cap.sr;
                    const double wait = due - nowMs();
                    if (wait > 1) app::pumpFor ((int) wait);
                }
            }
            playHead.playing = false;
            for (int i = 0; i < 8; ++i)
            {
                for (auto& b : block) std::fill (b.begin(), b.end(), 0.0f);
                plugin->process (ptrs.data(), nch, blockSize, playHead.get());
            }
        }

        //======================================================================
        // Lecture temps réel (sortie Windows par défaut, WASAPI partagé).
        void ensureAudio()
        {
            if (audioOut.isOpen()) return;
            audioOut.open ([this] (float* const* out, int numOut, int n) { audioCallback (out, numOut, n); });
            deviceName = audioOut.deviceName();
        }

        void shutdownAudio()
        {
            audioOut.close();
        }

        void prepareRealtime()
        {
            if (prepared == Prepared::realtime || ! audioOut.isOpen()) return;
            std::lock_guard<std::mutex> sl (renderLock);
            plugin->release();
            assignRenderers (nullptr);
            deviceRate = audioOut.sampleRate();
            deviceBlock = audioOut.maxFrames();
            plugin->prepare (deviceRate, deviceBlock, false);
            const int nch = std::max ({ 2, plugin->totalInputChannels(), plugin->totalOutputChannels() });
            rtBuffer.assign ((size_t) nch, std::vector<float> ((size_t) deviceBlock, 0.0f));
            rtPtrs.resize ((size_t) nch);
            for (int ch = 0; ch < nch; ++ch) rtPtrs[(size_t) ch] = rtBuffer[(size_t) ch].data();
            playHead.sampleRate = deviceRate;
            prepared = Prepared::realtime;
        }

        void startPlayback (double positionSeconds)
        {
            if (! plugin || ! dc) return;
            try { ensureAudio(); }
            catch (const std::exception& e)
            {
                io::log (e.what());
                auto o = Value::object();
                o.set ("message", "Aucune sortie audio active sur ce PC (carte son débranchée ou désactivée) : branche-la pour écouter dans le plugin.");
                o.set ("detail", std::string (e.what()));
                io::event ("audio_error", o);
                return;
            }
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
            playHead.timeInSamples = (int64_t) std::llround (std::max (0.0, seconds) * playHead.sampleRate.load());
            sendPlaybackEvent();
        }

        void sendPlaybackEvent()
        {
            auto o = Value::object();
            o.set ("playing", playHead.playing.load());
            o.set ("position", (double) playHead.timeInSamples.load() / playHead.sampleRate.load());
            io::event ("playback", o);
        }

        void audioCallback (float* const* out, int numOut, int n)
        {
            std::unique_lock<std::mutex> sl (renderLock, std::try_to_lock);
            if (! sl.owns_lock() || prepared != Prepared::realtime || ! playHead.playing.load()) return;
            if (n > deviceBlock) return;
            for (auto& b : rtBuffer) std::fill (b.begin(), b.begin() + n, 0.0f);
            const auto pos = playHead.timeInSamples.load();
            plugin->process (rtPtrs.data(), (int) rtPtrs.size(), n, playHead.get());
            for (int ch = 0; ch < numOut; ++ch)
                std::copy (rtBuffer[(size_t) std::min (ch, (int) rtBuffer.size() - 1)].begin(),
                           rtBuffer[(size_t) std::min (ch, (int) rtBuffer.size() - 1)].begin() + n, out[ch]);
            // Guide / contexte : joués tels quels, à leur place dans le morceau.
            for (auto& c : clips)
            {
                if (c->rendersThroughPlugin()) continue;
                const double ratio = c->sampleRate() / deviceRate;
                for (int i = 0; i < n; ++i)
                {
                    const int64_t idx = (int64_t) ((double) (pos + i) * ratio - c->start * c->sampleRate());
                    if (idx < 0 || idx >= c->audio.numFrames()) continue;
                    for (int ch = 0; ch < numOut; ++ch)
                        out[ch][i] += c->audio.channels[(size_t) std::min (ch, c->audio.numChannels() - 1)][(size_t) idx];
                }
            }
            playHead.timeInSamples = pos + n;
        }

        //======================================================================
        HostCallbacks callbacks;
        std::unique_ptr<Vst3Plugin> plugin;
        const ARA::ARAFactory* factory = nullptr;
        std::unique_ptr<AudioAccess> audioAccess;
        std::unique_ptr<Archiving> archiving;
        std::unique_ptr<ContentAccess> contentAccess;
        std::unique_ptr<ModelUpdates> modelUpdates;
        std::unique_ptr<PlaybackRequests> playbackRequests;
        std::unique_ptr<ARA::Host::DocumentControllerHostInstance> hostInstance;
        std::unique_ptr<ARA::Host::DocumentController> dc;
        const ARA::ARAPlugInExtensionInstance* extension = nullptr;
        std::unique_ptr<ARA::Host::PlaybackRenderer> playbackRenderer;
        std::unique_ptr<ARA::Host::EditorRenderer> editorRenderer;
        ARA::ARAMusicalContextRef musicalContext = nullptr;
        std::vector<std::unique_ptr<HostTrack>> tracks;
        std::vector<std::unique_ptr<HostClip>> clips;
        std::set<HostClip*> inPlayback, inEditor;
        std::unique_ptr<EditorWindow> editorWindow;
        std::unique_ptr<PendingAnalysis> pendingAnalysis;
        PlayHead playHead;
        std::mutex renderLock;
        std::atomic<Prepared> prepared { Prepared::none };
        WasapiOutput audioOut;
        std::vector<std::vector<float>> rtBuffer;
        std::vector<float*> rtPtrs;
        std::string deviceName;
        bool canAnalyzeNotes = false, restored = false;
        double sampleRate = 44100.0, deviceRate = 48000.0;
        int blockSize = 1024, deviceBlock = 512;
    };

    //==========================================================================
    static std::unique_ptr<AraSession> session;

    static void replyOk (const Value& id, Value payload)
    {
        if (! payload.isObject()) payload = Value::object();
        payload.set ("id", id);
        payload.set ("ok", true);
        io::writeLine (payload);
    }

    static void replyErr (const Value& id, const std::string& err)
    {
        auto o = Value::object();
        o.set ("id", id);
        o.set ("ok", false);
        o.set ("error", err);
        io::writeLine (o);
    }

    static void handle (const std::string& text)
    {
        std::string perr;
        const auto req = Value::parse (text, &perr);
        const auto id = req["id"];
        const auto cmd = req["cmd"].asString();
        try
        {
            if (! req.isObject()) replyErr (id, "Requête JSON illisible : " + perr);
            else if (cmd == "ping") replyOk (id, {});
            else if (cmd == "load") replyOk (id, session->load (req));
            else if (cmd == "setup") replyOk (id, session->setup (req));
            else if (cmd == "analyze")
                session->analyze (req, [id] (Value res, std::string err) { if (err.empty()) replyOk (id, res); else replyErr (id, err); });
            else if (cmd == "notes") replyOk (id, session->notes());
            else if (cmd == "show_editor") replyOk (id, session->showEditor (req));
            else if (cmd == "hide_editor") replyOk (id, session->hideEditor());
            else if (cmd == "snapshot") replyOk (id, session->snapshot (req));
            else if (cmd == "capture_output") replyOk (id, session->captureOutput (req));
            else if (cmd == "capture_align") replyOk (id, session->captureAlign (req));
            else if (cmd == "select") replyOk (id, session->select());
            else if (cmd == "keys") replyOk (id, session->keys (req));
            else if (cmd == "render") replyOk (id, session->render (req));
            else if (cmd == "archive") replyOk (id, session->archive());
            else if (cmd == "restore") replyOk (id, session->restore (req));
            else if (cmd == "transport") replyOk (id, session->transport (req));
            else if (cmd == "quit") { replyOk (id, {}); PostQuitMessage (0); }
            else replyErr (id, "Commande inconnue : " + cmd);
        }
        catch (const std::exception& e) { replyErr (id, e.what()); }
        catch (...) { replyErr (id, "Erreur inconnue dans l'hôte ARA"); }
    }

    static LRESULT CALLBACK msgProc (HWND h, UINT m, WPARAM w, LPARAM l)
    {
        if (m == app::WM_NOVA_TASK) { app::runQueue(); return 0; }
        if (m == WM_TIMER && w == app::kTimerId)
        {
            // Pas pendant une commande (édition ARA en cours, rendu…) : comme un Timer JUCE différé.
            if (session && ! app::processing) session->timer();
            return 0;
        }
        return DefWindowProcW (h, m, w, l);
    }

    static void readLoop()
    {
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
                while (! one.empty() && (one.back() == '\r' || one.back() == ' ' || one.back() == '\t')) one.pop_back();
                size_t s = 0;
                while (s < one.size() && (one[s] == ' ' || one[s] == '\t')) ++s;
                if (s >= one.size()) continue;
                app::post ([line = one.substr (s)] { handle (line); });
            }
        }
        // Le pont s'est arrêté : on quitte aussi.
        app::post ([] { PostQuitMessage (0); });
    }
}

//==============================================================================
int WINAPI wWinMain (HINSTANCE, HINSTANCE, PWSTR, int)
{
    using namespace nova;
    // Jamais de boîte de dialogue d'erreur Windows (le pont tourne caché).
    SetErrorMode (SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetProcessDpiAwarenessContext (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    OleInitialize (nullptr);

    WNDCLASSEXW wc { sizeof (wc) };
    wc.lpfnWndProc = &msgProc;
    wc.hInstance = GetModuleHandleW (nullptr);
    wc.lpszClassName = L"NovaARAHostMessages";
    RegisterClassExW (&wc);
    app::msgWindow = CreateWindowExW (0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    SetTimer (app::msgWindow, app::kTimerId, 40, nullptr);

    session = std::make_unique<AraSession>();
    std::thread reader (readLoop);
    reader.detach();

    auto o = json::Value::object();
    o.set ("version", "2.0.0");
    o.set ("sdk", "VST3 SDK 3.8.1 (MIT) + ARA SDK 2.3 (Apache 2.0), sans JUCE");
    io::event ("ready", o);

    MSG m;
    while (GetMessageW (&m, nullptr, 0, 0) > 0)
    {
        TranslateMessage (&m);
        DispatchMessageW (&m);
    }

    KillTimer (app::msgWindow, app::kTimerId);
    session.reset();
    OleUninitialize();
    // Certains plugins gardent des fils en vie : on sort franchement une fois tout libéré.
    ExitProcess (0);
}
