#!/usr/bin/env python3
"""
NOVA - installation du module optionnel « voix par l'IA locale » (R24).

Installé à la demande, fonction par fonction, hors de l'installateur de Nova Studio :

    %LOCALAPPDATA%\\NovaStudio\\voice\\
        env\\                 Python 3.12 dédié : faster-whisper (MIT), CTranslate2 (MIT),
                              soundfile, numpy, scipy
        cuda\\                cuBLAS pour la carte NVIDIA : liens vers celui de PyTorch du
                              module stems quand il est là (rien à télécharger), sinon le
                              paquet officiel nvidia-cublas-cu12 (PyPI) dans env\\
        models\\whisper\\<m>\\   poids Whisper convertis (Hugging Face, MIT)
        tools\\deep-filter.exe  DeepFilterNet 3 (GitHub officiel, MIT / Apache-2.0)
        voice_worker.py       moteur (lancé par le pont)
        installed.json        fonctions prêtes (transcription, déréverbération), tailles
        install.log           journal complet

Utilisation (le pont le lance caché, sans fenêtre) :
    python voice_install.py --feature transcribe|deverb [--home DOSSIER] [--variant auto|cpu|cuda] [--model large-v3-turbo]

Chaque étape est écrite sur la sortie standard en JSON (comme stems_install).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import stems_install
from stems_install import InstallCancelled, dir_size, kill_tree, NO_WINDOW

PYTHON_VERSION = "3.12"
FASTER_WHISPER_VERSION = "1.2.1"
CUBLAS_PACKAGE = "nvidia-cublas-cu12==12.8.4.1"
CUBLAS_DLLS = ("cublas64_12.dll", "cublasLt64_12.dll")

# Modèles Whisper convertis pour CTranslate2 (licence MIT, vérifiée sur Hugging Face).
WHISPER_MODELS = {
    "large-v3-turbo": {"repo": "dropbox-dash/faster-whisper-large-v3-turbo", "bytes": 1_620_000_000},
    "large-v3": {"repo": "Systran/faster-whisper-large-v3", "bytes": 3_090_000_000},
}
WHISPER_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"]

DEEPFILTER_URL = "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe"
DEEPFILTER_SHA256 = "75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915"
DEEPFILTER_BYTES = 26_912_256

# Tailles annoncées avant l'installation (téléchargement), en octets.
ENV_BYTES = 230_000_000          # Python 3.12 + faster-whisper, CTranslate2, onnxruntime, scipy…
CUBLAS_BYTES = 570_000_000       # paquet NVIDIA, seulement sans le module stems en version carte graphique

FEATURES = ("transcribe", "deverb")


def default_home() -> Path:
    env = os.environ.get("NOVA_VOICE_HOME")
    if env:
        return Path(env)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "NovaStudio" / "voice"


def env_python(home: Path) -> Path:
    return home / "env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def stems_torch_lib() -> Path | None:
    """cuBLAS déjà sur le disque : PyTorch CUDA du module stems (même volume : liens physiques)."""
    lib = stems_install.default_home() / "env" / "Lib" / "site-packages" / "torch" / "lib"
    return lib if all((lib / d).is_file() for d in CUBLAS_DLLS) else None


def read_installed(home: Path) -> dict:
    try:
        return json.loads((home / "installed.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def download_estimate(home: Path, feature: str, variant: str = "auto", model: str = "large-v3-turbo") -> int:
    """Octets à télécharger pour installer `feature` maintenant (pour l'annoncer)."""
    info = read_installed(home)
    total = 0 if env_python(home).is_file() and info.get("env") else ENV_BYTES
    if feature == "transcribe":
        cuda = variant == "cuda" or (variant == "auto" and Installer.nvidia_ok())
        if cuda and not (home / "cuda" / CUBLAS_DLLS[0]).is_file() and stems_torch_lib() is None:
            total += CUBLAS_BYTES
        total += WHISPER_MODELS.get(model, WHISPER_MODELS["large-v3-turbo"])["bytes"]
    else:
        total += DEEPFILTER_BYTES
    return total


class Installer(stems_install.Installer):
    """Même mécanique que stems_install (commandes cachées, progression par la taille du
    dossier, annulation), étapes propres au module voix."""

    def __init__(self, home: Path, feature: str, variant: str = "auto", model: str = "large-v3-turbo", on_event=None):
        if feature not in FEATURES:
            raise ValueError(f"Fonction inconnue : {feature}")
        self.feature = feature
        super().__init__(home, variant, model, on_event=on_event)

    def emit(self, event: str, **kw):
        super().emit(event, feature=self.feature, **kw)

    def env(self):
        e = super().env()
        e["HF_HOME"] = str(self.home / "models" / "hf")
        e["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
        e["HF_HUB_DISABLE_TELEMETRY"] = "1"
        return e

    # --- étapes -------------------------------------------------------------------

    def ensure_env(self, uv: Path, pct_from: float, pct_to: float):
        info = read_installed(self.home)
        py = env_python(self.home)
        if py.is_file() and info.get("env"):
            self.progress(pct_to, "env", "Environnement Python déjà prêt")
            return py
        self.run([uv, "venv", "--clear", "--python", PYTHON_VERSION, str(self.home / "env")],
                 "python", pct_from, pct_from + (pct_to - pct_from) * 0.3, "Préparation de Python 3.12 (dédié à la voix)", 1.5e8)
        self.run([uv, "pip", "install", "--python", py, f"faster-whisper=={FASTER_WHISPER_VERSION}",
                  "soundfile", "numpy<2.4", "scipy", "huggingface_hub"],
                 "packages", pct_from + (pct_to - pct_from) * 0.3, pct_to, "Installation de faster-whisper et des outils audio", 4e8)
        return py

    def ensure_cuda(self, uv: Path, py: Path, pct_from: float, pct_to: float) -> str:
        """cuBLAS pour la carte graphique. Renvoie « cuda » ou « cpu »."""
        if self.variant == "cpu" or (self.variant == "auto" and not self.nvidia_ok()):
            return "cpu"
        dst = self.home / "cuda"
        if all((dst / d).is_file() for d in CUBLAS_DLLS):
            return "cuda"
        dst.mkdir(parents=True, exist_ok=True)
        lib = stems_torch_lib()
        if lib is not None:
            self.progress(pct_from, "cuda", "Bibliothèques de la carte graphique reprises du module stems (rien à télécharger)")
            for d in CUBLAS_DLLS:
                try:
                    os.link(lib / d, dst / d)  # même fichier, aucune place en plus
                except OSError:
                    shutil.copyfile(lib / d, dst / d)
            self.log("cuBLAS : liens vers " + str(lib))
            self.progress(pct_to, "cuda", "Bibliothèques de la carte graphique prêtes")
            return "cuda"
        self.run([uv, "pip", "install", "--python", py, CUBLAS_PACKAGE],
                 "cuda", pct_from, pct_to, "Téléchargement de cuBLAS (NVIDIA, pour la carte graphique)", CUBLAS_BYTES * 1.6)
        return "cuda"

    def download_whisper(self, py: Path, pct_from: float, pct_to: float):
        spec = WHISPER_MODELS.get(self.model)
        if not spec:
            raise RuntimeError(f"Modèle inconnu : {self.model}")
        dst = self.home / "models" / "whisper" / self.model
        if (dst / "model.bin").is_file() and (dst / "model.bin").stat().st_size > spec["bytes"] * 0.9:
            self.progress(pct_to, "model", "Modèle déjà téléchargé")
            return
        code = ("import sys\nfrom huggingface_hub import snapshot_download\n"
                f"snapshot_download({spec['repo']!r}, local_dir=sys.argv[1], allow_patterns={WHISPER_FILES!r})\n")
        self.run([py, "-I", "-c", code, str(dst)], "model", pct_from, pct_to,
                 f"Téléchargement du modèle Whisper {self.model} (~{spec['bytes'] / 1e9:.1f} Go)", spec["bytes"] * 1.02)
        shutil.rmtree(dst / ".cache", ignore_errors=True)

    def download_deepfilter(self, pct_from: float, pct_to: float):
        exe = self.home / "tools" / "deep-filter.exe"
        if exe.is_file() and sha256(exe) == DEEPFILTER_SHA256:
            self.progress(pct_to, "deverb", "DeepFilterNet déjà là")
            return
        self.check_cancel()
        self.progress(pct_from, "deverb", "Téléchargement de DeepFilterNet 3 (~27 Mo)")
        exe.parent.mkdir(parents=True, exist_ok=True)
        tmp = exe.with_suffix(".part")
        req = urllib.request.Request(DEEPFILTER_URL, headers={"User-Agent": "NovaStudio"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            got = 0
            while True:
                self.check_cancel()
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
                got += len(buf)
                self.progress(pct_from + (pct_to - pct_from) * min(0.99, got / DEEPFILTER_BYTES), "deverb",
                              f"Téléchargement de DeepFilterNet 3 ({got / 1e6:.0f} Mo)")
        if sha256(tmp) != DEEPFILTER_SHA256:
            tmp.unlink(missing_ok=True)
            raise RuntimeError("DeepFilterNet téléchargé ne correspond pas à la version officielle (empreinte)")
        os.replace(tmp, exe)
        self.progress(pct_to, "deverb", "DeepFilterNet 3 prêt")

    def copy_worker(self):
        shutil.copyfile(worker_source(), self.home / "voice_worker.py")

    def install(self):
        t0 = time.time()
        if self.variant == "auto":
            self.variant = "cuda" if self.nvidia_ok() else "cpu"
            self.log(f"variante choisie : {self.variant}")
        info = read_installed(self.home)
        feats = dict(info.get("features") or {})
        feats.pop(self.feature, None)  # pas « prête » tant que ce n'est pas fini
        info["features"] = feats
        self.write_info(info)
        uv = self.find_uv()
        self.log(f"uv : {uv}")
        py = self.ensure_env(uv, 3, 30)
        info["env"] = {"python": PYTHON_VERSION, "faster_whisper": FASTER_WHISPER_VERSION}
        self.write_info(info)
        self.copy_worker()
        if self.feature == "transcribe":
            device = self.ensure_cuda(uv, py, 30, 45)
            self.download_whisper(py, 45, 94)
            entry = {"model": self.model, "device": device}
        else:
            self.download_deepfilter(30, 92)
            entry = {"engine": "deepfilternet3", "device": "cpu"}
        self.progress(95, "check", "Vérification")
        r = subprocess.run([str(py), "-I", str(self.home / "voice_worker.py"), "self-test", self.feature, "--model", self.model],
                           capture_output=True, env=self.env(), creationflags=NO_WINDOW, timeout=1800)
        out = r.stdout.decode("utf-8", "replace")
        self.log(out + r.stderr.decode("utf-8", "replace"))
        self.check_cancel()
        test = {}
        for line in out.splitlines():
            if line.startswith("{"):
                try:
                    test = json.loads(line)
                except ValueError:
                    pass
        if r.returncode != 0 or not test.get("ok"):
            raise RuntimeError("Le test de vérification a échoué (voir install.log)")
        shutil.rmtree(self.home / "cache", ignore_errors=True)
        entry.update({"installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "install_seconds": round(time.time() - t0, 1),
                      "self_test": test})
        if test.get("device"):
            entry["device"] = test["device"]
        if test.get("gpu"):
            entry["gpu"] = test["gpu"]
        info = read_installed(self.home)
        info.setdefault("features", {})[self.feature] = entry
        info["size_bytes"] = dir_size(self.home)
        self.write_info(info)
        label = "Transcription des paroles installée" if self.feature == "transcribe" else "Déréverbération installée"
        self.emit("done", pct=100, info=info, message=label)
        return info

    def write_info(self, info: dict):
        tmp = self.home / "installed.json.tmp"
        tmp.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.home / "installed.json")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(1 << 20), b""):
            h.update(buf)
    return h.hexdigest()


def worker_source() -> Path:
    for base in (Path(__file__).resolve().parent, Path(getattr(sys, "_MEIPASS", "") or ".")):
        p = base / "voice_worker.py"
        if p.is_file():
            return p
    raise FileNotFoundError("voice_worker.py introuvable")


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=None)
    ap.add_argument("--feature", required=True, choices=FEATURES)
    ap.add_argument("--variant", default="auto", choices=["cpu", "cuda", "auto"])
    ap.add_argument("--model", default="large-v3-turbo", choices=list(WHISPER_MODELS))
    a = ap.parse_args(argv)
    inst = Installer(Path(a.home) if a.home else default_home(), a.feature, a.variant, a.model)
    try:
        inst.install()
        return 0
    except InstallCancelled:
        inst.emit("cancelled", message="Installation annulée")
        return 2
    except Exception as e:
        inst.emit("error", message=str(e))
        return 1
    finally:
        inst.close()


if __name__ == "__main__":
    sys.exit(main())
