#!/usr/bin/env python3
"""
NOVA - service « voix par l'IA locale » du pont (R24) : socle commun à la
déréverbération (deverb_service.py) et à la transcription (transcribe_service.py).

Comme les stems : le pont n'embarque ni Whisper ni DeepFilterNet. Il pilote le module
optionnel installé à la demande dans %LOCALAPPDATA%\\NovaStudio\\voice (voir
voice_install.py) et lance voice_worker.py dans un sous-processus caché, avec
progression et annulation.

    svc = VoiceService()
    svc.status()                                   → fonctions installées, installation en cours, tailles
    svc.start_install("transcribe", on_event)      → installation en arrière-plan (thread)
    svc.cancel_install()
    svc.run_job(job_id, ["deverb", ...], on_event) (bloquant : à lancer dans un thread)
    svc.cancel(job_id)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable, Dict, List, Optional

import stems_install
import voice_install

NO_WINDOW = stems_install.NO_WINDOW
FEATURE_LABELS = {"transcribe": "la transcription des paroles", "deverb": "le retrait de la réverbe"}


class VoiceError(RuntimeError):
    pass


class VoiceNotInstalled(VoiceError):
    def __init__(self, feature: str):
        self.feature = feature
        super().__init__(f"Il faut d'abord installer {FEATURE_LABELS.get(feature, feature)} sur ce PC "
                         "(module optionnel, téléchargé une fois).")


class VoiceCancelled(VoiceError):
    def __init__(self):
        super().__init__("Calcul annulé")


class VoiceService:
    def __init__(self, home: Optional[Path] = None, python_exe: Optional[Path] = None):
        self.home = Path(home) if home else voice_install.default_home()
        self.python_exe = Path(python_exe) if python_exe else None  # tests
        self.lock = threading.Lock()
        self.jobs: Dict[str, subprocess.Popen] = {}
        self.cancelled: set = set()
        self.installer: Optional[voice_install.Installer] = None
        self.install_thread: Optional[threading.Thread] = None
        self.install_state: Dict = {}
        self.install_feature: Optional[str] = None

    # --- état ------------------------------------------------------------------

    def python(self) -> Path:
        return self.python_exe or voice_install.env_python(self.home)

    def worker(self) -> Path:
        return self.home / "voice_worker.py"

    def info(self) -> dict:
        return voice_install.read_installed(self.home)

    def installed(self, feature: str) -> bool:
        return bool((self.info().get("features") or {}).get(feature)) and self.python().is_file() and self.worker().is_file()

    def installing(self) -> bool:
        return self.install_thread is not None and self.install_thread.is_alive()

    def status(self, variant: str = "auto") -> dict:
        info = self.info()
        feats = info.get("features") or {}
        out = {}
        for f in voice_install.FEATURES:
            e = feats.get(f) if self.installed(f) else None
            try:
                dl = voice_install.download_estimate(self.home, f, variant)
            except Exception:
                dl = None
            out[f] = {"installed": e is not None, "model": (e or {}).get("model") or (e or {}).get("engine"),
                      "device": (e or {}).get("device"), "gpu": (e or {}).get("gpu"), "download_bytes": dl}
        return {
            "home": str(self.home),
            "installing": self.installing(),
            "install_feature": self.install_feature if self.installing() else None,
            "install": dict(self.install_state) if self.install_state else None,
            "features": out,
            "size_bytes": info.get("size_bytes"),
            "busy": len(self.jobs),
        }

    # --- installation ------------------------------------------------------------

    def start_install(self, feature: str, on_event: Callable[[dict], None], variant: str = "auto",
                      model: str = "large-v3-turbo") -> bool:
        """Lance l'installation en arrière-plan. False si une installation tourne déjà."""
        if feature not in voice_install.FEATURES:
            raise VoiceError(f"Fonction inconnue : {feature}")
        with self.lock:
            if self.installing():
                return False
            self.install_feature = feature
            self.install_state = {"event": "progress", "feature": feature, "pct": 0, "step": "start", "message": "Préparation"}

            def relay(ev: dict):
                self.install_state = ev
                try:
                    on_event(ev)
                except Exception:
                    pass

            self.installer = voice_install.Installer(self.home, feature, variant, model, on_event=relay)

            def run():
                try:
                    self.installer.install()
                except stems_install.InstallCancelled:
                    relay({"event": "cancelled", "feature": feature, "message": "Installation annulée"})
                except Exception as e:
                    relay({"event": "error", "feature": feature, "message": f"Installation impossible : {e}"})
                finally:
                    self.installer.close()

            self.install_thread = threading.Thread(target=run, name="voice-install", daemon=True)
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
            src = voice_install.worker_source()
            if src.resolve() != self.worker().resolve():
                if not self.worker().is_file() or src.read_bytes() != self.worker().read_bytes():
                    shutil.copyfile(src, self.worker())
        except OSError:
            pass

    # --- calculs -------------------------------------------------------------------

    def work_dir(self, job_id: str) -> Path:
        safe = "".join(ch for ch in job_id if ch.isalnum() or ch in "-_")[:40] or "job"
        d = self.home / "work" / safe
        d.mkdir(parents=True, exist_ok=True)
        return d

    def run_job(self, job_id: str, feature: str, args: List[str], on_event: Optional[Callable[[dict], None]] = None) -> dict:
        """Bloquant. Renvoie l'événement « done » du moteur."""
        if not self.installed(feature):
            raise VoiceNotInstalled(feature)
        if self.installing():
            raise VoiceError("Installation en cours : attends la fin")
        self._refresh_worker()
        cmd = [str(self.python()), "-I", str(self.worker())] + [str(a) for a in args]
        env = dict(os.environ)
        env.update({"PYTHONIOENCODING": "utf-8", "HF_HOME": str(self.home / "models" / "hf"), "HF_HUB_OFFLINE": "1"})
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        with self.lock:
            if job_id in self.jobs:
                raise VoiceError("Calcul déjà en cours pour ce clip")
            self.cancelled.discard(job_id)
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                    creationflags=NO_WINDOW, cwd=str(self.home))
            self.jobs[job_id] = proc
        err_tail: List[str] = []

        def drain_err():
            for raw in proc.stderr:
                err_tail.append(raw.decode("utf-8", "replace").rstrip())
                del err_tail[:-20]

        drain = threading.Thread(target=drain_err, daemon=True)
        drain.start()
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
                elif on_event is not None:
                    try:
                        on_event(ev)
                    except Exception:
                        pass
            rc = proc.wait()
        finally:
            with self.lock:
                self.jobs.pop(job_id, None)
            drain.join(timeout=2)
            for stream in (proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass
        if job_id in self.cancelled:
            self.cancelled.discard(job_id)
            raise VoiceCancelled()
        if rc != 0 or done is None:
            raise VoiceError(friendly_error(error or " | ".join(err_tail[-3:]) or f"code {rc}"))
        return done

    def cancel(self, job_id: str) -> bool:
        with self.lock:
            proc = self.jobs.get(job_id)
            if proc is None:
                return False
            self.cancelled.add(job_id)
        stems_install.kill_tree(proc.pid)
        return True


def friendly_error(msg: str) -> str:
    low = msg.lower()
    if "out of memory" in low or "outofmemory" in low or "mémoire" in low:
        return "Pas assez de mémoire : ferme des programmes (ou coupe le clip) et réessaie."
    if "trop court" in low:
        return "Clip trop court (une demi-seconde minimum)."
    if "introuvable" in low or "no such file" in low or "filenotfound" in low:
        return "Fichier du module introuvable : réinstalle-le si ça se répète."
    return f"Le calcul a échoué : {msg[:300]}"
