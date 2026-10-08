# -*- coding: utf-8 -*-
"""
Construction de l'application Windows « Nova Studio » et de son installateur.

Étapes (toutes relançables) :
  1. SDK WebView2 (NuGet, version figée) -> vendor/webview2/
  2. installateur « Evergreen Bootstrapper » de WebView2 (Microsoft, signé) -> vendor/
     (lancé par l'installateur seulement si le runtime manque sur le PC)
  3. assets/nova.ico à partir de public/icons/icon-512.png (si absent)
  4. interface du DAW embarquée (build_ui.py) -> build/ui-bundle/
  5. PyInstaller -> dist/NovaStudio/ (dossier, sans console)
  6. contrôle des DLL d'exécution Visual C++ (copiées si une dépendance en a besoin)
  7. signature de NovaStudio.exe (facultative, voir plus bas)
  8. Inno Setup (paquet npm innosetup-compiler) -> dist/NovaStudioSetup.exe (signé aussi si configuré)
  9. copie dans public/downloads/NovaStudioSetup.exe

Usage : build.bat                       (tout, interface = vite build de HEAD)
        build.bat --ui-ref origin/main  (interface = ce qui est en ligne, branche main)
        build.bat --ui-online           (interface = copie exacte du site en ligne)
        build.bat --skip-ui             (réutilise build/ui-bundle tel quel)
        build.bat --no-copy             (sans copier dans public/downloads)

Signature de code (facultative ; sans certificat, Windows SmartScreen avertit au 1er lancement) :
  NOVA_SIGN_PFX=C:\\certs\\makemusic.pfx  NOVA_SIGN_PFX_PASSWORD=...   certificat en fichier
  NOVA_SIGN_CERT_SHA1=<empreinte>                                     certificat du magasin Windows
                                                                      (clé matérielle EV, etc.)
  NOVA_SIGN_COMMAND="jsign ... {file}"                                 autre outil (Azure Trusted Signing…)
  NOVA_SIGN_TIMESTAMP=http://timestamp.digicert.com                   serveur d'horodatage
  NOVA_SIGNTOOL=C:\\...\\signtool.exe                                   sinon cherché dans Windows Kits
"""
import glob
import io
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WEBVIEW2_VERSION = "1.0.3856.49"
VENDOR = os.path.join(HERE, "vendor", "webview2")
WV2_BOOTSTRAPPER = os.path.join(HERE, "vendor", "MicrosoftEdgeWebview2Setup.exe")
WV2_BOOTSTRAPPER_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
ICON = os.path.join(HERE, "assets", "nova.ico")
DIST = os.path.join(HERE, "dist")
WORK = os.path.join(HERE, "build")
STEPS = 9


def step(n: int, text: str) -> None:
    print(f"[{n}/{STEPS}] {text}", flush=True)


def app_version() -> str:
    with open(os.path.join(HERE, "nova_desktop.py"), encoding="utf-8") as f:
        m = re.search(r'^APP_VERSION\s*=\s*"([^"]+)"', f.read(), re.M)
    if not m:
        sys.exit("APP_VERSION introuvable dans nova_desktop.py")
    return m.group(1)


