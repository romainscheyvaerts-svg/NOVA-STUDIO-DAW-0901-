"""R14 / R15 · Enregistrement multipiste et mixes casque : scénario Chrome headless (aucune
fenêtre), avec le VRAI pont ASIO et une carte son SIMULÉE (qa/harness/pont_asio_simule.py :
aucun pilote ASIO n'est ouvert, ni celui du studio ni un autre).

A. Navigateur seul (micro simulé de Chrome, 2 canaux : 220 Hz à gauche, 330 Hz à droite,
   une impulsion par seconde sur les deux) : 2 pistes armées en même temps (entrées 1 et
   2), Maj+clic arme une piste seule, une 3e piste sur l'entrée 3 → message clair (le
   navigateur ne donne que 2 entrées) ; prise : chaque piste a SON signal, alignées.
B. Pont ASIO simulé (8 entrées / 8 sorties, 44,1 kHz) : latence mesurée par entrée (boucle
   sortie 1 → entrées, l'entrée 3 a 24 échantillons de plus), 4 pistes armées sur les
   entrées 1 à 4 (220 / 330 / 440 / 550 Hz) : chaque prise contient le bon signal et les
   impulsions communes tombent au même échantillon sur les 4 pistes.
C. Punch multipiste, Loop Record multipiste, comp groupé (un balayage sur une piste = les 3
   autres suivent), capture après coup multipiste.
D. Récupération après plantage d'une prise multipiste (onglet tué net pendant la prise).
E. Mixes casque : 2 mixes (artiste sur 3-4, ingé sur 5-6), sortie MESURÉE sur la carte
   simulée (niveaux par piste, pan, clic, voix en direct par le pont) ; tampon de la carte
   changé pour de vrai (flux recréé) ; carte à une seule paire de sorties → message clair.
F. Captures PC, tablette, téléphone.

Usage : NOVA_URL=http://127.0.0.1:3455/ PYTHONIOENCODING=utf-8 python qa/r14_r15_multipiste.py
Résultats : D:\\1 WORK\\CONTENU\\nova-r14-r15\\ (r14_r15.json + captures + projets enregistrés)
"""
import asyncio, io, json, math, os, re, shutil, subprocess, sys, tempfile, time, wave, zipfile
from pathlib import Path

import numpy as np
import psutil
import soundfile as sf

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3455/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r14-r15")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, OUT, CHROME, APP_MODULE_INIT, overflow_report  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PY = os.environ.get("NOVA_BRIDGE_PY", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe")
PORT = int(os.environ.get("QA_ASIO_PORT", "8796"))
SR = 44100
FREQS = [220.0, 330.0, 440.0, 550.0]
MICS = ["mic1", "mic2", "mic3", "mic4"]
res = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:600], flush=True)


def db(x):
    return 20 * math.log10(max(float(x), 1e-12))


# ─── fichiers de test ────────────────────────────────────────────────────────

