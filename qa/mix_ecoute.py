"""🎧 Outils d'écoute d'un ingé de mix (21/10/2026), de bout en bout, HORS production.

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucune carte son ni caméra.
Projet de test fabriqué par le script (sons et réponse impulsionnelle générés ici, à 48 kHz) :
  « Gauche » : 440 Hz dans le canal GAUCHE seul (0,3), membre du VCA « VCA » ;
  « Voix »   : 660 Hz au centre (0,3), fader à −6 dB, sortie vers le bus « BUS VOIX » ;
  « Clic »   : un clic toutes les 0,5 s, réverbe (mélange 100 %) — muette pendant les mesures 440 / 660.
Mesures : deux analyseurs sur la SORTIE D'ÉCOUTE (ce qu'on entend) et deux sur la sortie du MASTER
(le mix, ce qui part à l'export), amplitude à 440 et 660 Hz (Goertzel, fenêtre de Hann).

Bureau 1600 × 900 :
  1. Section d'écoute : stéréo / mono (−6 dB) / côtés / Dim −20 dB / volume −6 dB / coupure, par le bouton
     « Écoute » (panneau), les raccourcis (Alt+M, Ctrl+Alt+D, Alt+X), la tranche master de la console ; le mix
     (master) ne bouge pas ; pastilles visibles tant que c'est actif, un clic les retire ;
  2. Solo AFL / PFL : la voix seule après fader (0,15) / avant fader (0,30), le mix intact ; VCA en solo = ses
     pistes ; bus + piste en solo = prélevés une fois ; solo dans le mix : comportement d'avant ;
  3. Export (renderProject ET la chaîne d'export renderMixChannels) identique, au bit près, avec et sans
     mono / Dim / coupure / volume / solos AFL ;
  4. Polarité Ø d'une piste : l'export est inversé (elle, s'applique au fichier) ;
  5. Réverbe : réponse impulsionnelle IMPORTÉE (WAV fabriqué ici : écho à 50 ms, G 0,8 / D 0,4) par la fenêtre
     de l'effet ; export : l'écho est à 50 ms, G = 2 × D ; longueur rognée à 30 ms → plus d'écho ; en direct
     (AFL sur le clic) le même niveau qu'à l'export ; sauvegarde .zip (le WAV y est) puis rechargement : rendu
     identique au bit près ;
  6. Rien de recouvert (panneau, pastilles, tranche master, réverbe), aucune erreur console ; captures sombre / clair.
Téléphone 390 × 844 : menu ☰ › Écoute, pastilles, rien de recouvert.

NOVA_URL=http://127.0.0.1:3502/ python qa/mix_ecoute.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-mixecoute\\qa) : mix_ecoute.json + captures.
"""
import io, json, math, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3502/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-mixecoute\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, launch, new_page, shot, save_log, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
DUR = 6.0
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:900]}"), flush=True)


def wav_bytes(chans, sr=SR) -> bytes:
    x = np.stack(chans, axis=1)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(x.shape[1]); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).round().astype("<i2").tobytes())
    return buf.getvalue()


def sine(f, amp, n=int(DUR * SR)):
    t = np.arange(n) / SR
    return amp * np.sin(2 * np.pi * f * t)


IR_WAV = OUT / "reponse_impulsionnelle_test_50ms.wav"


def make_ir():
    n = SR  # 1 s
    l = np.zeros(n); r = np.zeros(n)
    k = int(round(0.05 * SR))
    l[k] = 0.8; r[k] = 0.4
    IR_WAV.write_bytes(wav_bytes([l, r]))


def track(id_, name, typ="AUDIO", **o):
    t = {"id": id_, "name": name, "type": typ, "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
         "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [], "clips": [], "plugins": [],
         "automationLanes": [], "totalLatency": 0}
    t.update(o)
    return t


def clip(id_, ref, name):
    return {"id": id_, "name": name, "start": 0, "duration": DUR, "offset": 0, "fadeIn": 0, "fadeOut": 0, "type": "AUDIO",
            "color": "#64748b", "audioRef": ref}


