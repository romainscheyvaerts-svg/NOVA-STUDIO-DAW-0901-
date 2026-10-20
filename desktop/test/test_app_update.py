# -*- coding: utf-8 -*-
"""
Tests de la mise à jour du PROGRAMME (app_update.py) et de sa publication (build.publish_update),
sans Internet et sans rien installer : un faux « site » est servi en local (127.0.0.1).

  python test\\test_app_update.py

Couvre : comparaison de versions (jamais de rétrogradation), origine fixe + HTTPS, manifeste
vérifié champ par champ, téléchargement repris après une coupure (Range), contrôle SHA-256 et
taille, redirections refusées, règle anti-boucle (une tentative par version et par jour), décision
« pas pendant un enregistrement / une lecture / une collaboration », installation à la fermeture
ou au démarrage (script lancé caché, faux Popen), manifeste écrit par build.py.
"""
import hashlib
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import app_update as au  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'OK' if ok else 'ÉCHEC'}] {name} {detail}")


def raises(fn, *a, **kw):
    try:
        fn(*a, **kw)
    except au.UpdateError as e:
        return str(e)
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Faux site : manifeste + installateur, plages d'octets, coupures simulées
# ─────────────────────────────────────────────────────────────────────────────

PAYLOAD = os.urandom(300_000)
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class Site:
    manifest = {}
    cut_first = 0        # nombre de requêtes coupées à mi-chemin
    ignore_range = False
    corrupt = False
    redirect = False
    requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        Site.requests.append((path, self.headers.get("Range")))
        if path == "/downloads/nova-studio-latest.json":
            if Site.redirect:
                self.send_response(302)
                self.send_header("Location", "https://example.com/evil.json")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = json.dumps(Site.manifest).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/downloads/NovaStudioSetup"):
            data = bytearray(PAYLOAD)
            if Site.corrupt:
                data[1000] ^= 0xFF
            start = 0
            rng = self.headers.get("Range")
            if rng and not Site.ignore_range:
                start = int(rng.split("=")[1].split("-")[0])
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
            else:
                self.send_response(200)
            body = bytes(data[start:])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if Site.cut_first > 0:
                Site.cut_first -= 1
                self.wfile.write(body[: len(body) // 2])
                self.wfile.flush()
                self.close_connection = True
                try:
                    self.connection.shutdown(2)
                except OSError:
                    pass
                return
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def good_manifest(version="1.5.3"):
    return {"version": version, "url": f"downloads/NovaStudioSetup-{version}.exe", "sha256": SHA,
            "size": len(PAYLOAD), "date": "2026-10-19T12:00:00+02:00",
            "notes": ["Ligne 1", "Ligne 2", "Ligne 3"]}


class FakeProc:
    pid = 4242


class FakePopen:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        return FakeProc()


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="nova-maj-test-")
    srv, origin = serve()
    try:
        print("Versions")
        check("1.5.3 > 1.5.2", au.is_newer("1.5.3", "1.5.2"))
        check("1.5.10 > 1.5.9 (numérique, pas alphabétique)", au.is_newer("1.5.10", "1.5.9"))
        check("1.6 > 1.5.9", au.is_newer("1.6", "1.5.9"))
        check("même version : pas une mise à jour", not au.is_newer("1.5.2", "1.5.2"))
        check("1.5.1 < 1.5.2 : jamais de rétrogradation", not au.is_newer("1.5.1", "1.5.2"))
        check("texte invalide refusé", au.parse_version("1.5.3-beta") is None and not au.is_newer("9.9.9x", "1.0"))

        print("Origine et HTTPS")
        check("origine par défaut = production", au.update_origin({}) == au.PROD_ORIGIN)
        check("surcharge de test 127.0.0.1 acceptée",
              au.update_origin({au.TEST_ORIGIN_ENV: "http://127.0.0.1:8802/"}) == "http://127.0.0.1:8802")
        check("surcharge vers un autre site ignorée",
              au.update_origin({au.TEST_ORIGIN_ENV: "https://evil.example.com"}) == au.PROD_ORIGIN)
        check("http hors boucle locale refusé",
              raises(au.check_url, "http://nova-studio-daw-0901-9kzo.vercel.app/x", "http://nova-studio-daw-0901-9kzo.vercel.app") is not None)
        check("autre domaine refusé", raises(au.check_url, "https://evil.com/downloads/NovaStudioSetup.exe", au.PROD_ORIGIN) is not None)

        print("Manifeste")
        m = au.parse_manifest(json.dumps(good_manifest()).encode(), au.PROD_ORIGIN)
        check("manifeste valide lu", m.version == "1.5.3" and m.url == au.PROD_ORIGIN + "/downloads/NovaStudioSetup-1.5.3.exe"
              and m.sha256 == SHA and m.notes == ["Ligne 1", "Ligne 2", "Ligne 3"])
        bad = dict(good_manifest(), url="https://evil.com/downloads/NovaStudioSetup-1.5.3.exe")
        check("installateur sur un autre domaine refusé", raises(au.parse_manifest, bad, au.PROD_ORIGIN) is not None)
        bad = dict(good_manifest(), url="downloads/autre.exe")
        check("autre fichier que NovaStudioSetup refusé", raises(au.parse_manifest, bad, au.PROD_ORIGIN) is not None)
        bad = dict(good_manifest(), sha256="abc")
        check("empreinte invalide refusée", raises(au.parse_manifest, bad, au.PROD_ORIGIN) is not None)
        bad = dict(good_manifest(), size=12)
        check("taille absurde refusée", raises(au.parse_manifest, bad, au.PROD_ORIGIN) is not None)
        check("page HTML (repli index.html de Vercel) refusée",
              raises(au.parse_manifest, b"<!doctype html><html>", au.PROD_ORIGIN) is not None)

        print("Téléchargement")
        Site.manifest = good_manifest()
        fm = au.fetch_manifest(origin, "test")
        check("manifeste lu en HTTP local (origine de test)", fm.version == "1.5.3")
        Site.redirect = True
        check("redirection refusée", "redirection" in (raises(au.fetch_manifest, origin, "test") or ""))
        Site.redirect = False

        d1 = os.path.join(tmp, "dl1")
        Site.cut_first, Site.requests = 2, []
        logs = []
        path = au.download(fm, d1, "test", log=logs.append, sleep=lambda s: None)
        ranges = [r for p, r in Site.requests if p.endswith(".exe")]
        check("coupé 2 fois puis repris (Range) et vérifié",
              au.verify_file(path, SHA, len(PAYLOAD)) and len(ranges) == 3 and ranges[0] is None
              and ranges[1] and ranges[2], f"plages : {ranges}")
        check("fichier final renommé, pas de .part restant",
              os.path.basename(path) == "NovaStudioSetup-1.5.3.exe" and not os.path.exists(path + ".part"))
        Site.requests = []
        au.download(fm, d1, "test", sleep=lambda s: None)
        check("déjà téléchargé et vérifié : rien n'est retéléchargé", not Site.requests)

        d2 = os.path.join(tmp, "dl2")
        Site.cut_first, Site.ignore_range = 1, True
        path = au.download(fm, d2, "test", sleep=lambda s: None)
        check("serveur sans reprise : repart de zéro, fichier correct", au.verify_file(path, SHA, len(PAYLOAD)))
        Site.ignore_range = False

        d3 = os.path.join(tmp, "dl3")
        Site.corrupt = True
        err = raises(au.download, fm, d3, "test", sleep=lambda s: None)
        check("empreinte différente : échec, aucun fichier final", err is not None and "SHA-256" in err
              and not os.path.exists(os.path.join(d3, "NovaStudioSetup-1.5.3.exe")), err or "")
        Site.corrupt = False

        d4 = os.path.join(tmp, "dl4")
        Site.cut_first = 99
        err = raises(au.download, fm, d4, "test", attempts=3, sleep=lambda s: None)
        part = os.path.join(d4, "NovaStudioSetup-1.5.3.exe.part")
        check("réseau qui coupe toujours : abandon après 3 essais, .part gardé pour la reprise",
              err is not None and os.path.exists(part) and 0 < os.path.getsize(part) < len(PAYLOAD))
        Site.cut_first = 0
        path = au.download(fm, d4, "test", sleep=lambda s: None)
        check("au passage suivant : reprise du .part et fichier vérifié", au.verify_file(path, SHA, len(PAYLOAD)))
        stop = threading.Event()
        stop.set()
        check("fermeture de l'appli : téléchargement interrompu proprement",
              "interrompu" in (raises(au.download, fm, os.path.join(tmp, "dl5"), "test", stop=stop) or ""))

        print("Vérification avant lancement")
        f = os.path.join(tmp, "x.exe")
        with open(f, "wb") as fh:
            fh.write(PAYLOAD)
        check("fichier intact vérifié", au.verify_file(f, SHA, len(PAYLOAD)))
        with open(f, "r+b") as fh:
            fh.seek(10)
            fh.write(b"\x00\x01\x02")
        check("fichier modifié sur le disque refusé", not au.verify_file(f, SHA, len(PAYLOAD)))
        check("taille différente refusée", not au.verify_file(f, SHA, len(PAYLOAD) + 1))

        print("Anti-boucle")
        st = au.default_state()
        check("1re tentative du jour autorisée", au.can_attempt(st, "1.5.3", "2026-10-19"))
        au.record_attempt(st, "1.5.3", "2026-10-19", "close")
        check("2e tentative le même jour refusée", not au.can_attempt(st, "1.5.3", "2026-10-19"))
        check("autre version autorisée", au.can_attempt(st, "1.5.4", "2026-10-19"))
        check("le lendemain : nouvel essai autorisé", au.can_attempt(st, "1.5.3", "2026-10-20"))
        out = au.resolve_attempts(st, "1.5.2", {"version": "1.5.3", "exitCode": 5, "error": ""})
        check("version inchangée au redémarrage = échec journalisé", out == [("1.5.3", "fail", "code de sortie de l'installateur : 5")]
              and st["attempts"]["1.5.3"]["result"] == "fail", str(out))
        st2 = au.default_state()
        au.record_attempt(st2, "1.5.3", "2026-10-19", "apply")
        out = au.resolve_attempts(st2, "1.5.3", {"version": "1.5.3", "exitCode": 0})
        check("nouvelle version au redémarrage = succès", out == [("1.5.3", "ok", "")])

        print("Pas pendant un enregistrement")
        check("enregistrement en cours -> refus", au.busy_reason({"recording": True, "playing": True}) == "recording")
        check("lecture en cours -> refus", au.busy_reason({"playing": True}) == "playing")
        check("collaboration ouverte -> refus", au.busy_reason({"collab": True}) == "collab")
        check("page qui ne répond pas -> refus (prudence)", au.busy_reason(None) == "unknown")
        check("rien en cours -> on peut redémarrer", au.busy_reason({"recording": False, "playing": False, "collab": False}) is None)

        print("Chef d'orchestre (Updater)")
        data = os.path.join(tmp, "data")
        posts, pop = [], FakePopen()
        now = [1_760_000_000.0]
        up = au.Updater("1.5.2", data, "test", post=posts.append, origin=origin, popen=pop,
                        now=lambda: now[0], relaunch_cmd=[r"C:\Nova\NovaStudio.exe"], backoff=(0,))
        up.startup()
        check("vérification : téléchargée et prête", up.check() == "ready" and posts[-1]["phase"] == "ready"
              and posts[-1]["available"]["version"] == "1.5.3" and posts[-1]["available"]["notes"][0] == "Ligne 1")
        check("état mémorisé sur le disque", au.load_state(up.dir)["ready"]["version"] == "1.5.3")
        check("refus pendant un enregistrement (rien n'est lancé)",
              up.request_apply({"recording": True}) == "recording" and posts[-1]["busy"] == "recording"
              and "enregistrement" in posts[-1]["busyText"] and not pop.calls)
        check("à la fermeture : installation cachée lancée", up.on_exit(1234) and len(pop.calls) == 1)
        cmd, kw = pop.calls[0]
        script = open(cmd[-1], encoding="utf-8-sig").read()
        check("PowerShell caché (CREATE_NO_WINDOW), détaché",
              kw["creationflags"] & au.CREATE_NO_WINDOW and "-WindowStyle" in cmd and cmd[cmd.index("-WindowStyle") + 1] == "Hidden")
        check("script : attend l'appli, revérifie le SHA-256, /VERYSILENT, pas de relance",
              "Wait-Process -Id 1234" in script and SHA in script and "/VERYSILENT" in script
              and "/CLOSEAPPLICATIONS" in script and "($false -or $wanted)" in script)
        check("tentative enregistrée (anti-boucle)", au.load_state(up.dir)["attempts"]["1.5.3"]["result"] == "pending")
        check("verrou « installation en cours » posé", au.install_in_progress(up.dir))
        os.remove(os.path.join(up.dir, au.LOCK_FILE))

        # Redémarrage : l'installation a échoué (toujours 1.5.2) -> pas de nouvel essai aujourd'hui
        pop2 = FakePopen()
        up2 = au.Updater("1.5.2", data, "test", origin=origin, popen=pop2, now=lambda: now[0],
                         relaunch_cmd=[r"C:\Nova\NovaStudio.exe"])
        up2.startup()
        check("échec : ancienne version utilisable, pas de réinstallation au démarrage le même jour",
              not up2.startup_install(999) and not pop2.calls
              and au.load_state(up2.dir)["attempts"]["1.5.3"]["result"] == "fail")
        snap = up2.snapshot()
        check("échec : message clair dans la carte (version actuelle utilisable, nouvel essai demain)",
              snap["phase"] == "ready" and "n'a pas abouti" in snap["error"])
        check("« Redémarrer et mettre à jour » après un échec le même jour : refusé (l'appli ne se ferme pas pour rien)",
              up2.request_apply({"recording": False}) == "failed" and not up2.relaunch_requested)
        up2.relaunch_requested = True  # (cas limite : échec découvert à la fermeture)
        check("… et si l'installation ne peut pas partir après « Redémarrer » : l'appli se rouvre quand même",
              not up2.on_exit(1) and pop2.calls and pop2.calls[-1][0] == [r"C:\Nova\NovaStudio.exe"])
        pop2.calls.clear()
        now[0] += 86400
        up3 = au.Updater("1.5.2", data, "test", origin=origin, popen=pop2, now=lambda: now[0],
                         relaunch_cmd=[r"C:\Nova\NovaStudio.exe"])
        up3.startup()
        check("le lendemain : installation au démarrage, avant la fenêtre (/SILENT + relance)",
              up3.startup_install(999) and len(pop2.calls) == 1)
        script = open(pop2.calls[0][0][-1], encoding="utf-8-sig").read()
        check("script de démarrage : /SILENT et relance de l'appli",
              "'/SILENT'" in script and "($true -or $wanted)" in script and "NovaStudio.exe" in script)
        os.remove(os.path.join(up3.dir, au.LOCK_FILE))

        # Redémarrage après succès : 1.5.3 -> « Mis à jour en 1.5.3 ✓ » une fois
        up4 = au.Updater("1.5.3", data, "test", origin=origin, popen=FakePopen(), now=lambda: now[0])
        up4.startup()
        snap = up4.snapshot()
        check("après la mise à jour : annonce « Mis à jour » avec les nouveautés",
              snap["justUpdated"] == {"version": "1.5.3", "notes": ["Ligne 1", "Ligne 2", "Ligne 3"]}
              and snap["available"] is None and snap["installed"] == "1.5.3")
        check("installateur retiré du dossier updates",
              not any(n.startswith(au.INSTALLER_PREFIX) for n in os.listdir(up4.dir)))
        up4.seen_announce()
        check("annonce montrée une seule fois", au.Updater("1.5.3", data, "test", origin=origin).snapshot()["justUpdated"] is None)

        # Automatique coupée : rien n'est téléchargé tout seul ; « Rechercher maintenant » oui
        data2 = os.path.join(tmp, "data2")
        pop5 = FakePopen()
        up5 = au.Updater("1.5.2", data2, "test", origin=origin, popen=pop5, now=lambda: now[0])
        up5.startup()
        up5.set_auto(False)
        check("automatique coupée : pas de téléchargement en arrière-plan",
              up5.check() == "idle" and up5.ready_manifest() is None)
        check("« Rechercher maintenant » télécharge quand même", up5.check(manual=True) == "ready")
        check("automatique coupée : pas d'installation à la fermeture", not up5.on_exit(1) and not pop5.calls)
        up5b = au.Updater("1.5.2", data2, "test", origin=origin, popen=pop5, now=lambda: now[0])
        up5b.relaunch_requested = True
        check("… sauf si l'utilisateur a cliqué « Redémarrer et mettre à jour »", up5b.on_exit(1) and len(pop5.calls) == 1)
        os.remove(os.path.join(up5b.dir, au.LOCK_FILE))

        # Pas de rétrogradation : version en ligne plus ancienne
        Site.manifest = good_manifest("1.5.1")
        up6 = au.Updater("1.5.2", os.path.join(tmp, "data3"), "test", origin=origin, popen=FakePopen())
        check("version en ligne plus ancienne : à jour, rien de téléchargé", up6.check() == "uptodate"
              and up6.ready_manifest() is None)

        # Installateur abîmé sur le disque entre-temps : jamais lancé
        Site.manifest = good_manifest()
        data7 = os.path.join(tmp, "data7")
        pop7 = FakePopen()
        up7 = au.Updater("1.5.2", data7, "test", origin=origin, popen=pop7)
        up7.check()
        with open(os.path.join(up7.dir, "NovaStudioSetup-1.5.3.exe"), "r+b") as fh:
            fh.write(b"MZ-modifie")
        check("installateur modifié après vérification : jamais lancé", not up7.on_exit(1) and not pop7.calls
              and up7.ready_manifest() is None)

        print("Publication (build.py)")
        import build  # noqa: E402
        dl = os.path.join(tmp, "downloads")
        os.makedirs(dl)
        for old in ("NovaStudioSetup-1.5.1.exe", "NovaStudioSetup-1.5.2.exe"):
            with open(os.path.join(dl, old), "wb") as fh:
                fh.write(b"old")
        setup = os.path.join(tmp, "NovaStudioSetup.exe")
        with open(setup, "wb") as fh:
            fh.write(PAYLOAD)
        notes = os.path.join(tmp, "NOUVEAUTES.md")
        with open(notes, "w", encoding="utf-8") as fh:
            fh.write("# x\n\n## 1.5.3\n- Un\n- Deux\n- Trois\n- Quatre\n- Cinq\n- Six\n- Sept\n\n## 1.5.2\n- Vieux\n")
        man = build.publish_update(setup, "1.5.3", dl, notes_file=notes, say=lambda *_: None)
        on_disk = json.load(open(os.path.join(dl, "nova-studio-latest.json"), encoding="utf-8"))
        check("manifeste écrit : version, url versionnée, sha256, taille, date, 6 nouveautés max",
              on_disk == man and man["version"] == "1.5.3" and man["url"] == "downloads/NovaStudioSetup-1.5.3.exe"
              and man["sha256"] == SHA and man["size"] == len(PAYLOAD) and man["date"][:2] == "20"
              and man["notes"] == ["Un", "Deux", "Trois", "Quatre", "Cinq", "Six"] and "minVersion" not in man)
        check("installateur fixe (lien du site) + versionné, anciens versionnés retirés",
              sorted(os.listdir(dl)) == ["NovaStudioSetup-1.5.3.exe", "NovaStudioSetup.exe", "nova-studio-latest.json"])
        check("le manifeste écrit est accepté par l'appli",
              au.parse_manifest(on_disk, au.PROD_ORIGIN).url.endswith("/downloads/NovaStudioSetup-1.5.3.exe"))
        man = build.publish_update(setup, "1.5.4", dl, notes_file=notes, min_version="1.5.0", say=lambda *_: None)
        check("version sans section de nouveautés : texte par défaut ; minVersion transmise",
              man["notes"] == build.DEFAULT_NOTES and man["minVersion"] == "1.5.0"
              and sorted(os.listdir(dl)) == ["NovaStudioSetup-1.5.4.exe", "NovaStudioSetup.exe", "nova-studio-latest.json"])
        check("NOUVEAUTES.md du dépôt : section 1.5.3 de 3 à 6 lignes",
              3 <= len(build.read_notes(build.NOTES_FILE, "1.5.3")) <= 6)
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    ok = sum(1 for _, r in results if r)
    print(f"\n{ok}/{len(results)} vérifications réussies")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
