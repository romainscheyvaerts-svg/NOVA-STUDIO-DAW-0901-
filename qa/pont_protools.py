"""Pont Pro Tools (chantier 9, B2) : prises BWF horodatées chez l'ingé + mix Pro Tools diffusé.

Deux navigateurs headless (aucune fenêtre), serveur NOVA (daw-session) et Supabase Realtime
SIMULÉS (qa/collab_sim.py), 100 % hors production (qa_hors_prod via qalib) ; WebRTC RÉEL
entre les deux pages ; VRAI code du pont (nova_bridge_server + protools_files) derrière
qa/harness/pont_projets.py sur le port 8791 (jamais le pont de l'appli installée, 8765).

  A = Lina, artiste, hôte                E = Max, ingé son (Nova Studio simulé : le pont écrit)

Pour chaque fréquence de projet (48 kHz puis 44,1 kHz) :
  1. Max active « Dossier Pro Tools » (dossier de test, départ de séance 01:00:00:00, 24 bits) ;
  2. Lina enregistre une prise (début hors grille) ; elle arrive chez Max par la collaboration ;
     → fichier BWF dans le dossier en ≤ 3 s après être posée chez Max ;
     → TimeReference relu en Python (protools_files.read_bwf) = 01:00:00:00 + position NOVA
       de la prise chez Max, à l'échantillon près ;
     → échantillons identiques au bit près au son de la prise chez Max (24 bits : entiers
       24 bits du même son, qui vient d'un WAV 16 bits : sans arrondi) ;
  3. même chose en 32 bits flottants (2e prise) : octets des échantillons = Float32 de NOVA ;
  4. (48 kHz) chemins du navigateur : dossier File System Access (dossier privé OPFS, même
     API) et téléchargement : mêmes échantillons, même TimeReference ;
  5. (48 kHz) mix Pro Tools diffusé : Max choisit une ENTRÉE SYSTÈME (faux micro Chromium,
     fichier stéréo : 440 Hz à gauche, 660 Hz à droite) comme source du mix en direct ;
     Lina l'écoute : séparation G / D mesurée à la réception (≥ 30 dB), Opus 2 canaux,
     débit réel, indicateurs de niveau et message chez Max ;
  6. entrée mono, entrée muette : message clair (navigateurs à part, faux micros mono / muet).

Usage : NOVA_URL=http://127.0.0.1:3431/ RUN=run1 python qa/pont_protools.py
Résultats : D:\\1 WORK\\CONTENU\\nova-pont-protools\\<RUN>\\
"""
import base64, json, math, os, shutil, socket, struct, subprocess, sys, time, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
RUN = os.environ.get("RUN", "run1")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pont-protools\{RUN}")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3431/")
from qalib import *  # noqa
from qalib import CHROME, OUT, BASE, Log, new_page, shot, save_log, sync_playwright  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa
from feat_lib import BASE_T, dismiss, wait_for, collab, open_panel, close_panel, rec_button, REC_INIT  # noqa

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge-python"))
import protools_files  # noqa: E402  (lecture des BWF : le même module que le pont)

BRIDGE_PY = os.environ.get("NOVA_BRIDGE_PY", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe")
PORT = int(os.environ.get("QA_PT_PORT", "8791"))
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LINA, MAX = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
RATES = [int(x) for x in os.environ.get("QA_RATES", "48000,44100").split(",")]
F_L, F_R = 440, 660
TC_START = "01:00:00:00"
OUT.mkdir(parents=True, exist_ok=True)
FAKE = OUT / "faux_micros"

PCS_INIT = """(() => { const O = window.RTCPeerConnection; if (!O || O.__qa) return; const list = []; window.__qaPcs = list;
  const P = class extends O { constructor(c) { super(c); list.push(this); } }; P.__qa = true; window.RTCPeerConnection = P; })();"""


# ─── faux micros (fichiers lus en boucle par Chromium) ─────────────────────────

def write_wav(path: Path, chans, sr=48000):
    n = len(chans[0])
    inter = np.stack([np.clip(c, -1, 1) for c in chans], axis=1).reshape(-1)
    data = (inter * 32767).astype("<i2").tobytes()
    nc = len(chans)
    path.write_bytes(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, nc, sr, sr * nc * 2, nc * 2, 16)
                     + b"data" + struct.pack("<I", len(data)) + data)


