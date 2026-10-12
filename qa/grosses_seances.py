"""Séances de 32 à 128 pistes × 4 effets : session de banc, mesures CPU / sous-régimes / images.

Utilisé par `qa/surcharge_cpu.py --paliers` (chantier 13 de la feuille de route).

Session de banc (une par palier N) :
  - N pistes audio, chacune avec 4 effets typiques : EQ 12 bandes (4 bandes actives),
    compresseur (modes CLEAN / OPTO / FET / VCA en alternance), de-esser (pistes paires) ou
    saturation (pistes impaires), et un envoi vers une reverb (piste retour) ;
  - 4 bus (compresseur), un retour reverb, master (EQ 12 bandes + compresseur) ;
  - morceau de 64 s lu en boucle. Deux profils :
      « realiste » : rôles d'une vraie séance (stems de beat continus, voix lead / doublages
        en phrases, chœurs aux refrains, ad-libs épars, instruments et ambiances par
        section) ; ~46 % d'activité moyenne, ~78 % au refrain ;
      « dense »    : toutes les pistes jouent sans arrêt (pire cas).

Mesures pendant la lecture (navigateur headless, aucune fenêtre) :
  - charge du fil audio : trace Chromium (catégorie « webaudio ») — temps CPU du fil de rendu
    (`tdur` de RealtimeAudioDestinationHandler::Render) / temps réel, par seconde ;
  - sous-régimes : AudioContext.playbackStats (événements + durée) ;
  - pistes en veille (moteur) ;
  - répartition par type de nœud (trace « webaudio.audionode », courte : elle ralentit) ;
  - images pendant l'édition à N pistes : défilement, zoom, déplacement d'un clip
    (requestAnimationFrame + tâches longues, Performance API).
"""
import io, json, math, os, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, CHROME, FAKE_WAV, Log, new_page  # noqa: E402

SR = 44100
SONG = 64.0
SECTIONS = {"intro": (0, 8), "c1": (8, 24), "r1": (24, 40), "c2": (40, 56), "outro": (56, 64)}
EQ_FREQ = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000]
COMP_MODES = ["CLEAN", "OPTO", "FET", "VCA"]
ROLES = ["beat", "lead", "double", "choeur", "choeur", "adlib", "instrument", "ambiance"]


