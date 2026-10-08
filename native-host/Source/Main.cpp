/*
    NovaVSTHost — hôte VST3 natif de Nova Studio, SANS JUCE : SDK VST3 de Steinberg (licence MIT)
    + API Windows. Remplace pedalboard (GPLv3) dans le pont VST (bridge-python/vst_native.py).

    Un processus = un plugin. Lancé caché par le pont. Un plugin qui plante n'emporte que son
    processus : le pont le voit (processus terminé ou code d'erreur) et passe la piste en signal sec.

    Modes
      NovaVSTHost.exe --scan     chemins .vst3 lus sur stdin (un par ligne) ; pour chacun, lignes
                                 « @@NOVA@@{json} » : {i, start} puis {i, classes:[[nom, sous-catégories,
                                 éditeur, cid, catégorie]]} ou {i, error} ; à la fin {end}. Aucune
                                 instance créée (les shells Waves donnent leurs 725 classes directement).
                                 Une fenêtre qui s'ouvre (activation…) est cachée et signalée {i, dialog}.
      NovaVSTHost.exe [--serve]  un plugin, piloté en lignes JSON :
         stdin  ← {"id": 1, "cmd": "...", ...}
         stdout → {"id": 1, "ok": true, ...} | {"id": 1, "ok": false, "error": "...", "crashed"?: true}
                  | {"event": "...", ...}
         Audio : mémoire partagée + 2 événements (voir SharedAudio.h), commande « attach ».

    Commandes (mode serve)
      ping
      load        path, class?, cid?           → name, vendor, version, sub_categories, instrument,
                                                  class_id, classes, buses, latency, num_params
      attach      shm, req, done, mmcss?        (noms Windows de la zone et des événements)
      prepare     sample_rate, block, offline?, channels? (1|2), sidechain?
                                                → ok, main_in, main_out, sidechain, latency, buses
      release | reset
      params                                    → params:[{id, title, short, units, steps, default, flags, unit, value}]
      values                                    → values:[float] (cache de l'hôte, comme JUCE)
      text        items:[[index, valeur]]       → texts:[[ok, texte]]
      from_text   index, text                   → ok, value
      set         items:[[index, valeur]]       (contrôleur + processeur au bloc suivant)
      ranges      indices:[…], steps, slow?     → ranges:[[[pas, texte], …], …]
      latency                                   → latency, processor_latency
      get_state                                 → component (base64 | null), controller (base64 | null)
      set_state   component?, controller?
      has_editor | show_editor offscreen?, title? | hide_editor | report_edits on
      quit
    Événements : ready {version, layout}, edit {id, index, value}, begin_edit, end_edit,
      restart {flags, latency}, editor_closed, crashed {error}, log

    (c) Make Music.
*/

#include "Common.h"
#include "EditorWindow.h"
#include "Guard.h"
#include "SharedAudio.h"
#include "VstInstance.h"

#include <tlhelp32.h>
#include <avrt.h>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <deque>
#include <functional>
#include <memory>
#include <set>
#include <stdexcept>
#include <thread>

using nova::json::Value;

namespace nova
{
    static const char* kVersion = "1.0.0";

    //==========================================================================
    // Boucle de messages : fil principal = fil de l'interface (plugins, fenêtres, minuteries).
    namespace app
    {
        static HWND msgWindow = nullptr;
        static std::mutex queueLock;
        static std::deque<std::function<void()>> queue;
        static bool processing = false;
        static constexpr UINT WM_NOVA_TASK = WM_APP + 1;

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
            if (processing) return;   // une tâche ouvre une boucle modale (fenêtre de licence) : plus tard
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
    }

    //==========================================================================
    // Une instance + sa zone audio.
    struct Session
    {
        std::unique_ptr<VstInstance> inst;
        std::unique_ptr<EditorWindow> editor;
        bool crashed = false;
        std::string crashReason;

