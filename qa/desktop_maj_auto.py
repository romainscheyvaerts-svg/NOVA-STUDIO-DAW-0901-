"""Appli Windows : mise à jour AUTOMATIQUE du programme, de bout en bout, SANS rien installer.

  NOVA_URL=http://127.0.0.1:3429/ python qa/desktop_maj_auto.py

Ce qui tourne vraiment :
  - le code de l'appli desktop/app_update.py (manifeste, téléchargement repris, SHA-256, règle
    anti-boucle, script d'installation PowerShell caché, relance) ;
  - un FAUX installateur : petit .exe compilé ici (csc de .NET Framework, sans fenêtre) qui écrit
    seulement un fichier témoin avec ses arguments (/VERYSILENT…) ; jamais le vrai installateur ;
  - un faux « site » local (port 8802, sinon un port libre) qui sert le manifeste et l'installateur,
    et COUPE le 1er téléchargement à mi-chemin (reprise prouvée) ;
  - l'interface du DAW (serveur Vite) dans Chromium headless, avec window.__novaDesktop et un faux
    window.chrome.webview reliés au VRAI Updater Python (même protocole que WebView2).
« L'appli » = un petit processus Python caché : la fermer = le terminer ; le script d'installation
attend sa fin, revérifie l'installateur, le lance, puis relance « l'appli » (fichier témoin).
Aucune donnée de l'appli installée n'est touchée (dossier de données de test), ports 8765/8766
non utilisés, aucune fenêtre.

Preuves : téléchargement → vérification → carte « est prête » → « Plus tard » → installation à la
fermeture (/VERYSILENT, sans relance) → « Mis à jour en X.Y.Z ✓ » ; « Redémarrer et mettre à jour »
refusé pendant la lecture puis accepté (/SILENT + relance) ; installation au démarrage suivant ;
appli ancienne (1.5.2) : carte de téléchargement ; site : rien ; réglages. Bureau 1366 et téléphone
390, thèmes sombre et clair ; aucun bouton recouvert.
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-153\\maj-auto) : desktop_maj_auto.json + captures.
"""
import hashlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3429/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-153\maj-auto")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, launch, new_page, shot, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import app_update as au  # noqa: E402

from desktop_gate import install_mocks, grille_billing  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402

CREATE_NO_WINDOW = 0x08000000
WORK = OUT / "banc"
NEW = "1.5.4"
CUR = "1.5.3"
NOTES = ["Les mises à jour s’installent toutes seules à la fermeture.",
         "Le panneau de mixage s’ouvre plus vite.",
         "Corrections de stabilité du pont VST."]

checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def pythonw() -> str:
    w = Path(sys.executable).with_name("pythonw.exe")
    return str(w if w.exists() else sys.executable)


# ─────────────────────────────────────────────────────────────────────────────
# Faux installateur + faux site
# ─────────────────────────────────────────────────────────────────────────────

FAKE_CS = r"""
using System; using System.IO;
class FauxInstallateur {
  static int Main(string[] a) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    File.AppendAllText(Path.Combine(dir, "temoin-installeur.txt"), DateTime.Now.ToString("o") + " | " + string.Join(" ", a) + Environment.NewLine);
    System.Threading.Thread.Sleep(600);
    return 0;
  }
}
"""


def build_fake_installer() -> bytes:
    src = WORK / "faux_installateur.cs"
    exe = WORK / "faux_installateur.exe"
    src.write_text(FAKE_CS, encoding="utf-8")
    csc = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
    subprocess.run([str(csc), "/nologo", "/target:winexe", f"/out:{exe}", str(src)], check=True,
                   creationflags=CREATE_NO_WINDOW, capture_output=True)
    # Un vrai installateur pèse ~51 Mo ; le manifeste exige au moins 100 ko : données ajoutées en fin
    # de fichier (ignorées par Windows au lancement).
    return exe.read_bytes() + os.urandom(400_000)