def fetch_webview2() -> None:
    wanted = {
        "lib/net462/Microsoft.Web.WebView2.Core.dll": "Microsoft.Web.WebView2.Core.dll",
        "lib/net462/Microsoft.Web.WebView2.WinForms.dll": "Microsoft.Web.WebView2.WinForms.dll",
        "build/native/x64/WebView2Loader.dll": "WebView2Loader.dll",
    }
    stamp = os.path.join(VENDOR, "VERSION")
    if os.path.exists(stamp) and open(stamp).read().strip() == WEBVIEW2_VERSION and all(
        os.path.exists(os.path.join(VENDOR, n)) for n in wanted.values()
    ):
        step(1, f"SDK WebView2 {WEBVIEW2_VERSION} déjà présent")
        return
    url = f"https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/{WEBVIEW2_VERSION}"
    step(1, f"Téléchargement du SDK WebView2 {WEBVIEW2_VERSION}…")
    data = urllib.request.urlopen(url, timeout=120).read()
    os.makedirs(VENDOR, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for src, dst in wanted.items():
            with z.open(src) as fi, open(os.path.join(VENDOR, dst), "wb") as fo:
                shutil.copyfileobj(fi, fo)
    with open(stamp, "w") as f:
        f.write(WEBVIEW2_VERSION)


def authenticode_signer(path: str) -> str:
    """Signataire Authenticode valide d'un fichier ('' si non signé / invalide)."""
    ps = (f"$s = Get-AuthenticodeSignature -LiteralPath '{path}'; "
          "if ($s.Status -eq 'Valid') { $s.SignerCertificate.Subject }")
    try:
        return subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                                       text=True, timeout=60).strip()
    except Exception:
        return ""


def fetch_webview2_bootstrapper() -> None:
    if os.path.isfile(WV2_BOOTSTRAPPER) and "Microsoft Corporation" in authenticode_signer(WV2_BOOTSTRAPPER):
        step(2, "Installateur WebView2 (Evergreen Bootstrapper) déjà présent")
        return
    step(2, "Téléchargement de l'installateur WebView2 (Evergreen Bootstrapper, Microsoft)…")
    req = urllib.request.Request(WV2_BOOTSTRAPPER_URL, headers={"User-Agent": "NovaStudio-build"})
    data = urllib.request.urlopen(req, timeout=120).read()
    if data[:2] != b"MZ" or len(data) < 500_000:
        sys.exit("installateur WebView2 inattendu")
    os.makedirs(os.path.dirname(WV2_BOOTSTRAPPER), exist_ok=True)
    tmp = WV2_BOOTSTRAPPER + ".tmp.exe"
    with open(tmp, "wb") as f:
        f.write(data)
    signer = authenticode_signer(tmp)
    if "Microsoft Corporation" not in signer:
        os.remove(tmp)
        sys.exit(f"installateur WebView2 : signature Microsoft absente ou invalide ({signer!r})")
    os.replace(tmp, WV2_BOOTSTRAPPER)
    print(f"      {len(data) / 1e6:.1f} Mo, signé : {signer[:60]}")