def fake_wav_2ch(path):
    """Micro simulé de Chrome : 220 Hz à gauche, 330 Hz à droite, impulsion commune chaque seconde."""
    n = SR * 12
    k = np.arange(n)
    l = 0.2 * np.sin(2 * np.pi * 220 * k / SR)
    r = 0.2 * np.sin(2 * np.pi * 330 * k / SR)
    imp = (k % SR) == 0
    l[imp] += 0.7; r[imp] += 0.7
    x = np.stack([l, r], 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def make_project(path):
    def tr(tid, name, **kw):
        t = {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 1, "pan": 0, "outputTrackId": "master", "sends": [], "clips": [], "plugins": [],
             "automationLanes": [], "totalLatency": 0}
        t.update(kw)
        return t
    tracks = [tr(m, f"Micro {i + 1}", recordInput={"ch": i}, color=["#ef4444", "#f59e0b", "#22c55e", "#3b82f6"][i]) for i, m in enumerate(MICS)]
    tracks.append(tr("live", "Voix live", recordInput={"ch": 4}, color="#a855f7"))
    tracks.append(tr("master", "MASTER BUS", type="BUS", outputTrackId=""))
    state = {"id": "qa-r14r15", "name": "Session multipiste", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 1, "loopEnd": 3,
             "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "mic1", "currentView": "ARRANGEMENT",
             "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None,
             "isDelayCompEnabled": True, "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


# ─── pont simulé ─────────────────────────────────────────────────────────────

def start_bridge(outs=8):
    env = dict(os.environ, NOVA_ASIO_PORT=str(PORT), QA_OUTS=str(outs), PYTHONIOENCODING="utf-8")
    log = open(OUT / f"pont_simule_{outs}sorties.log", "w", encoding="utf-8")
    pr = subprocess.Popen([BRIDGE_PY, str(ROOT / "qa" / "harness" / "pont_asio_simule.py")], env=env, stdout=log, stderr=subprocess.STDOUT,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(80):
        time.sleep(0.25)
        if any(c.laddr.port == PORT and c.status == "LISTEN" for c in psutil.net_connections("tcp")):
            return pr
    raise RuntimeError("pont simulé non démarré")


def stop_bridge(pr):
    try:
        pr.kill(); pr.wait(5)
    except Exception:
        pass


BRIDGE_CALL = r"""
import asyncio, json, sys, time, websockets
msg, want, port, timeout = json.loads(sys.argv[1]), sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
async def go():
    async with websockets.connect(f"ws://127.0.0.1:{port}", max_size=None) as ws:
        await ws.send(json.dumps(msg))
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = await asyncio.wait_for(ws.recv(), timeout)
            if isinstance(m, str) and json.loads(m).get("action") == want:
                return json.loads(m)
print(json.dumps(asyncio.run(go())))
"""


def bridge_call(msg, want, timeout=15):
    """Message au pont simulé (client websockets du Python du pont, sans fenêtre)."""
    r = subprocess.run([BRIDGE_PY, "-c", BRIDGE_CALL, json.dumps(msg), want, str(PORT), str(timeout)], capture_output=True, text=True,
                       timeout=timeout + 20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}


def dump_outputs(seconds):
    path = OUT / f"sorties_{int(time.time() * 1000)}.npy"
    bridge_call({"action": "QA_DUMP", "path": str(path), "seconds": seconds}, "QA_DUMPED")
    return np.load(path)


def tone_db(x, f, sr=SR, seg=4096, agg="median"):
    """Niveau (dB crête) de la raie f : médiane sur des tranches de 93 ms (fenêtre de Hann, projection
    sur la fréquence exacte) — insensible aux rares sauts de phase du transport réseau."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) < seg:
        return -120.0
    w = np.hanning(seg)
    e = np.exp(-2j * np.pi * f * np.arange(seg) / sr)
    amps = [2 * abs(np.sum(x[i:i + seg] * w * e)) / w.sum() for i in range(0, len(x) - seg + 1, seg // 2)]
    return db(float(np.median(amps) if agg == "median" else np.max(amps)))


# ─── navigateur ──────────────────────────────────────────────────────────────

INIT = """
try {
  localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0');
  localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_asio_port', '%d'); localStorage.setItem('nova_auto_clean', '0');
} catch (e) {}
""" % PORT


def launch(p, profile, fake_wav):
    ctx = p.chromium.launch_persistent_context(
        str(profile), headless=True, executable_path=CHROME, viewport={"width": 1600, "height": 900}, locale="fr-BE",
        permissions=["microphone"],
        args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={fake_wav}",
              "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
    ctx.add_init_script(INIT)
    ctx.add_init_script(APP_MODULE_INIT)

    def guard(route, request):
        if request.method in ("POST", "PATCH", "PUT", "DELETE") and not request.url.startswith(BASE.rstrip("/")):
            return route.abort()
        return route.continue_()
    ctx.route("**/*", guard)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.set_default_timeout(20000)
    return ctx, page


def open_project(page, f):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    for _ in range(60):
        page.wait_for_timeout(500)
        if page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'mic4'))"):
            break
    page.wait_for_timeout(1500)


ENGINE = "(await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine"


def arm(page, ids, on=True):
    page.evaluate("""([ids, on]) => { for (const id of ids) { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === id); window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: on }); } }""", [ids, on])
    page.wait_for_timeout(2500)


def armed_state(page):
    return page.evaluate(f"""async () => {{ const e = {ENGINE}; return {{ ui: window.DAW_CONTROL.getState().tracks.filter(t => t.isTrackArmed).map(t => t.id), engine: e.armedIds(), info: e.getInputInfo() }}; }}""")


def record(page, seconds, start=0.0):
    page.evaluate("(t) => window.DAW_CONTROL.seek(t)", start)
    page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(100):
        if page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
            break
        page.wait_for_timeout(50)
    page.wait_for_timeout(int(seconds * 1000))
    if page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
        page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(100):
        if not page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
            break
        page.wait_for_timeout(100)
    page.wait_for_timeout(1500)


def save_zip(page, label):
    """Enregistrement local du projet (Ctrl+S → cet appareil) et lecture du .zip : clips + audio des prises."""
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    path = OUT / f"projet_{label}.zip"
    dl.value.save_as(str(path))
    page.wait_for_timeout(500)
    page.keyboard.press("Escape")
    z = zipfile.ZipFile(path)
    return json.loads(z.read("project.json")), z


def read_take(z, clip):
    a, srr = sf.read(io.BytesIO(z.read(clip["audioRef"])), dtype="float64", always_2d=True)
    return a, srr


def impulses(x, thr=0.5):
    """Positions (échantillons) des impulsions : pics au-dessus du seuil, espacés d'au moins 0,5 s."""
    out = []
    a = np.abs(x)
    i = 0
    while i < len(a):
        if a[i] > thr:
            j = min(len(a), i + 64)
            k = i + int(np.argmax(a[i:j]))
            out.append(k)
            i = k + SR // 2
        else:
            i += 1
    return out


def dominant(x):
    w = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * w))
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    spec[fr < 50] = 0
    return float(fr[int(np.argmax(spec))])


def last_take(track):
    takes = [c for c in track["clips"] if c.get("takeNumber") and not c.get("isMuted")]
    return max(takes, key=lambda c: c["takeNumber"]) if takes else None


def meta_of(track, n):
    return next((m for m in track.get("takeMeta") or [] if m["n"] == n), {})


def analyse_pass(proj, z, ids, label):
    """Prises du dernier passage sur `ids` : signal de chaque piste, alignement des impulsions."""
    tracks = {t["id"]: t for t in proj["tracks"]}
    out = {}
    for i, tid in enumerate(ids):
        c = last_take(tracks[tid])
        if not c:
            out[tid] = None
            continue
        a, srr = read_take(z, c)
        mono = a[:, 0]
        seg = mono[int(0.2 * srr): int(0.2 * srr) + int(1.5 * srr)] if len(mono) > 2 * srr else mono
        imp = impulses(mono)
        # Temps sur la ligne de temps du morceau : début du clip + position dans le son − offset.
        times = [c["start"] + k / srr - (c.get("offset") or 0) for k in imp]
        out[tid] = {"clip": c["id"], "start": c["start"], "duration": round(c["duration"], 4), "n": c["takeNumber"], "group": meta_of(tracks[tid], c["takeNumber"]).get("group"),
                    "dominant_hz": round(dominant(seg), 1), "impulsions_s": [round(t, 6) for t in times], "canaux": a.shape[1]}
    ref = next((v for v in out.values() if v and v["impulsions_s"]), None)
    worst = 0.0
    if ref:
        for v in out.values():
            if not v or not v["impulsions_s"]:
                continue
            for t in ref["impulsions_s"]:
                d = min((abs(t - u) for u in v["impulsions_s"]), default=1)
                if d < 0.25:
                    worst = max(worst, d)
    res["mesures"][label] = out
    return out, worst * SR


