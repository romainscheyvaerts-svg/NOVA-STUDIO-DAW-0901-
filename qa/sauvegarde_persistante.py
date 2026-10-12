"""Chantiers 5 et 6 : sauvegardes qui ne disparaissent jamais, paiement sans perte.

QA 100 % hors production (qalib → qa_hors_prod) ; navigateur headless ; profils jetables.
Nova Studio est simulé par window.__novaDesktop + le VRAI code du pont (actions PROJECT_*,
project_store) lancé par qa/harness/pont_projets.py dans un dossier de projets temporaire.

  A. Nova Studio, stockage du navigateur VIDÉ (éviction simulée : IndexedDB, localStorage,
     Cache effacés) : « Reprendre ma session » retrouve la séance sur le disque, sons compris.
  B. Plantage du pont PENDANT l'écriture d'une version (processus tué, fichier à moitié écrit) :
     la version précédente reste intacte sur le disque et se rouvre.
  C. Projet de 40 pistes copié sur le disque : l'interface ne se fige jamais plus de 100 ms.
  D. Site web : état de la protection dans les réglages ; stockage vidé → message clair.
  E. Deux onglets sur le même projet : le 2e est prévenu et ne sauvegarde pas ; « Travailler ici ».
  F. Fermeture d'onglet : pas de « Quitter la page ? » si tout est sauvegardé, oui sinon.
  G. Paiement : erreur → message clair, pas de simulation, la page reste ; vers Stripe → le
     projet est sauvegardé AVANT de quitter la page.

Usage : NOVA_URL=http://127.0.0.1:3497/ PYTHONIOENCODING=utf-8 python qa/sauvegarde_persistante.py [A B C D E F G]
Résultats : D:\\1 WORK\\CONTENU\\nova-fiabilite\\sauvegarde_persistante\\resultat.json (+ captures)
"""
import io
import json
import re
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import wave
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-fiabilite")
from qalib import BASE, OUT, CHROME, APP_MODULE_INIT  # noqa: E402  (qa_hors_prod : Supabase simulé, prod bloquée)
from playwright.sync_api import sync_playwright  # noqa: E402

