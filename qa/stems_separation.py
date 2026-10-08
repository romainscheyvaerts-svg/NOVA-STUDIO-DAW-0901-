"""Séparation de stems de bout en bout avec le VRAI pont (nova_bridge_server.py) et le
VRAI module Demucs installé sur ce PC. Navigateur headless, aucune fenêtre.

Usage (serveur NOVA lancé : npx vite --port 3421 --strictPort) :
  NOVA_URL=http://127.0.0.1:3421/ python qa/stems_separation.py

  A. web sans pont           → message « marche dans l'appli Windows »
  B. appli, module absent     → bouton d'installation, installation réelle lancée puis annulée
  C. appli, module installé   → 2 stems puis 4 stems (fenêtre fermée : pastille), annulation
     + mesures sur les stems reçus (voix restée dans l'instru, somme des stems)

Le morceau : un extrait de « Silence blanc » (session Pro Tools du studio) dont on a les
vraies pistes séparées (instru, voix) : mix = instru + voix.
"""
import io, json, os, re, subprocess, sys, tempfile, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v18-stems")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3421/")
from qalib import *  # noqa
from gel_pre_effet import fake_login, open_project_file, DESKTOP_INIT, WORKER_STUB  # noqa

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
SRC = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
EXTRACT = (60.0, 45.0)  # début, durée (s) dans le morceau
CLIP = {"start": 2.0, "offset": 3.0, "duration": 40.0}
SORTIES = OUT / "sorties-pont"
RESULTS = {}


def read_mono(p):
    with wave.open(str(p)) as w:
        sr, n, sw = w.getframerate(), w.getnframes(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        return v.astype(np.float32) / (1 << 23), sr
    return np.frombuffer(raw, "<i2").astype(np.float32) / 32768, sr


def source_parts():
    parts = {}
    for k, name in (("instru", "Silence blanc (Instrumental)"), ("voix", "Silence blanc (Vocals)")):
        l, sr = read_mono(SRC / f"{name}.L.wav")
        r, _ = read_mono(SRC / f"{name}.R.wav")
        a, b = int(EXTRACT[0] * sr), int((EXTRACT[0] + EXTRACT[1]) * sr)
        parts[k] = np.stack([l[a:b], r[a:b]])
    return parts, sr


def make_project(path: Path):
    parts, sr = source_parts()
    mix = parts["instru"] + parts["voix"]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(mix.T, -1, 1) * 32767).astype("<i2").tobytes())
    clip = {"id": "beat-clip", "name": "Silence blanc (extrait)", "type": "AUDIO", "audioRef": "audio/beat.wav", "color": "#22d3ee",
            "fadeIn": 0.05, "fadeOut": 1.0, "gain": 0.9, **CLIP}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    tracks = [{**base, "id": "beat", "name": "Beat", "type": "AUDIO", "color": "#22d3ee", "clips": [clip]}]
    state = {
        "id": "proj-stems-test", "name": "Test stems", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "beat", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/beat.wav", buf.getvalue())
    return parts, sr


def start_bridge(port, stems_home=None):
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(port), NOVA_STEMS_OUTPUT=str(SORTIES), PYTHONIOENCODING="utf-8")
    if stems_home:
        env["NOVA_STEMS_HOME"] = str(stems_home)
    log = open(OUT / f"pont-{port}.log", "w", encoding="utf-8")
    p = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(ROOT / "bridge-python"), env=env,
                         stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
    import socket
    for _ in range(120):
        try:
            socket.create_connection(("127.0.0.1", port), 0.5).close()
            return p
        except OSError:
            time.sleep(0.5)
    stop_bridge(p)
    raise RuntimeError(f"pont {port} injoignable")


def stop_bridge(p):
    """Le lanceur du venv relance un 2e processus Python : on arrête tout l'arbre."""
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)


def prepare(page, port=None, desktop=True):
    """port : redirige ws://127.0.0.1:8765 vers le vrai pont lancé sur ce port
    (l'appli Nova Studio installée peut occuper 8765)."""
    if desktop:
        page.add_init_script(DESKTOP_INIT)
        fake_login(page)
    if port:
        page.add_init_script("""(() => { const W = window.WebSocket;
          window.WebSocket = function (u, p) { u = String(u).replace(':8765', ':%d'); return p ? new W(u, p) : new W(u); };
          window.WebSocket.prototype = W.prototype; ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => window.WebSocket[k] = W[k]); })();""" % port)
    else:
        page.route_web_socket(re.compile(r"^ws://(127\.0\.0\.1|localhost):8765"), lambda ws: ws.close())
    page.route_web_socket(re.compile(r"^ws://(127\.0\.0\.1|localhost):8766"), lambda ws: ws.close())
    page.route("**/worklets/vst-bridge-worker-v5.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=WORKER_STUB))
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))