# ─── scénario ────────────────────────────────────────────────────────────────

def main():
    fake = OUT / "micro_simule_2canaux.wav"
    fake_wav_2ch(fake)
    proj_path = OUT / "session_multipiste.zip"
    make_project(proj_path)
    profile = Path(tempfile.mkdtemp(prefix="nova-r14r15-"))
    bridge = None
    errs = []
    with sync_playwright() as p:
        ctx, page = launch(p, profile, fake)
        page.on("pageerror", lambda e: errs.append(str(e)[:300]))
        try:
            open_project(page, proj_path)
            run(p, ctx, page, profile, fake, proj_path, errs)
        except Exception as e:  # noqa
            res["exception"] = f"{type(e).__name__}: {str(e)[:600]}"
            print("EXCEPTION", res["exception"], flush=True)
            try:
                for pg in ctx.pages:
                    pg.screenshot(path=str(OUT / "ECHEC.png"))
            except Exception:
                pass
        finally:
            res["erreurs_page"] = errs[:20]
            try: ctx.close()
            except Exception: pass
            shutil.rmtree(profile, ignore_errors=True)
    total = len(res["etapes"]); good = sum(1 for v in res["etapes"].values() if v["ok"])
    res["bilan"] = f"{good} / {total} OK"
    (OUT / "r14_r15.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nBILAN :", res["bilan"])


def run(p, ctx, page, profile, fake, proj_path, errs):
    # ── A. Navigateur seul : 2 entrées ──────────────────────────────────────
    arm(page, ["mic1", "mic2"])
    st = armed_state(page)
    ok("A · deux pistes armées en même temps (armer n'en désarme plus d'autre)", set(st["ui"]) == {"mic1", "mic2"} and set(st["engine"]) == {"mic1", "mic2"}, st)
    page.screenshot(path=str(OUT / "A1_deux_pistes_armees_pc.png"))
    # Maj+clic sur Micro 3 : armée seule.
    page.get_by_role("button", name="Armer l'enregistrement : Micro 3").first.click(modifiers=["Shift"])
    page.wait_for_timeout(2500)
    st3 = armed_state(page)
    note = page.evaluate("() => document.body.innerText.match(/navigateur ne donne que[^\\n]*/)?.[0] || null")
    ok("A · Maj+clic arme la piste seule (comme Pro Tools)", st3["ui"] == ["mic3"] and st3["engine"] == ["mic3"], st3["ui"])
    ok("A · entrée 3 demandée au navigateur (2 entrées) : message clair", bool(note) and "Nova Studio" in (note or ""), note)
    page.screenshot(path=str(OUT / "A2_entree_absente_message_pc.png"))
    arm(page, ["mic3"], False)
    arm(page, ["mic1", "mic2"])
    record(page, 4.0, 0.0)
    proj, z = save_zip(page, "A_navigateur_2_pistes")
    a, worst = analyse_pass(proj, z, ["mic1", "mic2"], "A_navigateur")
    ok("A · chaque piste a SON signal (entrée 1 = 220 Hz, entrée 2 = 330 Hz)",
       a["mic1"] and a["mic2"] and abs(a["mic1"]["dominant_hz"] - 220) < 6 and abs(a["mic2"]["dominant_hz"] - 330) < 6,
       {k: v and v["dominant_hz"] for k, v in a.items()})
    ok("A · prises alignées à l'échantillon entre les pistes (impulsions communes)", a["mic1"] and len(a["mic1"]["impulsions_s"]) >= 2 and worst < 0.5,
       {"ecart_max_echantillons": round(worst, 3), "impulsions": {k: v and v["impulsions_s"][:4] for k, v in a.items()}})
    ok("A · prises du même passage groupées (take group commun)", a["mic1"] and a["mic1"]["group"] and a["mic1"]["group"] == a["mic2"]["group"],
       {k: v and v["group"] for k, v in a.items()})
    arm(page, ["mic1", "mic2"], False)

    # ── B. Pont ASIO simulé : 4 entrées ─────────────────────────────────────
    global_bridge = start_bridge(8)
    res["pont"] = "démarré"
    try:
        run_bridge(p, ctx, page, profile, fake, proj_path, errs)
    finally:
        stop_bridge(global_bridge)


