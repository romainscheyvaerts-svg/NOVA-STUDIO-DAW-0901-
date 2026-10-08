"""Endurance (soak) de NOVA : session lourde, lecture en boucle, éditions aléatoires, mesures.

Session : 40 pistes (24 audio + 16 MIDI), 3 effets natifs par piste, 4 bus, 2 retours
d'effets (reverb, delay) avec envois, automation de volume / pan sur chaque piste.
Lecture en boucle (0 → 32 s) pendant toute la durée ; toutes les 5 à 15 s (graine fixe,
donc reproductible) une édition tirée au sort :
  couper une plage, déplacer un clip, effacer en mode Shuffle, annuler / refaire,
  changer un effet (remplacer son type ou ses réglages), geler / dégeler une piste,
  ouvrir / fermer des fenêtres (console, repères, fenêtre d'effet), changer de thème,
  enregistrer une prise au micro simulé (3 à 6 s).
Mesures chaque minute (après un ramasse-miettes forcé, CDP) :
  tas JS (CDP + performance.memory), nœuds audio vivants (compteur posé avant le
  chargement de l'appli, FinalizationRegistry), nœuds DOM / écouteurs (CDP), intervalles
  actifs, sons en mémoire (registre), sources en cours dans le moteur, temps de rendu
  (images : p95 / max), tâches longues, décrochages audio (playbackStats : sous-régimes
  du contexte ; départs programmés en retard), erreurs de console.

Usage :
  NOVA_URL=http://127.0.0.1:3443/ python qa/endurance.py --minutes 60 --label avant
  (sortie : D:\\1 WORK\\CONTENU\\nova-stabilite\\endurance_<label>.json)
"""
import argparse, io, json, math, os, random, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite")
from qalib import BASE, OUT, CHROME, FAKE_WAV, Log, new_page, shot  # noqa: E402
from gel_pre_effet import prepare  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
LOOP_END = 32.0

# --------------------------------------------------------------------------- session lourde
FX_POOL = ["CHORUS", "FLANGER", "DOUBLER", "STEREOSPREADER", "VOCALSATURATOR", "DELAY", "DEESSER", "LOFI", "DJFILTER", "GATEFX"]


def tone(freq, dur, kind):
    t = np.arange(int(dur * SR)) / SR
    if kind == 0:
        x = 0.2 * np.sin(2 * np.pi * freq * t)
    elif kind == 1:
        x = 0.15 * np.sign(np.sin(2 * np.pi * freq * t)) * np.exp(-((t % 0.5) * 6))
    else:
        rng = np.random.default_rng(int(freq))
        x = 0.1 * rng.standard_normal(len(t)) * np.exp(-((t % 0.25) * 18))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def plugin(pid, ptype, enabled=True):
    p = {"id": pid, "name": ptype.title(), "type": ptype, "isEnabled": enabled, "params": {}}
    if ptype == "PROEQ12":
        p["params"] = {"isEnabled": True, "masterGain": 1.0, "bands": [
            {"id": i, "type": "highpass" if i == 0 else "lowpass" if i == 11 else "peaking",
             "frequency": [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000][i],
             "gain": (1.5 if i in (3, 7) else 0), "q": 1.0, "isEnabled": True, "isSolo": False} for i in range(12)]}
    return p


def lane(tid, param, pts, color):
    return {"id": f"auto-{tid}-{param}", "parameterName": param, "color": color, "isExpanded": False,
            "min": -1 if param == "pan" else 0, "max": 1 if param == "pan" else 1.5,
            "points": [{"id": f"p-{tid}-{param}-{i}", "time": t, "value": v} for i, (t, v) in enumerate(pts)]}