def dismiss_popups(page, wait_ms=5000):
    """Appli Windows + vrai pont : NOVA propose l'autotune du PC, puis la prise en main.
    Hors sujet ici : « Plus tard » tant qu'une telle fenêtre apparaît."""
    t0 = time.time()
    quiet = 0
    while (time.time() - t0) * 1000 < wait_ms + 10000 and quiet < 6:
        b = page.get_by_role("button", name="Plus tard", exact=True).locator("visible=true")
        if b.count():
            try:
                b.first.click(timeout=3000, force=True)
            except Exception:
                page.keyboard.press("Escape")
            quiet = 0
            page.wait_for_timeout(400)
        else:
            quiet += 1 if (time.time() - t0) * 1000 > wait_ms * 0.4 else 0
            page.wait_for_timeout(300)


def open_stems_menu(page, label):
    dismiss_popups(page)
    # Les clips sont dessinés (pas de texte dans la page) : on vise la piste « Beat »,
    # à droite de son en-tête, sous la ligne de gain du clip (début du clip : 2 s).
    y = None
    for _ in range(40):
        y = page.evaluate("""() => { for (const e of document.querySelectorAll('span, div')) {
            if (e.children.length || (e.textContent || '').trim() !== 'Beat') continue;
            const r = e.getBoundingClientRect(); if (r.x > 320 && r.x < 620 && r.height) return r.y; } return null; }""")
        if y:
            break
        page.wait_for_timeout(500)
    page.mouse.click(900, y + 60, button="right")
    page.wait_for_timeout(400)
    menu_open_for(page, "Séparer en stems")  # sous-menu « Traitement »
    item = page.get_by_role("menuitem", name=re.compile("Séparer en stems")).first
    title = item.get_attribute("title")
    shot(page, f"{label}_menu")
    item.click()
    page.get_by_test_id("stems-dialog").wait_for(timeout=8000)
    page.wait_for_timeout(800)
    return title


def scenario_web(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "A0_projet_web")
    res["menu_title"] = open_stems_menu(page, "A1_web")
    page.get_by_test_id("stems-web").wait_for(timeout=5000)
    shot(page, "A2_web_sans_pont")
    res["notes"].append(page.get_by_test_id("stems-web").inner_text()[:200])


def scenario_install(page, log, res, vp):
    prepare(page, port=PORT_EMPTY)
    open_project_file(page, PROJECT, res, "B0_projet")
    open_stems_menu(page, "B1")
    page.get_by_test_id("stems-not-installed").wait_for(timeout=15000)
    shot(page, "B2_module_absent")
    res["bouton"] = page.get_by_test_id("stems-install").inner_text()
    page.get_by_test_id("stems-install").click()
    page.get_by_test_id("stems-installing").wait_for(timeout=15000)
    # Laisse avancer l'installation réelle (uv, Python 3.12, début de PyTorch)
    t0 = time.time()
    label = ""
    while time.time() - t0 < 90:
        label = page.get_by_test_id("stems-installing").inner_text()
        if "PyTorch" in label:
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(4000)
    shot(page, "B3_installation_en_cours")
    res["progression"] = page.get_by_test_id("stems-installing").inner_text()[:200]
    page.get_by_role("button", name="Annuler l’installation").click()
    page.get_by_test_id("stems-not-installed").wait_for(timeout=30000)
    page.wait_for_timeout(500)
    shot(page, "B4_installation_annulee")
    res["apres_annulation"] = page.get_by_test_id("stems-not-installed").inner_text()[-120:]


