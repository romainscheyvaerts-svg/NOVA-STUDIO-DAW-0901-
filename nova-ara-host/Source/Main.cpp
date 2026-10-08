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
    Insert ARA sur une piste (comme Pro Tools : document de la piste tenu à jour, lecture en direct)
      doc         sources:[{id, path, name, persistent_id?}], regions:[{id, source, name, offset, start,
                  duration}], track:{name}, tempo:[{t, q}], signatures:[{q, num, den}], chords:[…], archive_b64?
                  → diff appliqué au document ARA (régions créées, déplacées, coupées, rognées, retirées)
      doc_state   notes?, wait_analysis_s? → régions relues dans le plugin (notes en temps du morceau)
      stream_open sample_rate, max_block → tube nommé du flux temps réel (voir AudioPipe.h)
      render_range out, start, duration, sample_rate? → la piste à travers le plugin (export, gel)
      editor      mode: dock (parent HWND, x, y, w, h, visible) | bounds | float | hide
      select      regions:[ids] → l'éditeur montre ces clips (vide : toute la piste)
      params / set_param id|title, value → réglages VST3 du plugin, en direct
    Évènements
      ready, editor_closed, transport_request {kind: start|stop|position, value}, analysis_progress,
      content_changed {scope, clip}, playback {playing, position}, audio_error, log
*/