def run_bridge(p, ctx, page, profile, fake, proj_path, errs):
    page.evaluate(f"async () => {{ const e = {ENGINE}; await e.connectASIO(); await new Promise(r => setTimeout(r, 800)); await e.startASIOStream(); }}")
    for _ in range(60):
        if page.evaluate(f"async () => {ENGINE}.isASIOStreamActive()"):
            break
        page.wait_for_timeout(250)
    info = page.evaluate(f"async () => {ENGINE}.getASIOStreamInfo()")
    ok("B · pont connecté (protocole v2) : 8 entrées / 8 sorties de la carte ouvertes", info["active"] and info["protocol"] == 2 and info["inputs"] == 8 and info["outputs"] == 8, info)
    lat = page.evaluate(f"async () => {ENGINE}.measureInputLatencies([0])")
    offs = lat.get("offsetsMs") or {}
    ok("B · latence mesurée par entrée (boucle) : l'entrée 3 a 24 échantillons de plus (≈ 0,544 ms)",
       lat.get("success") and lat["delays"][:4] == [384, 384, 408, 384] and abs((offs.get("2", 0) - offs.get("0", 0)) - 24 / 44.1) < 0.002,
       {"retards": lat.get("delays"), "retard_propre_ms": offs})
    arm(page, MICS)
    st = armed_state(page)
    ok("B · 4 pistes armées, chacune sur son entrée de la carte (1, 2, 3, 4)",
       sorted(st["engine"]) == sorted(MICS) and st["info"]["mode"] == "asio" and sorted(tuple(a["channels"]) for a in st["info"]["armed"]) == [(0,), (1,), (2,), (3,)],
       st["info"])
    page.screenshot(path=str(OUT / "B1_quatre_pistes_armees_vumetres_pc.png"))
    record(page, 5.0, 0.0)
    proj, z = save_zip(page, "B_pont_4_pistes")
    b, worst = analyse_pass(proj, z, MICS, "B_pont_4_pistes")
    ok("B · chaque prise contient le bon signal (220 / 330 / 440 / 550 Hz)",
       all(b[m] and abs(b[m]["dominant_hz"] - f) < 6 for m, f in zip(MICS, FREQS)), {m: b[m] and b[m]["dominant_hz"] for m in MICS})
    ok("B · les 4 prises alignées à l'échantillon (impulsions communes, entrée 3 compensée de ses 24 échantillons)",
       all(b[m] and len(b[m]["impulsions_s"]) >= 3 for m in MICS) and worst < 0.5,
       {"ecart_max_echantillons": round(worst, 3), "impulsions_s": {m: b[m] and b[m]["impulsions_s"][:3] for m in MICS}})
    gaps = [round((v[1] - v[0]) * SR, 2) for m in MICS if b[m] for v in zip(b[m]["impulsions_s"], b[m]["impulsions_s"][1:])]
    ok("B · aucune dérive dans la prise : impulsions espacées d'exactement 1 s (±1 échantillon)", gaps and all(abs(g - SR) <= 1 for g in gaps),
       {"ecarts_echantillons": gaps[:8]})
    ok("B · un seul groupe de prises pour les 4 pistes", len({b[m] and b[m]["group"] for m in MICS}) == 1 and b["mic1"]["group"], {m: b[m] and b[m]["group"] for m in MICS})
    res["etat_B"] = {"stream": page.evaluate(f"async () => {ENGINE}.getASIOStreamInfo()")}

    run_multi_tools(p, ctx, page, profile, fake, proj_path, errs)


COMP_JS = """async (ids) => {
  const cm = await window.__novaAppModule('/utils/comping.ts');
  const s = window.DAW_CONTROL.getState();
  const out = {};
  for (const id of ids) {
    const t = s.tracks.find(x => x.id === id);
    const meta = new Map((t.takeMeta || []).map(m => [m.n, m.group || null]));
    out[id] = cm.readComp(t.clips).map(g => ({ start: Math.round(g.start * 1000) / 1000, end: Math.round(g.end * 1000) / 1000, n: g.n, group: meta.get(g.n) || null }));
  }
  return out;
}"""


def groups_at(comp, t):
    """Groupe de la prise entendue à l'instant t sur chaque piste."""
    return {k: next((g["group"] for g in v if g["start"] <= t < g["end"]), None) for k, v in comp.items()}


