# -*- coding: utf-8 -*-
"""
Tests de l'interface embarquée et de ses mises à jour (ui_bundle.py), sans Internet :
un faux « site en ligne » est servi en local (avec le repli index.html de Vercel pour les
fichiers inconnus).

  venv\\Scripts\\python.exe test\\test_ui_bundle.py
"""
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import ui_bundle as ub  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'OK' if ok else 'ÉCHEC'}] {name} {detail}")


def write(root, rel, data):
    p = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def make_site(root, tag):
    """Mini site construit : index.html -> assets/index-<tag>.js -> import('./chunk-<tag>.js')."""
    write(root, "index.html", f'<!doctype html><html><head><script type="module" src="/assets/index-{tag}.js">'
                              f'</script><link rel="stylesheet" href="/assets/index-{tag}.css"></head>'
                              f'<body><div id="root"></div></body></html>')
    write(root, f"assets/index-{tag}.js", f'import("./chunk-{tag}.js");import("./shared-AAAA.js");const k="kick-0123abcd";'
                                          f'const u="/drums/lib/"+k+".wav";')
    write(root, f"assets/chunk-{tag}.js", "export default 1;")
    write(root, "assets/shared-AAAA.js", "export const shared = 1;")
    write(root, f"assets/index-{tag}.css", 'body{background:url(/assets/bg-BBBB.png)}')
    write(root, "assets/bg-BBBB.png", b"\x89PNG fake")
    write(root, "worklets/proc.js", f"// worklet {tag}")
    write(root, "drums/lib/kick-0123abcd.wav", b"RIFF....WAVEfake")


class SiteHandler(http.server.SimpleHTTPRequestHandler):
    root = None

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SiteHandler.root, **kw)

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path):  # repli SPA de Vercel : index.html en 200
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, *a):
        pass


def main():
    tmp = tempfile.mkdtemp(prefix="nova-ui-test-")
    try:
        online = os.path.join(tmp, "online")
        bundled_dir = os.path.join(tmp, "bundled")
        data = os.path.join(tmp, "data")
        make_site(bundled_dir, "v1")
        write(bundled_dir, "_ext/cdnjs.cloudflare.com/x/all.css", "a{}")
        ub.write_manifest(bundled_dir, "bundled", {"type": "test"}, stamp=time.time() - 3600)
        cache = ub.cache_root(data)

        print("\n== démarrage sans cache")
        active, bundled, dl = ub.choose(bundled_dir, cache)
        check("version livrée choisie", active is bundled and active.kind == "bundled", repr(active))
        check("résolution d'un fichier", active.resolve("assets/index-v1.js") is not None)
        check("chemin hors interface refusé", active.resolve("../secret.txt") is None and active.resolve("C:/x") is None)

        SiteHandler.root = online
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{srv.server_address[1]}"

        print("\n== site en ligne identique")
        shutil.copytree(bundled_dir, online, ignore=shutil.ignore_patterns(ub.MANIFEST))
        v = ub.check_for_update(origin, data, active, bundled, dl, "test")
        check("rien à télécharger", v is None)

        print("\n== nouvelle version en ligne")
        shutil.rmtree(online)
        make_site(online, "v2")
        v = ub.check_for_update(origin, data, active, bundled, dl, "test")
        check("version v2 téléchargée", v is not None and v.kind == "downloaded", repr(v))
        check("assets/ versionnés repris de la version livrée (pas retéléchargés)",
              "assets/shared-AAAA.js" in v.m["inherited"] and "drums/lib/kick-0123abcd.wav" in v.m["inherited"])
        check("chunk chargé dynamiquement téléchargé", "assets/chunk-v2.js" in v.m["files"])
        check("fichier public non versionné retéléchargé", "worklets/proc.js" in v.m["files"])
        a2, b2, dl2 = ub.choose(bundled_dir, cache)
        check("au démarrage suivant : v2", a2.id == v.id, repr(a2))
        check("v2 voit les fichiers de la version livrée", a2.resolve("assets/shared-AAAA.js") is not None)
        v_again = ub.check_for_update(origin, data, a2, b2, dl2, "test")
        check("pas de 2e téléchargement", v_again is None)

        print("\n== fichier manquant en ligne (repli index.html de Vercel)")
        shutil.rmtree(online)
        make_site(online, "v3")
        os.remove(os.path.join(online, "assets", "chunk-v3.js"))
        try:
            ub.check_for_update(origin, data, a2, b2, dl2, "test")
            check("téléchargement incomplet refusé", False)
        except Exception as e:
            check("téléchargement incomplet refusé", "absent" in str(e), str(e)[:60])
        leftovers = [n for n in os.listdir(cache) if n.startswith(".partial-")]
        check("aucun reste de téléchargement", not leftovers, str(leftovers))
        a3, _, _ = ub.choose(bundled_dir, cache)
        check("on garde v2", a3.id == v.id)

        print("\n== version téléchargée abîmée")
        p = os.path.join(v.root, "assets", "chunk-v2.js")
        with open(p, "ab") as f:
            f.write(b"// abime")
        a4, _, dl4 = ub.choose(bundled_dir, cache)
        check("version abîmée ignorée -> version livrée", a4.kind == "bundled" and not dl4, repr(a4))
        with open(p, "wb") as f:
            f.write(b"export default 1;")  # remise en état
        a5, _, _ = ub.choose(bundled_dir, cache)
        check("remise en état -> v2", a5.id == v.id)

        print("\n== version qui ne démarre pas")
        ub.mark_bad(a5, "test")
        a6, _, _ = ub.choose(bundled_dir, cache)
        check("marquée défectueuse -> version livrée", a6.kind == "bundled")
        shutil.rmtree(online)
        make_site(online, "v2")
        v7 = ub.check_for_update(origin, data, a6, bundled, [], "test")
        check("jamais retéléchargée", v7 is None)

        print("\n== le site en ligne revient à la version livrée")
        shutil.rmtree(online)
        shutil.copytree(bundled_dir, online, ignore=shutil.ignore_patterns(ub.MANIFEST))
        make_site(online, "v4")
        shutil.rmtree(online)
        make_site(online, "v4")
        v8 = ub.check_for_update(origin, data, a6, bundled, [], "test")
        a8, _, dl8 = ub.choose(bundled_dir, cache)
        check("v4 téléchargée puis choisie", v8 is not None and a8.id == v8.id)
        shutil.rmtree(online)
        shutil.copytree(bundled_dir, online, ignore=shutil.ignore_patterns(ub.MANIFEST))
        v9 = ub.check_for_update(origin, data, a8, bundled, dl8, "test")
        a9, _, _ = ub.choose(bundled_dir, cache)
        check("retour en ligne à v1 : la version livrée est reprise", v9 is bundled and a9 is not None
              and a9.kind == "bundled", repr(a9))

        print("\n== nouvelle installation (version livrée plus récente que la dernière vérification)")
        state = ub.read_state(cache)
        state["online"] = v8.id
        with open(os.path.join(cache, ub.STATE), "w") as f:
            json.dump(state, f)
        ub.write_manifest(bundled_dir, "bundled", {"type": "test"}, stamp=time.time() + 10)
        a10, _, _ = ub.choose(bundled_dir, cache)
        check("la version de l'installateur est prise", a10.kind == "bundled", repr(a10))

        print("\n== nettoyage")
        ub.prune(cache, {a10.id})
        left = [n for n in os.listdir(cache) if n.startswith("ui-")]
        check("anciennes versions supprimées", not left, str(left))
        srv.shutdown()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} vérifications OK")
    for n in failed:
        print("  ÉCHEC :", n)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