        HANDLE mapping = nullptr, reqEvent = nullptr, doneEvent = nullptr;
        uint8_t* view = nullptr;
        std::thread audio;
        std::atomic<bool> quitting { false };
        bool mmcss = false;

        ~Session() { stopAudio(); }

        void stopAudio()
        {
            quitting = true;
            if (reqEvent) SetEvent (reqEvent);
            if (audio.joinable()) audio.join();
            if (view) UnmapViewOfFile (view);
            if (mapping) CloseHandle (mapping);
            if (reqEvent) CloseHandle (reqEvent);
            if (doneEvent) CloseHandle (doneEvent);
            view = nullptr;
            mapping = reqEvent = doneEvent = nullptr;
        }

        void audioLoop()
        {
            DWORD task = 0;
            HANDLE av = mmcss ? AvSetMmThreadCharacteristicsW (L"Pro Audio", &task) : nullptr;
            if (av == nullptr) SetThreadPriority (GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
            auto* h = reinterpret_cast<shm::Header*> (view);
            float* in = reinterpret_cast<float*> (view + shm::inOffset());
            float* key = reinterpret_cast<float*> (view + shm::keyOffset());
            float* out = reinterpret_cast<float*> (view + shm::outOffset());
            while (! quitting)
            {
                if (WaitForSingleObject (reqEvent, 250) != WAIT_OBJECT_0) continue;
                if (quitting) break;
                if (crashed || ! inst)
                {
                    h->status = -3;
                    std::snprintf (h->error, sizeof (h->error), "plugin perdu (%s)", crashReason.c_str());
                }
                else
                {
                    try { inst->processRequest (*h, in, key, out); }
                    catch (const std::exception& e)
                    {
                        h->status = -4;
                        std::snprintf (h->error, sizeof (h->error), "%s", e.what());
                    }
                    if (h->status == -2)
                    {
                        crashed = true;
                        crashReason = h->error;
                        auto o = Value::object();
                        o.set ("error", std::string (h->error));
                        io::event ("crashed", o);
                    }
                }
                h->respSeq = h->reqSeq;
                SetEvent (doneEvent);
                // Réglages venus du processeur ou de l'automation : le contrôleur (fenêtre) suit.
                if (inst && ! crashed && (h->nOutChanges > 0 || h->nChanges > 0))
                    app::post ([this] { if (inst && ! crashed) inst->flushToController(); });
            }
            if (av != nullptr) AvRevertMmThreadCharacteristics (av);
        }
    };

    static std::unique_ptr<Session> session;

    //==========================================================================
    static void reply (const Value& id, Value o)
    {
        o.set ("id", id);
        o.set ("ok", true);
        io::writeLine (o);
    }

    static void replyErr (const Value& id, const std::string& msg, bool crashed = false)
    {
        auto o = Value::object();
        o.set ("id", id);
        o.set ("ok", false);
        o.set ("error", msg);
        if (crashed) o.set ("crashed", true);
        io::writeLine (o);
    }

    static Value layoutJson()
    {
        using shm::Header;
        auto o = Value::object();
        o.set ("magic", (double) shm::kMagic);
        o.set ("version", (double) shm::kVersion);
        o.set ("header", (double) sizeof (Header));
        o.set ("reqSeq", (double) offsetof (Header, reqSeq));
        o.set ("projectTimeSamples", (double) offsetof (Header, projectTimeSamples));
        o.set ("tempo", (double) offsetof (Header, tempo));
        o.set ("respSeq", (double) offsetof (Header, respSeq));
        o.set ("processUs", (double) offsetof (Header, processUs));
        o.set ("error", (double) offsetof (Header, error));
        o.set ("changes", (double) offsetof (Header, changes));
        o.set ("events", (double) offsetof (Header, events));
        o.set ("outChanges", (double) offsetof (Header, outChanges));
        o.set ("in", (double) shm::inOffset());
        o.set ("key", (double) shm::keyOffset());
        o.set ("out", (double) shm::outOffset());
        o.set ("total", (double) shm::totalSize());
        o.set ("maxFrames", shm::kMaxFrames);
        o.set ("maxChannels", shm::kMaxChannels);
        o.set ("maxKeyChannels", shm::kMaxKeyChannels);
        o.set ("maxChanges", shm::kMaxChanges);
        o.set ("maxEvents", shm::kMaxEvents);
        o.set ("maxOutChanges", shm::kMaxOutChanges);
        return o;
    }