def run_multi_tools(p, ctx, page, profile, fake, proj_path, errs):
    # ── C1. Punch multipiste : zone 2,0 → 3,0 s, pré-roll et post-roll d'une demi-mesure ──
    page.evaluate("() => window.DAW_CONTROL.setPunch({ enabled: true, punchIn: 2.0, punchOut: 3.0, preRollBars: 0.5, postRollBars: 0.5 })")
    page.wait_for_timeout(500)
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(200):          # arrêt tout seul à la fin du post-roll
        page.wait_for_timeout(100)
        if not page.evaluate("() => window.DAW_CONTROL.getState().isRecording") and _ > 10:
            break
    page.wait_for_timeout(2000)
    page.screenshot(path=str(OUT / "C1_punch_multipiste_pc.png"))
    proj, z = save_zip(page, "C1_punch")
    tracks = {t["id"]: t for t in proj["tracks"]}
    pun = {}
    for m, f in zip(MICS, FREQS):
        c = last_take(tracks[m])
        a, srr = read_take(z, c)
        olds = [x for x in tracks[m]["clips"] if not x.get("isMuted") and x.get("takeNumber") and x["takeNumber"] < c["takeNumber"]]
        pun[m] = {"debut": round(c["start"], 4), "fin": round(c["start"] + c["duration"], 4), "hz": round(dominant(a[:, 0]), 1), "groupe": meta_of(tracks[m], c["takeNumber"]).get("group"),
                  "ancienne_prise_gardee": sorted([(round(x["start"], 3), round(x["start"] + x["duration"], 3)) for x in olds])}
    ok("C · punch multipiste : chaque piste remplace SEULEMENT 2,0 → 3,0 s (crossfades de 5 ms), avec son signal, prises groupées",
       all(abs(pun[m]["debut"] - 1.995) < 0.002 and abs(pun[m]["fin"] - 3.005) < 0.002 and abs(pun[m]["hz"] - f) < 8 for m, f in zip(MICS, FREQS))
       and len({pun[m]["groupe"] for m in MICS}) == 1 and pun["mic1"]["groupe"]
       and all(any(abs(e - 2.005) < 0.002 for s0, e in pun[m]["ancienne_prise_gardee"]) and any(abs(s0 - 2.995) < 0.002 for s0, e in pun[m]["ancienne_prise_gardee"]) for m in MICS),
       pun)
    page.evaluate("() => window.DAW_CONTROL.setPunch({ enabled: false })")
    page.wait_for_timeout(400)

    # ── C2. Loop Record multipiste : boucle 1,0 → 3,0 s, un peu plus de 2 tours ──
    page.evaluate("() => window.DAW_CONTROL.setLoop(true, 1.0, 3.0)")
    page.wait_for_timeout(500)
    record(page, 4.6, 1.0)
    page.evaluate("() => window.DAW_CONTROL.setLoop(false, 1.0, 3.0)")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "C2_loop_record_multipiste_couloirs_pc.png"))
    st = page.evaluate("() => window.DAW_CONTROL.getState().tracks.filter(t => t.id.startsWith('mic')).map(t => ({ id: t.id, meta: (t.takeMeta || []).filter(m => m.loopPass).map(m => ({ n: m.n, pass: m.loopPass, group: m.group })) }))")
    loops = {t["id"]: t["meta"] for t in st}
    passes = {m: sorted({x["pass"] for x in loops[m]}) for m in MICS}
    grp_by_pass = {pp: {next((x["group"] for x in loops[m] if x["pass"] == pp), None) for m in MICS} for pp in passes["mic1"]}
    ok("C · Loop Record multipiste : un couloir par tour sur chaque piste, un groupe par tour commun aux 4 pistes",
       all(len(passes[m]) >= 2 and passes[m] == passes["mic1"] for m in MICS) and all(len(g) == 1 and None not in g for g in grp_by_pass.values())
       and len(set().union(*grp_by_pass.values())) == len(grp_by_pass),
       {"tours": passes, "groupes_par_tour": {k: sorted(v) for k, v in grp_by_pass.items()}})

    # ── C3. Comp groupé : on garde le tour 1 entre 1,5 et 2,0 s sur Micro 1 → les 3 autres suivent ──
    before = page.evaluate(COMP_JS, MICS)
    n1 = next(x["n"] for x in loops["mic1"] if x["pass"] == 1)
    g1 = next(x["group"] for x in loops["mic1"] if x["pass"] == 1)
    page.evaluate("([n]) => window.DAW_CONTROL.compTake('mic1', n, 1.5, 2.0)", [n1])
    page.wait_for_timeout(1200)
    after = page.evaluate(COMP_JS, MICS)
    at_in, at_out = groups_at(after, 1.75), groups_at(after, 2.6)
    note = page.evaluate("() => document.body.innerText.match(/gardée de[^\\n]*/)?.[0] || null")
    ok("C · comp groupé : garder un passage du tour 1 sur Micro 1 le garde aussi sur Micro 2, 3 et 4 (même tour, même zone)",
       all(v == g1 for v in at_in.values()) and all(v and v != g1 for v in at_out.values()) and groups_at(before, 1.75)["mic2"] != g1,
       {"a_1_75s": at_in, "a_2_6s": at_out, "avant_a_1_75s": groups_at(before, 1.75), "notification": note})
    # Suspendre les groupes : le comp ne touche que la piste.
    page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()"); page.keyboard.press("Control+Shift+G")
    page.wait_for_timeout(600)
    susp = page.evaluate("() => !!window.DAW_CONTROL.getState().groupSettings?.suspended")
    n2 = next(x["n"] for x in loops["mic1"] if x["pass"] == 2)
    if susp:
        page.evaluate("([n]) => window.DAW_CONTROL.compTake('mic1', n, 1.5, 2.0)", [n2])
        page.wait_for_timeout(1000)
        solo = page.evaluate(COMP_JS, MICS)
        ok("C · groupes suspendus (Ctrl+Maj+G) : le comp ne touche que la piste", groups_at(solo, 1.75)["mic1"] != g1 and all(groups_at(solo, 1.75)[m] == g1 for m in MICS[1:]),
           groups_at(solo, 1.75))
        page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()"); page.keyboard.press("Control+Shift+G")
        page.wait_for_timeout(600)
    else:
        res["groupes_suspendus"] = "raccourci non reçu (non bloquant)"

    # ── C4. Capture après coup multipiste : lecture 0,5 → 2,8 s sans REC, puis « Capturer » ──
    page.evaluate("() => window.DAW_CONTROL.seek(0.5)"); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(2300)
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(600)
    page.evaluate("() => window.DAW_CONTROL.captureLastTake()"); page.wait_for_timeout(2500)
    proj, z = save_zip(page, "C4_capture")
    cap, worst = analyse_pass(proj, z, MICS, "C4_capture")
    ok("C · capture après coup multipiste : 4 prises captées, chacune son signal, alignées et groupées",
       all(cap[m] and abs(cap[m]["dominant_hz"] - f) < 8 for m, f in zip(MICS, FREQS)) and worst < 0.5 and len({cap[m]["group"] for m in MICS}) == 1 and cap["mic1"]["group"],
       {"hz": {m: cap[m] and cap[m]["dominant_hz"] for m in MICS}, "ecart_max_echantillons": round(worst, 3), "groupes": {m: cap[m] and cap[m]["group"] for m in MICS},
        "durees": {m: cap[m] and cap[m]["duration"] for m in MICS}})

    page = run_crash(p, ctx, page, profile, fake, proj_path, errs)
    run_cues(p, ctx, page, profile, fake, proj_path, errs)


