# -*- coding: utf-8 -*-
"""Appli Windows (VRAIE fenêtre WebView2 de desktop/nova_desktop.py) et son intégration à Windows,
mesurée comme un ingé son qui l'utilise des heures : rien n'apparaît à l'écran (fenêtres posées hors
écran et jamais activées), profil jetable (la vraie Nova Studio ouverte n'est jamais touchée), sans
les ponts (ports 8765/8766 jamais utilisés), réseau de la page coupé (aucune requête vers la production).

Vérifie et mesure :
  1. démarrage à froid puis à chaud (lancement -> DAW monté) ;
  2. Cache Storage du DAW (beats, kits, pochettes, modèle de stems) GARDÉ d'un lancement à l'autre
     (jusqu'à la 1.5.15 : vidé à chaque démarrage, donc tout retéléchargé) ;
  3. place et taille de la fenêtre retenues à la fermeture (fenetre.json) ;
  4. un fichier lâché hors d'une zone d'import (navigation file://) n'ouvre plus le fichier À LA
     PLACE du DAW : navigation bloquée, bandeau d'explication, DAW toujours là ;
  5. fenêtre détachée (console sur le 2e écran) : fenêtre de Nova (possédée, pas de bouton de plus
     dans la barre des tâches), titre de la vue, protégée des captures comme la fenêtre principale,
     même origine que le studio, fermée par la page, fermée avec Nova (aucun processus qui reste) ;
  6. 2e lancement : ramène l'instance ouverte et s'arrête (pas de 2e fenêtre) ;
  7. Nova tuée net (plantage) : aucun processus orphelin, relance normale ;
  8. fermeture : aucun processus de Nova encore là (moteur WebView2 compris) peu après ;
  9. prise en cours (window.__novaBusy) : veille de Windows bloquée, puis permise à la fin.

  NOVA_URL=... PYTHONIOENCODING=utf-8 python qa/desktop_systeme.py
Sortie : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-auditos\\desktop_systeme)
"""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-auditos\desktop_systeme"))

if __name__ == "__main__" and os.environ.get("_DESKTOP_SYSTEME_ENFANT") != "1":
    # Processus de la batterie : compteur hors production, puis le travail dans le Python de l'appli
    # (il a websockets pour le port de débogage).
    sys.path.insert(0, str(HERE))
    import qa_hors_prod  # noqa: F401,E402
    from desktop_appli import VENV_PY  # noqa: E402
    env = dict(os.environ, _DESKTOP_SYSTEME_ENFANT="1", PYTHONIOENCODING="utf-8")
    p = subprocess.run([str(VENV_PY), "-I", str(Path(__file__).resolve())], env=env, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", creationflags=0x08000000)
    sys.stdout.write(p.stdout + p.stderr)
    sys.stdout.flush()
    sys.exit(p.returncode)

try:  # lancé avec -I (PYTHONIOENCODING ignoré) : sortie en UTF-8 pour la batterie
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "desktop"))
from desktop_appli import App, alive, descendants, process_table, rect, windows_of  # noqa: E402
import capture_guard  # noqa: E402

RES = {"name": "desktop_systeme", "ok": True, "etapes": {}, "mesures": {}}
CDP = 9471


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    if not v:
        RES["ok"] = False
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:400], flush=True)