    static void bringToFront (HWND hwnd)
    {
        // Un processus en arrière-plan n'a pas le droit de passer devant : la touche Alt simulée
        // le lui accorde (même astuce que le pont avec pedalboard).
        keybd_event (VK_MENU, 0, 0, 0);
        ShowWindow (hwnd, SW_RESTORE);
        SetForegroundWindow (hwnd);
        BringWindowToTop (hwnd);
        keybd_event (VK_MENU, 0, KEYEVENTF_KEYUP, 0);
    }

    // Exécute fn sous garde SEH : un plantage du plugin devient une erreur (et l'instance est perdue).
    template <typename Fn>
    static void guarded (const char* what, Fn&& fn)
    {
        std::string err;
        bool cppError = false;
        const bool ok = guard::call ([&] {
            try { fn(); }
            catch (const guard::Crash& e) { err = e.what(); session->crashed = true; session->crashReason = err; }
            catch (const std::exception& e) { err = e.what(); cppError = true; }
        });
        if (! ok)
        {
            char buf[160];
            std::snprintf (buf, sizeof (buf), "Le plugin a planté (%s, code 0x%08X)", what, guard::lastCode());
            session->crashed = true;
            session->crashReason = buf;
            throw guard::Crash (buf);
        }
        if (session->crashed) throw guard::Crash (err.empty() ? session->crashReason : err);
        if (cppError) throw std::runtime_error (err);
    }

    static VstInstance& need()
    {
        if (! session->inst) throw std::runtime_error ("Aucun plugin chargé");
        if (session->crashed) throw guard::Crash ("plugin perdu (" + session->crashReason + ")");
        return *session->inst;
    }

    static Value b64OrNull (const std::vector<uint8_t>& v, bool present)
    {
        if (! present) return Value();
        return Value (base64::encode (v.data(), v.size()));
    }