def make_icon() -> None:
    if os.path.exists(ICON):
        step(3, "Icône déjà présente")
        return
    from PIL import Image  # pillow : uniquement pour la construction

    step(3, "Génération de l'icône")
    os.makedirs(os.path.dirname(ICON), exist_ok=True)
    src = Image.open(os.path.join(REPO, "public", "icons", "icon-512.png")).convert("RGBA")
    src.save(ICON, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def build_ui(argv: list) -> None:
    if "--skip-ui" in argv and os.path.isfile(os.path.join(WORK, "ui-bundle", "desktop-ui.json")):
        step(4, "Interface du DAW : build/ui-bundle réutilisé")
        return
    step(4, "Interface du DAW embarquée…")
    import build_ui as bu
    args = []
    if "--ui-ref" in argv:
        args += ["--ref", argv[argv.index("--ui-ref") + 1]]
    if "--ui-online" in argv:
        args.append("--online")
    if "--ui-from-dir" in argv:
        args += ["--from-dir", argv[argv.index("--ui-from-dir") + 1]]
    bu.main(args)


ARA_HOST_EXE = os.path.join(REPO, "nova-ara-host", "build", "NovaARAHost_artefacts", "Release", "NovaARAHost.exe")


def ara_host() -> None:
    """Hôte ARA2 (Melodyne, VocAlign) : NovaARAHost.exe, construit depuis nova-ara-host/ s'il
    manque (MSVC + CMake + sources JUCE / ARA SDK). Facultatif : sans lui, l'appli marche,
    seules les commandes Melodyne / VocAlign restent grisées (« Mets à jour Nova Studio »)."""
    # Opt-in : JUCE est utilisé sous AGPLv3 ; tant que Romain n'a pas tranché la licence
    # (publier les sources de l'hôte ou licence JUCE), l'installateur public ne l'embarque pas.
    if os.environ.get("NOVA_INCLUDE_ARA") != "1":
        print("    hôte ARA : non inclus (NOVA_INCLUDE_ARA=1 pour l'inclure, licence JUCE à trancher)")
        return
    if os.path.isfile(ARA_HOST_EXE) and "--rebuild-ara" not in sys.argv:
        print(f"    hôte ARA : {os.path.relpath(ARA_HOST_EXE, REPO)} (déjà construit)")
        return
    bat = os.path.join(REPO, "nova-ara-host", "build.bat")
    try:
        subprocess.check_call(["cmd", "/c", bat], cwd=os.path.dirname(bat), creationflags=0x08000000)
        print("    hôte ARA construit")
    except Exception as e:  # noqa: BLE001 - non bloquant
        print(f"    hôte ARA NON construit ({e}) : Melodyne / VocAlign indisponibles dans cette version")


def pyinstaller() -> None:
    step(5, "PyInstaller…")
    subprocess.check_call(
        [sys.executable, "-m", "PyInstaller", "NovaStudio.spec", "--noconfirm",
         "--distpath", DIST, "--workpath", WORK],
        cwd=HERE,
    )


CRT = re.compile(r"^(msvcp\d+[a-z0-9_]*|vcruntime\d+[a-z0-9_]*|concrt\d+|vcomp\d+|vccorlib\d+|msvcr\d+)\.dll$", re.I)


def check_runtime_dlls() -> None:
    """Toute DLL Visual C++ dont dépend un module livré doit être livrée avec (un PC neuf n'a
    pas forcément le « Redistribuable Visual C++ ») ; copie locale autorisée par Microsoft."""
    from PyInstaller.depend import bindepend
    app = os.path.join(DIST, "NovaStudio")
    internal = os.path.join(app, "_internal")
    present = {f.lower() for _, _, fs in os.walk(app) for f in fs}
    needed = {}
    for dirpath, _, files in os.walk(app):
        for fn in files:
            if not fn.lower().endswith((".dll", ".pyd", ".exe")):
                continue
            p = os.path.join(dirpath, fn)
            try:
                imports = bindepend.get_imports(p)
            except Exception:
                continue
            for dll in imports:
                if isinstance(dll, (tuple, list)):  # PyInstaller 6 : (nom, chemin résolu)
                    dll = dll[0]
                dll = os.path.basename(str(dll))
                if CRT.match(dll):
                    needed.setdefault(dll.lower(), []).append(os.path.relpath(p, app))
    missing = sorted(set(needed) - present)
    sysdir = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    for dll in missing:
        src = os.path.join(sysdir, dll)
        if not os.path.isfile(src):
            sys.exit(f"{dll} (requis par {needed[dll][:3]}) introuvable : installer le redistribuable VC++ x64")
        shutil.copy2(src, os.path.join(internal, dll))
    step(6, f"DLL Visual C++ : {', '.join(sorted(needed)) or 'aucune'} requises ; "
            f"{'copiées : ' + ', '.join(missing) if missing else 'toutes livrées'}")


# ── signature (facultative) ────────────────────────────────────────────────

def find_signtool() -> str:
    if os.environ.get("NOVA_SIGNTOOL"):
        return os.environ["NOVA_SIGNTOOL"]
    kits = os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Windows Kits", "10", "bin")
    found = sorted(glob.glob(os.path.join(kits, "*", "x64", "signtool.exe")))
    if found:
        return found[-1]
    path = shutil.which("signtool")
    if path:
        return path
    sys.exit("signtool.exe introuvable (Windows SDK) : définir NOVA_SIGNTOOL")


def signing_command() -> "list | None":
    """Commande de signature avec {file} à remplacer, ou None si aucun certificat n'est configuré."""
    if os.environ.get("NOVA_SIGN_COMMAND"):
        return ["{custom}", os.environ["NOVA_SIGN_COMMAND"]]
    if not (os.environ.get("NOVA_SIGN_PFX") or os.environ.get("NOVA_SIGN_CERT_SHA1")):
        return None
    ts = os.environ.get("NOVA_SIGN_TIMESTAMP", "http://timestamp.digicert.com")
    base = [find_signtool(), "sign", "/fd", "sha256", "/tr", ts, "/td", "sha256", "/d", "Nova Studio"]
    if os.environ.get("NOVA_SIGN_PFX"):
        base += ["/f", os.environ["NOVA_SIGN_PFX"]]
        if os.environ.get("NOVA_SIGN_PFX_PASSWORD"):
            base += ["/p", os.environ["NOVA_SIGN_PFX_PASSWORD"]]
        return base + ["{file}"]
    return base + ["/sha1", os.environ["NOVA_SIGN_CERT_SHA1"], "{file}"]


def sign(path: str) -> None:
    cmd = signing_command()
    if cmd is None:
        return
    if cmd[0] == "{custom}":
        subprocess.check_call(cmd[1].replace("{file}", f'"{path}"'), shell=True)
    else:
        subprocess.check_call([c.replace("{file}", path) for c in cmd])
    print(f"      signé : {os.path.basename(path)} ({authenticode_signer(path)[:60] or 'signature non vérifiable'})")


def inno_sign_args() -> list:
    """Inno Setup signe lui-même l'installateur et le désinstallateur (directive SignTool)."""
    cmd = signing_command()
    if cmd is None:
        return []
    if cmd[0] == "{custom}":
        line = cmd[1].replace("{file}", "$f")
    else:
        line = " ".join("$f" if c == "{file}" else f"$q{c}$q" for c in cmd)
    return ["/DSIGN", f"/Snovasign={line}"]


def find_iscc() -> str:
    candidates = [
        os.path.join(HERE, "node_modules", "innosetup-compiler", "bin", "ISCC.exe"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    print("      installation du compilateur Inno Setup (npm innosetup-compiler, local au dossier desktop)…")
    subprocess.check_call("npm install --no-audit --no-fund", cwd=HERE, shell=True)
    for c in candidates:
        if os.path.exists(c):
            return c
    sys.exit("ISCC.exe introuvable (node_modules/innosetup-compiler)")


def inno(version: str) -> str:
    step(8, "Inno Setup…")
    iscc = find_iscc()
    subprocess.check_call([iscc, f"/DAppVersion={version}", *inno_sign_args(), "/Q", "installer.iss"], cwd=HERE)
    out = os.path.join(DIST, "NovaStudioSetup.exe")
    print(f"      {out} : {os.path.getsize(out) / 1e6:.1f} Mo")
    return out


def main() -> None:
    argv = sys.argv[1:]
    version = app_version()
    print(f"Nova Studio {version}")
    fetch_webview2()
    fetch_webview2_bootstrapper()
    make_icon()
    build_ui(argv)
    ara_host()
    pyinstaller()
    check_runtime_dlls()
    if signing_command() is None:
        step(7, "Signature : aucun certificat configuré (NOVA_SIGN_*), installateur non signé")
    else:
        step(7, "Signature de NovaStudio.exe…")
        sign(os.path.join(DIST, "NovaStudio", "NovaStudio.exe"))
    setup = inno(version)
    if "--no-copy" not in argv:
        dst = os.path.join(REPO, "public", "downloads", "NovaStudioSetup.exe")
        old = os.path.getsize(dst) if os.path.exists(dst) else 0
        shutil.copyfile(setup, dst)
        step(9, f"Copié dans {dst} ({old / 1e6:.1f} Mo -> {os.path.getsize(dst) / 1e6:.1f} Mo)")
    else:
        step(9, "(copie ignorée)")


if __name__ == "__main__":
    main()
