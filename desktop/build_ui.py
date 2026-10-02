# -*- coding: utf-8 -*-
"""
Construit l'interface du DAW embarquée dans Nova Studio pour Windows -> desktop/build/ui-bundle/
(reprise par NovaStudio.spec dans _internal/ui/, voir ui_bundle.py).

  venv\\Scripts\\python.exe build_ui.py                     # vite build d'un instantané git (HEAD)
  venv\\Scripts\\python.exe build_ui.py --ref origin/main   # ... d'une autre révision (ce qui est en ligne)
  venv\\Scripts\\python.exe build_ui.py --online            # copie exacte du site en ligne
  venv\\Scripts\\python.exe build_ui.py --from-dir ..\\dist  # build déjà fait (VERCEL=1 npm run build)

Source git : `git archive <ref>` dans un dossier temporaire (jamais les fichiers en cours
d'édition du dépôt), node_modules du dépôt relié par jonction, `vite build` avec VERCEL=1
(base '/', comme le site en ligne) et sans aucune variable secrète dans l'environnement.
Ensuite : retrait de public/downloads (installateurs), copie locale de Font Awesome (cdnjs),
contrôle anti-secrets (clé d'API, JWT service_role), manifeste desktop-ui.json.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import ui_bundle  # noqa: E402

OUT = os.path.join(HERE, "build", "ui-bundle")
UA = "NovaStudioDesktop-build"
# Inutile pour construire le site (et lourd) : exclu de l'instantané git.
ARCHIVE_EXCLUDES = ["public/downloads", "desktop", "bridge-python", "nova-vst-host", "supabase", "tests",
                    "test", "e2e", "android", "ios"]
SECRET_ENV = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)", re.I)
SECRET_PATTERNS = [
    re.compile(rb"AIza[0-9A-Za-z_\-]{35}"),            # clé Google / Gemini
    re.compile(rb"\bgsk_[0-9A-Za-z]{20,}"),            # Groq
    re.compile(rb"\bsk-(?:ant-|proj-)?[0-9A-Za-z_\-]{20,}"),  # OpenAI / Anthropic
    re.compile(rb"\b[rs]k_live_[0-9A-Za-z]{10,}"),     # Stripe secret
    re.compile(rb"\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{16,}"),  # Resend
]
JWT = re.compile(rb"eyJ[0-9A-Za-z_\-]{10,}\.(eyJ[0-9A-Za-z_\-]{10,})\.[0-9A-Za-z_\-]{10,}")


def git(*args, **kw) -> str:
    return subprocess.check_output(["git", "-c", "safe.directory=*", *args], cwd=REPO, text=True, **kw).strip()


def build_from_git(ref: str, work: str) -> "tuple[str, dict]":
    commit = git("rev-parse", ref)
    subject = git("log", "-1", "--format=%cI %s", commit)
    print(f"      instantané git {ref} = {commit[:10]} ({subject})")
    src = os.path.join(work, "src")
    archive = os.path.join(work, "src.zip")
    pathspec = ["."] + [f":(exclude){p}" for p in ARCHIVE_EXCLUDES]
    subprocess.check_call(["git", "-c", "safe.directory=*", "archive", "--format=zip", "-o", archive, commit,
                           "--", *pathspec], cwd=REPO)
    with zipfile.ZipFile(archive) as z:
        z.extractall(src)
    os.remove(archive)
    nm = os.path.join(REPO, "node_modules")
    if not os.path.isdir(nm):
        sys.exit("node_modules absent à la racine du dépôt : lancer `npm install` d'abord")
    subprocess.check_call(["cmd", "/c", "mklink", "/J", os.path.join(src, "node_modules"), nm],
                          stdout=subprocess.DEVNULL)
    env = {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k)}
    env["VERCEL"] = "1"            # base '/' (vite.config.ts), comme le build Vercel
    env["NODE_ENV"] = "production"
    out = os.path.join(work, "out")
    vite = os.path.join(nm, "vite", "bin", "vite.js")
    t0 = time.time()
    try:
        subprocess.check_call(["node", vite, "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"],
                              cwd=src, env=env)
    finally:
        # la jonction d'abord : un rmtree ne doit jamais descendre dans le vrai node_modules
        subprocess.call(["cmd", "/c", "rmdir", os.path.join(src, "node_modules")])
    print(f"      vite build : {time.time() - t0:.0f} s")
    return out, {"type": "git", "ref": ref, "commit": commit, "subject": subject}


def scan_secrets(root: str) -> None:
    for dirpath, _, files in os.walk(root):
        for fn in files:
            if not fn.endswith((".js", ".html", ".css", ".json", ".mjs")):
                continue
            p = os.path.join(dirpath, fn)
            with open(p, "rb") as f:
                data = f.read()
            for pat in SECRET_PATTERNS:
                m = pat.search(data)
                if m:
                    sys.exit(f"SECRET détecté dans {p} ({m.group(0)[:12]!r}…) : construction annulée")
            for m in JWT.finditer(data):
                try:
                    payload = m.group(1) + b"=" * (-len(m.group(1)) % 4)
                    claims = json.loads(base64.urlsafe_b64decode(payload))
                except Exception:
                    continue
                if claims.get("role") not in (None, "anon"):
                    sys.exit(f"JWT « {claims.get('role')} » détecté dans {p} : construction annulée")


def finalize(built: str, source: dict) -> dict:
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(built, OUT, ignore=shutil.ignore_patterns("downloads", "sw.js"))
    for top in ui_bundle.EXCLUDED_TOP:
        shutil.rmtree(os.path.join(OUT, top), ignore_errors=True)
    if not os.path.isfile(os.path.join(OUT, "index.html")):
        sys.exit("index.html absent du build")
    with open(os.path.join(OUT, "index.html"), "rb") as f:
        index = f.read()
    ui_bundle.mirror_external_css(index, OUT, UA, log=lambda s: print("      " + s))
    scan_secrets(OUT)
    m = ui_bundle.write_manifest(OUT, "bundled", source)
    v, why = ui_bundle.load_version(OUT, deep=True)
    if v is None:
        sys.exit(f"interface embarquée invalide : {why}")
    size = sum(i["size"] for i in m["files"].values())
    print(f"      interface {m['id']} : {len(m['files'])} fichiers, {size / 1e6:.1f} Mo -> {OUT}")
    return m


def public_files() -> "list[str]":
    pub = os.path.join(REPO, "public")
    out = []
    for dirpath, _, files in os.walk(pub):
        for fn in files:
            rel = os.path.relpath(os.path.join(dirpath, fn), pub).replace("\\", "/")
            if rel.split("/")[0] not in ui_bundle.EXCLUDED_TOP and rel != "sw.js":
                out.append(rel)
    return sorted(out)


def main(argv=None) -> dict:
    argv = list(sys.argv[1:] if argv is None else argv)
    ref = "HEAD"
    if "--ref" in argv:
        ref = argv[argv.index("--ref") + 1]
    work = tempfile.mkdtemp(prefix="nova-ui-build-")
    try:
        if "--online" in argv:
            print(f"      copie du site en ligne {ui_bundle.PROD_ORIGIN}")
            tmp_out = os.path.join(work, "online")
            ui_bundle.download_version(ui_bundle.PROD_ORIGIN, work, None, public_files(), UA,
                                       log=lambda s: print("      " + s), kind="bundled", dest=tmp_out)
            os.remove(os.path.join(tmp_out, ui_bundle.MANIFEST))
            return finalize(tmp_out, {"type": "online", "origin": ui_bundle.PROD_ORIGIN})
        if "--from-dir" in argv:
            d = os.path.abspath(argv[argv.index("--from-dir") + 1])
            return finalize(d, {"type": "dir", "path": d})
        built, source = build_from_git(ref, work)
        return finalize(built, source)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