    static void handle (const std::string& line)
    {
        std::string perr;
        const auto req = Value::parse (line, &perr);
        const Value id = req["id"];
        if (! req.isObject()) { replyErr (id, "JSON illisible : " + perr); return; }
        const auto cmd = req["cmd"].asString();
        try
        {
            if (cmd == "ping")
            {
                auto o = Value::object();
                o.set ("version", kVersion);
                reply (id, o);
            }
            else if (cmd == "load")
            {
                if (session->inst) throw std::runtime_error ("Un plugin est déjà chargé dans ce processus");
                auto inst = std::make_unique<VstInstance>();
                inst->emit = [] (const std::string& n, Value o) { io::event (n, std::move (o)); };
                inst->postToMain = [] (std::function<void()> fn) { app::post (std::move (fn)); };
                auto* raw = inst.get();
                session->inst = std::move (inst);
                guarded ("chargement", [&] { raw->load (req["path"].asString(), req["class"].asString(), req["cid"].asString()); });
                auto o = Value::object();
                o.set ("name", raw->name);
                o.set ("vendor", raw->vendor);
                o.set ("version", raw->version);
                o.set ("category", raw->category);
                o.set ("sub_categories", raw->subCategories);
                o.set ("sdk_version", raw->sdkVersion);
                o.set ("class_id", raw->classId);
                o.set ("instrument", raw->instrument);
                o.set ("classes", raw->numClasses);
                o.set ("buses", raw->busesJson());
                o.set ("latency", raw->latency());
                o.set ("num_params", (int) raw->params.size());
                reply (id, o);
            }
            else if (cmd == "attach")
            {
                if (session->view) throw std::runtime_error ("Zone audio déjà ouverte");
                session->mapping = OpenFileMappingW (FILE_MAP_ALL_ACCESS, FALSE, widen (req["shm"].asString()).c_str());
                if (! session->mapping) throw std::runtime_error ("Zone audio introuvable");
                session->view = (uint8_t*) MapViewOfFile (session->mapping, FILE_MAP_ALL_ACCESS, 0, 0, shm::totalSize());
                if (! session->view) throw std::runtime_error ("Zone audio inaccessible");
                auto* h = reinterpret_cast<shm::Header*> (session->view);
                if (h->magic != shm::kMagic || h->headerSize != sizeof (shm::Header))
                    throw std::runtime_error ("Zone audio incompatible (version du pont ?)");
                session->reqEvent = OpenEventW (SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, widen (req["req"].asString()).c_str());
                session->doneEvent = OpenEventW (SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, widen (req["done"].asString()).c_str());
                if (! session->reqEvent || ! session->doneEvent) throw std::runtime_error ("Événements audio introuvables");
                session->mmcss = req["mmcss"].asBool (false);
                session->quitting = false;
                auto* s = session.get();
                session->audio = std::thread ([s] { s->audioLoop(); });
                reply (id, Value::object());
            }
            else if (cmd == "prepare")
            {
                auto& inst = need();
                Value res;
                guarded ("préparation", [&] {
                    res = inst.prepare (req["sample_rate"].asDouble (48000), req["block"].asInt (512),
                                        req["offline"].asBool (true), req["channels"].asInt (2), req["sidechain"].asBool (false));
                });
                reply (id, res);
            }
            else if (cmd == "release") { auto& inst = need(); guarded ("arrêt", [&] { inst.release(); }); reply (id, Value::object()); }
            else if (cmd == "reset") { auto& inst = need(); guarded ("remise à zéro", [&] { inst.reset(); }); reply (id, Value::object()); }
            else if (cmd == "params")
            {
                auto& inst = need();
                auto o = Value::object();
                o.set ("params", inst.paramsJson());
                Value units;
                guarded ("unités", [&] { units = inst.unitsJson(); });
                o.set ("units", units);
                reply (id, o);
            }
            else if (cmd == "values")
            {
                auto& inst = need();
                auto arr = Value::array();
                for (size_t i = 0; i < inst.params.size(); ++i) arr.push ((double) inst.value ((int) i));
                auto o = Value::object();
                o.set ("values", arr);
                o.set ("latency", inst.latency());
                reply (id, o);
            }
            else if (cmd == "text")
            {
                auto& inst = need();
                const auto& items = req["items"];
                auto arr = Value::array();
                guarded ("texte d'un réglage", [&] {
                    for (size_t i = 0; i < items.size(); ++i)
                    {
                        std::string t;
                        const bool ok = inst.textFor (items.at (i).at (0).asInt (-1), items.at (i).at (1).asDouble (0), t);
                        auto pair = Value::array();
                        pair.push (ok);
                        pair.push (t);
                        arr.push (pair);
                    }
                });
                auto o = Value::object();
                o.set ("texts", arr);
                reply (id, o);
            }
            else if (cmd == "from_text")
            {
                auto& inst = need();
                double v = 0;
                bool ok = false;
                guarded ("lecture d'un texte", [&] { ok = inst.valueForText (req["index"].asInt (-1), req["text"].asString(), v); });
                auto o = Value::object();
                o.set ("found", ok);
                o.set ("value", v);
                reply (id, o);
            }
            else if (cmd == "set")
            {
                auto& inst = need();
                const auto& items = req["items"];
                guarded ("réglage", [&] {
                    for (size_t i = 0; i < items.size(); ++i)
                        inst.setValue (items.at (i).at (0).asInt (-1), (float) items.at (i).at (1).asDouble (0));
                });
                reply (id, Value::object());
            }
            else if (cmd == "ranges")
            {
                auto& inst = need();
                const auto& idx = req["indices"];
                const int steps = req["steps"].asInt (1000);
                const bool slow = req["slow"].asBool (false);
                auto arr = Value::array();
                guarded ("textes d'un réglage", [&] {
                    for (size_t i = 0; i < idx.size(); ++i) arr.push (inst.ranges (idx.at (i).asInt (-1), steps, slow));
                });
                auto o = Value::object();
                o.set ("ranges", arr);
                reply (id, o);
            }
            else if (cmd == "latency")
            {
                auto& inst = need();
                auto o = Value::object();
                o.set ("latency", inst.latency());
                reply (id, o);
            }
            else if (cmd == "get_state")
            {
                auto& inst = need();
                std::vector<uint8_t> comp, ctrl;
                bool hasComp = false, hasCtrl = false;
                guarded ("lecture de l'état", [&] { hasComp = inst.getState (comp, ctrl, hasCtrl); });
                auto o = Value::object();
                o.set ("component", b64OrNull (comp, hasComp));
                o.set ("controller", b64OrNull (ctrl, hasCtrl));
                reply (id, o);
            }
            else if (cmd == "set_state")
            {
                auto& inst = need();
                std::vector<uint8_t> comp, ctrl;
                const bool hasComp = req["component"].isString() && base64::decode (req["component"].asString(), comp);
                const bool hasCtrl = req["controller"].isString() && base64::decode (req["controller"].asString(), ctrl);
                guarded ("restauration de l'état", [&] { inst.setState (hasComp ? &comp : nullptr, hasCtrl ? &ctrl : nullptr); });
                reply (id, Value::object());
            }
            else if (cmd == "has_editor")
            {
                auto& inst = need();
                bool has = false;
                guarded ("fenêtre", [&] { has = inst.hasEditor(); });
                auto o = Value::object();
                o.set ("has_editor", has);
                reply (id, o);
            }
            else if (cmd == "show_editor")
            {
                auto& inst = need();
                const bool offscreen = req["offscreen"].asBool (false);
                if (session->editor && session->editor->offscreen != offscreen) session->editor.reset();
                if (! session->editor)
                {
                    guarded ("ouverture de la fenêtre", [&] {
                        auto title = req["title"].asString (inst.name);
                        if (title.empty()) title = inst.name;
                        session->editor = std::make_unique<EditorWindow> (inst.createView(), title, offscreen, [] {
                            io::event ("editor_closed");
                            app::post ([] { if (session) session->editor.reset(); });
                        });
                    });
                }
                session->editor->show();
                if (! offscreen) bringToFront (session->editor->handle());
                auto o = Value::object();
                o.set ("width", session->editor->clientWidth());
                o.set ("height", session->editor->clientHeight());
                o.set ("hwnd", (double) (uintptr_t) session->editor->handle());
                reply (id, o);
            }
            else if (cmd == "hide_editor")
            {
                const bool was = session->editor != nullptr;
                session->editor.reset();
                if (was) io::event ("editor_closed");
                reply (id, Value::object());
            }
            else if (cmd == "report_edits")
            {
                auto& inst = need();
                inst.reportEdits = req["on"].asBool (true);
                reply (id, Value::object());
            }
            else if (cmd == "quit")
            {
                reply (id, Value::object());
                PostQuitMessage (0);
            }
            else replyErr (id, "Commande inconnue : " + cmd);
        }
        catch (const guard::Crash& e)
        {
            session->crashed = true;
            replyErr (id, e.what(), true);
        }
        catch (const std::exception& e) { replyErr (id, e.what(), session->crashed); }
        catch (...) { replyErr (id, "Erreur inconnue dans l'hôte VST", session->crashed); }
    }