def run_crash(p, ctx, page, profile, fake, proj_path, errs):
    """D · Prise multipiste interrompue net (onglet tué) puis « Récupérer la session »."""
    vers = "async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().listVersions()).length; }"
    t0 = time.time()
    while time.time() - t0 < 40 and not page.evaluate(vers):
        page.wait_for_timeout(1000)
    page.evaluate("() => window.DAW_CONTROL.seek(0)"); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(100):
        if page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
            break
        page.wait_for_timeout(50)
    rec_start = time.time()
    page.wait_for_timeout(4000)
    page.screenshot(path=str(OUT / "D1_prise_multipiste_avant_plantage_pc.png"))
    key = str(profile).lower()
    main_pr, kids = None, []
    for pr in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = pr.info["cmdline"] or []
            if "chrome" in (pr.info["name"] or "").lower() and key in " ".join(cmd).lower() and not any(x.startswith("--type=") for x in cmd):
                main_pr, kids = pr, pr.children(recursive=True)
                break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    renderers = [k for k in kids if any(a.startswith("--type=renderer") for a in (k.cmdline() or []))]
    kill_t = time.time()
    for r in renderers:
        try: r.kill()
        except Exception: pass
    res["plantage"] = {"processus_rendu_tues": len(renderers), "prise_avant_mise_a_mort_s": round(kill_t - rec_start, 2)}
    time.sleep(2)
    page = ctx.new_page()
    page.set_default_timeout(20000)
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    page.goto(BASE, wait_until="domcontentloaded")
    dlg = page.get_by_test_id("crash-recovery")
    dlg.wait_for(timeout=40000)
    page.wait_for_timeout(600)
    pend = page.evaluate("async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().pendingTakes()).map(t => ({ track: t.trackId, group: t.group || null, samples: t.samples, sr: t.sampleRate })); }")
    page.screenshot(path=str(OUT / "D2_proposition_recuperation_pc.png"))
    page.get_by_role("button", name="Récupérer la session").click()
    for _ in range(80):
        page.wait_for_timeout(500)
        n = page.evaluate("() => window.DAW_CONTROL ? window.DAW_CONTROL.getState().tracks.filter(t => t.clips.some(c => /récupérée/.test(c.name || ''))).length : 0")
        if n >= 4:
            break
    page.wait_for_timeout(2500)
    page.screenshot(path=str(OUT / "D3_session_recuperee_pc.png"))
    proj, z = save_zip(page, "D_recuperee")
    tracks = {t["id"]: t for t in proj["tracks"]}
    rec = {}
    for m, f in zip(MICS, FREQS):
        cs = [c for c in tracks[m]["clips"] if "récupérée" in (c.get("name") or "")]
        if not cs:
            rec[m] = None
            continue
        c = cs[-1]
        a, srr = read_take(z, c)
        imp = impulses(a[:, 0])
        rec[m] = {"duree": round(c["duration"], 2), "hz": round(dominant(a[: min(len(a), 2 * SR), 0]), 1), "impulsions_s": [round(c["start"] + k / srr - (c.get("offset") or 0), 6) for k in imp][:4], "debut": round(c["start"], 4), "offset": round(c.get("offset") or 0, 4)}
    groups = {x["group"] for x in pend if x["track"] in MICS}
    ref = rec.get("mic1") and rec["mic1"]["impulsions_s"]
    worst = 0.0
    if ref:
        for m in MICS:
            for t in (rec[m] or {}).get("impulsions_s", []):
                worst = max(worst, min(abs(t - u) for u in ref))
    ok("D · plantage pendant une prise multipiste : les 4 pistes récupérées (journal par piste, même groupe), chacune son signal, alignées",
       all(rec[m] for m in MICS) and all(abs(rec[m]["hz"] - f) < 8 for m, f in zip(MICS, FREQS)) and len(groups) == 1 and None not in groups
       and all(rec[m]["duree"] > res["plantage"]["prise_avant_mise_a_mort_s"] - 1.0 for m in MICS) and worst * SR < 0.5,
       {"journal": pend, "recuperees": rec, "ecart_max_echantillons": round(worst * SR, 3), **res["plantage"]})
    return page


def connect_bridge(page):
    page.evaluate(f"async () => {{ const e = {ENGINE}; await e.connectASIO(); await new Promise(r => setTimeout(r, 800)); await e.startASIOStream(); }}")
    for _ in range(80):
        if page.evaluate(f"async () => {ENGINE}.isASIOStreamActive()"):
            return True
        page.wait_for_timeout(250)
    return False


def hf_rms(x, sr=SR, f0=900):
    """Énergie au-dessus de f0 (le clic ; les sinus des pistes sont tous sous 700 Hz)."""
    spec = np.fft.rfft(x * np.hanning(len(x)))
    fr = np.fft.rfftfreq(len(x), 1 / sr)
    spec[fr < f0] = 0
    y = np.fft.irfft(spec, len(x))
    return db(np.sqrt(np.mean(y ** 2)))