OUTD = OUT / "sauvegarde_persistante"
OUTD.mkdir(parents=True, exist_ok=True)
VENV_PY = Path(os.environ.get("NOVA_BRIDGE_PY", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
HARNESS = Path(__file__).resolve().parent / "harness" / "pont_projets.py"
PROJECT = "mxdrxpzxbgybchzzvpkf"
USER = {"id": "33333333-3333-4333-8333-333333333333", "email": "sauvegarde.test@example.com"}
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SR = 44100
RES = {"etapes": {}, "ok": True}


# ─── outils ──────────────────────────────────────────────────────────────────

def wav(freq, dur, ch=1):
    t = np.arange(int(dur * SR)) / SR
    x = 0.2 * np.sin(2 * np.pi * freq * t)
    data = np.repeat(x[:, None], ch, axis=1) if ch > 1 else x
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((data * 32767).astype("<i2").tobytes())
    return b.getvalue()


def make_project(path: Path, pid: str, name: str, n: int, dur: float, ch: int = 1):
    def tr(tid, tname, clips, **kw):
        t = {"id": tid, "name": tname, "type": "AUDIO", "color": "#3b82f6", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": "master", "sends": [], "clips": clips, "plugins": [],
             "automationLanes": [], "totalLatency": 0}
        t.update(kw)
        return t
    tracks = [tr("master", "MASTER BUS", [], type="BUS", outputTrackId="")]
    files = {}
    for i in range(n):
        ref = f"audio/piste{i + 1}.wav"
        files[ref] = wav(110 + 13 * i, dur, ch)
        tracks.append(tr(f"t{i + 1}", f"Piste {i + 1}", [{"id": f"c{i + 1}", "name": f"Prise {i + 1}", "start": 0, "duration": dur, "offset": 0,
                                                           "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1}]))
    state = {"id": pid, "name": name, "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
             "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "t1", "currentView": "ARRANGEMENT",
             "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
             "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in files.items():
            z.writestr(k, v)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def start_bridge(port: int, root: Path, lent: Path = None):
    args = [str(VENV_PY), str(HARNESS), "--port", str(port), "--root", str(root)]
    if lent:
        args += ["--lent", str(lent)]
    log = open(OUTD / f"pont_{port}.log", "ab")
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, creationflags=NOWIN)
    for _ in range(150):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("le pont de test ne démarre pas")


def session_json():
    now = int(time.time())
    return json.dumps({"access_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.qa", "refresh_token": "qa-refresh", "token_type": "bearer",
                       "expires_in": 3600, "expires_at": now + 3600,
                       "user": {"id": USER["id"], "aud": "authenticated", "role": "authenticated", "email": USER["email"]}})


def launch(p, profile: Path, desktop: bool, port: int = 0):
    ctx = p.chromium.launch_persistent_context(
        str(profile), headless=True, executable_path=CHROME, viewport={"width": 1600, "height": 900}, locale="fr-BE",
        args=["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
    init = ["try { localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}"]
    if desktop:
        init.append(f"window.__novaDesktop = {{ version: '1.6.0', platform: 'windows', ui: 'qa', bridges: {{ asio: 0, vst: {port} }} }};")
        init.append(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{port}'); localStorage.setItem('sb-{PROJECT}-auth-token', {json.dumps(session_json())}); }} catch (e) {{}}")
    ctx.add_init_script("\n".join(init))
    ctx.add_init_script(APP_MODULE_INIT)
    if desktop:
        # Porte de l'appli Windows : compte de test (jamais le vrai serveur).
        def auth(route, request):
            if "/auth/v1/user" in request.url:
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps({**USER, "aud": "authenticated", "role": "authenticated"}))
            return route.fulfill(status=204, body="")
        ctx.route(f"https://{PROJECT}.supabase.co/auth/v1/**", auth)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.route_web_socket(__import__("re").compile(r"^ws://(127\.0\.0\.1|localhost):876[56]"), lambda ws: ws.close())
    page.set_default_timeout(30000)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    page.on("console", lambda m: errs.append(m.text[:300]) if m.type == "error" else None)
    return ctx, page, errs


def open_project(page, f: Path, expect_tracks: int):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    for _ in range(240):
        page.wait_for_timeout(500)
        n = page.evaluate("() => window.DAW_CONTROL ? window.DAW_CONTROL.getState().tracks.filter(t => t.clips.length).length : 0")
        if n >= expect_tracks:
            return
    raise AssertionError(f"projet pas chargé ({f.name})")


def diag(page):
    return page.evaluate("() => { const d = window.DAW_CONTROL && window.DAW_CONTROL.diag(); return d ? { autosave: d.autosave, disk: { ...d.disk }, tabLock: d.tabLock, buffers: d.buffers } : null; }")


def wait_until(page, js, timeout=60, step=0.4):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = page.evaluate(js)
        if v:
            return v
        page.wait_for_timeout(int(step * 1000))
    return None


def wait_disk(page, after_version=0, timeout=90):
    return wait_until(page, f"() => {{ const d = window.DAW_CONTROL && window.DAW_CONTROL.diag(); const l = d && d.disk && d.disk.last;"
                            f" return l && l.versionId > {after_version} && !d.disk.busy ? {{ ...l }} : null; }}", timeout)


def wait_autosave(page, after=0, timeout=40):
    return wait_until(page, f"() => {{ const d = window.DAW_CONTROL && window.DAW_CONTROL.diag(); return d && d.autosave && d.autosave.at > {after} ? d.autosave : null; }}", timeout)


def evict(page):
    """Éviction du navigateur simulée : IndexedDB, localStorage, Cache… effacés (PAS les cookies)."""
    origin = BASE.rstrip("/")
    cdp = page.context.new_cdp_session(page)
    cdp.send("Storage.clearDataForOrigin", {"origin": origin, "storageTypes": "indexeddb,local_storage,cache_storage,service_workers,file_systems,websql"})
    left = page.evaluate("async () => (await indexedDB.databases()).map(d => d.name)")
    return left


def landing_text(page):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.wait_for_timeout(3000)
    return page.evaluate("() => document.body.innerText")


def resume(page, expect_tracks):
    # Le bouton (le message du haut contient aussi « Reprendre ma session »).
    btn = page.get_by_role("button", name=re.compile("Reprendre ma session")).first
    btn.wait_for(timeout=20000)
    btn.click()
    return wait_until(page, f"() => window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.filter(t => t.clips.length).length >= {expect_tracks}"
                            " ? { bpm: window.DAW_CONTROL.getState().bpm, n: window.DAW_CONTROL.getState().tracks.filter(t => t.clips.length).length,"
                            " buffers: window.DAW_CONTROL.diag().buffers } : null", 60)


def shot(page, name):
    try:
        page.screenshot(path=str(OUTD / f"{name}.png"))
    except Exception:
        pass


class Step:
    def __init__(self, key, titre):
        self.key, self.titre = key, titre

    def __enter__(self):
        self.t0 = time.time()
        RES["etapes"][self.key] = {"titre": self.titre, "ok": None}
        print(f"\n== {self.key} · {self.titre}", flush=True)
        return RES["etapes"][self.key]

    def __exit__(self, et, ev, tb):
        e = RES["etapes"][self.key]
        e["secondes"] = round(time.time() - self.t0, 1)
        if et is None:
            e["ok"] = e.get("ok") is not False
        else:
            e["ok"] = False
            e["erreur"] = f"{ev}\n{traceback.format_exc()}"[-2500:]
        if not e["ok"]:
            RES["ok"] = False
        print(f"   -> {'OK' if e['ok'] else 'ÉCHEC'} {e.get('erreur', '')[:400]}", flush=True)
        save()
        return True  # étape suivante quoi qu'il arrive


def save():
    (OUTD / "resultat.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")


def version_files(root: Path):
    out = {}
    for d in root.iterdir() if root.exists() else []:
        out[d.name] = {"versions": sorted(f.name for f in (d / "versions").iterdir()), "audio": len(list((d / "audio").glob("*.wav")))}
    return out


# ─── scénarios ───────────────────────────────────────────────────────────────

def scen_A_B(p, tmp: Path):
    root = tmp / "A" / "Projets"
    port = free_port()
    lent = tmp / "A" / "ralentir.txt"
    bridge = start_bridge(port, root, lent)
    zipf = tmp / "seance_A.zip"
    make_project(zipf, "proj-disque-a", "Séance disque", 3, 6)
    ctx = None
    try:
        with Step("A", "Nova Studio : stockage du navigateur vidé → séance retrouvée sur le disque") as e:
            ctx, page, errs = launch(p, tmp / "profilA", True, port)
            open_project(page, zipf, 3)
            first = wait_disk(page, 0)
            assert first, "aucune version copiée sur le disque"
            page.evaluate("() => window.DAW_CONTROL.setBpm(97)")
            before = first["versionId"]
            second = wait_disk(page, before, 40)
            assert second, "la modification n'est pas partie sur le disque"
            e["disque_avant"] = version_files(root)
            e["copie_ms"] = [first["ms"], second["ms"]]
            left = evict(page)
            e["bases_restantes_apres_vidage"] = left
            txt = landing_text(page)
            e["message_affiche"] = "retrouvée sur le disque" in txt
            assert "Reprendre ma session" in txt, "« Reprendre ma session » absent après le vidage"
            shot(page, "A1_accueil_apres_vidage")
            r = resume(page, 3)
            if not r:
                shot(page, "A_echec_reprise")
                e["erreurs_page"] = errs[:20]
                e["texte"] = page.evaluate("() => document.body.innerText")[:1500]
            assert r, "la séance n'est pas revenue"
            e["rouverte"] = r
            assert r["bpm"] == 97, f"tempo {r['bpm']} au lieu de 97 (dernière version)"
            assert r["buffers"] >= 3, "sons manquants"
            page.wait_for_timeout(1500)
            shot(page, "A2_seance_rouverte_depuis_disque")
            e["erreurs_page"] = errs[:10]

        with Step("B", "Plantage du pont pendant l'écriture : la version précédente reste intacte") as e:
            assert ctx is not None
            pdir = root / "Séance disque" / "versions"
            good = sorted(int(f.stem) for f in pdir.glob("*.json"))
            last_good = good[-1]
            last_good_bytes = (pdir / f"{last_good}.json").read_bytes()
            lent.write_text("1")
            started = tmp / "A" / "ecriture_commencee.txt"
            if started.exists():
                started.unlink()
            page.evaluate("() => window.DAW_CONTROL.setBpm(131)")
            t0 = time.time()
            while not started.exists() and time.time() - t0 < 40:
                time.sleep(0.2)
            assert started.exists(), "l'écriture de la nouvelle version n'a pas commencé"
            e["ecriture_coupee"] = started.read_text(encoding="utf-8")
            bridge.kill(); bridge.wait(10)
            lent.unlink()
            tmps = [f.name for f in pdir.iterdir() if f.name.endswith(".tmp")]
            e["fichier_temporaire_laisse"] = tmps
            assert tmps, "pas de fichier à moitié écrit (la coupure n'a pas eu lieu au bon moment)"
            complete = sorted(int(f.stem) for f in pdir.glob("*.json"))
            assert complete[-1] == last_good, "une version à moitié écrite est visible"
            assert (pdir / f"{last_good}.json").read_bytes() == last_good_bytes, "la version précédente a été abîmée"
            assert '"bpm":97' in json.loads(last_good_bytes)["json"].replace(" ", ""), "la version gardée n'est pas celle d'avant la coupure"
            ctx.close(); ctx = None
            bridge = start_bridge(port, root)
            # Tout est perdu côté navigateur (profil neuf) : le disque suffit.
            ctx, page, errs = launch(p, tmp / "profilB", True, port)
            txt = landing_text(page)
            assert "Reprendre ma session" in txt
            r = resume(page, 3)
            e["rouverte"] = r
            assert r and r["bpm"] == 97, f"rouverte : {r}"
            shot(page, "B_rouverte_apres_coupure")
            e["erreurs_page"] = errs[:10]
    finally:
        if ctx:
            ctx.close()
        bridge.kill()


FREEZE_JS = r"""() => {
  const d = window.DAW_CONTROL.diag().disk;     // même objet que le miroir (busy en direct)
  const w = window.__gel = { maxDisk: 0, maxAutre: 0, n: 0, longDisk: [], diskSeen: false };
  let last = performance.now();
  const tick = () => {
    const now = performance.now(), gap = now - last; last = now;
    const s = window.DAW_CONTROL.diag ? window.__diskRef : null;
    if (window.__diskRef.busy) { w.diskSeen = true; if (gap > w.maxDisk) w.maxDisk = gap; } else if (gap > w.maxAutre) w.maxAutre = gap;
    w.n++;
  };
  window.__diskRef = d;
  window.__gelTimer = setInterval(tick, 10);
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) if (window.__diskRef.busy) w.longDisk.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  return true;
}"""


def scen_C(p, tmp: Path):
    root = tmp / "C" / "Projets"
    port = free_port()
    bridge = start_bridge(port, root)
    zipf = tmp / "seance_40.zip"
    make_project(zipf, "proj-40-pistes", "Séance 40 pistes", 40, 20, ch=2)
    ctx = None
    try:
        with Step("C", "40 pistes copiées sur le disque sans figer l'interface plus de 100 ms") as e:
            ctx, page, errs = launch(p, tmp / "profilC", True, port)
            # Mesure posée dès que le studio est là (avant la 1re copie).
            page.goto(BASE, wait_until="domcontentloaded")
            page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
            wait_until(page, "() => !!(window.DAW_CONTROL && window.DAW_CONTROL.diag)", 30)
            page.evaluate(FREEZE_JS)
            page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
            with page.expect_file_chooser(timeout=10000) as fc:
                page.get_by_text("Charger depuis l'ordinateur").first.click()
            fc.value.set_files(str(zipf))
            done = wait_disk(page, 0, 240)
            assert done, "pas de copie sur le disque"
            gel = page.evaluate("() => { clearInterval(window.__gelTimer); return window.__gel; }")
            files = version_files(root)
            e["copie"] = done
            e["fichiers"] = files
            e["max_gel_pendant_copie_ms"] = round(gel["maxDisk"], 1)
            e["taches_longues_pendant_copie_ms"] = gel["longDisk"][:20]
            e["max_gel_hors_copie_ms_info"] = round(gel["maxAutre"], 1)
            e["copie_vue"] = gel["diskSeen"]
            sons = sum(v["audio"] for v in files.values())
            assert sons >= 40, f"{sons} sons sur le disque au lieu de 40"
            assert gel["diskSeen"], "la copie n'a pas été observée"
            assert gel["maxDisk"] <= 100, f"interface figée {gel['maxDisk']:.0f} ms pendant la copie"
            e["erreurs_page"] = errs[:10]
    finally:
        if ctx:
            ctx.close()
        bridge.kill()


def scen_D(p, tmp: Path):
    zipf = tmp / "seance_D.zip"
    make_project(zipf, "proj-web-d", "Séance web", 2, 5)
    ctx = None
    try:
        with Step("D", "Site web : protection affichée dans les réglages ; stockage vidé → message clair") as e:
            ctx, page, errs = launch(p, tmp / "profilD", False)
            open_project(page, zipf, 2)
            assert wait_autosave(page), "pas de sauvegarde automatique"
            page.wait_for_timeout(1500)
            e["persisted_navigateur"] = page.evaluate("async () => navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null")
            # Réglages audio par la palette (Ctrl+K) : le bouton de la barre peut être replié.
            page.keyboard.press("Control+k")
            page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
            page.keyboard.type("sauvegardes", delay=15)
            page.wait_for_timeout(300)
            e["palette_premier_choix"] = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
            page.keyboard.press("Enter")
            card = page.get_by_test_id("storage-protection")
            card.wait_for(timeout=15000)
            page.wait_for_timeout(800)
            e["carte_reglages"] = card.inner_text()[:900]
            assert "protégés contre l’effacement automatique du navigateur" in e["carte_reglages"] or ".zip" in e["carte_reglages"], "ni état protégé ni conseil clair"
            card.screenshot(path=str(OUTD / "D1_reglages_sauvegardes.png"))
            page.keyboard.press("Escape")
            evict(page)
            txt = landing_text(page)
            e["message_eviction"] = "effacées par le navigateur" in txt
            assert e["message_eviction"], "aucun message après l'effacement des sauvegardes"
            shot(page, "D2_message_stockage_vide")
            e["erreurs_page"] = errs[:10]
    finally:
        if ctx:
            ctx.close()


def scen_E_F_G(p, tmp: Path):
    zipf = tmp / "seance_E.zip"
    make_project(zipf, "proj-onglets", "Séance onglets", 2, 4)
    ctx = None
    try:
        ctx, page, errs = launch(p, tmp / "profilE", False)
        with Step("E", "Deux onglets sur le même projet : le 2e prévenu et ne sauvegarde pas") as e:
            open_project(page, zipf, 2)
            assert wait_autosave(page)
            page2 = ctx.new_page()
            page2.set_default_timeout(30000)
            open_project(page2, zipf, 2)
            page2.get_by_test_id("tab-lock-banner").wait_for(timeout=15000)
            e["bandeau_onglet2"] = page2.get_by_test_id("tab-lock-banner").inner_text()
            e["onglet1_peut_sauvegarder"] = page.evaluate("() => window.DAW_CONTROL.diag().tabLock.role")
            e["onglet2_peut_sauvegarder"] = page2.evaluate("() => window.DAW_CONTROL.diag().tabLock.role")
            assert e["onglet1_peut_sauvegarder"] == "owner" and e["onglet2_peut_sauvegarder"] == "guest"
            a0 = page2.evaluate("() => (window.DAW_CONTROL.diag().autosave || {}).at || 0")
            page2.evaluate("() => window.DAW_CONTROL.setBpm(77)")
            page2.wait_for_timeout(17000)
            e["onglet2_a_ecrit"] = page2.evaluate(f"() => ((window.DAW_CONTROL.diag().autosave || {{}}).at || 0) > {a0}")
            assert not e["onglet2_a_ecrit"], "l'onglet 2 a écrit une version alors qu'il n'a pas la main"
            shot(page2, "E1_onglet2_bandeau")
            page2.get_by_test_id("tab-lock-take").click()
            page.get_by_test_id("tab-lock-banner").wait_for(timeout=10000)
            e["bandeau_onglet1_apres_reprise"] = page.get_by_test_id("tab-lock-banner").inner_text()
            assert wait_autosave(page2, a0, 20), "l'onglet 2 ne sauvegarde pas après « Travailler ici »"
            shot(page, "E2_onglet1_repris")
            page2.close()

        with Step("F", "Fermeture d'onglet : fenêtre seulement s'il reste du non-sauvegardé") as e:
            # Le navigateur headless n'affiche pas la fenêtre « Quitter la page ? » : on rejoue
            # l'événement beforeunload sur la vraie page et on lit la décision du studio
            # (preventDefault = la fenêtre serait affichée).
            pf = ctx.new_page()
            open_project(pf, zipf, 2)
            pf.wait_for_timeout(1000)
            if pf.get_by_test_id("tab-lock-take").count():
                pf.get_by_test_id("tab-lock-take").click()
            assert wait_autosave(pf, 0, 30)
            pf.wait_for_timeout(500)
            ask = "() => { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; }"
            e["fenetre_si_tout_sauvegarde"] = pf.evaluate(ask)
            at = pf.evaluate("() => window.DAW_CONTROL.diag().autosave.at")
            pf.evaluate("() => window.DAW_CONTROL.setBpm(88)")
            pf.wait_for_timeout(300)
            e["fenetre_si_modifie"] = pf.evaluate(ask)
            assert wait_autosave(pf, at, 25), "pas de sauvegarde automatique après la modification"
            pf.wait_for_timeout(300)
            e["fenetre_apres_sauvegarde_auto"] = pf.evaluate(ask)
            assert e["fenetre_si_tout_sauvegarde"] is False, "fenêtre alors que tout est sauvegardé"
            assert e["fenetre_si_modifie"] is True, "pas de fenêtre alors qu'une modification n'est pas sauvegardée"
            assert e["fenetre_apres_sauvegarde_auto"] is False, "fenêtre alors que la sauvegarde automatique a tout écrit"
            pf.close()

        with Step("G", "Paiement : erreur → message, la page reste ; vers Stripe → sauvegarde d'abord") as e:
            pp = ctx.new_page()
            fails = {"n": 0}

            def fail(route, request):
                fails["n"] += 1
                return route.fulfill(status=500, content_type="application/json", body='{"error":"panne simulée"}',
                                     headers={"Access-Control-Allow-Origin": "*"})
            pp.route(f"https://*.supabase.co/functions/v1/create-checkout-session", fail)
            open_project(pp, zipf, 2)
            pp.wait_for_timeout(1000)
            if pp.get_by_test_id("tab-lock-take").count():
                pp.get_by_test_id("tab-lock-take").click()
            dialogs = []
            pp.on("dialog", lambda d: (dialogs.append(d.message[:200]), d.dismiss()))
            url0 = pp.url
            r = pp.evaluate("""async () => { const m = await window.__novaAppModule('/services/StripeManager.ts');
              return await m.stripeManager.buyInstrument({ id: 1, name: 'Beat', price_basic: 30, price_premium: 60, price_exclusive: 300 }, 'BASIC', { id: 'u' }); }""")
            e["erreur_affichee"] = r
            e["fenetres"] = dialogs
            assert fails["n"] >= 1 and r.get("error") and "page reste ouverte" in r["error"], f"réponse : {r}"
            assert not dialogs, "une fenêtre (simulation ?) s'est ouverte"
            assert pp.url == url0
            # Vers Stripe : tempo changé juste avant (pas encore dans une version), puis départ.
            pp.unroute(f"https://*.supabase.co/functions/v1/create-checkout-session")
            pp.route(f"https://*.supabase.co/functions/v1/create-checkout-session",
                     lambda route, req: route.fulfill(status=200, content_type="application/json", body='{"url":"https://checkout.stripe.test/qa"}',
                                                      headers={"Access-Control-Allow-Origin": "*"}))
            pp.route("https://checkout.stripe.test/**", lambda route, req: route.fulfill(status=200, content_type="text/html", body="<h1>Stripe (simulé)</h1>"))
            pp.evaluate("() => window.DAW_CONTROL.setBpm(123)")
            pp.wait_for_timeout(200)
            pp.evaluate("""() => { window.__novaAppModule('/services/StripeManager.ts').then(m => m.stripeManager.buyInstrument(
              { id: 1, name: 'Beat', price_basic: 30, price_premium: 60, price_exclusive: 300 }, 'BASIC', { id: 'u' })); }""")
            pp.wait_for_url("https://checkout.stripe.test/**", timeout=20000)
            pp.goto(BASE, wait_until="domcontentloaded")
            pp.get_by_text("Charger Projet").first.wait_for(timeout=60000)
            last = pp.evaluate("""async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts');
              const v = await m.recoveryStore().latest(); const r = await m.recoveryStore().getRecord(v.id);
              return { reason: v.reason, bpm: JSON.parse(r.json).bpm }; }""")
            e["derniere_version_avant_stripe"] = last
            assert last["bpm"] == 123, f"le tempo modifié juste avant le paiement n'était pas sauvegardé : {last}"
            e["erreurs_page"] = [x for x in errs if "checkout" not in x][:10]
    finally:
        if ctx:
            ctx.close()


def main():
    want = set(a.upper() for a in sys.argv[1:]) or set("ABCDEFG")
    tmp = Path(tempfile.mkdtemp(prefix="nova_sauvegarde_"))
    RES["debut"] = time.strftime("%Y-%m-%d %H:%M:%S")
    RES["url"] = BASE
    try:
        with sync_playwright() as p:
            if want & {"A", "B"}:
                scen_A_B(p, tmp)
            if "C" in want:
                scen_C(p, tmp)
            if "D" in want:
                scen_D(p, tmp)
            if want & {"E", "F", "G"}:
                scen_E_F_G(p, tmp)
    finally:
        RES["fin"] = time.strftime("%Y-%m-%d %H:%M:%S")
        save()
        shutil.rmtree(tmp, ignore_errors=True)
    print("\nRÉSULTAT :", "OK" if RES["ok"] else "ÉCHEC", "·", {k: v["ok"] for k, v in RES["etapes"].items()})
    sys.exit(0 if RES["ok"] else 1)


if __name__ == "__main__":
    main()