# --------------------------------------------------------------------------- sons
def _wav(x):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def voice(seed, dur=16.0, f0=180.0):
    """Voix synthétique : harmoniques + vibrato, syllabes (~4 Hz), sifflantes (bruit aigu)."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(dur * SR)) / SR
    f = f0 * (1 + 0.01 * np.sin(2 * np.pi * 5.5 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = sum((0.5 / k) * np.sin(k * ph) for k in range(1, 9))
    syl = np.clip(np.sin(2 * np.pi * (3.7 + seed % 3 * 0.3) * t), 0, 1) ** 0.6
    noise = rng.standard_normal(len(t))
    hp = noise - np.concatenate([[0], noise[:-1]])
    sib = (rng.random(len(t) // 2205 + 1) < 0.18).repeat(2205)[:len(t)] * hp * 0.25
    return 0.35 * (x * syl + sib)


def beat(seed, dur=16.0):
    t = np.arange(int(dur * SR)) / SR
    beat_t = (t % 0.5)
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-beat_t * 30)) * beat_t) * np.exp(-beat_t * 8)
    rng = np.random.default_rng(seed)
    hat = rng.standard_normal(len(t)) * np.exp(-((t % 0.25) * 40)) * 0.15
    return 0.45 * kick + hat


def pad(seed, dur=16.0, f0=110.0):
    t = np.arange(int(dur * SR)) / SR
    return 0.18 * sum(np.sin(2 * np.pi * f0 * r * t + seed) for r in (1, 1.25, 1.5, 2.0))


# --------------------------------------------------------------------------- session
def plugin(pid, ptype, params=None):
    return {"id": pid, "name": ptype.title(), "type": ptype, "isEnabled": True, "params": params or {}}


def eq_params(hpf=100):
    gains = {2: -2.0, 6: 2.0}
    return {"isEnabled": True, "masterGain": 1.0, "bands": [
        {"id": i, "type": "highpass" if i == 0 else "lowpass" if i == 11 else "peaking",
         "frequency": hpf if i == 0 else EQ_FREQ[i], "gain": gains.get(i, 0), "q": 1.0,
         "isEnabled": True, "isSolo": False} for i in range(12)]}


def comp_params(i):
    return {"threshold": -24, "ratio": 3, "knee": 6, "attack": 0.005, "release": 0.15, "makeupGain": 1.4,
            "mix": 1.0, "scHpFreq": 80, "lookahead": 0, "autoMakeup": False, "mode": COMP_MODES[i % 4], "isEnabled": True}


def base_track(tid, name, ttype, out, color, **kw):
    t = {"id": tid, "name": name, "type": ttype, "color": color, "isMuted": False, "isSolo": False,
         "isTrackArmed": False, "isFrozen": False, "volume": 0.5, "pan": 0, "outputTrackId": out,
         "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    t.update(kw)
    return t


def spans_for(role, i, profile):
    """Plages jouées (début, fin) dans le morceau de 64 s."""
    if profile == "dense" or role == "beat":
        return [(0.0, SONG)]
    S = SECTIONS
    out = []
    def phrases(a, b, ph, gap):
        t = a
        while t + 0.5 < b:
            out.append((t, min(b, t + ph))); t += ph + gap
    if role in ("lead", "double"):
        off = 0.0 if role == "lead" else 0.12
        for sec in ("c1", "r1", "c2"):
            a, b = S[sec]; phrases(a + off, b, 3.2, 0.8)
    elif role == "choeur":
        for sec in ("r1", "outro"):
            a, b = S[sec]; phrases(a, b, 3.5, 0.5)
    elif role == "adlib":
        for k, at in enumerate((10.5, 21.0, 29.5, 35.0, 46.5, 53.0)):
            if (k + i) % 2 == 0:
                out.append((at, at + 1.6))
    elif role == "instrument":
        out += [S["c1"], S["c2"]]
    else:  # ambiance
        out += [S["intro"], S["r1"]]
    return out


def make_bench_project(path: Path, n: int, profile="realiste"):
    files = {}
    for k in range(6):
        files[f"audio/voix{k}.wav"] = _wav(voice(k, f0=150 + 25 * k))
    for k in range(2):
        files[f"audio/beat{k}.wav"] = _wav(beat(k))
        files[f"audio/pad{k}.wav"] = _wav(pad(k, f0=110 * (1 + k * 0.5)))
    tracks = [base_track("master", "MASTER BUS", "BUS", "", "#00f2ff", volume=0.8,
                         plugins=[plugin("m-eq", "PROEQ12", eq_params(30)), plugin("m-comp", "COMPRESSOR", {**comp_params(0), "threshold": -12, "ratio": 2})]),
              base_track("send-verb", "REVERB", "SEND", "master", "#10b981", plugins=[plugin("sv-rev", "REVERB")])]
    for b in range(4):
        tracks.append(base_track(f"bus-{b}", f"BUS {b + 1}", "BUS", "master", "#fbbf24",
                                 plugins=[plugin(f"bus{b}-comp", "COMPRESSOR", {**comp_params(b), "threshold": -18, "ratio": 2})]))
    for i in range(n):
        role = ROLES[i % len(ROLES)]
        tid = f"t{i:03d}"
        src = (f"audio/beat{i % 2}.wav" if role == "beat" else f"audio/pad{i % 2}.wav" if role in ("instrument", "ambiance")
               else f"audio/voix{i % 6}.wav")
        clips = []
        for k, (a, b) in enumerate(spans_for(role, i, profile)):
            t = a
            while t < b - 1e-6:   # sons de 16 s : un clip par tranche de 16 s au plus
                d = min(16.0, b - t)
                clips.append({"id": f"{tid}-c{len(clips)}", "name": f"{role} {i + 1}", "start": round(t, 4), "duration": round(d, 4),
                              "offset": round((t * 0.37 + i * 0.5) % max(0.01, 16.0 - d), 4) if d < 16 else 0, "fadeIn": 0.005, "fadeOut": 0.01,
                              "color": "#3b82f6", "type": "AUDIO", "gain": 1, "audioRef": src})
                t += d
        third = (plugin(f"{tid}-ds", "DEESSER", {"frequency": 7000, "threshold": -30, "reduction": 0.5, "detection": "RELATIVE", "relThreshold": -6, "mode": "BELL", "q": 1, "isEnabled": True})
                 if i % 2 == 0 else plugin(f"{tid}-sat", "VOCALSATURATOR", {"drive": 20, "mix": 0.3, "mode": "TAPE", "tone": 0, "eqLow": 0, "eqMid": 0, "eqHigh": 0, "outputGain": 1.0, "isEnabled": True}))
        tracks.append(base_track(tid, f"{role.title()} {i + 1}", "AUDIO", f"bus-{i % 4}", "#3b82f6", clips=clips,
                                 plugins=[plugin(f"{tid}-eq", "PROEQ12", eq_params(80 if role in ("beat", "instrument") else 100)),
                                          plugin(f"{tid}-comp", "COMPRESSOR", comp_params(i)), third],
                                 pan=round(((i % 9) - 4) / 6, 2), volume=0.35,
                                 sends=[{"id": "send-verb", "level": 0.12, "isEnabled": True}]))
    state = {
        "id": f"proj-banc-{n}-{profile}", "name": f"Banc {n} pistes ({profile})", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": True, "loopStart": 0, "loopEnd": SONG,
        "tracks": tracks, "trackGroups": [], "markers": [{"id": "mk1", "time": 24, "label": "Refrain"}],
        "selectedTrackId": tracks[-1]["id"], "currentView": "ARRANGEMENT", "projectPhase": "MIXING", "isLowLatencyMode": False,
        "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in files.items():
            z.writestr(k, v)
    act = activity(state)
    return {"pistes": n, "profil": profile, "activite_moyenne_pct": act["moyenne"], "activite_max_pct": act["max"]}


def activity(state):
    """Part des pistes audio qui jouent, seconde par seconde."""
    aud = [t for t in state["tracks"] if t["type"] == "AUDIO"]
    per = []
    for s in range(int(SONG)):
        x = s + 0.5
        per.append(sum(1 for t in aud if any(c["start"] <= x < c["start"] + c["duration"] for c in t["clips"])) / max(1, len(aud)))
    return {"moyenne": round(100 * sum(per) / len(per), 1), "max": round(100 * max(per), 1)}


# --------------------------------------------------------------------------- mesures dans la page
PB = """() => { const c = window.__soakAudioCtx; if (!c || !c.playbackStats) return null; const p = c.playbackStats;
  return { ev: p.underrunEvents, s: p.underrunDuration, tot: p.totalDuration, t: performance.now(), ct: c.currentTime }; }"""
SLEEP_STATS = """async () => { try { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  return e.getSleepStats ? e.getSleepStats() : null; } catch (err) { return null; } }"""
CTX_HOOK = r"""
(() => { const A = window.AudioContext; if (!A) return;
  window.AudioContext = new Proxy(A, { construct(T, args, NT) { const c = Reflect.construct(T, args, NT); if (!window.__soakAudioCtx) window.__soakAudioCtx = c; return c; } });
})();
"""
PERF_INIT = r"""
window.__perf = { long: [], frames: [], on: false };
try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (window.__perf.on) window.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_safe_mode', '0'); } catch (e) {}
"""
FRAMES_START = r"""() => { const P = window.__perf; P.frames = []; P.long = []; P.on = true; let last = performance.now();
  const tick = (t) => { if (!P.on) return; P.frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; }"""
FRAMES_STOP = r"""() => { const P = window.__perf; P.on = false; const f = P.frames.slice(1); const tot = f.reduce((a, b) => a + b, 0);
  const s = [...f].sort((a, b) => a - b); const q = p => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null;
  return { images: f.length, fps: f.length ? Math.round(1000 * f.length / tot) : null, p95_ms: q(0.95), pire_image_ms: f.length ? Math.round(Math.max(...f) * 10) / 10 : null,
           images_sup_50ms: f.filter(x => x > 50).length, taches_longues: P.long.length, pire_tache_ms: P.long.length ? Math.round(Math.max(...P.long)) : 0 }; }"""


def trace_load(events, t_from=None):
    """Charge du fil audio (temps CPU du rendu / temps réel), par tranche d'une seconde."""
    rend = [e for e in events if e.get("name") == "RealtimeAudioDestinationHandler::Render" and e.get("ph") == "X"]
    if not rend:
        return None
    t0 = min(e["ts"] for e in rend); t1 = max(e["ts"] + e.get("dur", 0) for e in rend)
    nb = max(1, int((t1 - t0) // 1_000_000))
    bins_cpu = [0.0] * nb; bins_wall = [0.0] * nb; bins_n = [0] * nb
    for e in rend:
        k = int((e["ts"] - t0) // 1_000_000)
        if k >= nb: continue
        bins_cpu[k] += e.get("tdur", e.get("dur", 0)); bins_wall[k] += e.get("dur", 0); bins_n[k] += 1
    cpu = [b / 1e4 for b in bins_cpu]   # % d'une seconde
    wall = [b / 1e4 for b in bins_wall]
    per_q = sorted(e.get("tdur", e.get("dur", 0)) for e in rend)
    quantum_us = 128 / SR * 1e6
    return {"secondes": nb, "charge_cpu_moy_pct": round(sum(cpu) / nb, 1), "charge_cpu_max_pct": round(max(cpu), 1),
            "charge_murale_moy_pct": round(sum(wall) / nb, 1), "charge_murale_max_pct": round(max(wall), 1),
            "blocs": len(rend), "bloc_p99_us": round(per_q[int(len(per_q) * 0.99)]), "bloc_max_us": round(per_q[-1]),
            "blocs_plus_longs_que_temps_reel": sum(1 for x in per_q if x > quantum_us),
            "par_seconde_cpu_pct": [round(x, 1) for x in cpu]}


def node_breakdown(events):
    agg = {}
    for e in events:
        if e.get("ph") != "X" or "audionode" not in (e.get("cat") or ""): continue
        n = e.get("name", "")
        if n.endswith("::ProcessIfNecessary"): continue
        a = agg.setdefault(n, [0, 0]); a[0] += 1; a[1] += e.get("tdur", e.get("dur", 0))
    tot = sum(v[1] for v in agg.values()) or 1
    return [{"noeud": k, "appels": v[0], "part_pct": round(100 * v[1] / tot, 1)} for k, v in sorted(agg.items(), key=lambda kv: -kv[1][1])[:14]]


def open_bench(page, proj, n):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(proj))
    for _ in range(120):
        page.wait_for_timeout(1000)
        k = page.evaluate("() => window.DAW_CONTROL && window.DAW_CONTROL.diag ? window.DAW_CONTROL.diag().tracks : 0")
        if k >= n + 6:
            break
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.mouse.click(5, 300); page.keyboard.press("Escape")


def ensure_playing(page):
    if not page.evaluate("() => { const s = window.DAW_CONTROL.getState(); return s.isPlaying || s.isRecording; }"):
        page.evaluate("() => window.DAW_CONTROL.togglePlay()")
        page.wait_for_timeout(400)


def edit_gestures(page):
    """Défilement, zoom et déplacement d'un clip pendant la lecture ; images mesurées."""
    out = {}
    # Déplacement d'un clip (d'abord, zoom et défilement d'origine) : clip de la 1re piste,
    # saisi à 4 s (rangée lue sur l'en-tête de piste, abscisse = fin des en-têtes + 4 s × zoom).
    st0 = page.evaluate("() => JSON.stringify(window.DAW_CONTROL.getState().tracks.map(t => t.clips.map(c => c.start)))")
    hdr = page.evaluate("""() => { const h = document.querySelector('[data-track-header=t000]'); if (!h) return null; const r = h.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille'); return [r.right, r.top + r.height / 2, sc ? sc.scrollLeft || 0 : 0]; }""")
    moved = False
    page.evaluate(FRAMES_START)
    if hdr:
        for zoom in (40, 20, 60, 80):
            xx, yy = hdr[0] + 4 * zoom, hdr[1]
            page.mouse.move(xx, yy); page.mouse.down()
            for k in range(1, 31):
                page.mouse.move(xx + k * 4, yy + (k % 3), steps=1); page.wait_for_timeout(16)
            page.mouse.up(); page.wait_for_timeout(300)
            if page.evaluate("() => JSON.stringify(window.DAW_CONTROL.getState().tracks.map(t => t.clips.map(c => c.start)))") != st0:
                moved = True
                break
    page.wait_for_timeout(300)
    out["deplacement_clip"] = page.evaluate(FRAMES_STOP)
    out["deplacement_clip"]["clip_deplace"] = moved
    if moved:
        page.evaluate("() => window.DAW_CONTROL.undo()"); page.wait_for_timeout(500)
    grid = page.evaluate("() => { const g = document.querySelector('.nova-grille'); if (!g) return null; const r = g.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
    if not grid:
        return {"erreur": "grille introuvable"}
    gx, gy, gw, gh = grid
    page.mouse.move(gx + gw / 2, gy + gh / 2)
    page.evaluate(FRAMES_START)
    for i in range(30):
        page.mouse.wheel(0, 300 if i < 15 else -300); page.wait_for_timeout(50)
    page.wait_for_timeout(300)
    out["defilement"] = page.evaluate(FRAMES_STOP)
    page.evaluate(FRAMES_START)
    for i in range(12):
        page.keyboard.down("Control"); page.mouse.wheel(0, -120 if i < 6 else 120); page.keyboard.up("Control"); page.wait_for_timeout(90)
    page.wait_for_timeout(300)
    out["zoom"] = page.evaluate(FRAMES_STOP)
    return out


def run_palier(p, proj, n, seconds, trace_nodes=False, gestures=True, log_name="palier"):
    log = Log(log_name)
    b = p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
        "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows"])
    from gel_pre_effet import prepare  # noqa
    ctx, page = new_page(b, "pc", log)
    page.set_default_timeout(30000)
    prepare(page, None, desktop=False)
    ctx.add_init_script(CTX_HOOK)
    ctx.add_init_script(PERF_INIT)
    r = {"pistes": n}
    try:
        t0 = time.time()
        open_bench(page, proj, n)
        r["ouverture_s"] = round(time.time() - t0, 1)
        page.evaluate("() => window.DAW_CONTROL.seek(0)")
        ensure_playing(page)
        page.wait_for_timeout(6000)   # chauffe (worklets compilés, premières veilles)
        a = page.evaluate(PB)
        b.start_tracing(page=page, categories=["webaudio"])
        sl = []
        t_end = time.time() + seconds
        while time.time() < t_end:
            page.wait_for_timeout(2000)
            s = page.evaluate(SLEEP_STATS)
            if s: sl.append(s)
            ensure_playing(page)
        data = b.stop_tracing()
        z = page.evaluate(PB)
        ev = json.loads(data); ev = ev["traceEvents"] if isinstance(ev, dict) else ev
        r["charge"] = trace_load(ev)
        if a and z:
            r["sous_regimes"] = {"evenements": z["ev"] - a["ev"], "duree_ms": round((z["s"] - a["s"]) * 1000, 1),
                                 "duree_mesure_s": round((z["t"] - a["t"]) / 1000, 1)}
        if sl:
            r["veille"] = {"pistes_en_veille_moy": round(sum(x.get("asleep", 0) for x in sl) / len(sl), 1),
                           "pistes_en_veille_max": max(x.get("asleep", 0) for x in sl), "pistes_eligibles": sl[-1].get("eligible"),
                           "mises_en_veille": sl[-1].get("sleeps"), "reveils": sl[-1].get("wakes")}
        if trace_nodes:
            b.start_tracing(page=page, categories=["webaudio", "disabled-by-default-webaudio.audionode"])
            page.wait_for_timeout(1500)
            ev2 = json.loads(b.stop_tracing()); ev2 = ev2["traceEvents"] if isinstance(ev2, dict) else ev2
            r["repartition_noeuds"] = node_breakdown(ev2)
        if gestures:
            ensure_playing(page)
            r["images_edition"] = edit_gestures(page)
            ge = page.evaluate(PB)
            if z and ge:
                r["sous_regimes_pendant_edition"] = ge["ev"] - z["ev"]
    except Exception as e:  # noqa
        r["exception"] = f"{type(e).__name__}: {str(e)[:400]}"
    finally:
        r["erreurs_console"] = [x["text"][:160] for x in log.errors()][:8]
        try: ctx.close()
        except Exception: pass
        b.close()
    return r


OFFLINE_COST_JS = r"""
async ({ n, sec }) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await e.init();
  const SR = 44100;
  const eq = { isEnabled: true, masterGain: 1, bands: Array.from({ length: 12 }, (_, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency: [100,150,300,500,1000,2000,4000,6000,8000,10000,12000,18000][i], gain: i === 2 ? -2 : i === 6 ? 2 : 0, q: 1, isEnabled: true, isSolo: false })) };
  const cfg = { PROEQ12: eq, COMPRESSOR: { threshold: -24, ratio: 3, knee: 6, attack: 0.005, release: 0.15, mode: 'OPTO', mix: 1, makeupGain: 1.4 },
    DEESSER: { frequency: 7000 }, VOCALSATURATOR: { drive: 20, mix: 0.3, mode: 'TAPE' }, REVERB: {} };
  const sig = (oc, silent) => { const b = oc.createBuffer(2, SR * 2, SR); if (!silent) for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let s = 7 + c; for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647 - 0.5) * 0.5 * Math.abs(Math.sin(i / 3000)); } } return b; };
  const bench = async (type, silent) => {
    const N = type === 'REVERB' ? Math.max(2, Math.round(n / 8)) : n;
    const oc = new OfflineAudioContext(2, sec * SR, SR); const buf = sig(oc, silent);
    for (let k = 0; k < N; k++) {
      const s = oc.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0);
      const r = e.createPluginNode({ id: 'p' + k, type, name: type, isEnabled: true, params: JSON.parse(JSON.stringify(cfg[type])) }, 120, oc);
      if (r.node.ready) await r.node.ready;
      const ka = oc.createConstantSource(); ka.offset.value = 0; ka.start(0); ka.connect(r.input);
      s.connect(r.input); r.output.connect(oc.destination);
    }
    const t0 = performance.now(); await oc.startRendering();
    return Math.round((performance.now() - t0) / N / sec * 100) / 100;
  };
  const res = {};
  for (const t of Object.keys(cfg)) {
    const v = []; const vs = [];
    for (let k = 0; k < 3; k++) { v.push(await bench(t, false)); vs.push(await bench(t, true)); }
    v.sort((a, b) => a - b); vs.sort((a, b) => a - b);
    res[t] = { ms_par_s_signal: v[1], ms_par_s_silence: vs[1] };
  }
  return res;
}
"""


def offline_costs(p):
    """Coût de calcul de chaque effet (rendu hors ligne, médiane de 3) : ms de calcul par seconde de son et par instance."""
    b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
    ctx, page = new_page(b, "pc", Log("couts"))
    try:
        page.goto(BASE, wait_until="domcontentloaded"); page.wait_for_timeout(4000)
        return page.evaluate(OFFLINE_COST_JS, {"n": 24, "sec": 3})
    finally:
        ctx.close(); b.close()
