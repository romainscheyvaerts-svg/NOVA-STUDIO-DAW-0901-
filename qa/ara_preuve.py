"""Melodyne et VocAlign (ARA) depuis NOVA, de bout en bout : VRAI pont (port 8775), VRAI hôte
NovaARAHost.exe, VRAIS plugins du PC. Navigateur headless ; la fenêtre du plugin est ouverte
HORS ÉCRAN (localStorage nova.ara.offscreen=1) et capturée par le pont : rien ne surgit.

Usage (serveur NOVA lancé : npx vite --port 3432 --strictPort) :
  NOVA_URL=http://127.0.0.1:3432/ python qa/ara_preuve.py

  A. site sans pont       → « Ouvrir dans Melodyne (ARA) » grisé + infobulle ; repli « alignement NOVA »
  B. Melodyne             → clic droit → Ouvrir → fenêtre (capture) → Valider → Retoucher (retouches
                            rechargées) → Revenir à l'original
  C. VocAlign en un clic  → clic droit sur le double → guide = la lead, double coché → Caler

Insert de piste comme Pro Tools (pont v12) : `python qa/ara_preuve.py insert` enchaîne
  D. qa/ara_insert_pont.py          pont + hôte seuls : document à jour (déplacer, couper, rogner, dupliquer,
                                    supprimer, régions relues dans le plugin), clic à 2,000 s, export = lecture
  E. qa/ara_insert_pont.py vocalign VocAlign en insert sur le double, guide = la lead (capture transparente)
  F. qa/ara_insert_lecture.py       moteur de NOVA : clic du plugin calé sur le clic NOVA à l'échantillon près
                                    (lecture, saut, boucle), clip déplacé, réglage en direct, export
  G. qa/ara_dock_appli.py           appli Windows : éditeur de Melodyne ancré en bas de la fenêtre Édition
"""
import asyncio, io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-ara\qa")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3432/")
from qalib import *  # noqa
from stems_separation import start_bridge, stop_bridge, prepare, dismiss_popups  # noqa
from gel_pre_effet import open_project_file  # noqa

PORT = int(os.environ.get("NOVA_TEST_PORT", "8775"))
LEAD = Path(r"D:\1 WORK\CONTENU\nova-ara\melodyne\voix_originale.wav")
DUB = Path(r"D:\1 WORK\CONTENU\nova-ara\vocalign\double_decale.wav")
PROJECT = OUT / "projet_ara.zip"
# + « Ta voix sur nos beats, en 3 gestes » (première visite) déjà vu : il recouvrait le menu du clip.
OFFSCREEN = "try { localStorage.setItem('nova.ara.offscreen', '1'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}"


def wav16(path):
    import wave as w
    data = open(path, "rb").read()
    # float32 → PCM 16 bits (le projet NOVA)
    sys.path.insert(0, r"D:\1 WORK\CONTENU\nova-ara\scripts")
    import wavio
    x, sr = wavio.read(str(path))
    buf = io.BytesIO()
    with w.open(buf, "wb") as o:
        o.setnchannels(x.shape[1]); o.setsampwidth(2); o.setframerate(sr)
        o.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue(), x.shape[0] / sr


def make_project():
    lead, dl = wav16(LEAD)
    dub, dd = wav16(DUB)
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    clip = lambda i, n, ref, d: {"id": i, "name": n, "type": "AUDIO", "audioRef": ref, "color": "#e879f9", "fadeIn": 0, "fadeOut": 0,
                                 "gain": 1, "start": 2.0, "offset": 0.0, "duration": d}
    tracks = [{**base, "id": "lead", "name": "Voix lead", "type": "AUDIO", "color": "#e879f9", "clips": [clip("c-lead", "Lead couplet", "audio/lead.wav", dl)]},
              {**base, "id": "double", "name": "Double", "type": "AUDIO", "color": "#22d3ee", "clips": [clip("c-dbl", "Double couplet", "audio/dub.wav", dd)]}]
    state = {"id": "proj-ara", "name": "Test ARA", "bpm": 95, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
             "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "lead", "currentView": "ARRANGEMENT",
             "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
             "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(PROJECT, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/lead.wav", lead)
        z.writestr("audio/dub.wav", dub)


def track_y(page, name):
    for _ in range(40):
        y = page.evaluate("""(n) => { for (const e of document.querySelectorAll('span, div')) {
            if (e.children.length || (e.textContent || '').trim() !== n) continue;
            const r = e.getBoundingClientRect(); if (r.x > 200 && r.x < 700 && r.height) return r.y; } return null; }""", name)
        if y:
            return y
        page.wait_for_timeout(500)
    raise RuntimeError(f"piste {name} introuvable")


def clip_menu(page, track, label):
    dismiss_popups(page)
    page.keyboard.press("Escape")
    y = track_y(page, track)
    page.mouse.click(1000, y + 60, button="right")
    page.wait_for_timeout(500)
    menu_open_for(page, "Melodyne")  # menu du clip regroupé : sous-menu « Voix »
    shot(page, label)
    items = page.evaluate("""() => [...document.querySelectorAll('button')].filter(b => /Melodyne|VocAlign|alignement NOVA|Revenir à l'original/.test(b.textContent||''))
        .map(b => ({ text: b.textContent.trim(), disabled: b.disabled, title: b.title }))""")
    return items


def notify_text(page, pattern, timeout=600000):
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        txt = page.evaluate("() => document.body.innerText")
        m = re.search(pattern, txt)
        if m:
            return m.group(0)
        page.wait_for_timeout(500)
    raise RuntimeError(f"pas de message {pattern}")


