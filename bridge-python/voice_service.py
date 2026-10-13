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
    svc.run_transcription(job_id, {...}, on_event) (B7 : moteur gardé chargé entre les clips)
    svc.cancel(job_id)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

import stems_install
import voice_install

NO_WINDOW = stems_install.NO_WINDOW
# B7 : le moteur de transcription reste chargé (Whisper sur la carte graphique) tant que des
# clips arrivent ; libéré après ce délai sans travail (mémoire de la carte rendue).
SERVER_IDLE_S = float(os.environ.get("NOVA_VOICE_IDLE_S", "120"))
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
        self.server: Optional[subprocess.Popen] = None
        self.server_lock = threading.Lock()
        self.server_err: List[str] = []
        self.server_timer: Optional[threading.Timer] = None
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
        if not self.installing() and not self.jobs:
            self.stop_server()  # B7 : le moteur gardé chargé ne bloque pas les fichiers à remplacer
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

    # --- B7 : moteur de transcription gardé chargé ------------------------------------

    def _env(self) -> dict:
        env = dict(os.environ)
        env.update({"PYTHONIOENCODING": "utf-8", "HF_HOME": str(self.home / "models" / "hf"), "HF_HUB_OFFLINE": "1"})
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        return env

    def _start_server(self) -> subprocess.Popen:
        self._refresh_worker()
        proc = subprocess.Popen([str(self.python()), "-I", str(self.worker()), "serve"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self._env(),
                                creationflags=NO_WINDOW, cwd=str(self.home))
        self.server_err = []

        def drain_err():
            for raw in proc.stderr:
                self.server_err.append(raw.decode("utf-8", "replace").rstrip())
                del self.server_err[:-20]

        threading.Thread(target=drain_err, daemon=True).start()
        return proc

    def stop_server(self):
        """Libère le moteur (et la mémoire de la carte graphique)."""
        with self.lock:
            proc, self.server = self.server, None
            if self.server_timer:
                self.server_timer.cancel()
                self.server_timer = None
        if proc and proc.poll() is None:
            try:
                proc.stdin.write(b'{"cmd": "quit"}\n')
                proc.stdin.flush()
                proc.stdin.close()
                proc.wait(timeout=5)
            except Exception:
                stems_install.kill_tree(proc.pid)
        if proc:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass

    def _arm_idle(self, proc: subprocess.Popen):
        def idle():
            if self.server is proc and self.server_lock.acquire(blocking=False):
                try:
                    if self.server is proc:
                        self.stop_server()
                finally:
                    self.server_lock.release()
        with self.lock:
            if self.server_timer:
                self.server_timer.cancel()
            self.server_timer = threading.Timer(SERVER_IDLE_S, idle)
            self.server_timer.daemon = True
            self.server_timer.start()

    def run_transcription(self, job_id: str, request: dict, on_event: Optional[Callable[[dict], None]] = None) -> dict:
        """Bloquant. Une transcription par le moteur gardé chargé (lancé au besoin) ; renvoie
        l'événement « done ». Annuler (cancel) arrête le moteur : il repart au clip suivant."""
        if not self.installed("transcribe"):
            raise VoiceNotInstalled("transcribe")
        if self.installing():
            raise VoiceError("Installation en cours : attends la fin")
        with self.server_lock:
            with self.lock:
                if job_id in self.jobs:
                    raise VoiceError("Calcul déjà en cours pour ce clip")
                self.cancelled.discard(job_id)
                if self.server_timer:
                    self.server_timer.cancel()
                    self.server_timer = None
            proc = self.server
            if proc is None or proc.poll() is not None:
                proc = self.server = self._start_server()
            with self.lock:
                self.jobs[job_id] = proc
            done, error = None, None
            try:
                proc.stdin.write((json.dumps({"job": job_id, **request}, ensure_ascii=False) + "\n").encode("utf-8"))
                proc.stdin.flush()
                for raw in proc.stdout:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if ev.get("job") != job_id:
                        continue  # « ready » du moteur, restes d'une demande annulée
                    kind = ev.get("event")
                    if kind == "done":
                        done = ev
                        break
                    if kind == "error":
                        error = ev.get("message") or "erreur"
                        break
                    if on_event is not None:
                        try:
                            on_event(ev)
                        except Exception:
                            pass
            except (OSError, ValueError):
                pass  # moteur arrêté (annulation) ou tombé : traité plus bas
            finally:
                with self.lock:
                    self.jobs.pop(job_id, None)
            if job_id in self.cancelled:
                self.cancelled.discard(job_id)
                self.server = None
                raise VoiceCancelled()
            if done is None:
                if error is None:  # sortie fermée sans réponse : le moteur s'arrête (ou est tombé)
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                if proc.poll() is not None:  # moteur tombé : le prochain clip en relance un
                    self.server = None
                    raise VoiceError(friendly_error(error or " | ".join(self.server_err[-3:]) or f"code {proc.returncode}"))
                raise VoiceError(friendly_error(error))
            self._arm_idle(proc)
            return done


def friendly_error(msg: str) -> str:
    low = msg.lower()
    if "out of memory" in low or "outofmemory" in low or "mémoire" in low:
        return "Pas assez de mémoire : ferme des programmes (ou coupe le clip) et réessaie."
    if "trop court" in low:
        return "Clip trop court (une demi-seconde minimum)."
    if "introuvable" in low or "no such file" in low or "filenotfound" in low:
        return "Fichier du module introuvable : réinstalle-le si ça se répète."
    return f"Le calcul a échoué : {msg[:300]}"
