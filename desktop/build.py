# -*- coding: utf-8 -*-
"""
Construction de l'application Windows « Nova Studio » et de son installateur.

Étapes (toutes relançables) :
  1. récupère le SDK WebView2 (NuGet, version figée) dans vendor/webview2/
  2. génère assets/nova.ico à partir de public/icons/icon-512.png (si absent)
  3. PyInstaller -> dist/NovaStudio/ (dossier, sans console)
  4. Inno Setup (paquet npm innosetup-compiler) -> dist/NovaStudioSetup.exe
  5. copie l'installateur dans public/downloads/NovaStudioSetup.exe

Usage : build.bat            (tout)
        build.bat --no-copy  (sans copier dans public/downloads)
"""
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
ICON = os.path.join(HERE, "assets", "nova.ico")
DIST = os.path.join(HERE, "dist")
WORK = os.path.join(HERE, "build")


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
        print(f"[1/5] SDK WebView2 {WEBVIEW2_VERSION} déjà présent")
        return
    url = f"https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/{WEBVIEW2_VERSION}"
    print(f"[1/5] Téléchargement du SDK WebView2 {WEBVIEW2_VERSION}…")
    data = urllib.request.urlopen(url, timeout=120).read()
    os.makedirs(VENDOR, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for src, dst in wanted.items():
            with z.open(src) as fi, open(os.path.join(VENDOR, dst), "wb") as fo:
                shutil.copyfileobj(fi, fo)
    with open(stamp, "w") as f:
        f.write(WEBVIEW2_VERSION)


def make_icon() -> None:
    if os.path.exists(ICON):
        print("[2/5] Icône déjà présente")
        return
    from PIL import Image  # pillow : uniquement pour la construction

    print("[2/5] Génération de l'icône")
    os.makedirs(os.path.dirname(ICON), exist_ok=True)
    src = Image.open(os.path.join(REPO, "public", "icons", "icon-512.png")).convert("RGBA")
    src.save(ICON, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def pyinstaller() -> None:
    print("[3/5] PyInstaller…")
    subprocess.check_call(
        [sys.executable, "-m", "PyInstaller", "NovaStudio.spec", "--noconfirm",
         "--distpath", DIST, "--workpath", WORK],
        cwd=HERE,
    )


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
    print("[4/5] Inno Setup…")
    iscc = find_iscc()
    subprocess.check_call([iscc, f"/DAppVersion={version}", "/Q", "installer.iss"], cwd=HERE)
    out = os.path.join(DIST, "NovaStudioSetup.exe")
    print(f"      {out} : {os.path.getsize(out) / 1e6:.1f} Mo")
    return out


def main() -> None:
    version = app_version()
    print(f"Nova Studio {version}")
    fetch_webview2()
    make_icon()
    pyinstaller()
    setup = inno(version)
    if "--no-copy" not in sys.argv:
        dst = os.path.join(REPO, "public", "downloads", "NovaStudioSetup.exe")
        shutil.copyfile(setup, dst)
        print(f"[5/5] Copié dans {dst}")
    else:
        print("[5/5] (copie ignorée)")


if __name__ == "__main__":
    main()
