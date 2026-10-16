"""C1 · Prise ASIO écrite par le pont (zéro trou) : scénario Chrome headless (aucune fenêtre),
avec le VRAI pont ASIO et une carte son SIMULÉE (qa/harness/pont_asio_simule.py : aucun
pilote ASIO n'est ouvert, ni celui du studio ni un autre). Hors production (qalib →
qa_hors_prod). Les prises du pont vont dans <QA_OUT>\\prises (jamais dans les Documents).

Signal connu : chaque entrée de la carte simulée porte le NUMÉRO de chaque échantillon
(entrée c, image i : ((i + 1000·c) mod 2^20) / 2^20 − 0,5, exact en float32). Une prise est
« complète, au bit près, sans trou » si ses numéros se suivent un à un et si chaque
échantillon vaut exactement sa valeur codée.

A. AVANT (prise écrite par la page, comme avant : nova_bridge_takes = 0) : page figée 3 s
   pendant la prise (boucle de calcul) → trous dans la prise.
B. APRÈS, sans figer : la prise du pont est posée EXACTEMENT où la page posait la sienne
   (même échantillon de la carte au même instant du morceau).
C. APRÈS, page figée 3 s : prise complète au bit près, sans trou, calée comme en B.
D. Multipiste (2 entrées), page figée 3 s : 2 fichiers synchronisés au bit près.
E. Carte qui perd 2 blocs (pilote) : silence à leur place, la suite reste calée, message
   « 2 blocs perdus pendant la prise, à 0:0x ».
F. Page TUÉE pendant la prise : au relancement, « Récupérer la session » reprend le fichier
   du pont (complet jusqu'à la mise à mort), à sa place.

Usage : NOVA_URL=http://127.0.0.1:3496/ PYTHONIOENCODING=utf-8 python qa/prise_pont.py
Résultats : D:\\1 WORK\\CONTENU\\nova-prise-pont\\ (prise_pont.json + captures)
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

import psutil

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3496/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-prise-pont")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, OUT, CHROME, APP_MODULE_INIT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PY = os.environ.get("NOVA_BRIDGE_PY", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe")
PORT = int(os.environ.get("QA_ASIO_PORT", "8786"))
SR = 48000
TAKES_DIR = OUT / "prises"
FREEZE_S = float(os.environ.get("QA_FREEZE", "3"))
res = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:700], flush=True)


# ─── pont simulé ─────────────────────────────────────────────────────────────

def start_bridge():
    env = dict(os.environ, NOVA_ASIO_PORT=str(PORT), QA_SR=str(SR), QA_INS="4", QA_OUTS="4", QA_SIGNAL="rampe",
               NOVA_TAKES_DIR=str(TAKES_DIR), PYTHONIOENCODING="utf-8")
    log = open(OUT / "pont_simule.log", "w", encoding="utf-8")
    pr = subprocess.Popen([BRIDGE_PY, str(ROOT / "qa" / "harness" / "pont_asio_simule.py")], env=env, stdout=log, stderr=subprocess.STDOUT,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(80):
        time.sleep(0.25)
        if any(c.laddr.port == PORT and c.status == "LISTEN" for c in psutil.net_connections("tcp")):
            return pr
    raise RuntimeError("pont simulé non démarré")


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
    r = subprocess.run([BRIDGE_PY, "-c", BRIDGE_CALL, json.dumps(msg), want, str(PORT), str(timeout)], capture_output=True, text=True,
                       timeout=timeout + 20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}


# ─── navigateur ──────────────────────────────────────────────────────────────

INIT = """
try {
  localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0');
  localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_asio_port', '%d'); localStorage.setItem('nova_auto_clean', '0');
  localStorage.setItem('nova_qa_take_debug', '1');
} catch (e) {}
""" % PORT

ENGINE = "(await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine"
AUDIO_NOW = f"async () => {{ const e = {ENGINE}; return e.ctx ? e.ctx.currentTime : 0; }}"


def launch(p, profile):
    ctx = p.chromium.launch_persistent_context(
        str(profile), headless=True, executable_path=CHROME, viewport={"width": 1600, "height": 900}, locale="fr-BE",
        permissions=["microphone"],
        args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
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


def make_project(path):
    import zipfile

    def tr(tid, name, **kw):
        t = {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 1, "pan": 0, "outputTrackId": "master", "sends": [], "clips": [], "plugins": [],
             "automationLanes": [], "totalLatency": 0}
        t.update(kw)
        return t
    tracks = [tr("v1", "Voix lead", recordInput={"ch": 0}, color="#ef4444"), tr("v2", "Voix double", recordInput={"ch": 1}, color="#3b82f6"),
              tr("master", "MASTER BUS", type="BUS", outputTrackId="")]
    state = {"id": "qa-prise-pont", "name": "Prise pont QA", "bpm": 120, "sampleRate": SR, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 1, "loopEnd": 3,
             "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "v1", "currentView": "ARRANGEMENT",
             "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None,
             "isDelayCompEnabled": True, "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


def open_project(page, f):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    for _ in range(60):
        page.wait_for_timeout(500)
        if page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'v2'))"):
            break
    page.wait_for_timeout(1500)


def connect_bridge(page):
    page.evaluate(f"async () => {{ const e = {ENGINE}; await e.connectASIO(); await new Promise(r => setTimeout(r, 800)); await e.startASIOStream(); }}")
    for _ in range(80):
        if page.evaluate(f"async () => {ENGINE}.isASIOStreamActive()"):
            return True
        page.wait_for_timeout(250)
    return False


def arm(page, ids, on=True):
    page.evaluate("""([ids, on]) => { for (const id of ids) { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === id); window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: on }); } }""", [ids, on])
    page.wait_for_timeout(2500)


def wait_audio(page, seconds, label=None):
    """Attend `seconds` sur l'horloge du SON (machine chargée : la montre va plus vite)."""
    t0 = page.evaluate(AUDIO_NOW); w0 = time.time()
    while time.time() - w0 < seconds * 4 + 20:
        if page.evaluate(AUDIO_NOW) - t0 >= seconds:
            break
        page.wait_for_timeout(40)
    son = page.evaluate(AUDIO_NOW) - t0
    res["mesures"].setdefault("horloges", []).append({"etape": label, "son_s": round(son, 3), "montre_s": round(time.time() - w0, 3)})
    return son