#include "Common.h"
#include "AudioFile.h"
#include "AudioPipe.h"
#include "DockedEditor.h"
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
    // Objets de l'hôte confiés au plugin (références « host ref » d'ARA).
    struct HostObject
    {
        std::string id;
        HostObject() = default;
        explicit HostObject (std::string i) : id (std::move (i)) {}
        virtual ~HostObject() = default;
    };

    // Objet qui porte du son (source audio ARA).
    struct AudioHolder : HostObject
    {
        AudioData audio;
    };

    // Modèle : un clip NOVA = une source audio ARA + une modification + une région de lecture.
    struct HostClip : AudioHolder
    {
        std::string name, track, role, persistentId, modificationId;
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

    // Insert ARA sur une piste (comme Pro Tools) : un fichier son = une source audio + une
    // modification (les retouches de Melodyne y sont rangées : couper un clip les garde) ;
    // un clip = une région de lecture (début dans le fichier, place sur la timeline, durée).
    struct LiveSource : AudioHolder
    {
        std::string name, persistentId, modificationId;
        ARA::ARAAudioSourceRef source = nullptr;
        ARA::ARAAudioModificationRef modification = nullptr;
        bool samplesEnabled = false;
        double sampleRate() const { return audio.sampleRate; }
        double duration() const { return audio.sampleRate > 0 ? (double) audio.numFrames() / audio.sampleRate : 0.0; }
    };

    struct LiveRegion : HostObject
    {
        std::string sourceId, name;
        double offset = 0.0, start = 0.0, duration = 0.0;   // s : début dans le fichier, place, durée
        LiveSource* src = nullptr;
        ARA::ARAPlaybackRegionRef region = nullptr;
    };

    template <typename Ref, typename T> static Ref toRef (T* p) { return reinterpret_cast<Ref> (p); }
    template <typename T, typename Ref> static T* fromRef (Ref r) { return reinterpret_cast<T*> (r); }
    // Toujours passer par la classe de base : le plugin nous rend le même pointeur.
    template <typename Ref> static Ref objRef (HostObject* p) { return reinterpret_cast<Ref> (p); }
    template <typename Ref> static Ref audioRef (AudioHolder* p) { return reinterpret_cast<Ref> (p); }

    //==========================================================================
    class AudioAccess final : public ARA::Host::AudioAccessControllerInterface
    {
    public:
        struct Reader { AudioHolder* clip; bool use64; };

        ARA::ARAAudioReaderHostRef createAudioReaderForSource (ARA::ARAAudioSourceHostRef src, bool use64) noexcept override
        {
            auto r = std::make_unique<Reader> (Reader { fromRef<AudioHolder> (src), use64 });
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

        // Piste tempo et piste d'accords de NOVA (insert ARA) : vides = tempo constant, pas d'accords.
        std::vector<ARA::ARAContentTempoEntry> tempoMap;
        std::vector<ARA::ARAContentBarSignature> signatures;
        std::vector<ARA::ARAContentChord> chords;
        std::vector<std::string> chordNames;

        // Position musicale (noires) à l'instant t (s), selon la piste tempo.
        double quarterAt (double t) const
        {
            if (tempoMap.size() < 2) return t * bpm.load() / 60.0;
            size_t i = 0;
            while (i + 2 < tempoMap.size() && t >= tempoMap[i + 1].timePosition) ++i;
            const auto& a = tempoMap[i];
            const auto& b = tempoMap[i + 1];
            const double dt = b.timePosition - a.timePosition;
            const double slope = dt > 1e-9 ? (b.quarterPosition - a.quarterPosition) / dt : bpm.load() / 60.0;
            return a.quarterPosition + (t - a.timePosition) * slope;
        }

        double tempoAt (double t) const
        {
            if (tempoMap.size() < 2) return bpm.load();
            size_t i = 0;
            while (i + 2 < tempoMap.size() && t >= tempoMap[i + 1].timePosition) ++i;
            const auto& a = tempoMap[i];
            const auto& b = tempoMap[i + 1];
            const double dt = b.timePosition - a.timePosition;
            return dt > 1e-9 ? 60.0 * (b.quarterPosition - a.quarterPosition) / dt : bpm.load();
        }

        // Mesure en cours à la position q (noires) : début (noires), numérateur, dénominateur.
        void barAt (double q, double& barStart, int& num, int& den) const
        {
            double s = 0; num = sigNum; den = sigDen;
            for (const auto& b : signatures)
            {
                if (b.position > q + 1e-9) break;
                s = b.position; num = b.numerator; den = b.denominator;
            }
            const double len = 4.0 * (double) num / (double) std::max (1, den);
            barStart = len > 0 ? s + std::floor ((q - s) / len + 1e-9) * len : s;
        }

        bool isMusicalContextContentAvailable (ARA::ARAMusicalContextHostRef, ARA::ARAContentType t) noexcept override
        {
            if (t == ARA::kARAContentTypeSheetChords) return ! chords.empty();
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
            if (t == ARA::kARAContentTypeTempoEntries) return tempoMap.size() >= 2 ? (ARA::ARAInt32) tempoMap.size() : 2;
            if (t == ARA::kARAContentTypeBarSignatures) return signatures.empty() ? 1 : (ARA::ARAInt32) signatures.size();
            if (t == ARA::kARAContentTypeSheetChords) return (ARA::ARAInt32) chords.size();
            return 0;
        }

        const void* getContentReaderDataForEvent (ARA::ARAContentReaderHostRef r, ARA::ARAInt32 i) noexcept override
        {
            const auto t = (ARA::ARAContentType) reinterpret_cast<intptr_t> (r);
            if (t == ARA::kARAContentTypeTempoEntries && tempoMap.size() >= 2)
                return &tempoMap[(size_t) std::clamp<ARA::ARAInt32> (i, 0, (ARA::ARAInt32) tempoMap.size() - 1)];
            if (t == ARA::kARAContentTypeBarSignatures && ! signatures.empty())
                return &signatures[(size_t) std::clamp<ARA::ARAInt32> (i, 0, (ARA::ARAInt32) signatures.size() - 1)];
            if (t == ARA::kARAContentTypeSheetChords)
            {
                if (chords.empty()) return nullptr;
                auto& c = chords[(size_t) std::clamp<ARA::ARAInt32> (i, 0, (ARA::ARAInt32) chords.size() - 1)];
                return &c;
            }
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
        std::function<void (AudioHolder*, int, float)> analysisProgress;
        std::function<void (const std::string&, const std::string&)> contentChanged;
        std::function<void (const std::string&, double)> transportRequest;
    };

    class ModelUpdates final : public ARA::Host::ModelUpdateControllerInterface
    {
    public:
        explicit ModelUpdates (HostCallbacks& c) : cb (c) {}

        void notifyAudioSourceAnalysisProgress (ARA::ARAAudioSourceHostRef src, ARA::ARAAnalysisProgressState state, float value) noexcept override
        {
            if (cb.analysisProgress) cb.analysisProgress (fromRef<AudioHolder> (src), (int) state, value);
        }
        void notifyAudioSourceContentChanged (ARA::ARAAudioSourceHostRef src, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
        {
            if (cb.contentChanged) cb.contentChanged ("source", fromRef<AudioHolder> (src)->id);
        }
        void notifyAudioModificationContentChanged (ARA::ARAAudioModificationHostRef m, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
        {
            if (cb.contentChanged) cb.contentChanged ("modification", fromRef<HostObject> (m)->id);
        }
        void notifyPlaybackRegionContentChanged (ARA::ARAPlaybackRegionHostRef r, const ARA::ARAContentTimeRange*, ARA::ContentUpdateScopes) noexcept override
        {
            if (cb.contentChanged) cb.contentChanged ("region", fromRef<HostObject> (r)->id);
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
            callbacks.analysisProgress = [] (AudioHolder* c, int state, float value)
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
                // Insert sur une piste : c'est NOVA qui joue (le pont relaie la demande à son transport).
                if (liveMode) return;
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
            pipe.stop();
            shutdownAudio();
            docked.reset();
            editorWindow.reset();
            clearDocument();
            clearLive();
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
                clip->source = dc->createAudioSource (audioRef<ARA::ARAAudioSourceHostRef> (clip.get()), &sp);

                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAAudioModificationProperties, persistentID)> mp {
                    clip->name.c_str(), clip->modificationId.c_str() };
                clip->modification = dc->createAudioModification (clip->source, objRef<ARA::ARAAudioModificationHostRef> (clip.get()), &mp);

                const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, color)> rp {
                    (ARA::ARAPlaybackTransformationFlags) ARA::kARAPlaybackTransformationNoChanges,
                    0.0, clip->duration(), clip->start, clip->duration(),
                    musicalContext, track->sequence, clip->name.c_str(), nullptr };
                clip->region = dc->createPlaybackRegion (clip->modification, objRef<ARA::ARAPlaybackRegionHostRef> (clip.get()), &rp);
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
            HWND hwnd = (editorWindow != nullptr && editorWindow->isVisible()) ? editorWindow->handle()
                      : (docked != nullptr && docked->isVisible() ? docked->handle() : nullptr);
            if (hwnd == nullptr) throw std::runtime_error ("Aucune fenêtre ouverte");
            const auto path = req["path"].asString();
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
            HWND top = (editorWindow != nullptr && editorWindow->isVisible()) ? editorWindow->handle()
                     : (docked != nullptr && docked->isVisible() ? docked->handle() : nullptr);
            if (top == nullptr) throw std::runtime_error ("Aucune fenêtre ouverte");
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
        // INSERT ARA SUR UNE PISTE (comme Pro Tools) : document de la piste tenu à jour à chaque
        // édition de NOVA, lecture en direct (flux AudioPipe calé sur le transport de NOVA),
        // rendu hors ligne identique, fenêtre du plugin ancrée dans l'appli.
        //======================================================================

        // doc  sources:[{id, path, name, persistent_id?, modification_id?}] (path : fichiers nouveaux
        //      seulement), regions:[{id, source, name, offset, start, duration}], track:{name},
        //      tempo:[{t, q}], signatures:[{q, num, den}], chords:[{q, root, bass, intervals[12], name}],
        //      bpm?, archive_b64? (retouches à restaurer, une fois)
        Value doc (const Value& req)
        {
            requireLoaded();
            if (! clips.empty()) throw std::runtime_error ("Session « clip » ouverte : pas d'insert sur cette instance");
            liveMode = true;

            // 1) Fichiers nouveaux, lus hors verrou (la lecture continue pendant ce temps).
            std::map<std::string, std::unique_ptr<LiveSource>> fresh;
            std::set<std::string> listed;
            const auto& srcList = req["sources"];
            for (size_t i = 0; srcList.isArray() && i < srcList.size(); ++i)
            {
                const auto& s = srcList.at (i);
                const auto id = s["id"].asString();
                if (id.empty()) continue;
                listed.insert (id);
                if (liveSources.count (id) || fresh.count (id)) continue;
                auto src = std::make_unique<LiveSource>();
                src->id = id;
                src->name = s.has ("name") ? s["name"].asString() : id;
                src->persistentId = s.has ("persistent_id") ? s["persistent_id"].asString() : ("nova:" + id);
                src->modificationId = s.has ("modification_id") ? s["modification_id"].asString() : (src->persistentId + "/modif");
                const auto path = s["path"].asString();
                if (! readWav (path, src->audio)) throw std::runtime_error ("Audio illisible : " + path);
                if (src->audio.numChannels() == 0) src->audio.setSize (1, 0);
                fresh.emplace (id, std::move (src));
            }

            // 2) Régions voulues (clips de la piste).
            struct Want { std::string id, sourceId, name; double offset, start, duration; };
            std::vector<Want> want;
            const auto& regList = req["regions"];
            for (size_t i = 0; regList.isArray() && i < regList.size(); ++i)
            {
                const auto& r = regList.at (i);
                Want w { r["id"].asString(), r["source"].asString(), r["name"].asString(),
                         std::max (0.0, r["offset"].asDouble (0.0)), r["start"].asDouble (0.0), r["duration"].asDouble (0.0) };
                LiveSource* s = liveSources.count (w.sourceId) ? liveSources[w.sourceId].get()
                              : (fresh.count (w.sourceId) ? fresh[w.sourceId].get() : nullptr);
                if (w.id.empty() || s == nullptr) continue;
                // Région dans le fichier (ARA : jamais au-delà de la modification).
                const double srcDur = s->duration();
                w.offset = std::min (w.offset, std::max (0.0, srcDur - 1e-3));
                w.duration = std::min (w.duration, srcDur - w.offset);
                if (w.duration <= 1e-4) continue;
                if (w.name.empty()) w.name = s->name;
                want.push_back (w);
            }

            // 3) Tempo, mesures, accords (piste tempo R2, piste d'accords V20).
            Music music = parseMusic (req);
            const bool musicChanged = ! sameMusic (music);

            std::set<std::string> wantIds;
            for (auto& w : want) wantIds.insert (w.id);
            std::vector<std::string> removed, added, updated;
            for (auto& [id, r] : liveRegions) if (! wantIds.count (id)) removed.push_back (id);
            for (auto& w : want)
            {
                auto it = liveRegions.find (w.id);
                if (it == liveRegions.end()) { added.push_back (w.id); continue; }
                auto& r = *it->second;
                if (r.sourceId != w.sourceId) { removed.push_back (w.id); added.push_back (w.id); continue; }   // autre son
                if (std::abs (r.offset - w.offset) > 1e-7 || std::abs (r.start - w.start) > 1e-7
                    || std::abs (r.duration - w.duration) > 1e-7 || r.name != w.name)
                    updated.push_back (w.id);
            }
            const bool renderersChange = ! removed.empty() || ! added.empty();
            const auto archiveB64 = req["archive_b64"].asString();
            std::vector<uint8_t> archiveBytes;
            if (! archiveB64.empty()) base64::decode (archiveB64, archiveBytes);

            bool restoredNow = false;
            {
                std::lock_guard<std::mutex> sl (renderLock);
                // Ajouter / retirer des régions au rendu : plugin à l'arrêt (règle d'ARA).
                if (renderersChange && prepared != Prepared::none) { plugin->release(); prepared = Prepared::none; }
                for (auto& id : removed)
                {
                    auto it = liveRegions.find (id);
                    if (it == liveRegions.end()) continue;
                    unassignLive (it->second.get());
                }
                dc->beginEditing();
                if (musicChanged)
                {
                    applyMusic (std::move (music));
                    dc->updateMusicalContextContent (musicalContext, nullptr, ARA::ContentUpdateScopes::timelineIsAffected());
                }
                const auto trackName = req["track"]["name"].asString();
                if (liveSequence == nullptr)
                {
                    liveTrackName = trackName.empty() ? std::string ("Piste") : trackName;
                    const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARARegionSequenceProperties, color)> p {
                        liveTrackName.c_str(), 0, musicalContext, nullptr };
                    liveSequence = dc->createRegionSequence (objRef<ARA::ARARegionSequenceHostRef> (&liveSeqObj), &p);
                }
                else if (! trackName.empty() && trackName != liveTrackName)
                {
                    liveTrackName = trackName;
                    const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARARegionSequenceProperties, color)> p {
                        liveTrackName.c_str(), 0, musicalContext, nullptr };
                    dc->updateRegionSequenceProperties (liveSequence, &p);
                }
                for (auto& id : removed)
                {
                    auto it = liveRegions.find (id);
                    if (it == liveRegions.end()) continue;
                    if (it->second->region != nullptr) dc->destroyPlaybackRegion (it->second->region);
                    liveRegions.erase (it);
                }
                for (auto& [id, src] : fresh)
                {
                    const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAAudioSourceProperties, channelArrangement)> sp {
                        src->name.c_str(), src->persistentId.c_str(), (ARA::ARASampleCount) src->audio.numFrames(),
                        src->sampleRate(), (ARA::ARAChannelCount) src->audio.numChannels(), (ARA::ARABool) false,
                        ARA::kARAChannelArrangementUndefined, nullptr };
                    src->source = dc->createAudioSource (audioRef<ARA::ARAAudioSourceHostRef> (src.get()), &sp);
                    const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAAudioModificationProperties, persistentID)> mp {
                        src->name.c_str(), src->modificationId.c_str() };
                    src->modification = dc->createAudioModification (src->source, objRef<ARA::ARAAudioModificationHostRef> (src.get()), &mp);
                    liveSources.emplace (id, std::move (src));
                }
                fresh.clear();
                for (auto& w : want)
                {
                    const bool isNew = std::find (added.begin(), added.end(), w.id) != added.end();
                    const bool isUpd = std::find (updated.begin(), updated.end(), w.id) != updated.end();
                    if (! isNew && ! isUpd) continue;
                    LiveRegion* r = nullptr;
                    if (isNew)
                    {
                        auto nr = std::make_unique<LiveRegion>();
                        nr->id = w.id;
                        r = nr.get();
                        liveRegions[w.id] = std::move (nr);
                    }
                    else r = liveRegions[w.id].get();
                    r->sourceId = w.sourceId; r->name = w.name; r->offset = w.offset; r->start = w.start; r->duration = w.duration;
                    r->src = liveSources[w.sourceId].get();
                    const ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAPlaybackRegionProperties, color)> rp {
                        (ARA::ARAPlaybackTransformationFlags) ARA::kARAPlaybackTransformationNoChanges,
                        r->offset, r->duration, r->start, r->duration, musicalContext, liveSequence, r->name.c_str(), nullptr };
                    if (isNew) r->region = dc->createPlaybackRegion (r->src->modification, objRef<ARA::ARAPlaybackRegionHostRef> (r), &rp);
                    else dc->updatePlaybackRegionProperties (r->region, &rp);
                }
                if (! archiveBytes.empty())
                    restoredNow = dc->restoreObjectsFromArchive (toRef<ARA::ARAArchiveReaderHostRef> (&archiveBytes), nullptr);
                dc->endEditing();

                for (auto& [id, s] : liveSources)
                    if (! s->samplesEnabled) { dc->enableAudioSourceSamplesAccess (s->source, true); s->samplesEnabled = true; }

                // Fichiers qui ne servent plus (aucun clip, plus dans la liste) : retirés du document.
                std::vector<std::string> unused;
                for (auto& [id, s] : liveSources)
                {
                    if (listed.count (id)) continue;
                    bool used = false;
                    for (auto& [rid, r] : liveRegions) if (r->sourceId == id) { used = true; break; }
                    if (! used) unused.push_back (id);
                }
                if (! unused.empty())
                {
                    for (auto& id : unused) { auto& s = liveSources[id]; dc->enableAudioSourceSamplesAccess (s->source, false); s->samplesEnabled = false; }
                    dc->beginEditing();
                    for (auto& id : unused)
                    {
                        auto& s = liveSources[id];
                        dc->destroyAudioModification (s->modification);
                        dc->destroyAudioSource (s->source);
                    }
                    dc->endEditing();
                    for (auto& id : unused) liveSources.erase (id);
                }

                if (renderersChange || prepared == Prepared::none) assignLive();
                if (streamWanted && prepared != Prepared::stream) prepareStreamLocked();
            }
            if (restoredNow) restored = true;
            if (canAnalyzeNotes && ! added.empty())
            {
                const ARA::ARAContentType types[] { ARA::kARAContentTypeNotes };
                for (auto& [id, s] : liveSources)
                    if (dc->isAudioSourceContentAnalysisIncomplete (s->source, ARA::kARAContentTypeNotes))
                        dc->requestAudioSourceContentAnalysis (s->source, 1, types);
            }
            if (docked != nullptr && renderersChange) notifySelectionLive ({});
            ++docVersion;

            auto out = Value::object();
            out.set ("version", docVersion);
            out.set ("sources", (int) liveSources.size());
            out.set ("regions", (int) liveRegions.size());
            out.set ("added", (int) added.size());
            out.set ("removed", (int) removed.size());
            out.set ("updated", (int) updated.size());
            out.set ("music_changed", musicChanged);
            out.set ("restored", restoredNow);
            out.set ("latency_samples", plugin->latencySamples());
            return out;
        }

        // doc_state : le document tel que le plugin le voit (régions relues : notes de chaque
        // région, en temps du morceau, lues dans le plugin ; tête et queue).
        // wait_analysis_s : attend la fin de l'analyse (réponse différée).
        Value docState (const Value& req)
        {
            requireLoaded();
            auto out = Value::object();
            auto regs = Value::array();
            const bool withNotes = req["notes"].asBool (true);
            for (auto& [id, r] : liveRegions)
            {
                auto o = Value::object();
                o.set ("id", r->id);
                o.set ("source", r->sourceId);
                o.set ("offset", r->offset);
                o.set ("start", r->start);
                o.set ("duration", r->duration);
                ARA::ARATimeDuration head = 0, tail = 0;
                dc->getPlaybackRegionHeadAndTailTime (r->region, &head, &tail);
                o.set ("head", (double) head);
                o.set ("tail", (double) tail);
                if (withNotes) o.set ("notes", readRegionNotes (*r));
                regs.push (o);
            }
            auto srcs = Value::array();
            for (auto& [id, s] : liveSources)
            {
                auto o = Value::object();
                o.set ("id", s->id);
                o.set ("frames", (double) s->audio.numFrames());
                o.set ("sample_rate", s->sampleRate());
                o.set ("analysis_incomplete", canAnalyzeNotes && dc->isAudioSourceContentAnalysisIncomplete (s->source, ARA::kARAContentTypeNotes));
                srcs.push (o);
            }
            out.set ("regions", regs);
            out.set ("sources", srcs);
            out.set ("track", liveTrackName);
            out.set ("version", docVersion);
            out.set ("tempo_entries", (int) contentAccess->tempoMap.size());
            out.set ("signatures", (int) contentAccess->signatures.size());
            out.set ("chords", (int) contentAccess->chords.size());
            out.set ("audio_readers", audioAccess != nullptr ? audioAccess->readersCreated.load() : 0);
            out.set ("stream_blocks", (double) pipe.blocks.load());
            out.set ("stream_rendered", (double) pipe.rendered.load());
            out.set ("latency_samples", plugin->latencySamples());
            return out;
        }

        void docStateWhenAnalyzed (const Value& req, std::function<void (Value, std::string)> reply)
        {
            requireLoaded();
            pendingAnalysis = std::make_unique<PendingAnalysis>();
            pendingAnalysis->reply = std::move (reply);
            pendingAnalysis->started = nowMs();
            pendingAnalysis->timeoutMs = 1000.0 * req["wait_analysis_s"].asDouble (60.0);
            pendingAnalysis->live = true;
            pendingAnalysis->request = req;
        }

        // stream_open sample_rate, max_block → nom du tube ; le pont s'y connecte.
        Value streamOpen (const Value& req)
        {
            requireLoaded();
            liveMode = true;
            streamRate = req["sample_rate"].asDouble (sampleRate);
            streamBlock = std::clamp (req["max_block"].asInt (2048), 64, AudioPipe::kMaxFrames);
            streamWanted = true;
            {
                std::lock_guard<std::mutex> sl (renderLock);
                if (prepared == Prepared::stream) { plugin->release(); prepared = Prepared::none; }
                prepareStreamLocked();
            }
            if (! pipe.running())
                pipe.start ("NovaARAHost-" + std::to_string (GetCurrentProcessId()) + "-audio",
                            [this] (const float* const* in, int nin, float* const* outp, int n, int64_t pos, bool playing)
                            { return streamProcess (in, nin, outp, n, pos, playing); });
            auto out = Value::object();
            out.set ("pipe", "\\\\.\\pipe\\" + pipe.name());
            out.set ("sample_rate", streamRate);
            out.set ("max_block", streamBlock);
            out.set ("latency_samples", plugin->latencySamples());
            out.set ("output_channels", plugin->totalOutputChannels());
            return out;
        }

        // render_range out, start (s), duration (s), sample_rate? → la piste à travers le plugin,
        // hors temps réel, calée sur le temps du morceau (latence compensée) : export, gel, bounce.
        Value renderRange (const Value& req)
        {
            requireLoaded();
            const double start = req["start"].asDouble (0.0);
            const double dur = req["duration"].asDouble (0.0);
            const double sr = req["sample_rate"].asDouble (streamRate > 0 ? streamRate : sampleRate);
            const auto outPath = req["out"].asString();
            if (dur <= 0 || outPath.empty()) throw std::runtime_error ("Plage de rendu invalide");
            AudioData outBuf;
            double peak = 0;
            int latency = 0;
            {
                std::lock_guard<std::mutex> sl (renderLock);
                const bool wasStream = prepared == Prepared::stream;
                plugin->release();
                prepared = Prepared::none;
                assignLive();
                plugin->prepare (sr, blockSize, true);
                prepared = Prepared::offline;
                latency = plugin->latencySamples();
                const int64_t pos0 = (int64_t) std::llround (start * sr);
                const int64_t len = (int64_t) std::llround (dur * sr);
                const int64_t pre = (int64_t) std::llround (0.25 * sr);   // élan : le plugin se cale avant le début
                const int nch = std::max ({ 2, plugin->totalInputChannels(), plugin->totalOutputChannels() });
                const int outCh = std::max (1, plugin->totalOutputChannels());
                outBuf.sampleRate = sr;
                outBuf.setSize (2, len);
                std::vector<std::vector<float>> block ((size_t) nch, std::vector<float> ((size_t) blockSize, 0.0f));
                std::vector<float*> ptrs ((size_t) nch);
                for (int ch = 0; ch < nch; ++ch) ptrs[(size_t) ch] = block[(size_t) ch].data();
                const int64_t end = pos0 + len + latency;
                for (int64_t p = pos0 - pre; p < end; p += blockSize)
                {
                    const int n = (int) std::min ((int64_t) blockSize, end - p);
                    for (auto& b : block) std::fill (b.begin(), b.begin() + n, 0.0f);
                    plugin->process (ptrs.data(), nch, n, transportAt (p, sr, true));
                    for (int i = 0; i < n; ++i)
                    {
                        const int64_t idx = p + i - latency - pos0;
                        if (idx < 0 || idx >= len) continue;
                        for (int ch = 0; ch < 2; ++ch)
                        {
                            const float v = block[(size_t) std::min (ch, outCh - 1)][(size_t) i];
                            outBuf.channels[(size_t) ch][(size_t) idx] = v;
                            peak = std::max (peak, (double) std::abs (v));
                        }
                    }
                }
                plugin->release();
                prepared = Prepared::none;
                if (wasStream) prepareStreamLocked();
            }
            writeWavFloat (outPath, outBuf);
            auto o = Value::object();
            o.set ("path", outPath);
            o.set ("sample_rate", sr);
            o.set ("samples", (double) outBuf.numFrames());
            o.set ("latency", latency);
            o.set ("peak", peak);
            return o;
        }

        // editor mode: dock (parent, x, y, w, h, visible) | bounds | float | hide
        Value editor (const Value& req)
        {
            if (! plugin) throw std::runtime_error ("Aucun plugin chargé");
            if (! plugin->hasEditor()) throw std::runtime_error ("Ce plugin n'a pas de fenêtre");
            const auto mode = req["mode"].asString();
            auto out = Value::object();
            if (mode == "hide")
            {
                if (docked) docked->setBounds (0, 0, 1, 1, false);
                if (editorWindow) editorWindow->hide();
                if (req["release"].asBool (false)) { docked.reset(); editorWindow.reset(); }
                out.set ("mode", "hide");
                return out;
            }
            if (mode == "float")
            {
                docked.reset();
                auto r = showEditor (req);
                if (dc && liveMode) notifySelectionLive (selectedIds);
                r.set ("mode", "float");
                return r;
            }
            const int x = req["x"].asInt (0), y = req["y"].asInt (0), w = req["w"].asInt (800), h = req["h"].asInt (300);
            const bool visible = req["visible"].asBool (true);
            if (mode == "dock")
            {
                const auto parent = (HWND) (intptr_t) (int64_t) req["parent"].asDouble (0.0);
                if (docked == nullptr || docked->parent() != parent)
                {
                    docked.reset();
                    editorWindow.reset();   // une seule vue à la fois
                    auto view = plugin->createView();
                    if (view == nullptr) throw std::runtime_error ("Fenêtre du plugin indisponible");
                    docked = std::make_unique<DockedEditor> (view, parent);
                }
                docked->setBounds (x, y, w, h, visible);
                if (dc && liveMode) notifySelectionLive (selectedIds);
            }
            else if (mode == "bounds")
            {
                if (docked == nullptr) throw std::runtime_error ("Aucun panneau ancré");
                docked->setBounds (x, y, w, h, visible);
            }
            else throw std::runtime_error ("Mode de fenêtre inconnu : " + mode);
            out.set ("mode", mode);
            out.set ("child", docked->isChild());
            out.set ("visible", docked->isVisible());
            out.set ("view_width", docked->viewWidth());
            out.set ("view_height", docked->viewHeight());
            out.set ("resizable", docked->resizable());
            out.set ("hwnd", (double) (intptr_t) docked->handle());
            return out;
        }

        // select regions:[ids] (vide : toute la piste) → l'éditeur montre ces clips.
        Value selectLive (const Value& req)
        {
            requireLoaded();
            std::vector<std::string> ids;
            const auto& arr = req["regions"];
            for (size_t i = 0; arr.isArray() && i < arr.size(); ++i) ids.push_back (arr.at (i).asString());
            selectedIds = ids;
            const int n = notifySelectionLive (ids);
            auto out = Value::object();
            out.set ("selected", n);
            return out;
        }

        // params → réglages du plugin (VST3) ; set_param id|title, value (0–1) : réglage en direct.
        Value params()
        {
            if (! plugin || plugin->getController() == nullptr) throw std::runtime_error ("Aucun plugin chargé");
            auto* ctl = plugin->getController();
            auto arr = Value::array();
            const auto n = ctl->getParameterCount();
            for (Steinberg::int32 i = 0; i < n; ++i)
            {
                Steinberg::Vst::ParameterInfo pi {};
                if (ctl->getParameterInfo (i, pi) != Steinberg::kResultOk) continue;
                const double v = ctl->getParamNormalized (pi.id);
                Steinberg::Vst::String128 txt {};
                ctl->getParamStringByValue (pi.id, v, txt);
                auto o = Value::object();
                o.set ("id", (double) pi.id);
                o.set ("title", narrow (std::wstring (reinterpret_cast<const wchar_t*> (pi.title))));
                o.set ("units", narrow (std::wstring (reinterpret_cast<const wchar_t*> (pi.units))));
                o.set ("value", v);
                o.set ("text", narrow (std::wstring (reinterpret_cast<const wchar_t*> (txt))));
                o.set ("steps", (int) pi.stepCount);
                o.set ("flags", (int) pi.flags);
                arr.push (o);
            }
            auto out = Value::object();
            out.set ("params", arr);
            return out;
        }

        // vst_state → état VST3 du plugin (base64) ; set_vst_state state_b64 : réglages hors ARA.
        Value vstState()
        {
            if (! plugin) throw std::runtime_error ("Aucun plugin chargé");
            const auto bytes = plugin->getState();
            auto out = Value::object();
            out.set ("state_b64", base64::encode (bytes.data(), bytes.size()));
            out.set ("size", (int) bytes.size());
            return out;
        }

        Value setVstState (const Value& req)
        {
            if (! plugin) throw std::runtime_error ("Aucun plugin chargé");
            std::vector<uint8_t> m;
            if (! base64::decode (req["state_b64"].asString(), m) || m.empty()) throw std::runtime_error ("État du plugin illisible");
            bool ok = false;
            {
                std::lock_guard<std::mutex> sl (renderLock);
                ok = plugin->setState (m);
            }
            auto out = Value::object();
            out.set ("restored", ok);
            return out;
        }

        Value setParam (const Value& req)
        {
            if (! plugin || plugin->getController() == nullptr) throw std::runtime_error ("Aucun plugin chargé");
            auto* ctl = plugin->getController();
            Steinberg::Vst::ParamID id = (Steinberg::Vst::ParamID) req["id"].asDouble (-1.0);
            if (req.has ("title"))
            {
                const auto want = req["title"].asString();
                bool found = false;
                for (Steinberg::int32 i = 0; i < ctl->getParameterCount() && ! found; ++i)
                {
                    Steinberg::Vst::ParameterInfo pi {};
                    if (ctl->getParameterInfo (i, pi) == Steinberg::kResultOk
                        && narrow (std::wstring (reinterpret_cast<const wchar_t*> (pi.title))) == want) { id = pi.id; found = true; }
                }
                if (! found) throw std::runtime_error ("Réglage inconnu : " + want);
            }
            const double v = std::clamp (req["value"].asDouble (0.0), 0.0, 1.0);
            plugin->hostEdits[id] = nowMs();
            ctl->setParamNormalized (id, v);
            {
                std::lock_guard<std::mutex> l (plugin->paramLock);
                plugin->heldParams[id] = v;
                // Les valeurs déjà renvoyées par le processeur pour ce réglage sont périmées.
                auto& q = plugin->pendingToController;
                q.erase (std::remove_if (q.begin(), q.end(), [id] (const auto& e) { return e.first == id; }), q.end());
            }
            Steinberg::Vst::String128 txt {};
            ctl->getParamStringByValue (id, ctl->getParamNormalized (id), txt);
            auto out = Value::object();
            out.set ("id", (double) id);
            out.set ("value", ctl->getParamNormalized (id));
            out.set ("text", narrow (std::wstring (reinterpret_cast<const wchar_t*> (txt))));
            return out;
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
            {
                for (auto& c : clips)
                    if (dc->isAudioSourceContentAnalysisIncomplete (c->source, ARA::kARAContentTypeNotes))
                        incomplete = true;
                for (auto& [id, s] : liveSources)
                    if (dc->isAudioSourceContentAnalysisIncomplete (s->source, ARA::kARAContentTypeNotes))
                        incomplete = true;
            }
            const auto elapsed = nowMs() - pendingAnalysis->started;
            if (incomplete && elapsed < pendingAnalysis->timeoutMs) return;
            auto p = std::move (pendingAnalysis);
            try
            {
                auto res = p->live ? docState (p->request) : notes();
                res.set ("analysis_seconds", elapsed / 1000.0);
                res.set ("complete", ! incomplete);
                p->reply (res, {});
            }
            catch (const std::exception& e) { p->reply ({}, e.what()); }
        }

    private:
        enum class Prepared { none, offline, realtime, stream };

        struct PendingAnalysis
        {
            std::function<void (Value, std::string)> reply;
            double started = 0, timeoutMs = 120000;
            bool live = false;      // insert : réponse = doc_state
            Value request;
        };

        //======================================================================
        // Insert : tempo, mesures, accords reçus de NOVA.
        struct Music
        {
            double bpm = 120.0;
            std::vector<ARA::ARAContentTempoEntry> tempo;
            std::vector<ARA::ARAContentBarSignature> sigs;
            std::vector<ARA::ARAContentChord> chords;
            std::vector<std::string> names;
        };

        static Music parseMusic (const Value& req)
        {
            Music m;
            m.bpm = req["bpm"].asDouble (0.0);
            const auto& t = req["tempo"];
            for (size_t i = 0; t.isArray() && i < t.size(); ++i)
            {
                ARA::ARAContentTempoEntry e {};
                e.timePosition = t.at (i)["t"].asDouble (0.0);
                e.quarterPosition = t.at (i)["q"].asDouble (0.0);
                m.tempo.push_back (e);
            }
            const auto& s = req["signatures"];
            for (size_t i = 0; s.isArray() && i < s.size(); ++i)
            {
                ARA::ARAContentBarSignature b {};
                b.position = s.at (i)["q"].asDouble (0.0);
                b.numerator = s.at (i)["num"].asInt (4);
                b.denominator = s.at (i)["den"].asInt (4);
                m.sigs.push_back (b);
            }
            const auto& c = req["chords"];
            for (size_t i = 0; c.isArray() && i < c.size(); ++i)
            {
                const auto& x = c.at (i);
                ARA::ARAContentChord ch {};
                ch.position = x["q"].asDouble (0.0);
                ch.root = (ARA::ARACircleOfFifthsIndex) x["root"].asInt (0);
                ch.bass = (ARA::ARACircleOfFifthsIndex) (x.has ("bass") ? x["bass"].asInt (0) : x["root"].asInt (0));
                const auto& iv = x["intervals"];
                for (size_t k = 0; k < 12; ++k)
                    ch.intervals[k] = (ARA::ARAChordIntervalUsage) (iv.isArray() && k < iv.size() ? iv.at (k).asInt (0) : 0);
                m.chords.push_back (ch);
                m.names.push_back (x["name"].asString());
            }
            return m;
        }

        bool sameMusic (const Music& m) const
        {
            const auto& a = *contentAccess;
            if (m.bpm > 0 && std::abs (m.bpm - a.bpm.load()) > 1e-9) return false;
            if (m.tempo.size() != a.tempoMap.size() || m.sigs.size() != a.signatures.size() || m.chords.size() != a.chords.size()) return false;
            for (size_t i = 0; i < m.tempo.size(); ++i)
                if (std::abs (m.tempo[i].timePosition - a.tempoMap[i].timePosition) > 1e-9
                    || std::abs (m.tempo[i].quarterPosition - a.tempoMap[i].quarterPosition) > 1e-9) return false;
            for (size_t i = 0; i < m.sigs.size(); ++i)
                if (std::abs (m.sigs[i].position - a.signatures[i].position) > 1e-9
                    || m.sigs[i].numerator != a.signatures[i].numerator || m.sigs[i].denominator != a.signatures[i].denominator) return false;
            for (size_t i = 0; i < m.chords.size(); ++i)
                if (std::abs (m.chords[i].position - a.chords[i].position) > 1e-9 || m.chords[i].root != a.chords[i].root
                    || m.chords[i].bass != a.chords[i].bass || std::memcmp (m.chords[i].intervals, a.chords[i].intervals, 12) != 0) return false;
            return true;
        }

        // Sous renderLock, pendant une édition du document.
        void applyMusic (Music m)
        {
            auto& a = *contentAccess;
            if (m.bpm > 0) { a.bpm = m.bpm; playHead.bpm = m.bpm; }
            a.tempoMap = std::move (m.tempo);
            a.signatures = std::move (m.sigs);
            a.chordNames = std::move (m.names);
            a.chords = std::move (m.chords);
            for (size_t i = 0; i < a.chords.size(); ++i)
                a.chords[i].name = i < a.chordNames.size() && ! a.chordNames[i].empty() ? a.chordNames[i].c_str() : nullptr;
            if (! a.signatures.empty()) { a.sigNum = a.signatures.front().numerator; a.sigDen = a.signatures.front().denominator; }
        }

        // Position, tempo et mesure à l'échantillon pos du morceau (piste tempo de NOVA).
        Transport transportAt (int64_t pos, double sr, bool playing) const
        {
            Transport t;
            t.timeInSamples = pos;
            t.sampleRate = sr;
            t.playing = playing;
            const double sec = (double) pos / sr;
            const auto& a = *contentAccess;
            t.bpm = a.tempoAt (sec);
            t.sigNum = a.sigNum;
            t.sigDen = a.sigDen;
            if (a.tempoMap.size() >= 2 || ! a.signatures.empty())
            {
                const double q = a.quarterAt (sec);
                double bs = 0; int num = 4, den = 4;
                a.barAt (q, bs, num, den);
                t.musicPos = q; t.barPos = bs; t.sigNum = num; t.sigDen = den;
            }
            return t;
        }

        // Régions de l'insert confiées au rendu (plugin à l'arrêt).
        void assignLive()
        {
            for (auto& [id, r] : liveRegions)
            {
                if (playbackRenderer && ! livePlay.count (r.get())) { playbackRenderer->addPlaybackRegion (r->region); livePlay.insert (r.get()); }
                if (editorRenderer && ! liveEdit.count (r.get())) { editorRenderer->addPlaybackRegion (r->region); liveEdit.insert (r.get()); }
            }
        }

        void unassignLive (LiveRegion* r)
        {
            if (livePlay.count (r) && playbackRenderer) playbackRenderer->removePlaybackRegion (r->region);
            if (liveEdit.count (r) && editorRenderer) editorRenderer->removePlaybackRegion (r->region);
            livePlay.erase (r);
            liveEdit.erase (r);
        }

        void clearLive()
        {
            if (! dc) { liveRegions.clear(); liveSources.clear(); return; }
            {
                std::lock_guard<std::mutex> sl (renderLock);
                if (plugin) plugin->release();
                prepared = Prepared::none;
                for (auto& [id, r] : liveRegions) unassignLive (r.get());
            }
            for (auto& [id, s] : liveSources) if (s->samplesEnabled) dc->enableAudioSourceSamplesAccess (s->source, false);
            dc->beginEditing();
            for (auto& [id, r] : liveRegions) if (r->region) dc->destroyPlaybackRegion (r->region);
            for (auto& [id, s] : liveSources)
            {
                if (s->modification) dc->destroyAudioModification (s->modification);
                if (s->source) dc->destroyAudioSource (s->source);
            }
            if (liveSequence) dc->destroyRegionSequence (liveSequence);
            dc->endEditing();
            liveSequence = nullptr;
            liveRegions.clear();
            liveSources.clear();
        }

        // Sous renderLock.
        void prepareStreamLocked()
        {
            if (prepared == Prepared::stream || ! plugin) return;
            plugin->release();
            assignLive();
            plugin->prepare (streamRate, streamBlock, false);
            const int nch = std::max ({ 2, plugin->totalInputChannels(), plugin->totalOutputChannels() });
            streamBuf.assign ((size_t) nch, std::vector<float> ((size_t) streamBlock, 0.0f));
            streamPtrs.resize ((size_t) nch);
            for (int ch = 0; ch < nch; ++ch) streamPtrs[(size_t) ch] = streamBuf[(size_t) ch].data();
            streamOutCh = std::max (1, plugin->totalOutputChannels());
            prepared = Prepared::stream;
        }

        // Fil audio du tube : un bloc de la piste, calé sur la position du morceau envoyée par NOVA.
        bool streamProcess (const float* const* in, int nin, float* const* out, int n, int64_t pos, bool playing)
        {
            std::unique_lock<std::mutex> sl (renderLock, std::try_to_lock);
            if (! sl.owns_lock() || prepared != Prepared::stream || n > streamBlock) return false;
            for (size_t c = 0; c < streamBuf.size(); ++c)
            {
                auto& b = streamBuf[c];
                if (nin > 0 && (int) c < std::max (2, nin)) std::copy (in[std::min ((int) c, nin - 1)], in[std::min ((int) c, nin - 1)] + n, b.begin());
                else std::fill (b.begin(), b.begin() + n, 0.0f);
            }
            plugin->process (streamPtrs.data(), (int) streamPtrs.size(), n, transportAt (pos, streamRate, playing));
            for (int ch = 0; ch < 2; ++ch)
                std::copy (streamBuf[(size_t) std::min (ch, streamOutCh - 1)].begin(), streamBuf[(size_t) std::min (ch, streamOutCh - 1)].begin() + n, out[ch]);
            return true;
        }

        // L'éditeur montre ces clips (vide : toute la piste) et la piste.
        int notifySelectionLive (const std::vector<std::string>& ids)
        {
            if (extension == nullptr || extension->editorViewInterface == nullptr || extension->editorViewRef == nullptr) return 0;
            std::vector<ARA::ARAPlaybackRegionRef> regions;
            for (auto& [id, r] : liveRegions)
                if (ids.empty() || std::find (ids.begin(), ids.end(), id) != ids.end()) regions.push_back (r->region);
            std::vector<ARA::ARARegionSequenceRef> seqs;
            if (liveSequence) seqs.push_back (liveSequence);
            ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAViewSelection, timeRange)> sel;
            sel.playbackRegionRefsCount = regions.size();
            sel.playbackRegionRefs = regions.data();
            sel.regionSequenceRefsCount = seqs.size();
            sel.regionSequenceRefs = seqs.data();
            sel.timeRange = nullptr;
            ARA::Host::EditorView view (extension);
            view.notifySelection (&sel);
            return (int) regions.size();
        }

        // Notes d'une région, lues dans le plugin, en temps du morceau.
        Value readRegionNotes (LiveRegion& r)
        {
            auto arr = Value::array();
            const auto type = ARA::kARAContentTypeNotes;
            if (! dc->isPlaybackRegionContentAvailable (r.region, type)) return arr;
            auto reader = dc->createPlaybackRegionContentReader (r.region, type, nullptr);
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
            return arr;
        }

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

        // Insert ARA sur une piste (comme Pro Tools)
        bool liveMode = false, streamWanted = false;
        std::map<std::string, std::unique_ptr<LiveSource>> liveSources;
        std::map<std::string, std::unique_ptr<LiveRegion>> liveRegions;
        std::set<LiveRegion*> livePlay, liveEdit;
        HostObject liveSeqObj { std::string ("piste") };
        ARA::ARARegionSequenceRef liveSequence = nullptr;
        std::string liveTrackName;
        std::vector<std::string> selectedIds;
        int docVersion = 0;
        double streamRate = 48000.0;
        int streamBlock = 2048, streamOutCh = 2;
        std::vector<std::vector<float>> streamBuf;
        std::vector<float*> streamPtrs;
        std::unique_ptr<DockedEditor> docked;
        AudioPipe pipe;
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
            else if (cmd == "select") replyOk (id, req.has ("regions") ? session->selectLive (req) : session->select());
            else if (cmd == "doc") replyOk (id, session->doc (req));
            else if (cmd == "doc_state")
            {
                if (req.has ("wait_analysis_s"))
                    session->docStateWhenAnalyzed (req, [id] (Value res, std::string err) { if (err.empty()) replyOk (id, res); else replyErr (id, err); });
                else replyOk (id, session->docState (req));
            }
            else if (cmd == "stream_open") replyOk (id, session->streamOpen (req));
            else if (cmd == "render_range") replyOk (id, session->renderRange (req));
            else if (cmd == "editor") replyOk (id, session->editor (req));
            else if (cmd == "params") replyOk (id, session->params());
            else if (cmd == "vst_state") replyOk (id, session->vstState());
            else if (cmd == "set_vst_state") replyOk (id, session->setVstState (req));
            else if (cmd == "set_param") replyOk (id, session->setParam (req));
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