def make_fakes():
    FAKE.mkdir(parents=True, exist_ok=True)
    sr, n = 48000, 48000 * 20
    t = np.arange(n) / sr
    a = 10 ** (-12 / 20)
    write_wav(FAKE / "stereo_440G_660D.wav", [a * np.sin(2 * np.pi * F_L * t), a * np.sin(2 * np.pi * F_R * t)])
    write_wav(FAKE / "mono_440.wav", [a * np.sin(2 * np.pi * F_L * t)])
    write_wav(FAKE / "muet.wav", [np.zeros(n), np.zeros(n)])


def launch_with(p, fake: Path):
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={fake}",
        "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])


# ─── pont de test (vrai code du pont, port 8791) ───────────────────────────────

def start_bridge(root: Path):
    log = open(OUT / "pont_8791.log", "ab")
    proc = subprocess.Popen([BRIDGE_PY, str(ROOT / "qa" / "harness" / "pont_projets.py"), "--port", str(PORT), "--root", str(root)],
                            stdout=log, stderr=subprocess.STDOUT, creationflags=NOWIN, env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    for _ in range(150):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("le pont de test ne démarre pas")


# ─── projet ──────────────────────────────────────────────────────────────────

def project(path: Path, sr: int):
    tracks = [{**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": [], "plugins": [], "isTrackArmed": True}]
    state = {
        "id": f"proj-pt-{sr}", "name": f"Pont Pro Tools {sr // 1000 if sr % 1000 == 0 else sr / 1000} kHz", "bpm": 120, "sampleRate": sr,
        "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False, "isRecording": False, "currentTime": 0,
        "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix",
        "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


def seek(page, t):
    page.evaluate(f"async () => {{ const m = await import('/utils/playheadStore.ts'); m.playheadStore.set({t}); }}")


TAKES_JS = """() => { const e = window.__novaEdit; if (!e) return []; const t = e.getState().tracks.find(x => x.id === 'voix');
  return (t ? t.clips : []).filter(c => c.takeNumber && c.bufferId).map(c => ({ id: c.id, start: c.start, offset: c.offset || 0, duration: c.duration,
    takeNumber: c.takeNumber, bufferId: c.bufferId, name: c.name })); }"""

# Son de la prise tel que NOVA le joue chez la page (région du clip, échantillons entiers), en base64 Float32.
REGION_JS = """async (clipId) => {
  const reg = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
  const st = window.__novaEdit.getState(); const t = st.tracks.find(x => x.id === 'voix'); const c = t.clips.find(k => k.id === clipId);
  if (!c) return { erreur: 'clip absent' };
  const b = reg.get(c.bufferId); if (!b) return { erreur: 'son absent' };
  const sr = b.sampleRate; const from = Math.round((c.offset || 0) * sr); const len = Math.min(Math.round(c.duration * sr), b.length - from);
  const out = [];
  for (let ch = 0; ch < b.numberOfChannels; ch++) { const x = b.getChannelData(ch).slice(from, from + len); const u = new Uint8Array(x.buffer);
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); out.push(btoa(s)); }
  const m = await window.__novaAppModule('/engine/AudioEngine.ts');
  return { sr, from, len, start: c.start, offset: c.offset || 0, duration: c.duration, channels: out, projet_sr: st.sampleRate || null,
           contexte_sr: m.audioEngine.ctx ? m.audioEngine.ctx.sampleRate : null, bufferLength: b.length }; }"""

SINK_JS = """async () => { const m = await window.__novaAppModule('/services/ProToolsBridge.ts'); const s = m.proToolsSink();
  return { reglages: s.getSettings(), entrees: s.entries.map(e => ({ ...e })) }; }"""


def floats(b64s):
    return [np.frombuffer(base64.b64decode(x), dtype="<f4") for x in b64s]


def file_samples(info):
    """Échantillons du fichier : Float32 (32f) ou entiers 24 bits."""
    raw = info["data"]
    nc = info["channels"]
    if info["float"]:
        return np.frombuffer(raw, dtype="<f4").reshape(-1, nc).T
    b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
    v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
    v = (v << 8) >> 8
    return v.reshape(-1, nc).T


def to_int24(x):
    v = np.floor(x.astype(np.float64) * 8388608 + 0.5)  # Math.round de JavaScript : demi vers +∞
    return np.clip(v, -8388608, 8388607).astype(np.int64)


def goertzel_js():
    return """async ({ secs, freqs }) => {
  const el = document.querySelector('audio[data-collab-audio$=":mix"]'); const stream = el && el.srcObject; if (!stream) return { erreur: 'aucun flux reçu' };
  const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume(); const src = ctx.createMediaStreamSource(stream);
  const sp = ctx.createScriptProcessor(4096, 2, 2); sp.channelCount = 2; sp.channelCountMode = 'explicit'; sp.channelInterpretation = 'speakers';
  const mute = ctx.createGain(); mute.gain.value = 0; src.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
  const n = Math.round(secs * 48000), L = new Float32Array(n), R = new Float32Array(n); let w = 0, started = false, t0 = performance.now(), tSon = null;
  await new Promise(res => { sp.onaudioprocess = e => { const a = e.inputBuffer.getChannelData(0), b = e.inputBuffer.getChannelData(1);
    if (!started) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i] + b[i] * b[i]; if (s / a.length > 1e-6) { started = true; tSon = Math.round(performance.now() - t0); } else return; }
    if (performance.now() - t0 < tSon + 500) return;
    for (let i = 0; i < a.length && w < n; i++, w++) { L[w] = a[i]; R[w] = b[i]; } if (w >= n) res(); }; setTimeout(res, 30000); });
  sp.onaudioprocess = null; try { src.disconnect(); sp.disconnect(); mute.disconnect(); } catch (e) {} await ctx.close();
  if (w < n) return { erreur: 'pas assez de son', echantillons: w };
  const seg = 4800, hop = 2400, han = new Float32Array(seg); for (let i = 0; i < seg; i++) han[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / seg);
  const lvl = (x, f) => { const k = 2 * Math.PI * f / 48000, c = 2 * Math.cos(k), ck = Math.cos(k), sk = Math.sin(k); let p = 0, m = 0;
    for (let o = 0; o + seg <= n; o += hop, m++) { let s1 = 0, s2 = 0; for (let i = 0; i < seg; i++) { const s0 = x[o + i] * han[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      const re = s1 - s2 * ck, im = s2 * sk; p += re * re + im * im; } return +(20 * Math.log10(4 * Math.sqrt(p / Math.max(1, m)) / seg + 1e-12)).toFixed(2); };
  const out = {}; for (const f of freqs) out[f] = { g: lvl(L, f), d: lvl(R, f) };
  let dl = 0, dr = 0, dd = 0; for (let i = 0; i < n; i++) { dl += L[i] * L[i]; dr += R[i] * R[i]; dd += (L[i] - R[i]) ** 2; }
  return { niveaux: out, rms_g_db: +(10 * Math.log10(dl / n + 1e-20)).toFixed(2), rms_d_db: +(10 * Math.log10(dr / n + 1e-20)).toFixed(2),
           rms_g_moins_d_db: +(10 * Math.log10(dd / n + 1e-20)).toFixed(2), premier_son_ms: tSon }; }"""


STATS_JS = """async () => { const out = [];
  for (const pc of (window.__qaPcs || [])) { if (pc.connectionState === 'closed') continue; const rep = await pc.getStats(); const codecs = {};
    rep.forEach(x => { if (x.type === 'codec') codecs[x.id] = x; });
    rep.forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'audio') { const c = codecs[x.codecId] || {};
      out.push({ octets: x.bytesReceived, ts: x.timestamp, codec: c.mimeType || null, canaux: c.channels ?? null, fmtp: c.sdpFmtpLine || null, piste: x.trackIdentifier }); } }); }
  return out; }"""


def run():
    res = {"name": "pont_protools", "run": RUN, "ok": True, "steps": [], "verifications": {}, "mesures": {},
           "note": "Serveur NOVA et Supabase Realtime SIMULÉS ; WebRTC réel ; pont réel (port 8791) ; aucune requête vers la production ; Pro Tools non ouvert."}

    def check(label, ok):
        res["verifications"][label] = bool(ok)
        print(("OK  " if ok else "KO  ") + label, flush=True)
        if not ok:
            res["ok"] = False

    pages = {}

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
            print(f"··  {label} ({time.time() - t:.1f} s)", flush=True)
            return o
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:600]}"})
            print(f"KO  {label} : {type(e).__name__}: {str(e)[:300]}", flush=True)
            for tag, pg in pages.items():
                try: shot(pg, f"ECHEC_{len(res['steps'])}_{tag}")
                except Exception: pass
            return None

    make_fakes()
    bridge_root = OUT / "pont_projets"
    shutil.rmtree(bridge_root, ignore_errors=True)
    bridge = start_bridge(bridge_root)
    try:
        with sync_playwright() as p:
            for sr in RATES:
                one_rate(p, sr, res, step, check, pages)
            if 48000 in RATES:
                verdicts(p, res, step, check)
    finally:
        try:
            bridge.kill(); bridge.wait(5)
        except Exception:
            pass
    (OUT / "resultat_pont_protools.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    good = sum(1 for v in res["verifications"].values() if v)
    print(f"\nBILAN {RUN} : {good} / {len(res['verifications'])} vérifications OK ; étapes en échec : {[s['step'] for s in res['steps'] if not s['ok']]}")
    return res


def one_rate(p, sr, res, step, check, pages):
    tag = f"{sr // 100 / 10:g}k".replace(".", ",")
    mes = res["mesures"].setdefault(str(sr), {})
    cloud, rt = FakeNovaCloud(per_device=True, codes=True, strict=True), FakeRealtime()
    folder = OUT / f"dossier_pro_tools_{sr}"
    shutil.rmtree(folder, ignore_errors=True)
    src = OUT / f"00_session_{sr}.novaproj.zip"
    project(src, sr)
    link = {}
    b = launch_with(p, FAKE / "stereo_440G_660D.wav")
    logs = {k: Log(f"pt_{sr}_{k}") for k in ("A", "E")}
    _, A = new_page(b, "pc", logs["A"])
    _, E = new_page(b, "pc", logs["E"])
    pages.clear(); pages.update({"A": A, "E": E})
    for pg in (A, E):
        pg.add_init_script(REC_INIT)
        pg.add_init_script(PCS_INIT)
        prepare(pg, None, desktop=False)
    # Max : Nova Studio simulé, son pont (vrai code) sur 8791.
    E.add_init_script(f"window.__novaDesktop = {{ version: 'qa', platform: 'windows', ui: 'qa', features: ['google-login', 'stems', 'reveal-download', 'pick-folder'], bridges: {{ asio: 0, vst: {PORT} }} }};"
                      f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{PORT}'); }} catch (e) {{}}")
    connect(A, cloud, rt, "A", LINA, "lina@test.local")
    connect(E, cloud, rt, "E", MAX, "max@test.local")
    for pg in (A, E):
        pg.goto(BASE, wait_until="domcontentloaded", timeout=180000)
        pg.get_by_text("Nouveau Projet").first.wait_for(timeout=180000)

    def a_start():
        open_project_file(A, src, res, f"A1_{tag}")
        dismiss(A); open_panel(A)
        A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
        A.get_by_role("button", name="Démarrer la collaboration en direct").click()
        wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez Lina")
        sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
        link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
    step(f"[{tag}] Lina ouvre la séance ({sr} Hz) et démarre « En direct »", a_start)

    def e_join():
        E.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
        wait_for(E, lambda: E.get_by_test_id("collab-arrival").count() > 0, 90, what="choix du rôle (Max)")
        E.wait_for_timeout(1500); dismiss(E)
        E.get_by_test_id("arrival-role-engineer").click()
        E.get_by_label("Ton nom", exact=True).fill("Max")
        E.get_by_test_id("arrival-join").click()
        wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="Max relié")
        dismiss(E)
        bridge = E.evaluate("async () => { const m = await window.__novaAppModule('/services/NovaBridge.ts'); await m.novaBridge.connect(); return { connecte: m.novaBridge.isConnected(), protools: m.novaBridge.proToolsFiles(), version: m.novaBridge.getState ? m.novaBridge.getState().version : null }; }")
        return {"pont_chez_max": bridge}
    o = step(f"[{tag}] Max (ingé, Nova Studio simulé) rejoint ; son pont répond", e_join)
    if o:
        check(f"[{tag}] le pont de Max (port {PORT}) annonce l'écriture des prises Pro Tools (v14)", bool(o["pont_chez_max"].get("protools")))

    def e_setup():
        open_panel(E)
        E.get_by_test_id("pt-panel").scroll_into_view_if_needed()
        E.get_by_test_id("pt-enabled").check()
        wait_for(E, lambda: E.get_by_test_id("pt-target").get_attribute("data-target") == "bridge", 20, step=200, what="cible : pont")
        E.get_by_test_id("pt-folder").fill(str(folder)); E.get_by_test_id("pt-folder").press("Enter")
        E.get_by_test_id("pt-start").fill(TC_START); E.get_by_test_id("pt-start").press("Enter")
        E.get_by_test_id("pt-format-24").click()
        wait_for(E, lambda: E.get_by_test_id("pt-folder-state").count() and "Accessible" in E.get_by_test_id("pt-folder-state").inner_text(), 20, step=200, what="dossier accessible")
        E.wait_for_timeout(300)
        shot(E, f"E1_{tag}_reglage_dossier_pro_tools")
        return {"etat_dossier": E.get_by_test_id("pt-folder-state").inner_text(), "cible": E.get_by_test_id("pt-target").inner_text(), "reglages": E.evaluate(SINK_JS)["reglages"]}
    o = step(f"[{tag}] Max active « Dossier Pro Tools » : dossier, départ 01:00:00:00, 24 bits", e_setup)
    if o:
        check(f"[{tag}] réglages enregistrés (dossier, départ de séance, format)", o["reglages"]["enabled"] and o["reglages"]["folder"] == str(folder)
              and o["reglages"]["sessionStart"] == TC_START and o["reglages"]["format"] == "24")
    close_panel(E)

    def take(at, secs, fmt):
        known = {t["id"] for t in E.evaluate(TAKES_JS)}
        if fmt == "32f":
            open_panel(E); E.get_by_test_id("pt-format-32f").click(); close_panel(E)
        close_panel(A); A.keyboard.press("Escape")
        seek(A, at); A.wait_for_timeout(300)
        rec_button(A).click(); A.wait_for_timeout(int(secs * 1000)); rec_button(A).click()
        # Prise posée chez Max (polling 50 ms), puis fichier dans le dossier.
        t0 = time.time(); new = None
        while time.time() - t0 < 60:
            cur = [t for t in E.evaluate(TAKES_JS) if t["id"] not in known]
            if cur:
                new = cur[-1]; break
            E.wait_for_timeout(50)
        assert new, "prise jamais arrivée chez Max"
        t_pose = time.time()
        name = f"Voix lead_Prise {new['takeNumber']}_Lina.wav"
        path = folder / name
        t_file = None
        while time.time() - t_pose < 15:
            if path.exists():
                t_file = time.time(); break
            time.sleep(0.02)
        assert t_file, f"fichier {name} absent après 15 s"
        E.wait_for_timeout(600)
        sink = E.evaluate(SINK_JS)
        entry = next((e for e in sink["entrees"] if e["clipId"] == new["id"]), None)
        region = E.evaluate(REGION_JS, new["id"])
        info = protools_files.read_bwf(path)
        exp_tr = 3600 * sr + round(new["start"] * sr)
        nova = floats(region["channels"])
        fs = file_samples(info)
        if fmt == "32f":
            same = len(fs) == len(nova) and all(np.array_equal(fs[c].view(np.uint32), nova[c].view(np.uint32)) for c in range(len(nova)))
            diff = None
        else:
            same = len(fs) == len(nova) and all(np.array_equal(fs[c].astype(np.int64), to_int24(nova[c])) for c in range(len(nova)))
            diff = None
        # Le son de Lina (prise d'origine, chez elle) : arrivé chez Max par la collaboration (WAV 16 bits).
        orig = A.evaluate(REGION_JS, new["id"])
        lina = floats(orig["channels"]) if isinstance(orig, dict) and orig.get("channels") else None
        if lina is not None and len(lina[0]) == len(nova[0]):
            diff = float(max(np.max(np.abs(lina[c].astype(np.float64) - nova[c].astype(np.float64))) for c in range(len(nova))))
        notif = E.locator("body").inner_text()
        open_panel(E)
        E.get_by_test_id("pt-entries").scroll_into_view_if_needed()
        ui = E.locator(f"[data-testid=pt-entry][data-file='{name}']").first
        ui_txt = ui.inner_text() if ui.count() else ""
        shot(E, f"E2_{tag}_{fmt}_prise_envoyee_vers_pro_tools")
        close_panel(E)
        return {
            "prise": new, "fichier": str(path), "delai_pose_fichier_s": round(t_file - t_pose, 3), "delai_interne_ms": entry and entry.get("ms"),
            "entree": entry, "bext": {k: info[k] for k in ("sample_rate", "channels", "bits", "float", "time_reference", "description", "originator", "bext_version", "coding_history", "frames")},
            "ixml": info["ixml"] or "", "timereference_attendu": exp_tr, "ecart_echantillons": info["time_reference"] - exp_tr,
            "position_nova_echantillons": round(new["start"] * sr), "position_nova_s": new["start"], "identique_au_bit_pres": same,
            "frequences": {"projet": region["projet_sr"], "contexte": region["contexte_sr"], "son": region["sr"]},
            "longueur_nova": region["len"], "longueur_fichier": info["frames"],
            "ecart_max_avec_la_prise_de_lina": diff, "ui": ui_txt[:300],
            "message_visible": "Prise envoyée vers Pro Tools" in notif,
        }

    for i, (at, secs, fmt) in enumerate(((3.217, 3.0, "24"), (9.1234, 2.5, "32f"))):
        o = step(f"[{tag}] Lina enregistre une prise ({fmt}) ; elle arrive chez Max et part vers Pro Tools", lambda: take(at, secs, fmt))
        mes[f"prise_{fmt}"] = o
        if not o:
            continue
        check(f"[{tag}] {fmt} : fichier BWF dans le dossier en ≤ 3 s après la pose chez Max ({o['delai_pose_fichier_s']} s ; interne {o['delai_interne_ms']} ms)", o["delai_pose_fichier_s"] <= 3.0)
        check(f"[{tag}] {fmt} : TimeReference = 01:00:00:00 + position NOVA, à l'échantillon près ({o['bext']['time_reference']} = {3600 * sr} + {o['position_nova_echantillons']} ; écart {o['ecart_echantillons']})", o["ecart_echantillons"] == 0)
        check(f"[{tag}] {fmt} : fréquence du fichier = projet = moteur ({o['frequences']})", o["bext"]["sample_rate"] == sr and o["frequences"]["projet"] == sr and o["frequences"]["contexte"] == sr)
        check(f"[{tag}] {fmt} : échantillons identiques au bit près au son de la prise chez Max ({o['longueur_fichier']} images)", o["identique_au_bit_pres"])
        check(f"[{tag}] {fmt} : format ({'32 bits flottants' if fmt == '32f' else '24 bits entiers'}) et iXML (SCENE, TAKE, horodatage)",
              o["bext"]["bits"] == (32 if fmt == "32f" else 24) and o["bext"]["float"] == (fmt == "32f") and "<SCENE>Voix lead</SCENE>" in o["ixml"]
              and f"<TAKE>{o['prise']['takeNumber']}</TAKE>" in o["ixml"]
              and f"<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>{o['bext']['time_reference'] % 2 ** 32}<" in o["ixml"])
        check(f"[{tag}] {fmt} : retour visuel chez Max (« Envoyée vers Pro Tools · Spot à … » + message)", "Envoyée vers Pro Tools" in o["ui"] and o["message_visible"])

    if sr == 48000:
        browser_paths(E, res, step, check, tag, mes)
        mix_from_input(A, E, res, step, check, tag, mes)
    for k, lg in logs.items():
        res.setdefault("erreurs_page", {})[f"{sr}_{k}"] = [x["text"][:200] for x in lg.errors()][:12]
        save_log(lg)
    b.close()


def browser_paths(E, res, step, check, tag, mes):
    """Sans pont : dossier choisi dans le navigateur (File System Access ; ici le dossier privé
    OPFS, même API que showDirectoryPicker), puis téléchargement."""
    def go():
        tk = E.evaluate(TAKES_JS)[0]
        js = """async ([clipId, mode]) => {
          const m = await window.__novaAppModule('/services/ProToolsBridge.ts');
          const st = window.__novaEdit.getState(); const t = st.tracks.find(x => x.id === 'voix'); const c = t.clips.find(k => k.id === clipId);
          const sink = new m.ProToolsSink({ ...m.browserDeps(), bridgeReady: async () => false, storage: null });
          sink.setSettings({ enabled: true, sessionStart: '01:00:00:00', format: '24' });
          let dir = null;
          if (mode === 'dossier') { const root = await navigator.storage.getDirectory(); dir = await root.getDirectoryHandle('Pro Tools QA', { create: true }); sink.setDir(dir); }
          sink.noteIncoming(m.takesBatchOf('voix', t.name, 'Lina', [c], st.name)); await sink.idle();
          const e = sink.entries[0]; let b64 = null;
          if (dir && e && e.status === 'ok') { const f = await (await dir.getFileHandle(e.file)).getFile(); const u = new Uint8Array(await f.arrayBuffer());
            let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); b64 = btoa(s); }
          return { entree: { ...e }, b64 }; }"""
        d = E.evaluate(js, [tk["id"], "dossier"])
        with E.expect_download(timeout=15000) as dl:
            t = E.evaluate(js, [tk["id"], "telechargement"])
        dpath = OUT / f"telechargement_{dl.value.suggested_filename}"
        dl.value.save_as(dpath)
        ref = protools_files.read_bwf(OUT / "dossier_pro_tools_48000" / f"Voix lead_Prise {tk['takeNumber']}_Lina.wav")
        fpath = OUT / "fsa_opfs.wav"
        fpath.write_bytes(base64.b64decode(d["b64"])) if d.get("b64") else None
        f_info = protools_files.read_bwf(fpath) if d.get("b64") else None
        t_info = protools_files.read_bwf(dpath)
        return {"dossier_navigateur": {"entree": d["entree"], "time_reference": f_info and f_info["time_reference"], "meme_audio_que_le_pont": bool(f_info) and f_info["data"] == ref["data"]},
                "telechargement": {"entree": t["entree"], "nom": dl.value.suggested_filename, "time_reference": t_info["time_reference"], "meme_audio_que_le_pont": t_info["data"] == ref["data"]},
                "time_reference_pont": ref["time_reference"]}
    o = step(f"[{tag}] navigateur sans pont : dossier File System Access, puis téléchargement", go)
    mes["chemins_navigateur"] = o
    if o:
        check(f"[{tag}] File System Access : même fichier (TimeReference {o['dossier_navigateur']['time_reference']}, audio identique) que celui du pont",
              o["dossier_navigateur"]["entree"]["target"] == "folder" and o["dossier_navigateur"]["time_reference"] == o["time_reference_pont"] and o["dossier_navigateur"]["meme_audio_que_le_pont"])
        check(f"[{tag}] téléchargement : « {o['telechargement']['nom']} », même TimeReference et même audio",
              o["telechargement"]["entree"]["target"] == "download" and o["telechargement"]["time_reference"] == o["time_reference_pont"] and o["telechargement"]["meme_audio_que_le_pont"])


def mix_from_input(A, E, res, step, check, tag, mes):
    def go():
        open_panel(E)
        E.get_by_test_id("pt-mix-source").scroll_into_view_if_needed()
        opts = E.eval_on_selector("[data-testid=pt-mix-source]", "s => [...s.options].map(o => ({ v: o.value, t: o.textContent }))")
        pick = next((o["v"] for o in opts if o["v"].startswith("in:") and "Fake" in o["t"] and "Default" not in o["t"]), None) or next(o["v"] for o in opts if o["v"].startswith("in:"))
        E.select_option("[data-testid=pt-mix-source]", pick)
        wait_for(E, lambda: E.get_by_test_id("pt-mix-verdict").count() and E.get_by_test_id("pt-mix-verdict").get_attribute("data-verdict") == "stereo", 20, step=200, what="entrée stéréo reconnue chez Max")
        lv = {s: E.get_by_test_id(f"pt-mix-level-{s}").inner_text() for s in ("G", "D")}
        verdict = E.get_by_test_id("pt-mix-verdict").inner_text()
        shot(E, f"E3_{tag}_source_entree_systeme")
        E.get_by_test_id("collab-mix-out").scroll_into_view_if_needed()
        E.get_by_test_id("collab-mix-out").click()
        E.wait_for_timeout(500)
        close_panel(E)
        open_panel(A)
        wait_for(A, lambda: A.get_by_test_id("collab-mix-listen").count() > 0, 30, step=100, what="« Écouter le mix de Max » chez Lina")
        A.get_by_test_id("collab-mix-listen").click()
        recu = A.evaluate(goertzel_js(), {"secs": 2, "freqs": [F_L, F_R]})
        s0 = A.evaluate(STATS_JS); A.wait_for_timeout(3000); s1 = A.evaluate(STATS_JS)
        mix = [x for x in s1 if x["codec"]]
        kbps = None
        if s0 and s1:
            by0 = {x["piste"]: x for x in s0}
            rates = [round((x["octets"] - by0[x["piste"]]["octets"]) * 8 / max(1, x["ts"] - by0[x["piste"]]["ts"]), 1) for x in s1 if x["piste"] in by0]
            kbps = max(rates) if rates else None
        try:
            wait_for(A, lambda: A.get_by_test_id("collab-mix-quality").count() > 0, 10, step=200, what="qualité affichée")
        except AssertionError:
            pass
        q = A.get_by_test_id("collab-mix-quality")
        qual = q.inner_text() if q.count() else None
        shot(A, f"A2_{tag}_lina_ecoute_mix_pro_tools")
        A.get_by_test_id("collab-mix-listen").click()
        close_panel(A)
        open_panel(E); E.get_by_test_id("collab-mix-out").click(); E.get_by_test_id("pt-mix-source").select_option("nova"); close_panel(E)
        return {"source": pick, "options": opts, "niveaux_chez_max": lv, "message_chez_max": verdict, "recu_chez_lina": recu, "debit_recu_kbps": kbps, "codecs_recus": mix, "qualite_affichee_chez_lina": qual}
    o = step(f"[{tag}] Max diffuse une ENTRÉE SYSTÈME (mix Pro Tools simulé : 440 Hz G / 660 Hz D) ; Lina l'écoute", go)
    mes["mix_entree_systeme"] = o
    if o and o["recu_chez_lina"] and "niveaux" in o["recu_chez_lina"]:
        n = o["recu_chez_lina"]["niveaux"]
        g = lambda f: n.get(str(f)) or n.get(f)  # noqa
        sep_l = round(g(F_L)["g"] - g(F_L)["d"], 1); sep_r = round(g(F_R)["d"] - g(F_R)["g"], 1)
        mes["separation_recue_db"] = {"440 Hz (G vs D)": sep_l, "660 Hz (D vs G)": sep_r}
        check(f"[{tag}] reçu chez Lina en STÉRÉO : G ≠ D (440 Hz : G − D = {sep_l} dB ; 660 Hz : D − G = {sep_r} dB ; ≥ 30 dB exigés)", sep_l >= 30 and sep_r >= 30)
        check(f"[{tag}] codec du mix reçu : Opus 2 canaux, stereo=1 ({[(c['codec'], c['canaux']) for c in o['codecs_recus']]})",
              any((c["codec"] or "").lower() == "audio/opus" and c["canaux"] == 2 and "stereo=1" in (c["fmtp"] or "") for c in o["codecs_recus"]))
        check(f"[{tag}] débit réel du mix ≥ 256 kb/s ({o['debit_recu_kbps']} kb/s)", (o["debit_recu_kbps"] or 0) >= 256)
        check(f"[{tag}] chez Max : niveaux G / D et message « Stéréo » ({o['niveaux_chez_max']} ; {o['message_chez_max'][:80]})", "Stéréo" in o["message_chez_max"])
        check(f"[{tag}] chez Lina : qualité affichée « stéréo » ({o['qualite_affichee_chez_lina']})", bool(o["qualite_affichee_chez_lina"]) and "stéréo" in o["qualite_affichee_chez_lina"])
    else:
        check(f"[{tag}] mix d'une entrée système reçu chez Lina", False)


def verdicts(p, res, step, check):
    """Entrée mono, entrée muette : diagnostic et message (faux micros à part)."""
    out = {}
    for name, fake, want in (("mono", "mono_440.wav", "mono"), ("muette", "muet.wav", "muette"), ("stéréo", "stereo_440G_660D.wav", "stereo")):
        def go():
            b = launch_with(p, FAKE / fake)
            try:
                _, pg = new_page(b, "pc", Log(f"pt_verdict_{name}"))
                prepare(pg, None, desktop=False)
                pg.goto(BASE, wait_until="domcontentloaded", timeout=180000)
                pg.get_by_text("Nouveau Projet").first.wait_for(timeout=180000)
                v = pg.evaluate("""async () => { const m = await window.__novaAppModule('/services/ProToolsBridge.ts'); const u = await window.__novaAppModule('/utils/proToolsBridge.ts');
                  const c = m.mixSource(); c.setSource('input', 'default'); await c.openInput(); await new Promise(r => setTimeout(r, 3000));
                  const v = c.view; const msg = u.inputVerdictMessage(v.verdict, v.label); c.closeInput(); c.setSource('nova');
                  return { verdict: v.verdict, canaux: v.channelCount, niveau_g: u.levelLabel(v.msL), niveau_d: u.levelLabel(v.msR), message: msg.text, alerte: msg.warn }; }""")
                return v
            finally:
                b.close()
        o = step(f"entrée système {name} : diagnostic", go)
        out[name] = o
        if o:
            check(f"entrée {name} → « {o['verdict']} » ({o['canaux']} canal/canaux ; G {o['niveau_g']}, D {o['niveau_d']}) : {o['message'][:90]}", o["verdict"] == want and o["alerte"] == (want != "stereo"))
    res["mesures"]["diagnostic_entrees"] = out


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