def wait_gone(pids, limit=20.0):
    t0 = time.time()
    while alive(pids) and time.time() - t0 < limit:
        time.sleep(0.25)
    return alive(pids), round(time.time() - t0, 1)


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    d = tempfile.mkdtemp(prefix="nova-qa-systeme-")
    wav = os.path.join(d, "voix a importer.wav")
    import wave
    with wave.open(wav, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b"\0\0" * 4410)
    try:
        # ── 1, 2, 3 : démarrage à froid, cache, place de la fenêtre ─────────────
        a = App(d, CDP)
        try:
            RES["mesures"]["demarrage_froid_s"] = a.wait_mounted()
            put = a.ev("""(async () => { for (const n of ['nova-audio-v1', 'nova-kits-v1', 'nova-images-v1', 'nova-models-v1']) {
                const c = await caches.open(n); await c.put('https://exemple.test/' + n, new Response('x'.repeat(4096))); }
                return (await caches.keys()).sort(); })()""")
            ok("caches du DAW remplis", len(put) >= 4, put)
            hw = a.main_window()
            RES["mesures"]["fenetre_principale"] = rect(hw)
        finally:
            c1 = a.close(timeout=60)
        ok("fermeture normale", c1["secondes"] is not None and c1["secondes"] < 10, c1)
        try:
            saved = json.loads(Path(d, "fenetre.json").read_text(encoding="utf-8"))
        except Exception as e:
            saved = str(e)
        ok("place de la fenêtre retenue", isinstance(saved, dict) and (saved["x"], saved["y"], saved["w"], saved["h"]) == tuple(RES["mesures"]["fenetre_principale"]),
           saved)

        a = App(d, CDP, extra_env={"NOVA_DESKTOP_AWAKE_POLL": "1"})
        try:
            RES["mesures"]["demarrage_chaud_s"] = a.wait_mounted()
            keys = sorted(a.ev("caches.keys()"))
            ok("Cache Storage gardé au redémarrage (beats, kits, pochettes, modèle)",
               all(k in keys for k in ("nova-audio-v1", "nova-kits-v1", "nova-images-v1", "nova-models-v1")), keys)
            body = a.ev("(async () => { const c = await caches.open('nova-audio-v1'); const r = await c.match('https://exemple.test/nova-audio-v1'); return r ? (await r.text()).length : -1; })()")
            ok("contenu du cache intact", body == 4096, body)

            # ── veille de Windows pendant une prise ───────────────────────────
            a.ev("window.__novaBusy = () => ({ recording: true, playing: false, collab: false }); 1")
            log_path = Path(d, "logs", "app.log")
            seen = False
            for _ in range(40):
                time.sleep(0.25)
                if "veille de Windows bloquée (prise en cours)" in log_path.read_text(encoding="utf-8", errors="replace"):
                    seen = True
                    break
            ok("prise en cours : veille de Windows bloquée", seen)
            a.ev("window.__novaBusy = () => ({ recording: false, playing: false, collab: false }); 1")
            seen = False
            for _ in range(40):
                time.sleep(0.25)
                if "veille de Windows permise" in log_path.read_text(encoding="utf-8", errors="replace"):
                    seen = True
                    break
            ok("prise finie : veille de Windows permise", seen)

            # ── 4 : fichier lâché à côté d'une zone d'import ──────────────────
            url = "file:///" + wav.replace("\\", "/").replace(" ", "%20")
            a.cdp_call("Page.navigate", {"url": url})
            time.sleep(1.5)
            href = a.ev("location.href", 5)
            ok("fichier lâché : le DAW reste affiché", href.startswith("https://"), href)
            hint = a.ev("(document.getElementById('nova-desktop-drop-hint') || {}).textContent || ''", 5)
            ok("fichier lâché : bandeau d'explication", "dépose-le sur la zone des pistes" in hint, hint)
            ok("fichier lâché : DAW toujours monté", a.ev("!!document.getElementById('root').children.length", 5))

            # (QA_AVANT=1 : ancienne version mesurée ; sa fenêtre détachée et son 2e lancement apparaîtraient
            #  à l'écran ou ramèneraient la vraie Nova : étapes sautées)
            if os.environ.get("QA_AVANT") != "1":
                # ── 5 : fenêtre détachée ────────────────────────────────────────
                r = a.cdp_call("Runtime.evaluate", {"expression": "(() => { window.__qaPop = window.open('/popout.html', 'nova-console', "
                                                    "'popup=yes,width=900,height=520,left=40,top=40'); return !!window.__qaPop; })()",
                                                    "userGesture": True, "returnByValue": True})
                ok("fenêtre détachée ouverte", r.get("result", {}).get("result", {}).get("value") is True, r.get("result"))
                same = None
                for _ in range(60):
                    time.sleep(0.1)
                    try:
                        same = a.ev("(() => { try { const w = window.__qaPop; if (w.document.readyState !== 'complete') return null; "
                                    "w.document.title = 'Console · NOVA'; return w.location.pathname; } catch (e) { return 'ERR ' + e.name; } })()", 3)
                    except Exception:
                        same = None
                    if same:
                        break
                ok("fenêtre détachée : même origine que le studio (popout.html servi en local)", same == "/popout.html", same)
                time.sleep(0.6)
                wins = windows_of(a.pids())
                main = [w for w in wins if w[3] == 0]
                pops = [w for w in wins if w[3] != 0]
                info = [{"titre": t, "barre_des_taches": bool(ex & 0x40000), "possedee": own != 0, "rect": rect(h),
                         "anti_capture": capture_guard.display_affinity(h)} for h, t, ex, own in wins]
                RES["mesures"]["fenetres_avec_console"] = info
                ok("fenêtre détachée possédée par Nova (pas de bouton de plus dans la barre des tâches)",
                   len(main) == 1 and len(pops) == 1 and not (pops[0][2] & 0x40000), info)
                ok("fenêtre détachée : titre de la vue (pas l'adresse du site)", pops and pops[0][1] == "Console · NOVA", info)
                ok("fenêtre détachée protégée des captures comme la fenêtre principale",
                   pops and capture_guard.display_affinity(pops[0][0]) == capture_guard.display_affinity(main[0][0]) != 0, info)
                ok("fenêtre détachée hors écran pendant le test (jamais devant Romain)", pops and rect(pops[0][0])[0] < -10000, info)
                closed = a.ev("(async () => { window.__qaPop.close(); await new Promise(r => setTimeout(r, 900)); return window.__qaPop.closed; })()")
                ok("fenêtre détachée fermée par la page", closed is True and len(windows_of(a.pids())) == 1)
                a.cdp_call("Runtime.evaluate", {"expression": "window.__qaPop = window.open('/popout.html', 'nova-console', 'popup=yes,width=900,height=520'); 1",
                                                "userGesture": True})
                time.sleep(2.0)
                ok("console rouverte avant de quitter Nova", len(windows_of(a.pids())) == 2)

                # ── 6 : 2e lancement ────────────────────────────────────────────
                t0 = time.perf_counter()
                b = App(d, CDP + 1)
                try:
                    b.proc.wait(30)
                    code = b.proc.returncode
                except subprocess.TimeoutExpired:
                    code = "toujours ouvert"
                    b.kill()
                RES["mesures"]["deuxieme_lancement_s"] = round(time.perf_counter() - t0, 2)
                ok("2e lancement : s'arrête et laisse la fenêtre ouverte", code == 0 and a.proc.poll() is None,
                   {"code": code, "secondes": RES["mesures"]["deuxieme_lancement_s"]})
            tree = descendants(a.pid)
        finally:
            c2 = a.close(timeout=60)
        RES["mesures"]["fermeture_avec_console"] = c2
        rest, secs = wait_gone(tree - {a.pid})
        RES["mesures"]["processus_restants_apres_s"] = secs
        ok("fermeture avec la console ouverte : plus aucun processus de Nova (≤ 20 s)", not rest, {"restants": rest, "secondes": secs})

        # ── 7 : plantage (processus tué net) puis relance ─────────────────
        a = App(d, CDP)
        try:
            a.wait_mounted()
            t = process_table()
            tree = descendants(a.pid, t)
            py = [p for p in tree if p != a.pid and t[p][1].lower().startswith("python")]
            subprocess.run(["taskkill", "/F", "/PID", str(py[0])], capture_output=True, creationflags=0x08000000)
            rest, secs = wait_gone(tree - {a.pid, py[0]}, 20)
            ok("Nova tuée net : aucun processus orphelin", not rest, {"restants": rest, "secondes": secs})
        finally:
            a.kill()
        a = App(d, CDP)
        try:
            RES["mesures"]["relance_apres_plantage_s"] = a.wait_mounted()
            ok("relance après plantage", RES["mesures"]["relance_apres_plantage_s"] < 30)
        finally:
            a.close(timeout=60)
    except Exception as e:  # noqa
        ok(f"EXCEPTION {type(e).__name__}", False, str(e)[:400])
    finally:
        time.sleep(1)
        shutil.rmtree(d, ignore_errors=True)
    (OUT / "resultat.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(RES["mesures"], ensure_ascii=False), flush=True)
    return RES["ok"]


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