def run_cues(p, ctx, page, profile, fake, proj_path, errs):
    """E · Mixes casque mesurés en sortie de la carte simulée, tampon réel, carte à une paire."""
    ok("E · pont reconnecté après la récupération", connect_bridge(page))
    arm(page, ["mic1", "mic2", "mic3", "mic4", "live"], False)
    # Les prises récupérées (D) s'ajoutent sans couper les autres : on les coupe, puis une prise neuve
    # des 4 micros (0 → 4 s) donne un mix net à mesurer (un sinus par piste, à 0,2).
    page.evaluate("""() => { for (const t of window.DAW_CONTROL.getState().tracks.filter(x => x.id.startsWith('mic')))
      window.DAW_CONTROL.updateTrack({ ...t, clips: t.clips.map(c => /récupérée/.test(c.name || '') ? { ...c, isMuted: true } : c) }); }""")
    page.wait_for_timeout(1000)
    arm(page, MICS)
    record(page, 4.0, 0.0)
    arm(page, MICS, False)
    # Fenêtre « Mixes casque » : création des deux mixes depuis l'interface.
    page.evaluate("() => window.dispatchEvent(new Event('nova:open-cue-mixes'))")
    page.get_by_test_id("cue-panel").wait_for(timeout=15000)
    page.screenshot(path=str(OUT / "E1_mixes_casque_vide_pc.png"))
    page.get_by_test_id("cue-create-default").click(); page.wait_for_timeout(800)
    mixes = page.evaluate("() => window.DAW_CONTROL.getState().cueMixes")
    ok("E · deux mixes créés : « Casque artiste » sur 3-4, « Casque ingé » sur 5-6",
       [(m["name"], m["pair"]) for m in mixes] == [("Casque artiste", 1), ("Casque ingé", 2)], [(m["name"], m["pair"]) for m in mixes])
    # Réglages (niveau et pan par piste, clic) : Micro 2 baissé de 12 dB au curseur de l'interface.
    art, ing = mixes
    page.evaluate("""([id]) => { const el = document.querySelector(`[data-testid="cue-level-${id}-mic2"]`);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '-12');
      el.dispatchEvent(new Event('input', { bubbles: true })); }""", [art["id"]])
    page.wait_for_timeout(500)
    lv2 = page.evaluate("() => window.DAW_CONTROL.getState().cueMixes[0].levels.mic2")
    ok("E · curseur de niveau du mix : Micro 2 à −12 dB dans le casque de l'artiste", lv2 and abs(db(lv2["level"]) + 12) < 0.05, lv2)
    page.evaluate("""([a, b]) => {
      const s = window.DAW_CONTROL.getState(); const m = s.cueMixes.map(x => ({ ...x, levels: { ...x.levels } }));
      m[0].levels = { ...m[0].levels, mic1: { level: 1, pan: 0 }, mic3: { level: 1, pan: 0, muted: true }, mic4: { level: 1, pan: 0, muted: true }, live: { level: 0.5, pan: 0 } };
      m[0].click = 1;
      m[1].levels = { mic1: { level: 1, pan: 0, muted: true }, mic2: { level: 1, pan: 0, muted: true }, mic3: { level: 1, pan: 0 }, mic4: { level: 0.5, pan: 1 }, live: { level: 1, pan: 0, muted: true } };
      m[1].click = 0;
      window.DAW_CONTROL.setCueMixes(m); }""", [art["id"], ing["id"]])
    page.wait_for_timeout(800)
    # Fenêtre refermée le temps de la mesure ; clic allumé (bouton Métronome de la barre de transport).
    page.evaluate("() => { const b = document.querySelector('[aria-label=\"Fermer les mixes casque\"]'); if (b) b.click(); }")
    page.wait_for_timeout(400)
    mbtn = page.get_by_role("button", name="Métronome", exact=True).locator("visible=true")
    if mbtn.count() and mbtn.first.get_attribute("aria-pressed") != "true":
        mbtn.first.click(); page.wait_for_timeout(400)
    # Lecture depuis 0,4 s (les prises jouent), mesure de 1,5 s en sortie de la carte.
    page.evaluate("() => window.DAW_CONTROL.seek(0.4)"); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(2200)
    out = dump_outputs(1.5)
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(500)
    lv = {pair: {f: round(tone_db(out[:, ch], f), 1) for f in FREQS} for pair, ch in (("1-2 G", 0), ("3-4 G", 2), ("5-6 G", 4), ("5-6 D", 5))}
    # Clic du métronome (son « CLICK » : 1000 Hz, 1500 Hz accentué) ; les impulsions des prises n'y pèsent rien.
    clicks = {k: round(max(tone_db(out[:, ch], 1000, agg="max"), tone_db(out[:, ch], 1500, agg="max")), 1) for k, ch in (("3-4", 2), ("5-6", 4))}
    res["mesures"]["mixes_casque"] = {"raies_dB": lv, "clic_dB": clicks}
    a = lv["3-4 G"]; i = lv["5-6 G"]; d = lv["5-6 D"]; m0 = lv["1-2 G"]
    ok("E · sortie 1-2 : le mix principal (les 4 pistes au même niveau)", max(m0.values()) - min(m0.values()) < 1.5 and min(m0.values()) > -40, m0)
    ok("E · casque artiste (3-4) mesuré : Micro 1 plein (comme sur 1-2), Micro 2 à −12 dB (±0,5), Micro 3 et 4 coupés",
       abs((a[220.0] - a[330.0]) - 12) < 0.5 and abs(a[220.0] - m0[220.0]) < 0.5 and a[440.0] < a[220.0] - 40 and a[550.0] < a[220.0] - 40, a)
    # Pan tout à droite d'une piste (stéréo dans le moteur) : la gauche passe à droite, +6 dB ; à −6 dB → même niveau que Micro 3.
    ok("E · casque ingé (5-6) mesuré : Micro 3 au centre, Micro 4 (−6 dB, pan tout à droite) seulement à droite, Micro 1 et 2 coupés",
       abs(i[440.0] - m0[440.0]) < 0.5 and abs(d[440.0] - i[440.0]) < 0.5 and abs(d[550.0] - i[440.0]) < 0.5 and i[550.0] < d[550.0] - 40
       and max(i[220.0], i[330.0], d[220.0], d[330.0]) < i[440.0] - 40,
       {"gauche": i, "droite": d})
    ok("E · clic dans le casque de l'artiste, pas dans celui de l'ingé (clic à 0)", clicks["3-4"] > clicks["5-6"] + 20, clicks)
    # Voix en direct : Voix live (entrée 5, 660 Hz) armée → mélangée DANS LE PONT (aucun aller-retour navigateur).
    arm(page, ["live"])
    page.wait_for_timeout(1500)
    stats = bridge_call({"action": "QA_STATS"}, "QA_STATS")
    out2 = dump_outputs(1.0)
    live = {k: round(tone_db(out2[:, ch], 660), 1) for k, ch in (("1-2", 0), ("3-4", 2), ("5-6", 4))}
    res["mesures"]["voix_directe"] = {"raie_660_dB": live, "routes_du_pont": stats.get("monitor_routes")}
    ok("E · voix en direct par le pont : 1-2 au niveau du retour, casque artiste à −6 dB, absente du casque ingé (coupée)",
       stats.get("direct") and abs((live["1-2"] - live["3-4"]) - 6.02) < 0.5 and live["5-6"] < live["1-2"] - 50 and live["1-2"] > -20,
       {"raie_660_dB": live, "routes": stats.get("monitor_routes")})
    page.evaluate("() => window.dispatchEvent(new Event('nova:open-cue-mixes'))")
    page.get_by_test_id("cue-panel").wait_for(timeout=15000)
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "E2_mixes_casque_regles_pc.png"))
    # Écouter le casque de l'artiste sur la sortie principale.
    page.get_by_test_id(f"cue-listen-{art['id']}").click(); page.wait_for_timeout(1200)
    out3 = dump_outputs(0.8)
    lis = round(tone_db(out3[:, 0], 660), 1)
    ok("E · « Écouter » : la sortie 1-2 joue le casque de l'artiste (voix à −6 dB comme dans son casque)", abs(lis - live["3-4"]) < 0.6, {"sortie_1_2_660_dB": lis, "casque_artiste": live["3-4"]})
    page.get_by_test_id(f"cue-listen-{art['id']}").click(); page.wait_for_timeout(400)
    page.keyboard.press("Escape")
    page.evaluate("() => { const b = document.querySelector('[aria-label=\"Fermer les mixes casque\"]'); if (b) b.click(); }")
    arm(page, ["live"], False)

    # ── Tampon de la carte : changé pour de vrai (le pont recrée le flux) ──
    r = page.evaluate(f"async () => {ENGINE}.setASIOBufferSize(1024)")
    page.wait_for_timeout(1200)
    st = bridge_call({"action": "QA_STATS"}, "QA_STATS")
    info = page.evaluate(f"async () => {ENGINE}.getASIOStreamInfo()")
    f0 = st["frames"]; time.sleep(1.0); f1 = bridge_call({"action": "QA_STATS"}, "QA_STATS")["frames"]
    ok("E · tampon 256 → 1024 : le flux de la carte est recréé avec 1024 (vérifié côté carte), le son continue",
       r.get("ok") and r.get("restarted") and st["opened"][-1]["blocksize"] == 1024 and info["blockSize"] == 1024 and f1 - f0 > SR * 0.5,
       {"reponse": r, "flux_ouverts": st["opened"][-3:], "moteur": info, "images_par_seconde": f1 - f0})
    big = page.evaluate("""async () => { const m = await window.__novaAppModule('/engine/AudioEngine.ts'); return await m.audioEngine.biggerBuffer(); }""")
    st2 = bridge_call({"action": "QA_STATS"}, "QA_STATS")
    ok("E · « Tampon plus grand » (alerte de surcharge) double le VRAI tampon de la carte : 2048", big.get("kind") == "asio" and big.get("ok") and st2["opened"][-1]["blocksize"] == 2048,
       {"reponse": big, "dernier_flux": st2["opened"][-1]})
    page.evaluate(f"async () => {ENGINE}.setASIOBufferSize(256)")
    page.wait_for_timeout(800)

    run_one_pair_and_screens(p, ctx, page, profile, fake, proj_path, errs)