    static LRESULT CALLBACK msgProc (HWND h, UINT m, WPARAM w, LPARAM l)
    {
        if (m == app::WM_NOVA_TASK) { app::runQueue(); return 0; }
        return DefWindowProcW (h, m, w, l);
    }

    static std::vector<std::string> splitLines (const std::string& all)
    {
        std::vector<std::string> out;
        size_t p = 0;
        while (p <= all.size())
        {
            size_t nl = all.find ('\n', p);
            if (nl == std::string::npos) nl = all.size();
            auto one = all.substr (p, nl - p);
            while (! one.empty() && (one.back() == '\r' || one.back() == ' ' || one.back() == '\t')) one.pop_back();
            size_t s = 0;
            while (s < one.size() && (one[s] == ' ' || one[s] == '\t')) ++s;
            if (s < one.size()) out.push_back (one.substr (s));
            p = nl + 1;
        }
        return out;
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
                for (auto& l : splitLines (one)) app::post ([line = l] { handle (line); });
            }
        }
        // Le pont s'est arrêté : on quitte aussi.
        app::post ([] { PostQuitMessage (0); });
    }

    //==========================================================================
    // Mode --scan
    namespace scan
    {
        static const char* kMark = "@@NOVA@@";
        static std::mutex outLock;
        static std::atomic<int> current { -1 };

        static void emit (const Value& v)
        {
            std::string s = "\n";
            s += kMark;
            s += v.dump();
            s += "\n";
            std::lock_guard<std::mutex> l (outLock);
            DWORD w = 0;
            auto h = GetStdHandle (STD_OUTPUT_HANDLE);
            WriteFile (h, s.data(), (DWORD) s.size(), &w, nullptr);
            FlushFileBuffers (h);
        }

        static std::set<DWORD> processTree()
        {
            std::set<DWORD> tree { GetCurrentProcessId() };
            HANDLE snap = CreateToolhelp32Snapshot (TH32CS_SNAPPROCESS, 0);
            if (snap == INVALID_HANDLE_VALUE) return tree;
            std::vector<std::pair<DWORD, DWORD>> all;
            PROCESSENTRY32W pe { sizeof (pe) };
            if (Process32FirstW (snap, &pe))
                do all.emplace_back (pe.th32ProcessID, pe.th32ParentProcessID); while (Process32NextW (snap, &pe));
            CloseHandle (snap);
            for (bool grew = true; grew;)
            {
                grew = false;
                for (auto& [pid, parent] : all)
                    if (tree.count (parent) && ! tree.count (pid)) { tree.insert (pid); grew = true; }
            }
            return tree;
        }

        // Fenêtres d'activation / de licence ouvertes pendant la lecture : cachées et signalées.
        static void dialogWatch()
        {
            std::set<HWND> seen;
            for (;;)
            {
                Sleep (200);
                const int i = current.load();
                if (i < 0) continue;
                const auto tree = processTree();
                struct Ctx { const std::set<DWORD>* tree; std::vector<HWND> found; } ctx { &tree, {} };
                EnumWindows ([] (HWND h, LPARAM lp) -> BOOL {
                    auto* c = reinterpret_cast<Ctx*> (lp);
                    DWORD pid = 0;
                    GetWindowThreadProcessId (h, &pid);
                    if (c->tree->count (pid) && IsWindowVisible (h)) c->found.push_back (h);
                    return TRUE;
                }, (LPARAM) &ctx);
                for (HWND h : ctx.found)
                {
                    if (seen.count (h)) continue;
                    seen.insert (h);
                    wchar_t title[256] {}, cls[128] {};
                    GetWindowTextW (h, title, 255);
                    GetClassNameW (h, cls, 127);
                    ShowWindow (h, SW_HIDE);
                    auto o = Value::object();
                    o.set ("i", i);
                    o.set ("dialog", narrow (title[0] ? title : cls));
                    emit (o);
                }
            }
        }

        static int run()
        {
            std::string all;
            {
                auto h = GetStdHandle (STD_INPUT_HANDLE);
                char buf[65536];
                DWORD got = 0;
                while (ReadFile (h, buf, sizeof (buf), &got, nullptr) && got > 0) all.append (buf, got);
            }
            const auto paths = splitLines (all);
            std::thread (dialogWatch).detach();
            for (int i = 0; i < (int) paths.size(); ++i)
            {
                current = i;
                auto st = Value::object();
                st.set ("i", i);
                st.set ("start", true);
                emit (st);
                auto o = Value::object();
                o.set ("i", i);
                std::string err;
                Value classes = Value::array();
                std::string factoryVendor;
                const double t0 = nowMs();
                const bool fine = guard::call ([&] {
                    try
                    {
                        auto m = openModule (paths[(size_t) i], err);
                        if (! m) throw std::runtime_error (err.empty() ? "binaire illisible" : err);
                        const auto& f = m->getFactory();
                        factoryVendor = f.info().vendor();
                        for (auto& c : listClasses (f))
                        {
                            if (c.category != kVstAudioEffectClass) continue;
                            auto row = Value::array();
                            row.push (c.name);
                            row.push (c.subCategories);
                            row.push (c.vendor.empty() ? factoryVendor : c.vendor);
                            row.push (c.cid);
                            row.push (c.version);
                            classes.push (row);
                        }
                        // Module gardé en mémoire : certains plugins plantent en se déchargeant.
                        new VST3::Hosting::Module::Ptr (m);
                    }
                    catch (const std::exception& e) { err = e.what(); if (err.empty()) err = "erreur"; }
                });
                if (! fine)
                {
                    char buf[96];
                    std::snprintf (buf, sizeof (buf), "plantage à la lecture (code 0x%08X)", guard::lastCode());
                    o.set ("error", std::string (buf));
                }
                else if (! err.empty()) o.set ("error", err.substr (0, 200));
                else o.set ("classes", classes);
                o.set ("ms", (int) (nowMs() - t0));
                emit (o);
            }
            current = -1;
            auto end = Value::object();
            end.set ("end", true);
            emit (end);
            return 0;
        }
    }
}