def make_project(path: Path):
    n = int(DUR * SR)
    clicks = np.zeros(n)
    for i in range(1, 12):
        clicks[int(i * 0.5 * SR)] = 0.9
    tracks = [
        track("master", "MASTER BUS", "BUS", outputTrackId=""),
        track("vca", "VCA", "BUS", outputTrackId="", isVca=True, color="#8b5cf6"),
        track("bus-voix", "BUS VOIX", "BUS"),
        track("gauche", "Gauche", vcaId="vca", clips=[clip("c-g", "audio/gauche.wav", "Gauche 440")]),
        track("voix", "Voix", volume=0.5, outputTrackId="bus-voix", clips=[clip("c-v", "audio/centre.wav", "Voix 660")]),
        track("clic", "Clic", isMuted=True, clips=[clip("c-c", "audio/clics.wav", "Clics")],
              plugins=[{"id": "p-rev", "type": "REVERB", "name": "Réverbe", "isEnabled": True,
                        "params": {"mix": 1, "preDelay": 0, "lowCut": 20, "highCut": 20000, "erLevel": 0.3, "modDepth": 0.1,
                                   "decay": 1.2, "mode": "HALL", "isEnabled": True}}]),
    ]
    state = {
        "id": "proj-mix-ecoute", "name": "Mix écoute", "bpm": 120, "sampleRate": SR, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": True, "loopStart": 0, "loopEnd": DUR,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "MIXING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/gauche.wav", wav_bytes([sine(440, 0.3), np.zeros(n)]))
        z.writestr("audio/centre.wav", wav_bytes([sine(660, 0.3), sine(660, 0.3)]))
        z.writestr("audio/clics.wav", wav_bytes([clicks, clicks]))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0');
      localStorage.removeItem('nova_solo_listen'); localStorage.removeItem('nova_monitor_volume_db'); } catch (e) {}
"""


def open_project(page, f: Path, label, touch=False):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    b = page.get_by_text("Charger Projet").first
    b.tap() if touch else b.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        c = page.get_by_text("Charger depuis l'ordinateur").first
        c.tap() if touch else c.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    page.keyboard.press("Escape")
    shot(page, label)


MEAS_INIT = """async () => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const ctx = audioEngine.getAudioContext();
  const mk = (node) => { const sp = ctx.createChannelSplitter(2); node.connect(sp);
    return [0, 1].map(i => { const an = ctx.createAnalyser(); an.fftSize = 32768; an.smoothingTimeConstant = 0; sp.connect(an, i); return an; }); };
  window.__qaMon = mk(audioEngine.getMonitorOutput());
  window.__qaMix = mk(audioEngine.getMasterMeterInput());
  window.__qaSr = ctx.sampleRate;
  return { sr: ctx.sampleRate, monitor: !!audioEngine.getMonitorOutput() };
}"""

MEASURE = """() => {
  const sr = window.__qaSr;
  const amp = (an, f) => { const n = an.fftSize; const d = new Float32Array(n); an.getFloatTimeDomainData(d);
    let re = 0, im = 0, w = 0; for (let i = 0; i < n; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); const a = 2 * Math.PI * f * i / sr; re += d[i] * h * Math.cos(a); im -= d[i] * h * Math.sin(a); w += h; }
    return Math.round(2 * Math.sqrt(re * re + im * im) / w * 10000) / 10000; };
  const peak = (an) => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return Math.round(m * 10000) / 10000; };
  const side = (arr) => ({ L440: amp(arr[0], 440), R440: amp(arr[1], 440), L660: amp(arr[0], 660), R660: amp(arr[1], 660), pkL: peak(arr[0]), pkR: peak(arr[1]) });
  return { mon: side(window.__qaMon), mix: side(window.__qaMix) };
}"""

# Pics de la sortie d'écoute (réverbe en direct) : valeur max de chaque canal sur la fenêtre de l'analyseur.
PEAKS_LIVE = """() => { const r = window.__qaMon.map(an => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; }); return r; }"""

STORE = "async (patch) => { const { monitorStore } = await window.__novaAppModule('/utils/monitorSection.ts'); monitorStore.set(patch); return monitorStore.get(); }"
ENGINE_INFO = "async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts'); return { taps: audioEngine.getListenTaps(), active: audioEngine.isListenBusActive() }; }"


def set_tracks(page, patches):
    """patches : {id: {champ: valeur}} appliqués par le chemin de l'interface (DAW_CONTROL.updateTrack)."""
    page.evaluate("""(patches) => { for (const [id, p] of Object.entries(patches)) {
        const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === id); if (t) window.DAW_CONTROL.updateTrack({ ...t, ...p }); } }""", patches)
    page.wait_for_timeout(500)


def ensure_playing(page):
    if not page.evaluate("() => window.DAW_CONTROL.getState().isPlaying"):
        page.evaluate("() => { window.DAW_CONTROL.seek(0); window.DAW_CONTROL.togglePlay(); }")
        page.wait_for_timeout(1200)


def measure(page, settle=900):
    ensure_playing(page)
    page.wait_for_timeout(settle)
    return page.evaluate(MEASURE)


def near(a, b, tol):
    return abs(a - b) <= tol


# Export : le moteur (renderProject) et la chaîne d'export (renderMixChannels) sur les pistes telles qu'elles sont.
RENDER_JS = """async ([dur, ids]) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const EP = await window.__novaAppModule('/services/ExportPipeline.ts');
  let tracks = window.DAW_CONTROL.getState().tracks;
  if (ids) tracks = tracks.filter(t => ids.includes(t.id));
  const sr = audioEngine.getProjectSampleRate();
  const b = await audioEngine.renderProject(tracks, dur, 0, sr);
  const m = await EP.renderMixChannels(tracks, { start: 0, end: dur, tail: { mode: 'cut', seconds: 0 }, sampleRate: sr, format: 'WAV' });
  const pack = (chs) => chs.map(c => Array.from(c));
  window.__qaLast = { eng: [b.getChannelData(0), b.getChannelData(1)], exp: m.ch };
  return { sr, n: b.length, nExp: m.ch[0].length };
}"""

