#!/usr/bin/env python3
"""
NOVA - installation du module optionnel « séparation de stems » (Demucs).

Installé à la demande, une seule fois, hors de l'installateur de Nova Studio
(sinon tout le monde téléchargerait ~1 à 2 Go) :

    %LOCALAPPDATA%\\NovaStudio\\stems\\
        tools\\uv.exe         gestionnaire Python « uv » (Astral, MIT/Apache-2.0),
                              repris du PC s'il existe, sinon téléchargé
        python\\              Python 3.12 autonome (python-build-standalone)
        env\\                 environnement : torch, torchaudio, demucs, soundfile
        models\\hub\\         poids du modèle Demucs (htdemucs, ~80 Mo)
        models\\hub\\…\\5c90dfd2-34c22ccb.th   6 pistes (htdemucs_6s, ~55 Mo), à la demande
        models\\uvr\\UVR_MDXNET_KARA_2.onnx    voix lead / chœurs (UVR, ~53 Mo), à la demande,
                              avec onnxruntime (CPU ~13 Mo, GPU ~215 Mo) dans env\\
        stems_worker.py       moteur de séparation (lancé par le pont)
        installed.json        présent = module prêt (versions, CPU/GPU, taille)
        install.log           journal complet

Utilisation (le pont le lance caché, sans fenêtre) :
    python stems_install.py [--home DOSSIER] [--variant cpu|cuda|auto] [--model htdemucs]

Chaque étape est écrite sur la sortie standard en JSON, une ligne par événement :
    {"event": "progress", "pct": 42.0, "step": "torch", "message": "..."}
    {"event": "done", "info": {...}}   |   {"event": "error", "message": "..."}

Variante :
    cpu  (défaut) : PyTorch CPU (~1 Go installé). Marche partout, y compris quand
                    la carte NVIDIA est désactivée (mode MAO).
    cuda           : PyTorch CUDA 12.8 (~4 à 5 Go installés), 10 à 20 fois plus rapide
                    quand la carte NVIDIA est active ; repli CPU automatique sinon.
    auto           : cuda si une carte NVIDIA répond (nvidia-smi), sinon cpu.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

PYTHON_VERSION = "3.12"
# Versions figées : torchaudio 2.9+ a retiré load/save (que Demucs importe).
TORCH_VERSION = "2.8.0"
TORCHAUDIO_VERSION = "2.8.0"
DEMUCS_VERSION = "4.0.1"
TORCH_INDEX = {
    "cpu": "https://download.pytorch.org/whl/cpu",
    "cuda": "https://download.pytorch.org/whl/cu128",  # RTX 50xx (Blackwell) : CUDA 12.8 minimum
}
# Croissance du dossier pendant l'étape PyTorch (cache, liens physiques comptés deux
# fois par la mesure ; ~6,3 Go mesurés le 07/10/2026 pour la variante CPU), pour la
# barre de progression. Les ~2,6 Go de .lib
# inutiles sont supprimés à la fin (voir prune) : il reste ~0,8 Go (CPU).
TORCH_GROWTH = {"cpu": 6_400_000_000, "cuda": 11_000_000_000}
# Modèles en plus, téléchargés à la première séparation qui les demande (voir install_addon).
HTDEMUCS_6S_FILE = "5c90dfd2-34c22ccb.th"
HTDEMUCS_6S_BYTES = 54_996_327
KARAOKE_FILE = "UVR_MDXNET_KARA_2.onnx"
KARAOKE_BYTES = 52_786_726
ORT_PACKAGES = {"cpu": "onnxruntime==1.22.1", "cuda": "onnxruntime-gpu==1.22.0"}
ORT_BYTES = {"cpu": 12_690_910 + 2_000_000, "cuda": 214_923_964 + 2_000_000}  # roue + petites dépendances


def addon_files(home: Path) -> dict:
    return {"6": home / "models" / "hub" / "checkpoints" / HTDEMUCS_6S_FILE,
            "leadback": home / "models" / "uvr" / KARAOKE_FILE}


def ort_installed(home: Path) -> bool:
    sp = home / "env" / ("Lib/site-packages" if os.name == "nt" else "lib")
    return any(sp.glob("onnxruntime*/__init__.py")) or any(sp.glob("python*/site-packages/onnxruntime/__init__.py"))


def addon_ready(home: Path, name: str) -> bool:
    """Le jeu de stems « name » (« 6 » ou « leadback ») peut-il tourner sans rien télécharger ?"""
    if name in ("2", "4"):
        return True
    f = addon_files(home).get(name)
    if f is None or not f.is_file():
        return False
    size = HTDEMUCS_6S_BYTES if name == "6" else KARAOKE_BYTES
    if f.stat().st_size != size:
        return False
    return ort_installed(home) if name == "leadback" else True


def addon_download_bytes(home: Path, name: str, variant: str) -> int:
    """Taille à télécharger pour ce jeu de stems (0 s'il est prêt)."""
    if addon_ready(home, name):
        return 0
    if name == "6":
        return HTDEMUCS_6S_BYTES
    if name == "leadback":
        files = addon_files(home)
        total = 0 if files["leadback"].is_file() and files["leadback"].stat().st_size == KARAOKE_BYTES else KARAOKE_BYTES
        return total + (0 if ort_installed(home) else ORT_BYTES.get(variant, ORT_BYTES["cpu"]))
    return 0


UV_URL = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW


def default_home() -> Path:
    env = os.environ.get("NOVA_STEMS_HOME")
    if env:
        return Path(env)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "NovaStudio" / "stems"


def env_python(home: Path) -> Path:
    return home / "env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


class InstallCancelled(RuntimeError):
    pass


class Installer:
    """on_event(dict) reçoit chaque événement (par défaut : JSON sur la sortie
    standard). cancel() arrête l'installation en cours (processus enfant tué)."""

    def __init__(self, home: Path, variant: str, model: str, on_event=None):
        self.home = home
        self.variant = variant
        self.model = model
        self.on_event = on_event
        self.proc = None
        self.cancelled = threading.Event()
        self.home.mkdir(parents=True, exist_ok=True)
        self.log_file = open(self.home / "install.log", "a", encoding="utf-8")
        self.log(f"=== Installation {time.strftime('%Y-%m-%d %H:%M:%S')} variante={variant} modèle={model}")

    # --- sorties ------------------------------------------------------------

    def log(self, line: str):
        if self.log_file.closed:
            return
        self.log_file.write(line.rstrip() + "\n")
        self.log_file.flush()

    def emit(self, event: str, **kw):
        msg = {"event": event, **kw}
        if self.on_event is not None:
            self.on_event(msg)
        else:
            sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        self.log(f"[{event}] {kw.get('pct', '')} {kw.get('message', '')}")

    def close(self):
        try:
            self.log_file.close()
        except Exception:
            pass

    def cancel(self):
        self.cancelled.set()
        proc = self.proc
        if proc is not None and proc.poll() is None:
            kill_tree(proc.pid)

    def check_cancel(self):
        if self.cancelled.is_set():
            raise InstallCancelled("Installation annulée")

    def progress(self, pct: float, step: str, message: str):
        self.emit("progress", pct=round(pct, 1), step=step, message=message)

    # --- outils ----------------------------------------------------------------

    def run(self, cmd, step: str, pct_from: float, pct_to: float, message: str, expect_bytes: float = 1e8,
            show_total: bool = False):
        """Lance une commande cachée ; pendant qu'elle tourne, la progression suit
        la taille du dossier (téléchargements de PyTorch : plusieurs centaines de Mo)."""
        self.check_cancel()
        self.log("$ " + " ".join(str(c) for c in cmd))
        self.progress(pct_from, step, message)
        self.proc = proc = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                env=self.env(), creationflags=NO_WINDOW, cwd=str(self.home))
        start_size = dir_size(self.home)
        stop = threading.Event()

        def watch():
            while not stop.wait(2.0):
                grown = max(0, dir_size(self.home) - start_size)
                frac = min(0.97, grown / max(1.0, expect_bytes))
                done_mb = f"{min(grown, expect_bytes) / 1e6:.0f} / {expect_bytes / 1e6:.0f} Mo" if show_total else f"{grown / 1e6:.0f} Mo"
                self.progress(pct_from + (pct_to - pct_from) * frac, step, f"{message} ({done_mb})")

        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        tail = []
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip()
                self.log(line)
                tail = (tail + [line])[-15:]
            rc = proc.wait()
        finally:
            stop.set()
            watcher.join(timeout=5)
            self.proc = None
        self.check_cancel()
        if rc != 0:
            raise RuntimeError(f"Étape « {step} » en échec (code {rc}) : " + " | ".join(tail[-4:]))
        self.progress(pct_to, step, message)

    def env(self):
        e = dict(os.environ)
        e.update({
            "UV_CACHE_DIR": str(self.home / "cache"),
            "UV_PYTHON_INSTALL_DIR": str(self.home / "python"),
            # Liens physiques (cache et environnement sur le même disque) : PyTorch n'est
            # pas stocké deux fois pendant l'installation ; effacer le cache ensuite ne
            # touche pas aux fichiers installés.
            "UV_LINK_MODE": "hardlink",
            "UV_NO_PROGRESS": "1",
            "UV_PYTHON_PREFERENCE": "only-managed",  # jamais le Python du système
            "TORCH_HOME": str(self.home / "models"),
            "PYTHONIOENCODING": "utf-8",
        })
        e.pop("VIRTUAL_ENV", None)
        return e

    def find_uv(self) -> Path:
        local = self.home / "tools" / "uv.exe"
        candidates = [local, shutil.which("uv"),
                      Path.home() / ".local" / "bin" / "uv.exe",
                      Path.home() / ".cargo" / "bin" / "uv.exe"]
        for c in candidates:
            if c and Path(c).is_file():
                return Path(c)
        self.progress(2, "uv", "Téléchargement de l'outil d'installation (uv, ~20 Mo)")
        (self.home / "tools").mkdir(exist_ok=True)
        zpath = self.home / "tools" / "uv.zip"
        urllib.request.urlretrieve(UV_URL, zpath)
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                if name.endswith("uv.exe"):
                    local.write_bytes(z.read(name))
        zpath.unlink(missing_ok=True)
        if not local.is_file():
            raise RuntimeError("uv.exe introuvable dans l'archive téléchargée")
        return local

    @staticmethod
    def nvidia_ok() -> bool:
        exe = shutil.which("nvidia-smi")
        if not exe:
            return False
        try:
            r = subprocess.run([exe, "-L"], capture_output=True, timeout=15, creationflags=NO_WINDOW)
            return r.returncode == 0 and b"GPU" in r.stdout
        except Exception:
            return False

    # --- étapes -----------------------------------------------------------------

    def install(self):
        t0 = time.time()
        if self.variant == "auto":
            self.variant = "cuda" if self.nvidia_ok() else "cpu"
            self.log(f"variante choisie : {self.variant}")
        (self.home / "installed.json").unlink(missing_ok=True)  # pas « prêt » tant que ce n'est pas fini
        uv = self.find_uv()
        self.log(f"uv : {uv}")
        self.run([uv, "venv", "--clear", "--python", PYTHON_VERSION, str(self.home / "env")],
                 "python", 3, 12, "Préparation de Python 3.12 (dédié aux stems)", 1.5e8)
        py = env_python(self.home)
        torch_pkgs = [f"torch=={TORCH_VERSION}", f"torchaudio=={TORCHAUDIO_VERSION}"]
        self.run([uv, "pip", "install", "--python", py, "--index-url", TORCH_INDEX[self.variant]] + torch_pkgs,
                 "torch", 12, 72, "Téléchargement de PyTorch " + ("GPU (CUDA)" if self.variant == "cuda" else "CPU"),
                 TORCH_GROWTH[self.variant])
        # demucs dépend de torch : on garde la version déjà installée (index PyTorch en plus).
        self.run([uv, "pip", "install", "--python", py,
                  "--extra-index-url", TORCH_INDEX[self.variant], "--index-strategy", "unsafe-best-match",
                  f"demucs=={DEMUCS_VERSION}", "soundfile", "numpy<2.4"] + torch_pkgs,
                 "demucs", 72, 85, "Installation de Demucs (séparation de sources)", 1.2e8)
        self.copy_worker()
        self.run([py, "-I", str(self.home / "stems_worker.py"), "--download-model", "--model", self.model],
                 "model", 85, 95, f"Téléchargement du modèle {self.model} (~80 Mo)",
                 8.5e7 * (4 if self.model.endswith("_ft") else 1))
        self.progress(96, "check", "Vérification")
        r = subprocess.run([str(py), "-I", str(self.home / "stems_worker.py"), "--self-test", "--model", self.model],
                           capture_output=True, env=self.env(), creationflags=NO_WINDOW, timeout=900)
        out = r.stdout.decode("utf-8", "replace")
        self.log(out + r.stderr.decode("utf-8", "replace"))
        self.check_cancel()
        info = {}
        for line in out.splitlines():
            if line.startswith("{"):
                try:
                    info = json.loads(line)
                except json.JSONDecodeError:
                    pass
        if r.returncode != 0 or not info.get("ok"):
            raise RuntimeError("Le test de séparation a échoué (voir install.log)")
        # Le cache de téléchargement ne sert plus (les fichiers installés restent).
        shutil.rmtree(self.home / "cache", ignore_errors=True)
        self.prune()
        info.update({"variant": self.variant, "model": self.model, "python": PYTHON_VERSION,
                     "torch": TORCH_VERSION, "demucs": DEMUCS_VERSION,
                     "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                     "install_seconds": round(time.time() - t0, 1),
                     "size_bytes": dir_size(self.home)})
        (self.home / "installed.json").write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
        self.emit("done", pct=100, info=info, message="Séparation de stems installée")
        return info

    def install_addon(self, name: str, pct_from: float = 0.0, pct_to: float = 100.0):
        """Ajoute un jeu de stems au module déjà installé : « 6 » (modèle htdemucs_6s) ou
        « leadback » (onnxruntime + modèle UVR Karaoke 2, puis un essai qui prépare la carte
        graphique). Progression de pct_from à pct_to ; annulable (cancel)."""
        if name not in ("6", "leadback"):
            raise ValueError(f"Jeu de stems inconnu : {name}")
        py = env_python(self.home)
        if not py.is_file():
            raise RuntimeError("Module stems absent : installe d'abord la séparation de stems")
        self.copy_worker()
        worker = self.home / "stems_worker.py"
        span = pct_to - pct_from
        if name == "6":
            self.run([py, "-I", worker, "--download-model", "--model", "htdemucs_6s"], "model6",
                     pct_from, pct_to, "Téléchargement du modèle 6 pistes",
                     HTDEMUCS_6S_BYTES, show_total=True)
        else:
            if not ort_installed(self.home):
                uv = self.find_uv()
                ort_pkg = ORT_PACKAGES["cuda" if self.variant == "cuda" else "cpu"]
                self.run([uv, "pip", "install", "--python", py, ort_pkg, "numpy<2.4"], "onnxruntime",
                         pct_from, pct_from + span * 0.55,
                         "Installation du moteur ONNX " + ("GPU" if self.variant == "cuda" else "CPU")
                         + f", ~{ORT_BYTES['cuda' if self.variant == 'cuda' else 'cpu'] / 1e6:.0f} Mo à télécharger",
                         ORT_BYTES["cuda" if self.variant == "cuda" else "cpu"] * 1.6)
                shutil.rmtree(self.home / "cache", ignore_errors=True)
            self.run([py, "-I", worker, "--download-karaoke"], "karaoke", pct_from + span * 0.55,
                     pct_from + span * 0.85, "Téléchargement du modèle voix lead / chœurs",
                     KARAOKE_BYTES, show_total=True)
            # Premier passage : vérifie le modèle et, sur une carte NVIDIA récente, compile
            # les noyaux de calcul une fois pour toutes (jusqu'à ~1 min).
            self.run([py, "-I", worker, "--self-test", "--stems", "leadback", "--device", "auto"], "check",
                     pct_from + span * 0.85, pct_to,
                     "Vérification (la 1re fois sur la carte graphique : jusqu'à 1 min)", 1)
        self.check_cancel()
        info_path = self.home / "installed.json"
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            info.setdefault("addons", {})[name] = time.strftime("%Y-%m-%dT%H:%M:%S")
            info["size_bytes"] = dir_size(self.home)
            info_path.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
        except (OSError, ValueError):
            pass
        self.log(f"jeu de stems {name} prêt")

    def prune(self):
        """PyTorch pour Windows livre ~2,6 Go de bibliothèques statiques (.lib) et
        d'en-têtes C++ qui ne servent qu'à compiler des extensions : inutiles ici."""
        torch_dir = self.home / "env" / "Lib" / "site-packages" / "torch"
        freed = 0
        for lib in (torch_dir / "lib").glob("*.lib"):
            try:
                freed += lib.stat().st_size
                lib.unlink()
            except OSError:
                pass
        inc = torch_dir / "include"
        if inc.is_dir():
            freed += dir_size(inc)
            shutil.rmtree(inc, ignore_errors=True)
        self.log(f"allègement : {freed / 1e6:.0f} Mo libérés")

    def copy_worker(self):
        src = worker_source()
        shutil.copyfile(src, self.home / "stems_worker.py")