def base_track(tid, name, ttype, out, color, **kw):
    t = {"id": tid, "name": name, "type": ttype, "color": color, "isMuted": False, "isSolo": False,
         "isTrackArmed": False, "isFrozen": False, "volume": 0.6, "pan": 0, "outputTrackId": out,
         "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    t.update(kw)
    return t


def make_project(path: Path, n_audio=24, n_midi=16):
    tracks, files = [], {}
    tracks.append(base_track("master", "MASTER BUS", "BUS", "", "#00f2ff", volume=0.8,
                             plugins=[plugin("m-eq", "PROEQ12"), plugin("m-comp", "COMPRESSOR")]))
    tracks.append(base_track("send-verb", "REVERB", "SEND", "master", "#10b981", plugins=[plugin("sv-rev", "REVERB")]))
    tracks.append(base_track("send-delay", "DELAY", "SEND", "master", "#22d3ee", plugins=[plugin("sd-del", "DELAY")]))
    for b in range(4):
        tracks.append(base_track(f"bus-{b}", f"BUS {b + 1}", "BUS", "master", "#fbbf24",
                                 plugins=[plugin(f"bus{b}-comp", "COMPRESSOR"), plugin(f"bus{b}-eq", "PROEQ12")]))
    for i in range(8):
        files[f"audio/son{i}.wav"] = tone(110 * (1 + i * 0.25), 12.0, i % 3)
    for i in range(n_audio):
        tid = f"a{i:02d}"
        clips = []
        for k in range(3):
            st = k * 10.5 + (i % 4) * 0.25
            clips.append({"id": f"{tid}-c{k}", "name": f"Audio {i + 1}.{k + 1}", "start": st, "duration": 10.0, "offset": 0.5 * k,
                          "fadeIn": 0.01, "fadeOut": 0.05, "color": "#3b82f6", "type": "AUDIO", "gain": 1,
                          "audioRef": f"audio/son{(i + k) % 8}.wav"})
        fx = [plugin(f"{tid}-eq", "PROEQ12"), plugin(f"{tid}-comp", "COMPRESSOR"), plugin(f"{tid}-fx", FX_POOL[i % len(FX_POOL)])]
        tracks.append(base_track(tid, f"Audio {i + 1}", "AUDIO", f"bus-{i % 4}", "#3b82f6", clips=clips, plugins=fx,
                                 pan=round(((i % 7) - 3) / 4, 2),
                                 sends=[{"id": "send-verb", "level": 0.15, "isEnabled": True}, {"id": "send-delay", "level": 0.08, "isEnabled": True}],
                                 automationLanes=[lane(tid, "volume", [(0, 0.6), (8, 0.4), (16, 0.7), (31, 0.6)], "#3b82f6"),
                                                  lane(tid, "pan", [(0, -0.3), (16, 0.3), (31, -0.3)], "#3b82f6")]))
    for i in range(n_midi):
        tid = f"m{i:02d}"
        notes = []
        for n in range(48):
            notes.append({"id": f"{tid}-n{n}", "pitch": 48 + ((n * 7 + i * 3) % 24), "start": n * 0.66, "duration": 0.5, "velocity": 0.7})
        clips = [{"id": f"{tid}-c0", "name": f"MIDI {i + 1}", "start": 0, "duration": LOOP_END, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                  "color": "#a855f7", "type": "MIDI", "notes": notes}]
        fx = [plugin(f"{tid}-eq", "PROEQ12"), plugin(f"{tid}-comp", "COMPRESSOR"), plugin(f"{tid}-fx", FX_POOL[(i + 3) % len(FX_POOL)])]
        tracks.append(base_track(tid, f"MIDI {i + 1}", "MIDI", f"bus-{i % 4}", "#a855f7", clips=clips, plugins=fx, volume=0.35,
                                 sends=[{"id": "send-verb", "level": 0.1, "isEnabled": True}],
                                 automationLanes=[lane(tid, "volume", [(0, 0.35), (16, 0.25), (31, 0.35)], "#a855f7")]))
    tracks.append(base_track("rec", "REC", "AUDIO", "bus-0", "#ff0000", plugins=[plugin("rec-comp", "COMPRESSOR")]))
    state = {
        "id": "proj-endurance", "name": f"Endurance {n_audio + n_midi} pistes", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": True, "loopStart": 0, "loopEnd": LOOP_END,
        "tracks": tracks, "trackGroups": [], "markers": [{"id": "mk1", "time": 8, "label": "Couplet"}, {"id": "mk2", "time": 16, "label": "Refrain"}],
        "selectedTrackId": "rec", "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "isLowLatencyMode": False,
        "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in files.items():
            z.writestr(k, v)


# --------------------------------------------------------------------------- instruments de mesure
INIT = r"""
(() => {
  const S = window.__soak = { created: 0, finalized: 0, byType: {}, liveByType: {}, intervals: new Map(), lateStarts: 0, starts: 0,
    longTasks: 0, longMs: 0, frames: [], errors: 0, winListeners: 0 };
  const reg = new FinalizationRegistry((t) => { S.finalized++; S.liveByType[t] = (S.liveByType[t] || 1) - 1; });
  const track = (n, t) => { if (!n || n.__soak) return n; try { Object.defineProperty(n, '__soak', { value: 1 }); } catch (e) {} S.created++; S.byType[t] = (S.byType[t] || 0) + 1; S.liveByType[t] = (S.liveByType[t] || 0) + 1; reg.register(n, t); return n; };
  const B = (window.BaseAudioContext || window.AudioContext).prototype;
  for (const k of Object.getOwnPropertyNames(B)) {
    if (!/^create(?!Buffer$|PeriodicWave$)/.test(k)) continue;
    const d = Object.getOwnPropertyDescriptor(B, k); if (!d || typeof d.value !== 'function') continue;
    const f = d.value; const t = k.slice(6);
    B[k] = function (...a) { return track(f.apply(this, a), t); };
  }
  for (const name of Object.getOwnPropertyNames(window)) {
    let C; try { C = window[name]; } catch (e) { continue; }
    if (typeof C !== 'function' || !C.prototype || !(C.prototype instanceof AudioNode)) continue;
    window[name] = new Proxy(C, { construct(T, args, NT) { return track(Reflect.construct(T, args, NT), name.replace(/Node$/, '')); } });
  }
  // Départs de sons programmés en retard (le planificateur n'a pas tenu la cadence).
  for (const P of [AudioBufferSourceNode.prototype, OscillatorNode.prototype, ConstantSourceNode.prototype]) {
    const st = P.start;
    P.start = function (when, ...rest) {
      S.starts++;
      try { if (when > 0 && this.context && this.context.state === 'running' && !(this.context instanceof OfflineAudioContext) && when < this.context.currentTime - 0.003) S.lateStarts++; } catch (e) {}
      return st.call(this, when, ...rest);
    };
  }
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...a) { const id = si.call(window, fn, ms, ...a); S.intervals.set(id, (new Error().stack || '').split('\n').slice(2, 4).join(' | ').slice(0, 220)); return id; };
  window.clearInterval = function (id) { S.intervals.delete(id); return ci.call(window, id); };
  const ael = EventTarget.prototype.addEventListener, rel = EventTarget.prototype.removeEventListener;
  const keyOf = (t) => t === window ? 'window' : t === document ? 'document' : null;
  S.listenerTypes = {};
  EventTarget.prototype.addEventListener = function (type, fn, o) { const k = keyOf(this); if (k) { S.winListeners++; S.listenerTypes[k + ':' + type] = (S.listenerTypes[k + ':' + type] || 0) + 1; } return ael.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { const k = keyOf(this); if (k) { S.winListeners--; S.listenerTypes[k + ':' + type] = (S.listenerTypes[k + ':' + type] || 0) - 1; } return rel.call(this, type, fn, o); };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { S.longTasks++; S.longMs += e.duration; } }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  let last = 0; const raf = (t) => { if (last) S.frames.push(t - last); if (S.frames.length > 20000) S.frames.splice(0, 10000); last = t; requestAnimationFrame(raf); }; requestAnimationFrame(raf);
  try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}
})();
"""

SAMPLE_JS = r"""
() => {
  const S = window.__soak; const d = window.DAW_CONTROL && window.DAW_CONTROL.diag ? window.DAW_CONTROL.diag() : null;
  const f = S.frames.splice(0).sort((a, b) => a - b);
  const pct = (p) => f.length ? Math.round(f[Math.min(f.length - 1, Math.floor(f.length * p))] * 10) / 10 : null;
  const st = window.DAW_CONTROL ? window.DAW_CONTROL.getState() : null;
  const out = {
    audioCreated: S.created, audioLive: S.created - S.finalized,
    liveByType: Object.fromEntries(Object.entries(S.liveByType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    intervals: S.intervals.size, winListeners: S.winListeners,
    lateStarts: S.lateStarts, starts: S.starts, longTasks: S.longTasks, longMs: Math.round(S.longMs),
    frameP50: pct(0.5), frameP95: pct(0.95), frameMax: f.length ? Math.round(f[f.length - 1]) : null, frames: f.length,
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null,
    diag: d, playing: st ? !!st.isPlaying : null, recording: st ? !!st.isRecording : null,
  };
  return out;
}
"""



class Soak:
    def __init__(self, page, cdp, rng, log, res):
        self.page, self.cdp, self.rng, self.log, self.res = page, cdp, rng, log, res
        self.frozen = set()
        self.edits = []
        self.errors_seen = 0

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg)

    def state(self):
        return self.ev("() => { const s = window.DAW_CONTROL.getState(); return { playing: s.isPlaying, rec: s.isRecording, t: s.currentTime,"
                       " tracks: s.tracks.map(t => ({ id: t.id, type: t.type, frozen: !!t.isFrozen, clips: t.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration })),"
                       " plugins: t.plugins.map(p => ({ id: p.id, type: p.type, isEnabled: p.isEnabled })) })) }; }")

    def ensure_playing(self):
        s = self.ev("() => { const s = window.DAW_CONTROL.getState(); return { p: s.isPlaying, r: s.isRecording }; }")
        if not s["p"] and not s["r"]:
            self.ev("() => window.DAW_CONTROL.togglePlay()")
            self.page.wait_for_timeout(300)

    def media_tracks(self, st, kind=None):
        return [t for t in st["tracks"] if (t["type"] in ("AUDIO", "MIDI")) and t["id"] != "rec" and (kind is None or t["type"] == kind)]

    # ---- éditions
    def e_cut(self, st):
        tr = self.rng.choice(self.media_tracks(st, "AUDIO"))
        a = round(self.rng.uniform(0, 26), 2)
        self.ev("([a, b, id]) => { window.__novaEdit.selectRange(a, b, [id]); return window.__novaEdit.cutSelection(); }", [a, a + self.rng.uniform(0.5, 3), tr["id"]])
        return f"couper {tr['id']} @{a}"

    def e_move(self, st):
        tr = self.rng.choice([t for t in self.media_tracks(st) if t["clips"]])
        c = self.rng.choice(tr["clips"])
        ns = max(0.0, round(c["start"] + self.rng.uniform(-1.5, 1.5), 3))
        self.ev("([tid, cid, s]) => window.__novaEdit.patchClips(tid, { [cid]: { start: s } })", [tr["id"], c["id"], ns])
        return f"déplacer {c['id']} → {ns}"

    def e_shuffle(self, st):
        tr = self.rng.choice(self.media_tracks(st, "AUDIO"))
        a = round(self.rng.uniform(0, 24), 2)
        self.ev("([a, b, id]) => { window.__novaEditMode.set({ mode: 'SHUFFLE' }); window.__novaEdit.selectRange(a, b, [id]); const r = window.__novaEdit.deleteSelection(); window.__novaEditMode.set({ mode: 'SLIP' }); return r; }",
                [a, a + self.rng.uniform(0.3, 2), tr["id"]])
        return f"shuffle {tr['id']} @{a}"

    def e_undo_redo(self, st):
        n = self.rng.randint(1, 3)
        for _ in range(n):
            self.ev("() => window.DAW_CONTROL.undo()"); self.page.wait_for_timeout(120)
        for _ in range(self.rng.randint(0, n)):
            self.ev("() => window.DAW_CONTROL.redo()"); self.page.wait_for_timeout(120)
        return f"annuler/refaire x{n}"

    def e_fx(self, st):
        tr = self.rng.choice(self.media_tracks(st))
        if not tr["plugins"]:
            return "effet (aucun)"
        if self.rng.random() < 0.6:
            new = self.rng.choice(FX_POOL)
            self.ev("""([tid, typ]) => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === tid); if (!t) return;
              const pl = t.plugins.slice(); const i = pl.length - 1; pl[i] = { ...pl[i], id: tid + '-fx-' + Date.now(), type: typ, name: typ, params: {} };
              window.DAW_CONTROL.updateTrack({ ...t, plugins: pl }); }""", [tr["id"], new])
            return f"effet {tr['id']} → {new}"
        p = self.rng.choice(tr["plugins"])
        self.ev("([tid, pid]) => window.DAW_CONTROL.toggleBypass(tid, pid)", [tr["id"], p["id"]])
        return f"bypass {p['id']}"

    def e_freeze(self, st):
        if self.frozen and self.rng.random() < 0.6:
            tid = self.rng.choice(sorted(self.frozen))
            self.frozen.discard(tid)
        else:
            cands = [t for t in self.media_tracks(st) if not t["frozen"]]
            if not cands:
                return "geler (rien)"
            tid = self.rng.choice(cands)["id"]
            self.frozen.add(tid)
        self.ev("(tid) => window.DAW_CONTROL.freeze(tid)", tid)
        self.page.wait_for_timeout(1500)
        return f"geler/dégeler {tid}"

    def e_windows(self, st):
        r = self.rng.random()
        if r < 0.35:
            self.ev("() => window.DAW_CONTROL.setView('MIXER')"); self.page.wait_for_timeout(self.rng.randint(800, 2500))
            self.ev("() => window.DAW_CONTROL.setView('ARRANGEMENT')")
            return "console ouverte / fermée"
        if r < 0.6:
            self.ev("() => window.DAW_CONTROL.openWindow('memory-locations')"); self.page.wait_for_timeout(700)
            self.page.keyboard.press("Escape")
            return "fenêtre repères"
        chips = self.page.locator(".fx-slot button[aria-label^='Ouvrir']")
        n = chips.count()
        if n:
            try:
                chips.nth(self.rng.randrange(min(n, 30))).click(timeout=3000)
                self.page.wait_for_timeout(self.rng.randint(600, 1500))
            except Exception as e:  # noqa
                self.log.add("note", f"fenêtre d'effet : {e}")
            self.page.keyboard.press("Escape")
            return "fenêtre d'effet"
        return "fenêtre (aucune)"

    def e_theme(self, st):
        th = self.rng.choice(["light", "dark"])
        self.ev("(p) => window.DAW_CONTROL.setTheme(p)", th)
        return f"thème {th}"

    def e_record(self, st):
        self.ev("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'rec'); if (t && !t.isTrackArmed) window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: true }); }")
        self.page.wait_for_timeout(1200)
        self.ev("() => window.DAW_CONTROL.toggleRecord()")
        dur = self.rng.uniform(3, 6)
        self.page.wait_for_timeout(int(dur * 1000))
        recording = self.ev("() => window.DAW_CONTROL.getState().isRecording")
        self.ev("() => window.DAW_CONTROL.toggleRecord()")
        self.page.wait_for_timeout(1200)
        self.ev("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'rec'); if (t && t.isTrackArmed) window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: false }); }")
        # Les prises s'accumulent comme dans une vraie séance ; une sur deux est annulée.
        if self.rng.random() < 0.5:
            self.ev("() => window.DAW_CONTROL.undo()")
        return f"prise {dur:.1f} s ({'ok' if recording else 'NON démarrée'})"

    EDITS = [("cut", 3), ("move", 3), ("shuffle", 2), ("undo_redo", 3), ("fx", 3), ("freeze", 1), ("windows", 2), ("theme", 1), ("record", 1)]

    def edit(self):
        st = self.state()
        names = [n for n, w in self.EDITS for _ in range(w)]
        name = self.rng.choice(names)
        t0 = time.time()
        try:
            what = getattr(self, "e_" + name)(st)
        except Exception as e:  # noqa
            what = f"{name} : ÉCHEC {type(e).__name__}: {str(e)[:160]}"
        self.edits.append({"t": round(time.time() - self.t_start, 1), "edit": what, "ms": int((time.time() - t0) * 1000)})
        self.ensure_playing()

    def sample(self, minute):
        cdp = self.cdp
        cdp.send("HeapProfiler.collectGarbage")
        self.page.wait_for_timeout(400)
        cdp.send("HeapProfiler.collectGarbage")
        self.page.wait_for_timeout(300)
        heap = cdp.send("Runtime.getHeapUsage")
        dom = cdp.send("Memory.getDOMCounters")
        m = self.ev(SAMPLE_JS)
        pb = self.ev("""() => { const c = window.__soakAudioCtx; if (!c || !c.playbackStats) return null; const p = c.playbackStats;
                         return { underrunEvents: p.underrunEvents, underrunMs: Math.round(p.underrunDuration * 1000), totalS: Math.round(p.totalDuration), ctxTime: Math.round(c.currentTime), state: c.state }; }""")
        row = {"minute": minute, "wall_s": round(time.time() - self.t_start, 1),
               "heapUsedMB": round(heap["usedSize"] / 1048576, 1), "heapTotalMB": round(heap["totalSize"] / 1048576, 1),
               "domNodes": dom.get("nodes"), "jsEventListeners": dom.get("jsEventListeners"), "documents": dom.get("documents"),
               "playback": pb, "consoleErrors": len(self.log.errors()), **m}
        return row


CTX_HOOK = r"""
(() => { const A = window.AudioContext; if (!A) return;
  window.AudioContext = new Proxy(A, { construct(T, args, NT) { const c = Reflect.construct(T, args, NT); if (!window.__soakAudioCtx) window.__soakAudioCtx = c; return c; } });
})();
"""


def open_project(page, f, min_tracks=40):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=40000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    for _ in range(60):
        page.wait_for_timeout(1000)
        n = page.evaluate("() => window.DAW_CONTROL && window.DAW_CONTROL.diag ? window.DAW_CONTROL.diag().tracks : 0")
        if n >= min_tracks:
            break
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass


def run(minutes, label, seed, every=(5, 15), edits=True, pistes=40):
    OUT.mkdir(parents=True, exist_ok=True)
    proj = OUT / f"endurance_session_{pistes}_pistes.novaproj.zip"
    if not proj.exists():
        make_project(proj, n_audio=round(pistes * 0.6), n_midi=pistes - round(pistes * 0.6))
    res = {"label": label, "url": BASE, "seed": seed, "minutes": minutes, "rows": [], "edits": [], "ok": True, "notes": []}
    out_path = OUT / f"endurance_{label}.json"
    rng = random.Random(seed)
    log = Log(f"endurance_{label}")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
            "--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"])
        ctx, page = new_page(b, "pc", log)
        page.set_default_timeout(20000)
        prepare(page, None, desktop=False)
        ctx.add_init_script(INIT)
        ctx.add_init_script(CTX_HOOK)
        cdp = ctx.new_cdp_session(page)
        cdp.send("HeapProfiler.enable")
        soak = Soak(page, cdp, rng, log, res)
        try:
            open_project(page, proj, min_tracks=pistes)
            shot(page, f"endurance_{label}_00_session")
            page.evaluate("() => window.DAW_CONTROL.seek(0)")
            soak.t_start = time.time()
            soak.ensure_playing()
            page.wait_for_timeout(3000)
            res["rows"].append(soak.sample(0))
            print(json.dumps(res["rows"][-1], ensure_ascii=False), flush=True)
            next_sample = 60.0
            next_edit = rng.uniform(*every)
            end = minutes * 60.0
            while True:
                el = time.time() - soak.t_start
                if el >= end:
                    break
                if edits and el >= next_edit:
                    soak.edit()
                    next_edit = (time.time() - soak.t_start) + rng.uniform(*every)
                el = time.time() - soak.t_start
                if el >= next_sample:
                    row = soak.sample(int(round(next_sample / 60)))
                    res["rows"].append(row)
                    print(json.dumps({k: row[k] for k in ("minute", "heapUsedMB", "audioLive", "domNodes", "jsEventListeners", "intervals", "lateStarts", "longTasks", "frameP95", "consoleErrors")}
                                     | {"underruns": (row.get("playback") or {}).get("underrunEvents"), "buffers": (row.get("diag") or {}).get("buffers")}, ensure_ascii=False), flush=True)
                    next_sample += 60.0
                    res["edits"] = soak.edits
                    res["errors"] = [e["text"][:300] for e in log.errors()][:60]
                    out_path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
                page.wait_for_timeout(250)
            shot(page, f"endurance_{label}_99_fin")
            res["intervals_sources"] = page.evaluate("() => { const c = {}; for (const v of window.__soak.intervals.values()) c[v] = (c[v] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 15); }")
            res["listener_types"] = page.evaluate("() => Object.entries(window.__soak.listenerTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 25)")
        except Exception as e:  # noqa
            res["ok"] = False
            res["notes"].append(f"EXCEPTION: {type(e).__name__}: {str(e)[:500]}")
            try: shot(page, f"endurance_{label}_FAIL")
            except Exception: pass
        finally:
            res["edits"] = soak.edits
            res["errors"] = [e["text"][:300] for e in log.errors()][:60]
            res["error_count"] = len(log.errors())
            out_path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            ctx.close(); b.close()
    print("→", out_path)
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=60)
    ap.add_argument("--label", default="essai")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--sans-editions", action="store_true", help="lecture seule (mesure de la charge DSP)")
    ap.add_argument("--pistes", type=int, default=40, help="nombre de pistes audio + MIDI (60 %% audio)")
    a = ap.parse_args()
    run(a.minutes, a.label, a.seed, edits=not a.sans_editions, pistes=a.pistes)