COMPARE_JS = """async (key) => {
  const a = window.__qaRef[key], b = window.__qaLast;
  let d = 0, e = 0;
  for (const k of ['eng', 'exp']) for (let c = 0; c < 2; c++) { const x = a[k][c], y = b[k][c]; if (x.length !== y.length) return { diff: 99, len: [x.length, y.length] };
    for (let i = 0; i < x.length; i++) { d = Math.max(d, Math.abs(x[i] - y[i])); e += x[i] * x[i]; } }
  return { diff: d, energie: Math.round(e) };
}"""

KEEP_REF = "(key) => { window.__qaRef = window.__qaRef || {}; window.__qaRef[key] = window.__qaLast; return true; }"

# Polarité : l'export d'une piste avec Ø = l'opposé exact de l'export sans Ø.
INVERT_JS = """() => { const a = window.__qaRef['phase0'].eng, b = window.__qaLast.eng; let d = 0, m = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) { d = Math.max(d, Math.abs(a[c][i] + b[c][i])); m = Math.max(m, Math.abs(a[c][i])); }
  return { somme_max: d, crete: m }; }"""

# Réverbe à réponse importée : pics de l'export après chaque clic (fenêtres de 0,5 s).
ECHO_JS = """() => { const [L, R] = window.__qaLast.eng; const sr = window.__qaSr;
  const out = [];
  for (let k = 1; k <= 3; k++) { const c = Math.round(k * 0.5 * sr); let iL = c, mL = 0, mR = 0;
    for (let i = c; i < c + Math.round(0.45 * sr) && i < L.length; i++) { if (Math.abs(L[i]) > mL) { mL = Math.abs(L[i]); iL = i; } mR = Math.max(mR, Math.abs(R[i])); }
    out.push({ retard_ms: Math.round((iL - c) / sr * 100000) / 100, picL: Math.round(mL * 10000) / 10000, picR: Math.round(mR * 10000) / 10000 });
  }
  return out; }"""

COVER_JS = """(sel) => [...document.querySelectorAll(sel)].filter(b => b.offsetParent !== null).map(b => {
  const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  return { label: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 40), ok: !inView || (!!hit && (hit === b || b.contains(hit))),
           over: hit && hit !== b && !b.contains(hit) ? (hit.getAttribute('aria-label') || hit.className || hit.tagName).toString().slice(0, 80) : null };
})"""


def covered(page, sel):
    c = page.evaluate(COVER_JS, sel)
    return [x for x in c if not x["ok"]], len(c)