async def bridge_snapshot(session, path):
    import websockets
    async with websockets.connect(f"ws://127.0.0.1:{PORT}", origin="http://localhost:3432") as ws:
        await ws.send(json.dumps({"action": "ARA_SNAPSHOT", "req_id": "snap", "session_id": session, "path": str(path)}))
        return json.loads(await ws.recv())


def scenario_web(page, log, res, vp):
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "A0_projet_site")
    res["menu_site"] = clip_menu(page, "Voix lead", "A1_menu_site")


def scenario_melodyne(page, log, res, vp):
    page.add_init_script(OFFSCREEN)
    prepare(page, port=PORT)
    open_project_file(page, PROJECT, res, "B0_projet")
    page.wait_for_timeout(4000)
    res["menu"] = clip_menu(page, "Voix lead", "B1_menu_clip")
    page.get_by_role("menuitem", name=re.compile(r"Ouvrir dans Melodyne")).first.click()
    page.get_by_test_id("ara-dialog-melodyne").wait_for(timeout=8000)
    shot(page, "B2_dialogue")
    t0 = time.time()
    page.get_by_test_id("ara-open").click()
    page.get_by_test_id("ara-open-info").wait_for(timeout=240000)
    res["ouverture_s"] = round(time.time() - t0, 1)
    res["info"] = page.get_by_test_id("ara-open-info").inner_text()
    shot(page, "B3_melodyne_ouvert")
    sid = page.evaluate("() => window.__novaAraSession")
    page.wait_for_timeout(2500)
    # Capture de la fenêtre du plugin (hors écran) par le pont, via la connexion de NOVA.
    res["capture_fenetre"] = page.evaluate("""([sid, path]) => window.__novaBridge.request({ action: 'ARA_SNAPSHOT', session_id: sid, path }, 30000)""",
                                           [sid, str(OUT / "B3_fenetre_melodyne_depuis_nova.png")])
    page.get_by_test_id("ara-validate").click()
    res["valide"] = notify_text(page, r"Melodyne : son corrigé appliqué[^\n]*")
    shot(page, "B4_valide")
    page.wait_for_timeout(1500)
    res["menu_apres"] = clip_menu(page, "Voix lead", "B5_menu_apres")
    page.get_by_role("menuitem", name=re.compile(r"Retoucher dans Melodyne")).first.click()
    page.get_by_test_id("ara-open").click()
    page.get_by_test_id("ara-open-info").wait_for(timeout=240000)
    res["reouverture"] = page.get_by_test_id("ara-open-info").inner_text()
    shot(page, "B6_reouverture")
    page.get_by_test_id("ara-revert").click()
    res["retour"] = notify_text(page, r"Prise d’origine remise[^\n]*")
    page.wait_for_timeout(1000)
    res["menu_final"] = clip_menu(page, "Voix lead", "B7_apres_retour")


def scenario_vocalign(page, log, res, vp):
    page.add_init_script(OFFSCREEN)
    prepare(page, port=PORT)
    open_project_file(page, PROJECT, res, "C0_projet")
    page.wait_for_timeout(4000)
    clip_menu(page, "Double", "C1_menu_double")
    page.get_by_role("menuitem", name=re.compile(r"Aligner avec VocAlign")).first.click()
    page.get_by_test_id("ara-dialog-vocalign").wait_for(timeout=8000)
    page.wait_for_timeout(1500)
    res["guide"] = page.get_by_test_id("ara-guide").evaluate("e => e.options[e.selectedIndex].text")
    res["candidats"] = page.get_by_test_id("ara-candidates").inner_text()
    shot(page, "C2_dialogue_vocalign")
    t0 = time.time()
    page.get_by_test_id("ara-align").click()
    page.wait_for_timeout(1500)
    shot(page, "C3_en_cours")
    res["cale"] = notify_text(page, r"clip[^\n]*calé[^\n]*")
    res["duree_s"] = round(time.time() - t0, 1)
    shot(page, "C4_cale")


def insert_scenarios():
    """D–G : Melodyne / VocAlign en insert de piste (comme Pro Tools), chacun dans son processus."""
    import subprocess
    here = Path(__file__).parent
    py = os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", QA_OUT=os.environ.get("QA_OUT_INSERT", r"D:\1 WORK\CONTENU\nova-ara\insert"))
    res = {}
    for key, cmd, out in (("D_pont", [py, str(here / "ara_insert_pont.py")], "ara_insert_pont.json"),
                          ("E_vocalign", [py, str(here / "ara_insert_pont.py"), "vocalign"], "ara_insert_vocalign.json"),
                          ("F_lecture", [sys.executable, str(here / "ara_insert_lecture.py")], "ara_insert_lecture.json"),
                          ("G_appli", [sys.executable, str(here / "ara_dock_appli.py")], "ara_dock_appli.json")):
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800)
        try:
            res[key] = json.loads((Path(env["QA_OUT"]) / out).read_text(encoding="utf-8"))
        except Exception as e:
            res[key] = {"erreur": str(e), "sortie": (r.stdout or "")[-2000:] + (r.stderr or "")[-2000:]}
    return res


if __name__ == "__main__" and "insert" in sys.argv[1:]:
    r = insert_scenarios()
    p = Path(os.environ.get("QA_OUT_INSERT", r"D:\1 WORK\CONTENU\nova-ara\insert")) / "ara_preuve_insert.json"
    p.write_text(json.dumps(r, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(r, ensure_ascii=False, indent=1, default=str)[:6000])
    sys.exit(0)

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    make_project()
    results = {}
    results["A_site"] = run_one(scenario_web, name="A_site")
    br = start_bridge(PORT)
    try:
        results["B_melodyne"] = run_one(scenario_melodyne, name="B_melodyne")
        results["C_vocalign"] = run_one(scenario_vocalign, name="C_vocalign")
    finally:
        stop_bridge(br)
    (OUT / "ara_preuve.json").write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=1, default=str)[:6000])