FREEZE = "(ms) => { const t0 = performance.now(); let x = 0; while (performance.now() - t0 < ms) { x += Math.sqrt(x + 1); } return Math.round(performance.now() - t0); }"


def takes_count(page, tid):
    return page.evaluate("(tid) => window.DAW_CONTROL.getState().tracks.find(t => t.id === tid).clips.filter(c => c.takeNumber).length", tid)


def record(page, seconds, start=2.0, label=None, freeze_at=None, during=None):
    """Prise de `seconds` (horloge du son) depuis `start` ; page figée FREEZE_S s à `freeze_at` s."""
    before = {t: takes_count(page, t) for t in ("v1", "v2")}
    page.evaluate("(t) => window.DAW_CONTROL.seek(t)", start)
    page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(100):
        if page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
            break
        page.wait_for_timeout(50)
    frozen = None
    if freeze_at is not None:
        wait_audio(page, freeze_at, f"{label} avant figeage")
        if during:
            during()
        frozen = page.evaluate(FREEZE, int(FREEZE_S * 1000))
        wait_audio(page, max(0.5, seconds - freeze_at - FREEZE_S), f"{label} après figeage")
    else:
        if during:
            wait_audio(page, 0.3, f"{label} début")
            during()
        wait_audio(page, seconds, label)
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(200):
        if not page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
            break
        page.wait_for_timeout(100)
    for _ in range(200):
        if any(takes_count(page, t) > before[t] for t in before):
            break
        page.wait_for_timeout(100)
    page.wait_for_timeout(1200)
    if page.evaluate("() => window.DAW_CONTROL.getState().isPlaying"):
        page.evaluate("() => window.DAW_CONTROL.togglePlay()")
        page.wait_for_timeout(500)
    return frozen