def desktop(b, f: Path):
    R = res["bureau"]
    log = Log("mix_ecoute_pc")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_00_projet")
    info = page.evaluate(MEAS_INIT)
    R["moteur"] = info
    check("sortie d'écoute présente dans le moteur", info.get("monitor"), info)
    page.evaluate("() => window.DAW_CONTROL.setLoop(true, 0, 6)")
    page.evaluate("() => { window.DAW_CONTROL.seek(0); window.DAW_CONTROL.togglePlay(); }")
    page.wait_for_timeout(1500)

    # ── 1. Section d'écoute ────────────────────────────────────────────────
    m = measure(page); R["stereo"] = m
    check("stéréo : 440 Hz à gauche seulement (0,30), 660 Hz au centre (0,15 après le fader à −6 dB)",
          near(m["mon"]["L440"], 0.3, 0.01) and m["mon"]["R440"] < 0.005 and near(m["mon"]["L660"], 0.15, 0.008) and near(m["mon"]["R660"], 0.15, 0.008), m)
    mix_ref = m["mix"]

    page.locator('[data-testid="open-monitor"]').click(); page.wait_for_timeout(400)
    check("bouton « Écoute » : le panneau s'ouvre", page.locator('[data-testid="monitor-panel"]').count() == 1)
    bad, n = covered(page, '[data-testid="monitor-panel"] button, [data-testid="monitor-panel"] input')
    check(f"panneau d'écoute : aucun bouton recouvert ({n})", n >= 8 and not bad, bad)
    shot(page, "pc_01_panneau_ecoute")
    page.locator('[data-testid="monitor-matrix-mono"]').click()
    m = measure(page); R["mono"] = m
    check("mono (panneau) : (G + D) / 2 dans les deux canaux — 440 à 0,15 des deux côtés, 660 centré inchangé (0,15)",
          near(m["mon"]["L440"], 0.15, 0.008) and near(m["mon"]["R440"], 0.15, 0.008) and near(m["mon"]["L660"], 0.15, 0.008) and near(m["mon"]["R660"], 0.15, 0.008), m)
    check("mono : le mix (master, ce qui part à l'export) ne change pas", near(m["mix"]["L440"], mix_ref["L440"], 0.005) and m["mix"]["R440"] < 0.005, m["mix"])
    page.locator('[data-testid="monitor-matrix-side"]').click()
    m = measure(page); R["cotes"] = m
    check("côtés (S) : (G − D) / 2 — le 660 centré disparaît, le 440 reste (0,15)",
          near(m["mon"]["L440"], 0.15, 0.008) and near(m["mon"]["R440"], 0.15, 0.008) and m["mon"]["L660"] < 0.004 and m["mon"]["R660"] < 0.004, m)
    page.locator('[data-testid="monitor-matrix-stereo"]').click()
    page.locator('[data-testid="monitor-dim"]').click()
    m = measure(page); R["dim"] = m
    check("Dim : −20 dB pile sur l'écoute (440 : 0,030), le mix ne bouge pas",
          near(m["mon"]["L440"], 0.03, 0.002) and near(m["mix"]["L440"], mix_ref["L440"], 0.005), m)
    shot(page, "pc_02_dim_actif")
    page.locator('[data-testid="monitor-dim"]').click()
    page.locator('[data-testid="monitor-volume"]').fill("-6")
    m = measure(page); R["volume_m6"] = m
    check("volume d'écoute −6 dB (séparé du master) : 440 à 0,150 ; mix inchangé",
          near(m["mon"]["L440"], 0.3 * 10 ** (-6 / 20), 0.006) and near(m["mix"]["L440"], mix_ref["L440"], 0.005), m)
    badge = page.locator('[data-testid="monitor-badge-vol"]')
    check("pastille « ÉCOUTE −6 dB » visible", badge.count() == 1 and "6" in badge.inner_text(), badge.count())
    page.locator('[data-testid="monitor-cut"]').click()
    m = measure(page); R["coupe"] = m
    check("couper l'écoute : silence en sortie, le mix continue", m["mon"]["pkL"] < 1e-4 and m["mon"]["pkR"] < 1e-4 and near(m["mix"]["L440"], mix_ref["L440"], 0.005), m)
    shot(page, "pc_03_ecoute_coupee")
    page.locator('[data-testid="monitor-reset"]').click(); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    playing = page.evaluate("() => window.DAW_CONTROL.getState().isPlaying")
    check("« Tout remettre à zéro » + Échap : panneau fermé, plus aucune pastille, la lecture continue", page.locator('[data-testid="monitor-panel"]').count() == 0 and page.locator('[data-testid="monitor-badges"]').count() == 0 and playing, playing)

    # Raccourcis clavier
    page.mouse.move(800, 600)
    ensure_playing(page)
    page.keyboard.press("Alt+m")
    m = measure(page); R["alt_m"] = m
    mono_badge = page.locator('[data-testid="monitor-badge-mono"]')
    check("Alt+M : écoute en mono et pastille « MONO » en haut", near(m["mon"]["R440"], 0.15, 0.008) and mono_badge.count() == 1, {"m": m["mon"], "badge": mono_badge.count()})
    page.keyboard.press("Control+Alt+d")
    m = measure(page)
    check("Ctrl+Alt+D : Dim en plus du mono (0,015)", near(m["mon"]["R440"], 0.015, 0.002) and page.locator('[data-testid="monitor-badge-dim"]').count() == 1, m["mon"])
    page.keyboard.press("Alt+x")
    m = measure(page)
    check("Alt+X : écoute coupée (pastille rouge)", m["mon"]["pkL"] < 1e-4 and page.locator('[data-testid="monitor-badge-cut"]').count() == 1, m["mon"])
    bad, n = covered(page, '[data-testid="monitor-badges"] button')
    check(f"pastilles : rien ne les recouvre ({n})", n >= 2 and not bad, bad)
    shot(page, "pc_04_pastilles_mono_dim_coupe")
    for bid in ("cut", "dim", "mono"):
        page.locator(f'[data-testid="monitor-badge-{bid}"]').click(); page.wait_for_timeout(200)
    m = measure(page)
    check("un clic sur chaque pastille la retire : écoute normale", page.locator('[data-testid="monitor-badges"]').count() == 0 and near(m["mon"]["L440"], 0.3, 0.01) and m["mon"]["R440"] < 0.005, m["mon"])

    # Palette Ctrl+K
    page.keyboard.press("Control+k"); page.wait_for_timeout(400)
    page.keyboard.type("écoute mono"); page.wait_for_timeout(400)
    pal = page.locator('[role="dialog"]').filter(has_text=re.compile("mono", re.I))
    check("palette Ctrl+K : « Écoute en mono » trouvée", pal.count() > 0 and "Écoute en mono" in pal.first.inner_text(), pal.count())
    shot(page, "pc_05_palette_mono")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # ── 2. Solo AFL / PFL ────────────────────────────────────────────────
    page.evaluate(STORE, {"listen": "afl"})
    set_tracks(page, {"voix": {"isSolo": True}})
    m = measure(page); R["afl_voix"] = m
    eng = page.evaluate(ENGINE_INFO)
    check("AFL sur « Voix » : on entend la voix seule APRÈS son fader (660 à 0,15, plus de 440)",
          near(m["mon"]["L660"], 0.15, 0.008) and m["mon"]["L440"] < 0.004, {"m": m["mon"], "moteur": eng})
    check("AFL : le mix (master / export) n'est pas touché (440 toujours là)", near(m["mix"]["L440"], mix_ref["L440"], 0.005) and near(m["mix"]["L660"], mix_ref["L660"], 0.005), m["mix"])
    page.locator('[data-testid="monitor-badge-afl"]').wait_for(timeout=3000)
    check("pastille « AFL » pendant l'écoute", page.locator('[data-testid="monitor-badge-afl"]').count() == 1)
    shot(page, "pc_06_afl_voix")
    page.evaluate(STORE, {"listen": "pfl"})
    m = measure(page); R["pfl_voix"] = m
    check("PFL sur « Voix » : AVANT le fader (660 à 0,30), le mix intact",
          near(m["mon"]["L660"], 0.3, 0.012) and m["mon"]["L440"] < 0.004 and near(m["mix"]["L440"], mix_ref["L440"], 0.005), m)
    set_tracks(page, {"bus-voix": {"isSolo": True}})
    page.evaluate(STORE, {"listen": "afl"})
    m = measure(page); eng = page.evaluate(ENGINE_INFO); R["afl_bus_et_voix"] = {"m": m, "moteur": eng}
    check("AFL : « Voix » et son bus en solo → prélevés une seule fois (660 à 0,15, pas 0,30)",
          near(m["mon"]["L660"], 0.15, 0.008) and [t["id"] for t in eng["taps"]] == ["bus-voix"], {"m": m["mon"], "moteur": eng})
    set_tracks(page, {"bus-voix": {"isSolo": False}, "voix": {"isSolo": False}, "vca": {"isSolo": True}})
    m = measure(page); eng = page.evaluate(ENGINE_INFO); R["afl_vca"] = {"m": m, "moteur": eng}
    check("AFL sur le VCA : on entend ses pistes (« Gauche » : 440 à gauche seulement)",
          near(m["mon"]["L440"], 0.3, 0.01) and m["mon"]["R440"] < 0.005 and m["mon"]["L660"] < 0.004, {"m": m["mon"], "moteur": eng})
    # Bouton solo de la console : libellé AFL
    page.evaluate("() => window.DAW_CONTROL.setView('MIXER')"); page.wait_for_timeout(1200)
    lbl = page.locator('[data-strip-id="voix"] button[aria-label^="Solo"]').first.inner_text()
    check("console : le bouton solo s'appelle « AFL » en mode AFL", lbl.strip() == "AFL", lbl)
    master = page.locator('[data-testid="master-monitor"]')
    check("tranche master : section « Écoute (hors export) »", master.count() == 1)
    bad, n = covered(page, '[data-testid="master-monitor"] button, [data-testid="master-monitor"] input')
    check(f"tranche master : boutons d'écoute non recouverts ({n})", n >= 6 and not bad, bad)
    master.scroll_into_view_if_needed()
    shot(page, "pc_07_console_afl_master")
    page.locator('[data-testid="master-monitor"] [data-testid="monitor-matrix-mono"]').click()
    m = measure(page)
    check("tranche master : « Mono » agit sur l'écoute (bus AFL compris)", near(m["mon"]["L440"], 0.15, 0.008) and near(m["mon"]["R440"], 0.15, 0.008), m["mon"])
    page.evaluate(STORE, {"matrix": "stereo"})
    # Solo dans le mix : comportement d'avant
    page.evaluate(STORE, {"listen": "sip"})
    set_tracks(page, {"vca": {"isSolo": False}, "voix": {"isSolo": True}})
    m = measure(page); eng = page.evaluate(ENGINE_INFO); R["sip_voix"] = {"m": m, "moteur": eng}
    check("solo dans le mix (comme avant) : « Gauche » se tait dans le mix, l'écoute = le mix, aucun prélèvement",
          m["mix"]["L440"] < 0.004 and near(m["mix"]["L660"], 0.15, 0.008) and not eng["taps"] and not eng["active"], {"m": m, "moteur": eng})
    set_tracks(page, {"voix": {"isSolo": False}})
    page.evaluate("() => window.DAW_CONTROL.setView('ARRANGEMENT')"); page.wait_for_timeout(600)

    # ── 3. Export identique avec et sans écoute ─────────────────────────
    page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(300)
    page.evaluate(STORE, {"listen": "sip", "matrix": "stereo", "dim": False, "cut": False, "volumeDb": 0})
    r = page.evaluate(RENDER_JS, [3.0, None]); page.evaluate(KEEP_REF, "neutre"); R["rendu_neutre"] = r
    page.evaluate(STORE, {"listen": "afl", "matrix": "mono", "dim": True, "cut": True, "volumeDb": -12})
    set_tracks(page, {"voix": {"isSolo": True}, "vca": {"isSolo": True}})
    page.evaluate(RENDER_JS, [3.0, None]); c = page.evaluate(COMPARE_JS, "neutre"); R["export_afl_mono_dim_coupe"] = c
    check("export (moteur + chaîne d'export) identique au bit près avec mono, Dim, coupure, volume −12 et solos AFL",
          c["diff"] == 0 and c["energie"] > 100, c)
    page.evaluate(STORE, {"listen": "pfl", "matrix": "side", "cut": False})
    page.evaluate(RENDER_JS, [3.0, None]); c = page.evaluate(COMPARE_JS, "neutre")
    check("export identique avec côtés + solos PFL", c["diff"] == 0, c)
    page.evaluate(STORE, {"listen": "sip", "matrix": "stereo", "dim": False, "cut": False, "volumeDb": 0})
    set_tracks(page, {"voix": {"isSolo": False}, "vca": {"isSolo": False}})

    # ── 4. Polarité Ø (elle, va dans le fichier) ────────────────────────
    page.evaluate(RENDER_JS, [2.0, ["master", "voix", "bus-voix"]]); page.evaluate(KEEP_REF, "phase0")
    set_tracks(page, {"voix": {"phaseInvert": True}})
    page.evaluate(RENDER_JS, [2.0, ["master", "voix", "bus-voix"]]); inv = page.evaluate(INVERT_JS); R["polarite"] = inv
    check("Ø sur « Voix » : l'export est l'opposé exact (somme ≈ 0)", inv["crete"] > 0.1 and inv["somme_max"] < 1e-6, inv)
    set_tracks(page, {"voix": {"phaseInvert": False}})

    # ── 5. Réverbe : réponse impulsionnelle importée ─────────────────────
    set_tracks(page, {"clic": {"isMuted": False}, "gauche": {"isMuted": True}, "voix": {"isMuted": True}})
    page.evaluate("() => window.DAW_CONTROL.setView('MIXER')"); page.wait_for_timeout(1200)
    slot = page.locator('[data-strip-id="clic"] [data-fx-id="p-rev"]')
    slot.scroll_into_view_if_needed()
    opener = slot.locator("button").first
    opener.click(); page.wait_for_timeout(1500)
    win = page.locator("[data-nova-plugin='REVERB']")
    check("fenêtre de la réverbe ouverte depuis la console", win.count() >= 1)
    check("section « Réponse importée » : charger / glisser, aucune réponse de tiers fournie",
          page.locator('[data-testid="reverb-ir-drop"]').count() == 1 and "Aucune réponse de tiers" in page.locator('[data-testid="reverb-ir-drop"]').inner_text())
    shot(page, "pc_08_reverbe_avant_import")
    page.locator('[data-testid="reverb-ir-input"]').set_input_files(str(IR_WAV))
    page.locator('[data-testid="reverb-ir-name"]').wait_for(timeout=10000)
    page.wait_for_timeout(800)
    name = page.locator('[data-testid="reverb-ir-name"]').inner_text()
    pp = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'clic').plugins[0].params")
    R["reverbe_params"] = pp
    check("réponse importée par la fenêtre : nom affiché, réglage « irUser » posé", "reponse_impulsionnelle_test_50ms" in name and str(pp.get("irUser", "")).startswith("userir:"), {"nom": name, "params": pp})
    bad, n = covered(page, "[data-nova-plugin='REVERB'] [data-testid^='reverb-ir'] button, [data-nova-plugin='REVERB'] [data-testid='reverb-ir-drop'] [role=slider]")
    check(f"réverbe : boutons de la réponse importée non recouverts ({n})", not bad, bad)
    shot(page, "pc_09_reverbe_reponse_importee")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    for _ in range(3):
        if page.locator("[data-nova-plugin='REVERB']").count() == 0: break
        close = page.locator("[data-nova-plugin='REVERB'] button[aria-label^='Fermer']")
        if close.count(): close.first.click(); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.setView('ARRANGEMENT')"); page.wait_for_timeout(600)

    page.evaluate(RENDER_JS, [2.0, ["master", "clic"]]); page.evaluate(KEEP_REF, "ir"); e = page.evaluate(ECHO_JS); R["echo_export"] = e
    check("export : l'écho de la réponse importée est à 50 ms de chaque clic (± 0,1 ms : son timing exact)", all(abs(x["retard_ms"] - 50) <= 0.1 for x in e), e)
    check("export : réponse stéréo respectée (gauche = 2 × droite, ± 5 %)", all(x["picR"] > 0 and abs(x["picL"] / x["picR"] - 2) < 0.1 for x in e), e)
    exp_amp = 0.9 * 0.8 * (1 / math.sqrt((0.64 + 0.16) / (2 * SR))) * 10 ** (-58 / 20) * 44100 / SR
    check(f"export : niveau calibré comme prévu (≈ {exp_amp:.3f}, filtres compris)", all(0.6 * exp_amp < x["picL"] < 1.05 * exp_amp for x in e), {"attendu": exp_amp, "echos": e})
    # En direct (AFL sur le clic) : même niveau qu'à l'export
    page.evaluate(STORE, {"listen": "afl"})
    set_tracks(page, {"clic": {"isSolo": True}})
    page.evaluate("() => { window.DAW_CONTROL.seek(0); window.DAW_CONTROL.togglePlay(); }")
    page.wait_for_timeout(2500)
    live = page.evaluate(PEAKS_LIVE); R["echo_direct"] = live
    db = 20 * math.log10(max(live[0], 1e-9) / e[0]["picL"])
    check("en direct (AFL sur le clic) : même écho qu'à l'export (± 1 dB) et G = 2 × D", abs(db) < 1 and abs(live[0] / max(live[1], 1e-9) - 2) < 0.15, {"direct": live, "export": e[0], "ecart_db": db})
    page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(300)
    set_tracks(page, {"clic": {"isSolo": False}})
    page.evaluate(STORE, {"listen": "sip"})
    # Longueur rognée à 30 ms : l'écho (à 50 ms) disparaît
    page.evaluate("() => window.DAW_CONTROL.updatePluginParams('clic', 'p-rev', { irLength: 0.03, irFade: 0.005 })"); page.wait_for_timeout(400)
    page.evaluate(RENDER_JS, [2.0, ["master", "clic"]]); e2 = page.evaluate(ECHO_JS); R["echo_rogne"] = e2
    check("longueur 30 ms : plus d'écho à 50 ms (la queue est vraiment rognée)", all(x["picL"] < 1e-3 for x in e2), e2)
    page.evaluate("() => window.DAW_CONTROL.updatePluginParams('clic', 'p-rev', { irLength: 0, irFade: 0.15 })"); page.wait_for_timeout(400)
    page.evaluate(RENDER_JS, [2.0, ["master", "clic"]]); c = page.evaluate(COMPARE_JS, "ir")
    check("longueur entière : rendu revenu au bit près", c["diff"] == 0, c)

    # ── 6. Thème clair, balayage, sauvegarde ─────────────────────────────
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    page.locator('[data-testid="open-monitor"]').click(); page.wait_for_timeout(400)
    page.locator('[data-testid="monitor-panel"] [data-testid="monitor-matrix-mono"]').click()
    page.locator('[data-testid="monitor-panel"] [data-testid="monitor-dim"]').click(); page.wait_for_timeout(300)
    shot(page, "pc_10_theme_clair_panneau")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    shot(page, "pc_10b_theme_clair_pastilles")
    folded = page.evaluate("() => !!document.querySelector('[data-bar-item=\"ecoute\"][data-bar-folded]')")
    R["ecoute_replie_1600"] = folded
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(400)
    page.mouse.move(2, 2)
    bal = balayage_chevauchement(page)
    R["balayage"] = bal
    check(f"bureau (pastilles MONO + DIM actives) : aucun bouton recouvert sur l'écran ({bal.get('boutons')} boutons)",
          not bal.get("erreur") and bal.get("boutons", 0) > 10 and not bal["recouverts"], bal.get("recouverts") or bal.get("erreur"))
    page.evaluate(STORE, {"matrix": "stereo", "dim": False})
    # Réglages audio : mode de solo
    page.wait_for_timeout(800)
    btn = page.get_by_role("button", name=re.compile("^Réglages audio$", re.I)).locator("visible=true")
    if btn.count():
        btn.first.click(); page.wait_for_timeout(900)
    else:  # replié dans le menu ☰
        page.locator('[data-testid="transport-menu"]').locator("visible=true").first.click(); page.wait_for_timeout(600)
        page.locator('[data-testid="menu-audio"]').locator("visible=true").first.click(); page.wait_for_timeout(900)
    sl = page.locator('[data-testid="settings-listen"]')
    if sl.count():
        sl.scroll_into_view_if_needed()
        sl.locator('[data-testid="solo-listen-pfl"]').click(); page.wait_for_timeout(200)
        shot(page, "pc_11_reglages_ecoute_solo")
        mode = page.evaluate("async () => (await window.__novaAppModule('/utils/monitorSection.ts')).monitorStore.get().listen")
        check("réglages audio : « Écoute et solo », choix PFL appliqué", mode == "pfl", mode)
        sl.locator('[data-testid="solo-listen-sip"]').click(); page.wait_for_timeout(200)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        valider = page.get_by_role("button", name="Valider").locator("visible=true")
        if valider.count(): valider.first.click(); page.wait_for_timeout(300)
    else:
        check("réglages audio : section « Écoute et solo » trouvée", False, "fenêtre des réglages audio non ouverte")

    dest = OUT / "seance_mix_ecoute.zip"
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(600)
    with zipfile.ZipFile(dest) as z:
        names = z.namelist()
        pj = json.loads(z.read("project.json"))
    rp = [t for t in pj["tracks"] if t["id"] == "clic"][0]["plugins"][0]["params"]
    irs = [n for n in names if n.startswith("audio/userir")]
    R["sauvegarde"] = {"fichiers": names, "params": rp}
    check("sauvegarde .zip : la réponse importée y est (audio/userir-….wav) et le réglage la référence",
          len(irs) == 1 and rp.get("irAudioRef") == irs[0] and rp.get("irUser", "").startswith("userir:"), R["sauvegarde"])
    errs = log.errors()
    R["erreurs_console"] = errs[:10]
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    R = res["rechargement"]
    log = Log("mix_ecoute_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_12_rechargement")
    page.evaluate(MEAS_INIT)
    page.wait_for_timeout(1000)
    pp = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'clic').plugins[0].params")
    has = page.evaluate("async (k) => !!(await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry.get(k)", pp.get("irUser", ""))
    check("rechargement : la réponse importée est revenue (registre audio, même clé)", has and "irAudioRef" not in pp, pp)
    page.evaluate(RENDER_JS, [2.0, ["master", "clic"]]); e = page.evaluate(ECHO_JS); R["echo_apres_rechargement"] = e
    avant = res["bureau"]["echo_export"]
    check("rechargement : même écho, même niveau qu'avant la sauvegarde",
          all(abs(a["retard_ms"] - b_["retard_ms"]) < 0.05 and abs(a["picL"] - b_["picL"]) < 2e-4 and abs(a["picR"] - b_["picR"]) < 2e-4 for a, b_ in zip(e, avant)), {"avant": avant, "apres": e})
    mon = page.evaluate("async () => (await window.__novaAppModule('/utils/monitorSection.ts')).monitorStore.get()")
    check("rechargement : l'écoute repart neutre (ni mono ni Dim ni coupure), pas de pastille", mon["matrix"] == "stereo" and not mon["dim"] and not mon["cut"]
          and page.locator('[data-testid="monitor-badges"]').count() == 0, mon)
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    R = res["telephone"]
    for theme in ("dark", "light"):
        log = Log(f"mix_ecoute_tel_{theme}")
        ctx, page = new_page(b, "tel390", log=log, touch=True)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, f, f"tel_{theme}_00_ouvert", touch=True)
        page.wait_for_timeout(1000)
        page.evaluate(STORE, {"matrix": "mono", "dim": True})
        page.wait_for_timeout(400)
        badges = page.locator('[data-testid="monitor-badges"]').locator("visible=true")
        check(f"téléphone ({theme}) : pastilles MONO et DIM visibles", badges.count() == 1 and "MONO" in badges.first.inner_text(), badges.count())
        shot(page, f"tel_{theme}_01_pastilles")
        menu = page.locator('[data-testid="transport-menu"]').locator("visible=true")
        if menu.count():
            menu.first.tap(); page.wait_for_timeout(700)
            sec = page.locator('[data-testid="menu-monitor"]').locator("visible=true")
            if sec.count(): sec.first.scroll_into_view_if_needed(); page.wait_for_timeout(300)
            check(f"téléphone ({theme}) : menu ☰ › rubrique « Écoute »", sec.count() == 1)
            bad, n = covered(page, '[data-testid="menu-monitor"] button')
            check(f"téléphone ({theme}) : boutons d'écoute du menu non recouverts ({n})", n >= 5 and not bad, bad)
            sizes = page.evaluate("""() => [...document.querySelectorAll('[data-testid="menu-monitor"] button')].filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().height))""")
            check(f"téléphone ({theme}) : boutons au doigt (≥ 32 px)", sizes and min(sizes) >= 32, sizes)
            shot(page, f"tel_{theme}_02_menu_ecoute")
            if sec.count():
                sec.first.locator('[data-testid="monitor-dim"]').tap(); page.wait_for_timeout(300)
                st = page.evaluate("async () => (await window.__novaAppModule('/utils/monitorSection.ts')).monitorStore.get().dim")
                check(f"téléphone ({theme}) : « Dim » au doigt l'éteint", st is False, st)
            page.keyboard.press("Escape"); page.wait_for_timeout(300)
        else:
            check(f"téléphone ({theme}) : menu ☰ trouvé", False)
        page.evaluate(STORE, {"matrix": "stereo", "dim": False})
        page.mouse.move(2, 2)
        bal = balayage_chevauchement(page)
        R[f"balayage_{theme}"] = bal
        check(f"téléphone ({theme}) : aucun bouton recouvert sur l'écran ({bal.get('boutons')} boutons)",
              not bal.get("erreur") and bal.get("boutons", 0) > 5 and not bal["recouverts"], bal.get("recouverts") or bal.get("erreur"))
        errs = log.errors()
        check(f"téléphone ({theme}) : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


with sync_playwright() as p:
    b = launch(p)
    try:
        f = OUT / "seance_mix_ecoute_source.zip"
        make_ir()
        make_project(f)
        saved = desktop(b, f)
        reload_desktop(b, saved)
        phone(b, saved)
    finally:
        b.close()

res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "mix_ecoute.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