def kill_tree(pid: int):
    """Arrête un processus et ses enfants (uv lance lui-même des processus)."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def worker_source() -> Path:
    """stems_worker.py à côté de ce fichier (ou dans l'exécutable PyInstaller)."""
    for base in (Path(__file__).resolve().parent, Path(getattr(sys, "_MEIPASS", "") or ".")):
        p = base / "stems_worker.py"
        if p.is_file():
            return p
    raise FileNotFoundError("stems_worker.py introuvable")


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=None)
    ap.add_argument("--variant", default="cpu", choices=["cpu", "cuda", "auto"])
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--addon", choices=["6", "leadback"], default=None,
                    help="ajoute un jeu de stems au module déjà installé")
    a = ap.parse_args(argv)
    inst = Installer(Path(a.home) if a.home else default_home(), a.variant, a.model)
    try:
        if a.addon:
            inst.install_addon(a.addon)
            inst.emit("done", pct=100, message="Prêt")
            return 0
        inst.install()
        return 0
    except InstallCancelled:
        inst.emit("cancelled", message="Installation annulée")
        return 2
    except Exception as e:  # message lisible pour le DAW + journal complet
        inst.emit("error", message=str(e))
        return 1
    finally:
        inst.close()


if __name__ == "__main__":
    sys.exit(main())