# Analyse d'une prise DANS la page (le son ne sort pas de la page) : numéros décodés.
ANALYSE = r"""async ([tid, c, which]) => {
  const reg = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
  const e = (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine;
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === tid);
  let clip, x, sr, start, offset;
  if (which === 'take' || which === 'recup') {
    const cs = t.clips.filter(k => which === 'take' ? !!k.takeNumber : /récupérée/.test(k.name || ''));
    if (!cs.length) return null;
    clip = which === 'take' ? cs.reduce((a, b) => (b.takeNumber > a.takeNumber ? b : a)) : cs[cs.length - 1];
    const b = reg.get(clip.bufferId || clip.id);
    if (!b) return { error: 'son introuvable', clip: clip.id };
    x = b.getChannelData(0); sr = b.sampleRate; start = clip.start; offset = clip.offset || 0;
  } else {
    const d = e.lastTakeDebug && e.lastTakeDebug.tracks[tid];
    if (!d || !d[which]) return null;
    x = d[which]; sr = e.lastTakeDebug.sr; start = which === 'browser' ? d.browserStart : d.bridgeStart; offset = 0;
  }
  const M = 1 << 20;
  const dec = v => (((Math.round((v + 0.5) * M) - c * 1000) % M) + M) % M;
  const val = i => Math.fround(((i + c * 1000) % M) / M - 0.5);
  const n = x.length;
  let first = -1, f0 = 0;
  for (let i = 0; i < n; i++) if (x[i] !== 0) { first = dec(x[i]); f0 = i; break; }
  const base = (first - f0 + M * 4) % M;          // numéro de la carte attendu à l'index 0
  let inexact = 0, gaps = [], silent = 0, run = 0, runs = [], misplaced = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    // Zéro : silence, sauf si c'est la vraie valeur à cet endroit (la rampe passe par 0 une fois par tour).
    if (v === 0 && val((base + i) % M) !== 0) { run++; silent++; continue; }
    if (v === 0) { if (run >= 16) runs.push({ at_s: +((i - run) / sr).toFixed(3), samples: run }); run = 0; continue; }
    if (run >= 16) runs.push({ at_s: +((i - run) / sr).toFixed(3), samples: run });
    run = 0;
    const k = dec(v);
    if (Math.fround(v) !== val(k)) inexact++;
    if (k !== (base + i) % M) misplaced++;
    if (i > 0 && x[i - 1] !== 0) { const d = (k - dec(x[i - 1]) + M) % M; if (d !== 1 && gaps.length < 30) gaps.push({ at_s: +(i / sr).toFixed(3), saut: d - 1 }); }
  }
  if (run >= 16) runs.push({ at_s: +((n - run) / sr).toFixed(3), samples: run });
  let nGaps = 0;
  for (let i = 1; i < n; i++) if (x[i] !== 0 && x[i - 1] !== 0 && ((dec(x[i]) - dec(x[i - 1]) + M) % M) !== 1) nGaps++;
  return { name: clip ? clip.name : which, start, offset, sr, len: n, dur: +(n / sr).toFixed(3), base, first_index: f0,
           // Instant (morceau) de l'image de la carte n° base : start − offset (index 0)
           t_base: start - offset, inexact, sauts: nGaps, gaps, silences: runs.slice(0, 20), silence_total: silent, hors_place: misplaced };
}"""


def analyse(page, tid, c=0, which="take"):
    return page.evaluate(ANALYSE, [tid, c, which])


