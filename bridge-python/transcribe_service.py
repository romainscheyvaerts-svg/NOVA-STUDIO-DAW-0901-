#!/usr/bin/env python3
"""
NOVA - transcription des paroles calée sur le temps (R24) : Whisper en local
(faster-whisper / CTranslate2, MIT ; poids d'OpenAI, MIT) sur la carte graphique, avec
repli sur le processeur, dans le module voix installé à la demande (voice_service).

Langues : « fr » (défaut), « en », « mix » (français avec de l'anglais, rap) et « auto ».
Renvoie les mots horodatés (début / fin en secondes du son envoyé, confiance, début de
phrase), que NOVA range dans le clip et dans le prompteur de paroles.
"""

from __future__ import annotations

import shutil
from typing import Callable, Optional

import numpy as np

import stems_service
from voice_service import VoiceError, VoiceService

LANGUAGES = ("fr", "en", "mix", "auto")
MAX_SECONDS = 20 * 60


def transcribe(svc: VoiceService, job_id: str, audio: np.ndarray, sr: int, language: str = "fr",
               on_event: Optional[Callable[[dict], None]] = None, model: Optional[str] = None) -> dict:
    """audio : (canaux, échantillons) float32. Bloquant. Renvoie {words, segments, language, model, device, seconds}."""
    if language not in LANGUAGES:
        language = "fr"
    if audio.ndim != 2 or audio.shape[1] < int(sr * 0.3):
        raise VoiceError("Clip trop court pour être transcrit.")
    if audio.shape[1] > sr * MAX_SECONDS:
        raise VoiceError("Clip trop long (20 minutes maximum) : coupe-le d'abord.")
    info = (svc.info().get("features") or {}).get("transcribe") or {}
    work = svc.work_dir(job_id)
    try:
        src = work / "voix.wav"
        # Whisper n'écoute qu'un canal : la voix est envoyée en mono.
        stems_service.write_wav_float(src, audio.mean(axis=0, keepdims=True).astype(np.float32), sr)
        # B7 : moteur gardé chargé entre les clips (une piste de 10 prises ne recharge pas Whisper 10 fois).
        done = svc.run_transcription(job_id, {"input": str(src), "language": language,
                                              "model": model or info.get("model") or "large-v3-turbo"}, on_event)
        words = [w for w in done.get("words") or [] if isinstance(w, dict) and str(w.get("w", "")).strip()]
        return {"words": words, "segments": done.get("segments") or [], "language": done.get("language") or language,
                "model": done.get("model"), "device": done.get("device", "cpu"), "seconds": done.get("seconds"),
                "duration": done.get("duration")}
    finally:
        shutil.rmtree(work, ignore_errors=True)
