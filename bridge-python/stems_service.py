#!/usr/bin/env python3
"""
NOVA - service « séparation de stems » du pont (comme Stem Splitter dans Logic
ou Stem Separation dans FL Studio).

Le pont n'embarque pas PyTorch : il pilote le module optionnel installé à la
demande dans %LOCALAPPDATA%\\NovaStudio\\stems (voir stems_install.py) et lance
stems_worker.py dans un sous-processus caché, avec progression et annulation.

    svc = StemsService()
    svc.status()                                   → installé ? installation en cours ? taille, CPU/GPU
    svc.start_install(on_event, variant="cpu")     → installation en arrière-plan (thread)
    svc.cancel_install()
    svc.separate(job_id, wav_in, outdir, stems=2|4|6|"leadback", on_event=...)   (bloquant : dans un thread)
        6 pistes et voix lead / chœurs : le modèle manquant (55 Mo, ou 53 Mo + onnxruntime)
        est téléchargé d'abord, dans la même progression, annulable.
    svc.cancel(job_id)

Erreurs : StemsNotInstalled (module absent), StemsCancelled (annulé),
StemsError (message clair pour le musicien).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np

import stems_install

NO_WINDOW = stems_install.NO_WINDOW
STEM_LABELS = {
    "vocals": "Voix",
    "instrumental": "Instru",
    "drums": "Batterie",
    "bass": "Basse",
    "guitar": "Guitare",
    "piano": "Piano",
    "other": "Autres",
    "lead_vocals": "Voix lead",
    "backing_vocals": "Chœurs",
}
# Jeux de stems : 2 (voix / instru), 4, 6 (htdemucs_6s) et voix lead / chœurs.
STEM_SETS = ("2", "4", "6", "leadback")
# Part de la barre de progression prise par un téléchargement de modèle avant la séparation.
DOWNLOAD_SHARE = 25.0
MAX_SECONDS = 20 * 60  # au-delà, mieux vaut couper le morceau


class StemsError(RuntimeError):
    pass


class StemsNotInstalled(StemsError):
    def __init__(self):
        super().__init__("La séparation de stems n'est pas encore installée sur ce PC "
                         "(module optionnel, ~0,7 Go à télécharger une fois).")


class StemsCancelled(StemsError):
    def __init__(self):
        super().__init__("Séparation annulée")


# ─── WAV float 32 bits (sans dépendance : le pont n'a pas soundfile) ──────────

def write_wav_float(path: Path, audio: np.ndarray, sr: int):
    """audio : (canaux, échantillons) float32."""
    audio = np.ascontiguousarray(audio, dtype="<f4")
    nch, n = audio.shape
    data = audio.T.tobytes()
    fmt = struct.pack("<HHIIHH", 3, nch, sr, sr * nch * 4, nch * 4, 32)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + 4 + 8 + len(data)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
        f.write(b"fact" + struct.pack("<II", 4, n))
        f.write(b"data" + struct.pack("<I", len(data)) + data)


def read_wav(path: Path):
    """WAV PCM 16/24/32 bits ou float 32/64 (y compris WAVE_FORMAT_EXTENSIBLE).
    Renvoie (canaux, échantillons) float32 et la fréquence."""
    buf = Path(path).read_bytes()
    if buf[:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise StemsError(f"Fichier WAV illisible : {path}")
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(buf):
        cid, size = buf[pos:pos + 4], struct.unpack_from("<I", buf, pos + 4)[0]
        body = buf[pos + 8: pos + 8 + size]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            data = body
        pos += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise StemsError(f"Fichier WAV incomplet : {path}")
    tag, nch, sr, _br, _ba, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag == 0xFFFE and len(fmt) >= 26:
        tag = struct.unpack_from("<H", fmt, 24)[0]
    if tag == 3:
        arr = np.frombuffer(data, dtype="<f4" if bits == 32 else "<f8").astype(np.float32)
    elif tag == 1 and bits == 16:
        arr = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    elif tag == 1 and bits == 24:
        b = np.frombuffer(data[: len(data) // 3 * 3], dtype=np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        arr = v.astype(np.float32) / float(1 << 23)
    elif tag == 1 and bits == 32:
        arr = np.frombuffer(data, dtype="<i4").astype(np.float32) / float(1 << 31)
    else:
        raise StemsError(f"Format WAV non pris en charge ({tag}, {bits} bits)")
    n = arr.size // nch
    return arr[: n * nch].reshape(n, nch).T, sr


def safe_name(text: str, fallback: str = "clip") -> str:
    t = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", str(text or "")).strip().strip(".")
    t = re.sub(r"\s+", " ", t)
    return (t or fallback)[:60]


def default_output_root() -> Path:
    env = os.environ.get("NOVA_STEMS_OUTPUT")
    if env:
        return Path(env)
    docs = Path.home() / "Documents"
    return (docs if docs.is_dir() else Path.home()) / "Nova Studio" / "Stems"


# ─── Service ─────────────────────────────────────────────────────────────────

class StemsService:
    def __init__(self, home: Optional[Path] = None, output_root: Optional[Path] = None,
                 python_exe: Optional[Path] = None):
        self.home = Path(home) if home else stems_install.default_home()
        self.python_exe = Path(python_exe) if python_exe else None  # tests
        self.output_root = Path(output_root) if output_root else default_output_root()
        self.lock = threading.Lock()
        self.jobs: Dict[str, subprocess.Popen] = {}
        self.addon_jobs: Dict[str, stems_install.Installer] = {}
        self.cancelled: set = set()
        self.installer: Optional[stems_install.Installer] = None
        self.install_thread: Optional[threading.Thread] = None
        self.install_state: Dict = {}

    # --- état ------------------------------------------------------------------

    def python(self) -> Path:
        return self.python_exe or stems_install.env_python(self.home)

    def worker(self) -> Path:
        return self.home / "stems_worker.py"

    def info(self) -> Optional[dict]:
        try:
            return json.loads((self.home / "installed.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def installed(self) -> bool:
        return self.info() is not None and self.python().is_file() and self.worker().is_file()

    def installing(self) -> bool:
        return self.install_thread is not None and self.install_thread.is_alive()

    def status(self) -> dict:
        info = self.info() if self.installed() else None
        variant = (info or {}).get("variant") or "cpu"
        sets = None
        if info is not None:
            sets = {k: {"ready": stems_install.addon_ready(self.home, k),
                        "download_bytes": stems_install.addon_download_bytes(self.home, k, variant)} for k in STEM_SETS}
        return {
            "installed": info is not None,
            "installing": self.installing(),
            "install": dict(self.install_state) if self.install_state else None,
            "home": str(self.home),
            "output_root": str(self.output_root),
            "variant": (info or {}).get("variant"),
            "model": (info or {}).get("model"),
            "size_bytes": (info or {}).get("size_bytes"),
            "busy": len(self.jobs) + len(self.addon_jobs),
            "sets": sets,
        }

    # --- installation ------------------------------------------------------------

    def start_install(self, on_event: Callable[[dict], None], variant: str = "cpu", model: str = "htdemucs") -> bool:
        """Lance l'installation en arrière-plan. False si elle tourne déjà."""
        with self.lock:
            if self.installing():
                return False
            self.install_state = {"event": "progress", "pct": 0, "step": "start", "message": "Préparation"}

            def relay(ev: dict):
                self.install_state = ev
                try:
                    on_event(ev)
                except Exception:
                    pass

            self.installer = stems_install.Installer(self.home, variant, model, on_event=relay)

            def run():
                try:
                    self.installer.install()
                    self._refresh_worker()
                except stems_install.InstallCancelled:
                    relay({"event": "cancelled", "message": "Installation annulée"})
                except Exception as e:
                    relay({"event": "error", "message": f"Installation impossible : {e}"})
                finally:
                    self.installer.close()

            self.install_thread = threading.Thread(target=run, name="stems-install", daemon=True)
            self.install_thread.start()
            return True

    def cancel_install(self) -> bool:
        inst = self.installer
        if inst is None or not self.installing():
            return False
        inst.cancel()
        return True

    def _refresh_worker(self):
        """Le moteur suit la version du pont (copie à côté de l'environnement)."""
        try:
            src = stems_install.worker_source()
            if src.resolve() != self.worker().resolve():
                if not self.worker().is_file() or src.read_bytes() != self.worker().read_bytes():
                    shutil.copyfile(src, self.worker())
        except OSError:
            pass

    # --- séparation --------------------------------------------------------------

    def output_dir(self, project: str, clip: str) -> Path:
        stamp = time.strftime("%Y-%m-%d %H-%M-%S")
        return self.output_root / safe_name(project, "Projet") / f"{safe_name(clip)} {stamp}"

    def _ensure_addon(self, job_id: str, stem_set: str, emit: Callable[[dict], None]) -> bool:
        """Télécharge le modèle d'un jeu de stems s'il manque (dans la progression de la
        séparation). True si un téléchargement a eu lieu."""
        if stems_install.addon_ready(self.home, stem_set):
            return False
        info = self.info() or {}
        variant = info.get("variant") or "cpu"
        what = "6 pistes" if stem_set == "6" else "voix lead / chœurs"
        size = stems_install.addon_download_bytes(self.home, stem_set, variant)
        emit({"event": "progress", "pct": 0.5, "phase": "download",
              "message": f"Premier usage : téléchargement du modèle {what} (~{size / 1e6:.0f} Mo, une seule fois)"})

        def relay(ev: dict):
            if ev.get("event") == "progress":
                emit({"event": "progress", "phase": "download", "message": ev.get("message") or "Téléchargement",
                      "pct": round(DOWNLOAD_SHARE * float(ev.get("pct") or 0) / 100.0, 1)})

        inst = stems_install.Installer(self.home, variant, info.get("model") or "htdemucs", on_event=relay)
        with self.lock:
            if job_id in self.cancelled:
                inst.close()
                raise StemsCancelled()
            self.addon_jobs[job_id] = inst
        try:
            inst.install_addon(stem_set)
        except stems_install.InstallCancelled:
            raise StemsCancelled()
        except Exception as e:
            if job_id in self.cancelled:
                raise StemsCancelled()
            raise StemsError(f"Téléchargement du modèle {what} impossible : {str(e)[:200]}. "
                             "Vérifie ta connexion Internet puis réessaie (rien n'est perdu).")
        finally:
            with self.lock:
                self.addon_jobs.pop(job_id, None)
            inst.close()
        return True

    def separate(self, job_id: str, wav_in: Path, outdir: Path, stems=4,
                 on_event: Optional[Callable[[dict], None]] = None, device: str = "auto",
                 model: Optional[str] = None) -> dict:
        """Bloquant. Renvoie {stems:[{key,label,path,rms}], seconds, device}."""
        stem_set = str(stems)
        if stem_set not in STEM_SETS:
            raise StemsError("Choisis 2 stems (voix / instru), 4, 6 ou voix lead / chœurs")
        if not self.installed():
            raise StemsNotInstalled()
        if self.installing():
            raise StemsError("Installation de la séparation de stems en cours : attends la fin")
        self._refresh_worker()
        self.cancelled.discard(job_id)

        def emit(ev: dict):
            if on_event is not None:
                try:
                    on_event(ev)
                except Exception:
                    pass

        outdir = Path(outdir)
        try:
            downloaded = self._ensure_addon(job_id, stem_set, emit)
        except StemsCancelled:
            self.cancelled.discard(job_id)
            self._drop_cancelled(wav_in, outdir)
            raise
        info = self.info() or {}
        outdir.mkdir(parents=True, exist_ok=True)
        cmd = [str(self.python()), "-I", str(self.worker()), "--input", str(wav_in), "--outdir", str(outdir),
               "--stems", stem_set, "--model", model or info.get("model") or "htdemucs", "--device", device]
        env = dict(os.environ)
        env.update({"TORCH_HOME": str(self.home / "models"), "PYTHONIOENCODING": "utf-8"})
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        with self.lock:
            if job_id in self.jobs:
                raise StemsError("Séparation déjà en cours pour ce clip")
            if job_id in self.cancelled:  # annulé juste après le téléchargement du modèle
                self.cancelled.discard(job_id)
                self._drop_cancelled(wav_in, outdir)
                raise StemsCancelled()
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                    creationflags=NO_WINDOW, cwd=str(self.home))
            self.jobs[job_id] = proc
        err_tail: List[str] = []

        def drain_err():
            for raw in proc.stderr:
                err_tail.append(raw.decode("utf-8", "replace").rstrip())
                del err_tail[:-20]

        threading.Thread(target=drain_err, daemon=True).start()
        done, error = None, None
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("{"):
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                kind = ev.get("event")
                if kind == "done":
                    done = ev
                elif kind == "error":
                    error = ev.get("message")
                else:
                    if downloaded and kind == "progress" and isinstance(ev.get("pct"), (int, float)):
                        ev = {**ev, "pct": round(DOWNLOAD_SHARE + (100 - DOWNLOAD_SHARE) * ev["pct"] / 100.0, 1)}
                    emit(ev)
            rc = proc.wait()
        finally:
            with self.lock:
                self.jobs.pop(job_id, None)
        if job_id in self.cancelled:
            self.cancelled.discard(job_id)
            self._drop_cancelled(wav_in, outdir)
            raise StemsCancelled()
        if rc != 0 or done is None:
            raise StemsError(friendly_error(error or " | ".join(err_tail[-3:]) or f"code {rc}"))
        result = []
        for s in done.get("stems", []):
            label = STEM_LABELS.get(s["key"], s["key"])
            src = Path(s["path"])
            dst = outdir / f"{label}.wav"
            try:
                os.replace(src, dst)
            except OSError:
                dst = src
            result.append({"key": s["key"], "label": label, "path": str(dst), "rms": s.get("rms")})
        return {"stems": result, "seconds": done.get("seconds"), "device": done.get("device"),
                "outdir": str(outdir), "set": stem_set, "model": done.get("model"),
                "karaoke_device": done.get("karaoke_device")}

    @staticmethod
    def _drop_cancelled(wav_in: Path, outdir: Path):
        outdir = Path(outdir)
        shutil.rmtree(outdir / ".partiel", ignore_errors=True)
        try:
            # Le clip envoyé (Original.wav, écrit par le pont dans ce dossier) ne sert plus :
            # sans lui, une séparation annulée laissait un dossier « Original.wav » seul
            # dans Documents\Nova Studio\Stems à chaque annulation.
            if Path(wav_in).parent.resolve() == outdir.resolve():
                Path(wav_in).unlink(missing_ok=True)
            if outdir.is_dir() and not any(outdir.iterdir()):
                outdir.rmdir()
        except OSError:
            pass

    def cancel(self, job_id: str) -> bool:
        with self.lock:
            inst = self.addon_jobs.get(job_id)
            proc = self.jobs.get(job_id)
            if proc is None and inst is None:
                return False
            self.cancelled.add(job_id)
        if inst is not None:
            inst.cancel()
        if proc is not None:
            stems_install.kill_tree(proc.pid)
        return True


def friendly_error(msg: str) -> str:
    low = msg.lower()
    if "out of memory" in low or "outofmemory" in low or "mémoire" in low:
        return "Pas assez de mémoire pour séparer ce morceau : ferme des programmes ou coupe-le en deux."
    if "trop court" in low:
        return "Clip trop court pour être séparé (une demi-seconde minimum)."
    if "no such file" in low or "introuvable" in low or "filenotfound" in low:
        return "Fichier introuvable pendant la séparation. Réinstalle le module si ça se répète."
    return f"La séparation a échoué : {msg[:300]}"