def calage_ecart(a, b):
    """Écart (échantillons) entre deux prises du même passage : instant du morceau d'une même image de la carte."""
    M = 1 << 20
    if not a or not b:
        return None
    d_idx = ((b["base"] - a["base"] + M // 2) % M) - M // 2       # images de la carte entre les deux index 0
    return round(((b["t_base"] - a["t_base"]) * a["sr"] - d_idx), 4)


def notif(page):
    return page.evaluate(r"() => (document.body.innerText.match(/[^\n]*(blocs? perdus?|Prise récupérée|récupérée)[^\n]*/g) || []).slice(0, 4)")


def set_bridge_takes(page, on):
    page.evaluate("(on) => localStorage.setItem('nova_bridge_takes', on ? '1' : '0')", on)


def main():
    if TAKES_DIR.exists():
        shutil.rmtree(TAKES_DIR, ignore_errors=True)
    TAKES_DIR.mkdir(parents=True, exist_ok=True)
    proj = OUT / "projet_prise_pont.zip"
    make_project(proj)
    profile = Path(tempfile.mkdtemp(prefix="nova-prise-pont-"))
    errs = []
    bridge = start_bridge()
    try:
        with sync_playwright() as p:
            ctx, page = launch(p, profile)
            page.on("pageerror", lambda e: errs.append(str(e)[:300]))
            try:
                open_project(page, proj)
                run(p, ctx, page, profile, errs)
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
    finally:
        try:
            bridge.kill(); bridge.wait(5)
        except Exception:
            pass
    total = len(res["etapes"]); good = sum(1 for v in res["etapes"].values() if v["ok"])
    res["bilan"] = f"{good} / {total} OK"
    (OUT / "prise_pont.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nBILAN :", res["bilan"])


def run(p, ctx, page, profile, errs):
    ok("pont simulé connecté (carte 4 entrées, signal numéroté)", connect_bridge(page), page.evaluate(f"async () => {ENGINE}.getASIOStreamInfo()"))
    res["mesures"]["frequences"] = page.evaluate(f"async () => ({{ contexte: {ENGINE}.ctx.sampleRate, carte: {ENGINE}.asioConfig && {ENGINE}.asioConfig.sample_rate }})")
    ok("projet et carte à 48 kHz (fréquence par défaut)", res["mesures"]["frequences"]["contexte"] == SR, res["mesures"]["frequences"])
    feats = page.evaluate(f"async () => {ENGINE}.asioBridge && {ENGINE}.asioBridge.features")
    ok("le pont annonce l'écriture des prises (take_writer)", feats and "take_writer" in feats, feats)
    arm(page, ["v1"])

    # ── A. AVANT : prise écrite par la page, page figée ─────────────────────
    set_bridge_takes(page, False)
    fz = record(page, 8.0, 2.0, "A", freeze_at=2.0)
    a = analyse(page, "v1")
    res["mesures"]["A_avant_page_figee"] = {"figee_ms": fz, **(a or {})}
    ok(f"A · AVANT (prise écrite par la page) : page figée {FREEZE_S:.0f} s → la prise a des trous",
       a and (a["sauts"] > 0 or a["silence_total"] > SR * 0.5 or a["hors_place"] > 0),
       a and {"figee_ms": fz, "sauts": a["sauts"], "silences": a["silences"][:5], "echantillons_hors_place": a["hors_place"], "duree_s": a["dur"]})
    page.screenshot(path=str(OUT / "A_avant_prise_trouee.png"))
    set_bridge_takes(page, True)

    # ── B. APRÈS, sans figer : calage identique à la prise de la page ─────────
    record(page, 4.0, 2.0, "B")
    b_take, b_br, b_pg = analyse(page, "v1"), analyse(page, "v1", 0, "bridge"), analyse(page, "v1", 0, "browser")
    dbg = page.evaluate(f"async () => {{ const d = {ENGINE}.lastTakeDebug; return d && {{ bridgeTake: d.bridgeTake, anchorFrame: d.anchorFrame, firstFrame: d.firstFrame, lead: d.lead, note: d.note, path: d.tracks.v1 && d.tracks.v1.path }}; }}")
    ecart = calage_ecart(b_pg, b_br)
    res["mesures"]["B_sans_figer"] = {"prise": b_take, "pont": b_br, "page": b_pg, "debug": dbg, "ecart_calage_echantillons": ecart}
    ok("B · la prise posée vient du fichier du pont (Documents\\Nova Studio\\Prises\\<projet>, ici le dossier de test)",
       dbg and dbg.get("path") and str(TAKES_DIR) in dbg["path"] and "Prise pont QA" in dbg["path"], dbg)
    ok("B · prise du pont complète, au bit près, sans trou", b_take and b_take["inexact"] == 0 and b_take["sauts"] == 0 and b_take["silence_total"] == 0 and b_take["hors_place"] == 0,
       b_take and {k: b_take[k] for k in ("dur", "inexact", "sauts", "silence_total", "hors_place")})
    ok("B · calée EXACTEMENT comme la prise de la page (même image de la carte au même instant, latence compensée)",
       ecart is not None and abs(ecart) < 0.01 and b_take and abs(b_take["t_base"] - b_br["t_base"]) < 1e-9,
       {"ecart_echantillons": ecart, "debut_prise_s": b_take and b_take["start"], "debut_page_s": b_pg and b_pg["start"]})

    # ── C. APRÈS, page figée ─────────────────────────────────────────────────
    fz = record(page, 8.0, 2.0, "C", freeze_at=2.0)
    c_take, c_br, c_pg = analyse(page, "v1"), analyse(page, "v1", 0, "bridge"), analyse(page, "v1", 0, "browser")
    ecart = calage_ecart(c_pg, c_br)
    res["mesures"]["C_apres_page_figee"] = {"figee_ms": fz, "prise": c_take, "page_meme_passage": c_pg, "ecart_calage_echantillons": ecart}
    ok(f"C · APRÈS : page figée {FREEZE_S:.0f} s ({fz} ms mesurés) → prise complète, au bit près, sans trou",
       c_take and c_take["inexact"] == 0 and c_take["sauts"] == 0 and c_take["silence_total"] == 0 and c_take["hors_place"] == 0 and c_take["dur"] > 7.0,
       c_take and {k: c_take[k] for k in ("dur", "inexact", "sauts", "silence_total", "hors_place")})
    ok("C · même passage vu par la page : trous (preuve que la page s'est bien figée)",
       c_pg and (c_pg["sauts"] > 0 or c_pg["silence_total"] > SR * 0.5 or c_pg["hors_place"] > 0),
       c_pg and {"sauts": c_pg["sauts"], "silences": c_pg["silences"][:4], "hors_place": c_pg["hors_place"]})
    ok("C · calée comme la page avant le figeage (0 échantillon d'écart)", ecart is not None and abs(ecart) < 0.01, {"ecart_echantillons": ecart})
    page.screenshot(path=str(OUT / "C_apres_prise_complete.png"))

    # ── D. Multipiste, page figée ────────────────────────────────────────────
    arm(page, ["v1", "v2"])
    fz = record(page, 7.0, 2.0, "D", freeze_at=2.0)
    d1, d2 = analyse(page, "v1", 0), analyse(page, "v2", 1)
    sync = calage_ecart(d1, d2)
    res["mesures"]["D_multipiste"] = {"figee_ms": fz, "v1": d1, "v2": d2, "ecart_echantillons": sync}
    ok("D · multipiste (2 entrées), page figée : les 2 prises complètes au bit près, sans trou",
       all(x and x["inexact"] == 0 and x["sauts"] == 0 and x["silence_total"] == 0 and x["hors_place"] == 0 for x in (d1, d2)),
       {k: x and {kk: x[kk] for kk in ("dur", "inexact", "sauts", "silence_total")} for k, x in (("v1", d1), ("v2", d2))})
    ok("D · synchronisées au bit près (même image de la carte au même instant, même longueur)",
       sync is not None and abs(sync) < 0.01 and d1["len"] == d2["len"] and d1["base"] == d2["base"], {"ecart_echantillons": sync, "longueurs": [d1 and d1["len"], d2 and d2["len"]]})
    arm(page, ["v2"], False)

    # ── E. Blocs perdus par la carte ─────────────────────────────────────────
    drop = {}

    def inject():
        drop.update(bridge_call({"action": "QA_DROP", "blocks": 2, "after": 1.0}, "QA_DROPPED"))
    record(page, 4.0, 2.0, "E", during=inject)
    e_take = analyse(page, "v1")
    msgs = notif(page)
    res["mesures"]["E_blocs_perdus"] = {"injection": drop, "prise": e_take, "messages": msgs}
    block = drop.get("block") or 256
    ok("E · 2 blocs perdus par la carte : silence à leur place (2 blocs), la suite reste calée sur l'horloge de la carte",
       e_take and e_take["inexact"] == 0 and e_take["hors_place"] == 0 and len(e_take["silences"]) == 1 and e_take["silences"][0]["samples"] == 2 * block,
       e_take and {"silences": e_take["silences"], "hors_place": e_take["hors_place"], "sauts": e_take["sauts"]})
    ok("E · message clair à l'ingé : « 2 blocs perdus pendant la prise, à 0:0x »", any(re.search(r"2 blocs perdus pendant la prise, à \d:\d\d", m) for m in msgs), msgs)
    page.screenshot(path=str(OUT / "E_message_blocs_perdus.png"))
    meta = sorted(TAKES_DIR.rglob("*.json"), key=lambda q: q.stat().st_mtime)
    last = json.loads(meta[-1].read_text(encoding="utf-8")) if meta else {}
    ok("E · compteur de pertes dans les métadonnées de la prise", last.get("lost_blocks") == 2 and last.get("losses", [{}])[0].get("kind") == "asio",
       {k: last.get(k) for k in ("take_id", "lost_blocks", "lost_frames", "losses", "status")})

    # ── F. Page tuée pendant la prise ────────────────────────────────────────
    page = run_crash(p, ctx, page, profile, errs)
    ok("pas d'erreur dans la page", not errs, errs[:5])


def run_crash(p, ctx, page, profile, errs):
    vers = "async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().listVersions()).length; }"
    t0 = time.time()
    while time.time() - t0 < 40 and not page.evaluate(vers):
        page.wait_for_timeout(1000)
    last, stable = None, 0
    while time.time() - t0 < 60 and stable < 3:
        cur = page.evaluate("() => JSON.stringify(window.DAW_CONTROL.diag().autosave || null)")
        stable = stable + 1 if cur == last else 0
        last = cur
        page.wait_for_timeout(1000)
    page.evaluate("() => window.DAW_CONTROL.seek(2)"); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    for _ in range(100):
        if page.evaluate("() => window.DAW_CONTROL.getState().isRecording"):
            break
        page.wait_for_timeout(50)
    a0 = page.evaluate(AUDIO_NOW)
    wait_audio(page, 2.0, "F avant figeage")
    page.evaluate(FREEZE, int(FREEZE_S * 1000))          # figée PUIS tuée : le pire cas
    wait_audio(page, 1.5, "F après figeage")
    son_avant = page.evaluate(AUDIO_NOW) - a0
    key = str(profile).lower()
    kids = []
    for pr in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = pr.info["cmdline"] or []
            if "chrome" in (pr.info["name"] or "").lower() and key in " ".join(cmd).lower() and not any(x.startswith("--type=") for x in cmd):
                kids = pr.children(recursive=True)
                break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    renderers = [k for k in kids if any(a.startswith("--type=renderer") for a in (k.cmdline() or []))]
    for r in renderers:
        try: r.kill()
        except Exception: pass
    res["plantage"] = {"processus_rendu_tues": len(renderers), "prise_avant_mise_a_mort_s": round(son_avant, 2)}
    time.sleep(2.5)
    metas = sorted(TAKES_DIR.rglob("*.json"), key=lambda q: q.stat().st_mtime)
    meta = json.loads(metas[-1].read_text(encoding="utf-8")) if metas else {}
    ok("F · page tuée : le pont a fermé le fichier proprement (prise « interrompue », calage noté)",
       meta.get("status") == "interrompue" and meta.get("anchor") and meta.get("frames", 0) > SR,
       {k: meta.get(k) for k in ("take_id", "status", "frames", "anchor", "files")})
    page = ctx.new_page()
    page.set_default_timeout(20000)
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    page.goto(BASE, wait_until="domcontentloaded")
    dlg = page.get_by_test_id("crash-recovery")
    dlg.wait_for(timeout=40000)
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "F1_proposition_recuperation.png"))
    page.get_by_role("button", name="Récupérer la session").click()
    for _ in range(80):
        page.wait_for_timeout(500)
        n = page.evaluate("() => window.DAW_CONTROL ? window.DAW_CONTROL.getState().tracks.filter(t => t.clips.some(c => /récupérée/.test(c.name || ''))).length : 0")
        if n >= 1:
            break
    page.wait_for_timeout(2000)
    msgs = notif(page)
    page.screenshot(path=str(OUT / "F2_prise_recuperee.png"))
    r = analyse(page, "v1", 0, "recup")
    # Calage : celui noté par le pont (n° d'image ↔ position, latence de la piste).
    anc = meta.get("anchor") or {}
    expect_t_base = None
    if anc and r:
        lat = (anc.get("offsets") or {}).get("v1", anc.get("latency", 0))
        M = 1 << 20
        d = ((r["base"] - (anc["frame"] % M) + M // 2) % M) - M // 2
        expect_t_base = anc["pos0"] + d / r["sr"] - lat
    res["mesures"]["F_page_tuee"] = {"recuperee": r, "messages": msgs, "t_base_attendu": expect_t_base}
    ok("F · « Récupérer la session » : prise reprise du fichier du pont, complète au bit près jusqu'à la mise à mort",
       r and r["inexact"] == 0 and r["sauts"] == 0 and r["silence_total"] == 0 and r["hors_place"] == 0 and r["dur"] >= son_avant - 0.6,
       r and {"duree_s": r["dur"], "son_avant_mise_a_mort_s": round(son_avant, 2), "sauts": r["sauts"], "silence_total": r["silence_total"], "nom": r["name"]})
    ok("F · message « Prise récupérée … fichier écrit par la carte son »", any("récupérée" in m and "carte son" in m for m in msgs), msgs)
    ok("F · prise récupérée posée à sa place (calage noté pendant la prise)",
       expect_t_base is not None and abs(r["t_base"] - expect_t_base) * r["sr"] < 1.0, {"t_base": r and r["t_base"], "attendu": expect_t_base})
    return page


if __name__ == "__main__":
    main()
    # Une vérification KO = scénario en échec (avant : code 0, la batterie le voyait vert à tort).
    sys.exit(0 if res["etapes"] and all(v["ok"] for v in res["etapes"].values()) else 1)