//==============================================================================
int WINAPI wWinMain (HINSTANCE, HINSTANCE, PWSTR cmdLine, int)
{
    using namespace nova;
    // Jamais de boîte de dialogue d'erreur Windows (l'hôte tourne caché).
    SetErrorMode (SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetProcessDpiAwarenessContext (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    OleInitialize (nullptr);

    const std::wstring args = cmdLine != nullptr ? cmdLine : L"";
    if (args.find (L"--scan") != std::wstring::npos)
    {
        const int r = scan::run();
        // Sans décharger les plugins (certains plantent en se déchargeant).
        TerminateProcess (GetCurrentProcess(), (UINT) r);
    }

    WNDCLASSEXW wc { sizeof (wc) };
    wc.lpfnWndProc = &msgProc;
    wc.hInstance = GetModuleHandleW (nullptr);
    wc.lpszClassName = L"NovaVSTHostMessages";
    RegisterClassExW (&wc);
    app::msgWindow = CreateWindowExW (0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);

    session = std::make_unique<Session>();
    std::thread reader (readLoop);
    reader.detach();

    auto o = json::Value::object();
    o.set ("version", kVersion);
    o.set ("sdk", "VST3 SDK 3.8.1 (MIT), sans JUCE");
    o.set ("pid", (double) GetCurrentProcessId());
    o.set ("layout", layoutJson());
    io::event ("ready", o);

    MSG m;
    while (GetMessageW (&m, nullptr, 0, 0) > 0)
    {
        TranslateMessage (&m);
        DispatchMessageW (&m);
    }

    // Sortie franche : certains plugins gardent des fils en vie ou plantent en se déchargeant.
    if (session)
    {
        session->stopAudio();
        session->editor.reset();
        // Le plugin se termine proprement (il peut enregistrer ses préférences) ; les DLL ne sont
        // pas déchargées (certaines plantent en se déchargeant).
        if (! session->crashed) guard::call ([] { session->inst.reset(); });
    }
    io::event ("bye");
    TerminateProcess (GetCurrentProcess(), 0);
    return 0;
}