def run_one_pair_and_screens(p, ctx, page, profile, fake, proj_path, errs):
    global PORT
    # Carte à UNE paire de sorties : message clair, « Écouter » reste possible.
    page.evaluate(f"async () => {{ const e = {ENGINE}; e.stopASIOStream(); e.disconnectASIO(); }}")
    page.wait_for_timeout(800)
    for c in psutil.net_connections("tcp"):
        if c.laddr.port == PORT and c.status == "LISTEN" and c.pid:
            try: psutil.Process(c.pid).kill()
            except Exception: pass
    time.sleep(1.5)
    small = start_bridge(2)
    try:
        ok("E · carte simulée à 2 sorties : pont relancé et reconnecté", connect_bridge(page), page.evaluate(f"async () => {ENGINE}.getASIOStreamInfo()"))
        page.evaluate("() => window.dispatchEvent(new Event('nova:open-cue-mixes'))")
        page.get_by_test_id("cue-panel").wait_for(timeout=15000)
        page.wait_for_timeout(2000)
        msg = page.get_by_test_id("cue-problem").first.inner_text() if page.get_by_test_id("cue-problem").count() else None
        ok("E · une seule paire de sorties : message clair, le mix casque reste écoutable sur 1-2", bool(msg) and "une paire de sorties" in msg and "Écouter" in msg, msg)
        page.screenshot(path=str(OUT / "E3_carte_une_paire_message_pc.png"))
        arm(page, ["live"])
        art = page.evaluate("() => window.DAW_CONTROL.getState().cueMixes[0].id")
        page.get_by_test_id(f"cue-listen-{art}").click(); page.wait_for_timeout(1200)
        out = dump_outputs(0.8)
        ok("E · carte à une paire : « Écouter » le casque de l'artiste sur 1-2 (voix à −6 dB)", abs(tone_db(out[:, 0], 660) - (db(0.2) - 6.02)) < 0.8, {"sortie_1_660_dB": round(tone_db(out[:, 0], 660), 1)})
        page.get_by_test_id(f"cue-listen-{art}").click(); page.wait_for_timeout(300)
        page.evaluate("() => { const b = document.querySelector('[aria-label=\"Fermer les mixes casque\"]'); if (b) b.click(); }")
        arm(page, ["live"], False)
    finally:
        stop_bridge(small)

    # ── F. Captures PC, tablette, téléphone ──
    arm(page, MICS)
    page.wait_for_timeout(1500)
    page.screenshot(path=str(OUT / "F1_quatre_pistes_armees_pc.png"))
    for vp, size in (("tablette", (1024, 768)), ("telephone", (432, 768))):
        page.set_viewport_size({"width": size[0], "height": size[1]})
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / f"F2_pistes_armees_{vp}.png"))
        page.evaluate("() => window.dispatchEvent(new Event('nova:open-cue-mixes'))")
        page.get_by_test_id("cue-panel").wait_for(timeout=15000)
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / f"F3_mixes_casque_{vp}.png"))
        res[f"debordements_{vp}"] = overflow_report(page)
        page.evaluate("() => { const b = document.querySelector('[aria-label=\"Fermer les mixes casque\"]'); if (b) b.click(); }")
        page.wait_for_timeout(400)
    page.set_viewport_size({"width": 1600, "height": 900})
    page.wait_for_timeout(1500)
    # Réglages audio : section multipiste.
    page.evaluate("() => window.dispatchEvent(new Event('nova:open-cue-mixes'))")
    page.wait_for_timeout(300)
    page.evaluate("() => { const b = document.querySelector('[aria-label=\"Fermer les mixes casque\"]'); if (b) b.click(); }")
    ok("F · pas d'erreur dans la page", not errs, errs[:5])


if __name__ == "__main__":
    main()