class Site:
    files = {}
    manifest = {}
    cut_next = 0
    log = []


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        Site.log.append((path, self.headers.get("Range")))
        if path == "/downloads/nova-studio-latest.json":
            body = json.dumps(Site.manifest).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        data = Site.files.get(path)
        if data is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start = 0
        rng = self.headers.get("Range")
        if rng:
            start = int(rng.split("=")[1].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
        else:
            self.send_response(200)
        body = data[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if Site.cut_next > 0:  # coupure réseau au milieu du téléchargement
            Site.cut_next -= 1
            self.wfile.write(body[: len(body) // 2])
            self.wfile.flush()
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return
        self.wfile.write(body)


def free_port(pref=8802) -> int:
    for p in (pref, 0):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            return s.getsockname()[1]
        except OSError:
            continue
        finally:
            s.close()
    raise RuntimeError("aucun port libre")


# ─────────────────────────────────────────────────────────────────────────────
# « L'appli » : un processus caché qu'on ferme ; sa relance écrit un témoin
# ─────────────────────────────────────────────────────────────────────────────

RELAUNCH_PY = """import sys, time
open(sys.argv[1], 'a', encoding='utf-8').write(time.strftime('%H:%M:%S') + ' relance ' + ' '.join(sys.argv[2:]) + '\\n')
"""


def start_app() -> subprocess.Popen:
    return subprocess.Popen([pythonw(), "-c", "import time; time.sleep(900)"], creationflags=CREATE_NO_WINDOW,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_file(path: Path, timeout=60) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if path.exists() and path.stat().st_size > 0:
            return True
        time.sleep(0.3)
    return False


def make_updater(name: str, version: str, logs: list, outbox: list) -> au.Updater:
    data = WORK / name
    relaunch_marker = WORK / f"{name}-relance.txt"
    return au.Updater(version, str(data), f"NovaStudioDesktop/{version}", log=logs.append, post=outbox.append,
                      origin=au.update_origin(), relaunch_cmd=[pythonw(), str(WORK / "relance.py"), str(relaunch_marker), name],
                      backoff=(0.2,))


# ─────────────────────────────────────────────────────────────────────────────
# Page : faux WebView2 relié à l'Updater
# ─────────────────────────────────────────────────────────────────────────────

DESKTOP_JS = """
(function () {
  window.__novaDesktop = { version: %(version)s, platform: 'windows', ui: 'qa', features: %(features)s, bridges: { asio: 8766, vst: 8765 } };
  var listeners = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: function (m) { window.__novaToPython(String(m)); },
    addEventListener: function (t, h) { if (t === 'message') listeners.push(h); },
    removeEventListener: function (t, h) { listeners = listeners.filter(function (x) { return x !== h; }); }
  };
  window.__novaFromPython = function (s) { listeners.slice().forEach(function (h) { h({ data: s }); }); };
})();
"""
FEATURES_NEW = ["google-login", "stems", "voice", "reveal-download", "pick-folder", "app-update"]
FEATURES_OLD = ["google-login", "stems", "voice", "reveal-download", "pick-folder"]


class Bridge:
    """Ce que fait nova_desktop.py (on_app_update_message / apply_app_update), dans le fil du test."""

    def __init__(self, page, updater: au.Updater, outbox: list):
        self.page, self.up, self.outbox = page, updater, outbox
        self.inbox = []
        self.closed = False
        page.expose_function("__novaToPython", lambda m: self.inbox.append(m))

    def pump(self, ms=300):
        end = time.time() + ms / 1000
        while True:
            while self.inbox:
                m = self.inbox.pop(0)
                if not m.startswith("nova-desktop:update:"):
                    continue
                cmd = m[len("nova-desktop:update:"):]
                if cmd == "hello":
                    self.up.push()
                elif cmd == "check":
                    self.up.check(manual=True)
                elif cmd in ("auto:on", "auto:off"):
                    self.up.set_auto(cmd == "auto:on")
                elif cmd == "later":
                    self.up.later()
                elif cmd == "seen":
                    self.up.seen_announce()
                elif cmd == "apply":
                    probe = self.page.evaluate(au.BUSY_PROBE_JS)
                    if self.up.request_apply(probe) is None:
                        self.closed = True  # l'appli sauvegarde puis ferme sa fenêtre
            while self.outbox:
                self.page.evaluate("s => window.__novaFromPython(s)", json.dumps(self.outbox.pop(0)))
            if time.time() >= end:
                return
            self.page.wait_for_timeout(50)


def open_page(browser, vp, theme, version, features, updater=None, outbox=None):
    ctx, page = new_page(browser, vp)
    if version is not None:  # appli Windows : compte connecté (porte de connexion simulée)
        install_mocks(page, "artiste", grille_billing(), {})
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
    if version is not None:
        page.add_init_script(DESKTOP_JS % {"version": json.dumps(version), "features": json.dumps(features)})
    page.route("**/downloads/nova-studio-latest.json*", lambda route, req: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(Site.manifest)))
    bridge = Bridge(page, updater, outbox) if updater is not None else None
    if bridge is None and version is not None:
        page.expose_function("__novaToPython", lambda m: None)
    page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=60000)
    return ctx, page, bridge


def enter_studio(page, bridge=None):
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(1200)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 45)
    page.wait_for_timeout(800)
    if bridge:
        bridge.pump(600)


def overlap(page, tag):
    """Aucun bouton recouvert par la carte, et aucun bouton de la carte recouvert."""
    r = balayage_chevauchement(page)
    bad = [x for x in r.get("recouverts", [])
           if "app-update" in json.dumps(x) or "Redémarrer" in x.get("el", "") or "Plus tard" in x.get("el", "")
           or "Télécharger la mise" in x.get("el", "")]
    check(f"{tag} : aucun bouton recouvert par la carte ({r.get('boutons')} boutons)", not bad, bad)
    return r


def card_in_flow(page, sel):
    """La carte est DANS la page (position statique), pas flottante par-dessus le contenu."""
    return page.evaluate("""(sel) => { const el = document.querySelector(sel); if (!el) return null;
      const cs = getComputedStyle(el); return { position: cs.position, h: Math.round(el.getBoundingClientRect().height) }; }""", sel)


# ─────────────────────────────────────────────────────────────────────────────
# Scénario
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    if WORK.exists():
        shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "relance.py").write_text(RELAUNCH_PY, encoding="utf-8")
    payload = build_fake_installer()
    sha = hashlib.sha256(payload).hexdigest()
    Site.files = {f"/downloads/NovaStudioSetup-{NEW}.exe": payload}
    Site.manifest = {"version": NEW, "url": f"downloads/NovaStudioSetup-{NEW}.exe", "sha256": sha, "size": len(payload),
                     "date": "2026-10-19T23:00:00+02:00", "notes": NOTES}
    port = free_port()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ[au.TEST_ORIGIN_ENV] = f"http://127.0.0.1:{port}"
    check("origine de test acceptée (127.0.0.1 seulement)", au.update_origin() == f"http://127.0.0.1:{port}")
    res = {"port": port, "sha256": sha, "taille": len(payload)}
    apps = []
    try:
        # ── 1. téléchargement en arrière-plan, coupé puis repris, vérifié ───────
        logs, outbox = [], []
        up = make_updater("seance1", CUR, logs, outbox)
        up.startup()
        Site.cut_next, Site.log = 1, []
        phase = up.check()
        ranges = [r for p, r in Site.log if p.endswith(".exe")]
        dl = Path(up.dir) / f"NovaStudioSetup-{NEW}.exe"
        check("téléchargement coupé à mi-chemin puis repris (Range), installateur vérifié",
              phase == "ready" and len(ranges) == 2 and ranges[0] is None and (ranges[1] or "").startswith("bytes=")
              and au.verify_file(str(dl), sha, len(payload)), {"phase": phase, "plages": ranges, "journal": logs[-4:]})
        res["telechargement"] = {"plages": ranges, "journal": logs}

        with sync_playwright() as p:
            browser = launch(p)
            # ── 2. carte « est prête » dans la page (bureau, sombre puis clair) ──
            for theme in ("dark", "light"):
                outbox.clear()
                up.dismissed = False  # nouvelle ouverture de l'appli
                ctx, page, br = open_page(browser, "pc1366", theme, CUR, FEATURES_NEW, up, outbox)
                enter_studio(page, br)
                card = page.get_by_test_id("app-update-card")
                card.wait_for(timeout=10000)
                txt = card.inner_text()
                check(f"[{theme}] carte « Nova Studio {NEW} est prête » avec les nouveautés et 2 boutons",
                      f"Nova Studio {NEW} est prête" in txt and NOTES[1] in txt and "Redémarrer et mettre à jour" in txt
                      and "Plus tard" in txt, txt)
                pos = card_in_flow(page, "[data-testid=app-update-card]")
                check(f"[{theme}] carte posée dans la page (pas flottante)", pos and pos["position"] == "static", pos)
                shot(page, f"1_carte_prete_bureau_{theme}")
                overlap(page, f"[{theme}] bureau")
                if theme == "dark":
                    check("window.__novaBusy fourni par le DAW (rien en cours)",
                          page.evaluate(au.BUSY_PROBE_JS) == {"recording": False, "playing": False, "collab": False, "src": "page"},
                          page.evaluate(au.BUSY_PROBE_JS))
                    # « Plus tard » : la carte disparaît, l'installation se fera à la fermeture
                    page.get_by_test_id("app-update-later").click()
                    br.pump(400)
                    check("« Plus tard » : carte retirée", page.get_by_test_id("app-update-card").count() == 0
                          and up.snapshot()["dismissed"])
                    shot(page, "2_apres_plus_tard")
                ctx.close()

            # ── 3. fermeture de l'appli : installation cachée, sans relance ──────
            app = start_app(); apps.append(app)
            launched = up.on_exit(app.pid)
            check("à la fermeture : script d'installation lancé (caché)", launched and au.install_in_progress(up.dir))
            time.sleep(1.0)
            check("rien n'est lancé tant que l'appli tourne", not (Path(up.dir) / "temoin-installeur.txt").exists())
            app.kill(); app.wait(10)
            temoin = Path(up.dir) / "temoin-installeur.txt"
            ok = wait_file(Path(up.dir) / au.RESULT_FILE, 60)
            t = temoin.read_text(encoding="utf-8") if temoin.exists() else ""
            result = au.read_result(up.dir)
            check("faux installateur lancé APRÈS la fermeture, en /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS",
                  ok and "/VERYSILENT" in t and "/SUPPRESSMSGBOXES" in t and "/NORESTART" in t and "/CLOSEAPPLICATIONS" in t,
                  {"temoin": t, "resultat": result})
            check("compte rendu : code 0, sans erreur ; verrou retiré", result and result.get("exitCode") == 0
                  and not result.get("error") and not au.install_in_progress(up.dir), result)
            time.sleep(1.5)
            check("fermeture normale : l'appli n'est PAS relancée", not (WORK / "seance1-relance.txt").exists())
            res["fermeture"] = {"temoin": t, "resultat": result}

            # ── 4. démarrage de la nouvelle version : « Mis à jour en X ✓ » une fois ──
            logs2, outbox2 = [], []
            up_new = make_updater("seance1", NEW, logs2, outbox2)
            up_new.startup()
            ctx, page, br = open_page(browser, "pc1366", "dark", NEW, FEATURES_NEW, up_new, outbox2)
            enter_studio(page, br)
            done = page.get_by_test_id("app-update-done")
            done.wait_for(timeout=10000)
            dtxt = done.inner_text()
            check(f"« Mis à jour en {NEW} ✓ » avec les nouveautés", f"Mis à jour en {NEW} ✓" in dtxt and NOTES[0] in dtxt, dtxt)
            shot(page, "3_mis_a_jour_bureau_dark")
            overlap(page, "« Mis à jour » bureau")
            page.get_by_test_id("app-update-done-ok").click()
            br.pump(300)
            ctx.close()
            check("annonce montrée une seule fois (oubliée après affichage)",
                  make_updater("seance1", NEW, [], []).snapshot()["justUpdated"] is None)
            check("installateur retiré du dossier des mises à jour",
                  not any(n.startswith(au.INSTALLER_PREFIX) for n in os.listdir(up_new.dir)))

            # ── 5. « Redémarrer et mettre à jour » : refusé pendant la lecture, puis relance ──
            logs3, outbox3 = [], []
            up2 = make_updater("seance2", CUR, logs3, outbox3)
            up2.startup()
            check("2e séance : téléchargée et prête", up2.check() == "ready")
            ctx, page, br = open_page(browser, "pc1366", "dark", CUR, FEATURES_NEW, up2, outbox3)
            enter_studio(page, br)
            page.get_by_test_id("app-update-card").wait_for(timeout=10000)
            page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")
            page.keyboard.press("Space")  # lecture
            page.wait_for_timeout(900)
            playing = page.evaluate("() => window.__novaBusy && window.__novaBusy().playing")
            page.get_by_test_id("app-update-apply").click()
            br.pump(600)
            busy = page.get_by_test_id("app-update-busy")
            check("pendant la lecture : redémarrage refusé, message clair", playing and busy.count() == 1
                  and "lecture est en cours" in busy.inner_text() and not br.closed,
                  {"playing": playing, "texte": busy.inner_text() if busy.count() else None})
            shot(page, "4_refus_pendant_lecture")
            page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")
            page.keyboard.press("Space")  # pause
            page.wait_for_timeout(700)
            # enregistrement en cours (état lu par l'appli) : refusé aussi
            page.evaluate("() => { window.__qaBusy = window.__novaBusy; window.__novaBusy = () => ({ recording: true, playing: true, collab: false }); }")
            page.get_by_test_id("app-update-apply").click()
            br.pump(500)
            check("pendant un enregistrement : refusé", "enregistrement est en cours" in page.get_by_test_id("app-update-busy").inner_text()
                  and not br.closed)
            page.evaluate("() => { window.__novaBusy = () => ({ recording: false, playing: false, collab: true }); }")
            page.get_by_test_id("app-update-apply").click()
            br.pump(500)
            check("pendant une collaboration : refusé", "collaboration est ouverte" in page.get_by_test_id("app-update-busy").inner_text()
                  and not br.closed)
            page.evaluate("() => { window.__novaBusy = window.__qaBusy; }")
            page.get_by_test_id("app-update-apply").click()
            br.pump(600)
            check("rien en cours : accepté (sauvegarde puis fermeture)", br.closed and up2.relaunch_requested)
            check("carte : « Redémarrage… »", "Redémarrage" in page.get_by_test_id("app-update-card").inner_text())
            shot(page, "5_redemarrage_demande")
            ctx.close()
            app = start_app(); apps.append(app)
            check("fermeture : installation lancée en mode « à la demande »", up2.on_exit(app.pid))
            app.kill(); app.wait(10)
            ok = wait_file(Path(up2.dir) / au.RESULT_FILE, 60)
            relance = WORK / "seance2-relance.txt"
            ok_rel = wait_file(relance, 30)
            t2 = (Path(up2.dir) / "temoin-installeur.txt").read_text(encoding="utf-8") if ok else ""
            check("installateur en /SILENT (petite fenêtre de progression) puis appli relancée",
                  ok and "/SILENT" in t2 and "/VERYSILENT" not in t2 and ok_rel,
                  {"temoin": t2, "relance": relance.read_text(encoding="utf-8") if ok_rel else None})
            res["redemarrer"] = {"temoin": t2, "relance": relance.read_text(encoding="utf-8") if ok_rel else None}

            # ── 6. pas installée à la fermeture (appli tuée) : au démarrage suivant ──
            logs4 = []
            up3 = make_updater("seance3", CUR, logs4, [])
            up3.startup(); up3.check()
            app = start_app(); apps.append(app)
            up3b = make_updater("seance3", CUR, logs4, [])  # nouveau démarrage, avant la fenêtre
            up3b.startup()
            started = up3b.startup_install(app.pid)
            app.kill(); app.wait(10)
            ok = wait_file(Path(up3b.dir) / au.RESULT_FILE, 60) and wait_file(WORK / "seance3-relance.txt", 30)
            t3 = (Path(up3b.dir) / "temoin-installeur.txt").read_text(encoding="utf-8") if ok else ""
            check("au démarrage suivant : installée avant la fenêtre (/SILENT), puis relance", started and ok and "/SILENT" in t3, t3)
            # échec simulé (version inchangée au redémarrage) : pas de boucle le même jour
            up3c = make_updater("seance3", CUR, logs4, [])
            up3c.startup()
            check("installation ratée : ancienne version gardée, pas de nouvel essai aujourd'hui",
                  not up3c.startup_install(os.getpid()) and au.load_state(up3c.dir)["attempts"][NEW]["result"] == "fail",
                  logs4[-3:])

            # ── 7. téléphone 390 (carte dans la page) + clair ───────────────────
            for theme in ("dark", "light"):
                logs5, outbox5 = [], []
                up5 = make_updater(f"tel-{theme}", CUR, logs5, outbox5)
                up5.check()
                ctx, page, br = open_page(browser, "tel390", theme, CUR, FEATURES_NEW, up5, outbox5)
                enter_studio(page, br)
                page.get_by_test_id("app-update-card").wait_for(timeout=10000)
                pos = card_in_flow(page, "[data-testid=app-update-card]")
                check(f"[téléphone {theme}] carte dans la page", pos and pos["position"] == "static", pos)
                shot(page, f"6_carte_prete_tel390_{theme}")
                overlap(page, f"[téléphone {theme}]")
                ctx.close()

            # ── 8. appli ancienne (1.5.2) : carte de téléchargement (côté web) ──
            for vp, theme in (("pc1366", "dark"), ("pc1366", "light"), ("tel390", "dark")):
                ctx, page, _ = open_page(browser, vp, theme, "1.5.2", FEATURES_OLD)
                card = page.get_by_test_id("app-update-legacy")
                card.wait_for(timeout=10000)
                ctxt = card.inner_text()
                check(f"[ancienne appli {vp} {theme}] « Une nouvelle version de Nova Studio est disponible »",
                      "Une nouvelle version de Nova Studio est disponible" in ctxt and NEW in ctxt and "Tu as la version 1.5.2" in ctxt, ctxt)
                href = page.get_by_test_id("app-update-legacy-download").get_attribute("href")
                check(f"[ancienne appli {vp} {theme}] bouton qui télécharge l'installateur du site", href == "/downloads/NovaStudioSetup.exe", href)
                pos = card_in_flow(page, "[data-testid=app-update-legacy]")
                check(f"[ancienne appli {vp} {theme}] carte dans la page", pos and pos["position"] == "static", pos)
                shot(page, f"7_ancienne_appli_{vp}_{theme}")
                overlap(page, f"[ancienne appli {vp} {theme}] accueil")
                if vp == "pc1366" and theme == "dark":
                    page.route("**/downloads/NovaStudioSetup.exe", lambda route, req: route.fulfill(
                        status=200, body=b"MZ" + b"\0" * 2000, headers={"Content-Type": "application/octet-stream",
                                                                       "Content-Disposition": 'attachment; filename="NovaStudioSetup.exe"'}))
                    with page.expect_download(timeout=10000) as d:
                        page.get_by_test_id("app-update-legacy-download").click()
                    check("clic : l'installateur se télécharge, puis « Ouvrir le dossier »",
                          d.value.suggested_filename == "NovaStudioSetup.exe" and page.get_by_test_id("app-update-legacy-reveal").count() == 1)
                    shot(page, "8_ancienne_appli_telechargement_lance")
                    page.get_by_test_id("app-update-legacy-later").click()
                    page.wait_for_timeout(300)
                    check("« Plus tard » : carte retirée pour cette version", page.get_by_test_id("app-update-legacy").count() == 0)
                ctx.close()
            # nouvelle appli : la carte web ne s'affiche pas (le natif s'en charge)
            logs6, outbox6 = [], []
            up6 = make_updater("seance6", NEW, logs6, outbox6)  # à jour : rien de prêt
            ctx, page, br = open_page(browser, "pc1366", "dark", "1.5.3", FEATURES_NEW, up6, outbox6)
            br.pump(1500)
            check("appli avec mise à jour native : pas de carte web", page.get_by_test_id("app-update-legacy").count() == 0)
            ctx.close()
            # site (navigateur) : rien
            seen = []
            ctx, page, _ = open_page(browser, "pc1366", "dark", None, None)
            page.on("request", lambda r: seen.append(r.url) if "nova-studio-latest" in r.url else None)
            page.reload(wait_until="domcontentloaded", timeout=90000)
            page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=60000)
            page.wait_for_timeout(1500)
            check("site (navigateur) : ni carte, ni manifeste lu",
                  page.get_by_test_id("app-update-legacy").count() == 0 and page.get_by_test_id("app-update-card").count() == 0
                  and not seen, seen)
            ctx.close()

            # ── 9. réglages : version, « Mises à jour automatiques », « Rechercher maintenant » ──
            for theme in ("dark", "light"):
                logs7, outbox7 = [], []
                up7 = make_updater(f"reglages-{theme}", CUR, logs7, outbox7)
                Site.manifest = {**Site.manifest, "version": CUR}  # en ligne = installée : à jour
                ctx, page, br = open_page(browser, "pc1366", theme, CUR, FEATURES_NEW, up7, outbox7)
                enter_studio(page, br)
                page.keyboard.press("Control+k")
                page.wait_for_timeout(400)
                page.keyboard.type("mise à jour de Nova Studio")
                page.wait_for_timeout(500)
                page.keyboard.press("Enter")
                br.pump(1500)
                sett = page.get_by_test_id("app-update-settings")
                sett.wait_for(timeout=10000)
                sett.scroll_into_view_if_needed()
                br.pump(500)
                stxt = sett.inner_text()
                check(f"[réglages {theme}] palette Ctrl+K → réglages : version installée + à jour",
                      f"version installée : {CUR}" in stxt and "Nova Studio est à jour" in stxt and "Mises à jour automatiques" in stxt, stxt)
                sw = page.get_by_test_id("app-update-auto")
                check(f"[réglages {theme}] « Mises à jour automatiques » activé par défaut", sw.is_checked())
                if theme == "dark":
                    sw.click(); br.pump(400)
                    check("interrupteur coupé : mémorisé par l'appli", not au.load_state(up7.dir)["auto"] and not sw.is_checked())
                    sw.click(); br.pump(400)
                    Site.manifest = {**Site.manifest, "version": NEW}
                    page.get_by_test_id("app-update-check").click()
                    br.pump(1500)
                    stxt = page.get_by_test_id("app-update-status").inner_text()
                    check("« Rechercher maintenant » : nouvelle version téléchargée et prête", f"Nova Studio {NEW} est prête" in stxt, stxt)
                shot(page, f"9_reglages_{theme}")
                # La fenêtre des réglages recouvre (normalement) la page : on vérifie ses propres boutons.
                r = balayage_chevauchement(page, "[data-testid=app-update-settings]")
                check(f"[réglages {theme}] boutons du réglage non recouverts ({r.get('boutons')})", not r.get("recouverts"), r.get("recouverts"))
                Site.manifest = {**Site.manifest, "version": NEW}
                ctx.close()
            browser.close()
    finally:
        for a in apps:
            try:
                a.kill()
            except Exception:
                pass
        srv.shutdown()
    ok = sum(c["ok"] for c in checks)
    res["verifications"] = checks
    res["resume"] = f"{ok}/{len(checks)}"
    (OUT / "desktop_maj_auto.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{ok}/{len(checks)} vérifications réussies", flush=True)
    return 0 if ok == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