def wait_done(page, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.get_by_test_id("stems-ready").count() and page.get_by_test_id("stems-ready").is_visible():
            return round(time.time() - t0, 1)
        page.wait_for_timeout(500)
    raise TimeoutError("séparation trop longue")


def scenario_separation(page, log, res, vp):
    prepare(page, port=PORT_REAL)
    open_project_file(page, PROJECT, res, "C0_projet")
    open_stems_menu(page, "C1")
    page.get_by_test_id("stems-ready").wait_for(timeout=15000)
    shot(page, "C2_pret_2_stems")
    # 2 stems
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    t0 = time.time()
    while time.time() - t0 < 120:
        txt = page.get_by_test_id("stems-running").inner_text() if page.get_by_test_id("stems-running").count() else ""
        m = re.search(r"(\d+) %", txt)
        if m and int(m.group(1)) >= 30:
            break
        page.wait_for_timeout(300)
    shot(page, "C3_separation_en_cours")
    res["deux_stems_s"] = wait_done(page)
    page.wait_for_timeout(500)
    shot(page, "C4_deux_stems_ajoutes")
    res["resume_2"] = page.get_by_test_id("stems-ready").inner_text()[:200]
    # 4 stems, fenêtre fermée pendant le calcul (pastille)
    page.get_by_role("radio", name=re.compile("4 stems")).check()
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    page.get_by_role("button", name="Continuer en arrière-plan").click()
    page.get_by_test_id("stems-pill").wait_for(timeout=5000)
    page.wait_for_timeout(3000)
    shot(page, "C5_pastille_arriere_plan")
    t0 = time.time()
    while "✅" not in page.get_by_test_id("stems-pill").inner_text() and time.time() - t0 < 600:
        if "❌" in page.get_by_test_id("stems-pill").inner_text():
            raise RuntimeError(page.get_by_test_id("stems-pill").inner_text())
        page.wait_for_timeout(500)
    res["quatre_stems_s"] = round(time.time() - t0, 1)
    page.wait_for_timeout(800)
    shot(page, "C6_quatre_stems_ajoutes")
    res["resume_4"] = page.get_by_test_id("stems-pill").inner_text()[:200]
    res["pistes"] = page.evaluate("""() => Array.from(document.querySelectorAll('input, span, div'))
        .map(e => (e.value || e.textContent || '').trim()).filter(t => /\\(stem\\)$/.test(t)).filter((t, i, a) => a.indexOf(t) === i)""")
    page.get_by_role("button", name="Fermer").first.click()
    # Annulation d'une séparation
    open_stems_menu(page, "C7")
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    page.wait_for_timeout(2500)
    res["avant_annulation"] = page.get_by_test_id("stems-running").inner_text()[:80]
    page.get_by_test_id("stems-running").get_by_role("button", name="Annuler", exact=True).click()
    page.get_by_test_id("stems-ready").wait_for(timeout=30000)
    res["sorties_partielles"] = [str(p) for p in SORTIES.rglob(".partiel")]
    page.wait_for_timeout(500)
    shot(page, "C8_separation_annulee")


def measure(parts, sr):
    """Stems écrits par le pont (même audio que celui reçu par NOVA) vs vraies pistes."""
    dirs = sorted([d for d in SORTIES.rglob("*") if d.is_dir() and (d / "Voix.wav").exists()], key=lambda d: d.stat().st_mtime)
    sys.path.insert(0, str(ROOT / "bridge-python"))
    import stems_service  # lecteur WAV du pont
    out = {}

    def rd(p):
        return stems_service.read_wav(p)[0]

    mix = parts["instru"] + parts["voix"]
    e = lambda x: float(np.sum(np.square(x, dtype=np.float64)))  # noqa
    db = lambda x: round(10 * np.log10(max(x, 1e-20)), 1)  # noqa
    for d in dirs:
        if (d / "Instru.wav").exists():
            v, i = rd(d / "Voix.wav"), rd(d / "Instru.wav")
            n = min(v.shape[1], mix.shape[1])
            g = float(np.sum(i[:, :n] * parts["voix"][:, :n]) / e(parts["voix"][:, :n]))
            out["2_stems"] = {"dossier": str(d), "voix_restante_dans_instru_db": db(e(g * parts["voix"]) / e(parts["voix"])),
                              "sdr_voix_db": db(e(parts["voix"][:, :n]) / e(v[:, :n] - parts["voix"][:, :n])),
                              "somme_vs_original_db": db(e(v[:, :n] + i[:, :n] - mix[:, :n]) / e(mix[:, :n]))}
        elif (d / "Batterie.wav").exists():
            s = sum(rd(d / f"{k}.wav") for k in ("Voix", "Batterie", "Basse", "Autres"))
            n = min(s.shape[1], mix.shape[1])
            out["4_stems"] = {"dossier": str(d), "somme_vs_original_db": db(e(s[:, :n] - mix[:, :n]) / e(mix[:, :n]))}
    return out


if __name__ == "__main__":
    import shutil
    shutil.rmtree(SORTIES, ignore_errors=True)
    PROJECT = OUT / "projet_stems_test.zip"
    parts, sr = make_project(PROJECT)
    PORT_REAL, PORT_EMPTY = 8795, 8796
    report = {}
    report["A_web"] = run_one(scenario_web, "pc", "A_web")
    empty_home = Path(tempfile.mkdtemp(prefix="nova-stems-vide-"))
    br = start_bridge(PORT_EMPTY, empty_home)
    try:
        report["B_installation"] = run_one(scenario_install, "pc", "B_installation")
    finally:
        stop_bridge(br)
        time.sleep(2)
        report["B_installation"]["dossier_temp_apres_annulation_mo"] = round(sum(f.stat().st_size for f in empty_home.rglob("*") if f.is_file()) / 1e6)
        shutil.rmtree(empty_home, ignore_errors=True)
    br = start_bridge(PORT_REAL)
    try:
        report["C_separation"] = run_one(scenario_separation, "pc", "C_separation")
    finally:
        stop_bridge(br)
    sys.path.insert(0, str(ROOT / "bridge-python"))
    try:
        report["mesures_pont"] = measure(parts, sr)
    except Exception as ex:  # noqa
        report["mesures_pont"] = {"erreur": str(ex)}
    (OUT / "qa_stems.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))
