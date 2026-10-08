#!/usr/bin/env python3
"""
NOVA - « Retirer la réverbe de la pièce » (R24) : une voix enregistrée dans une pièce
(chambre, salon) sans la réverbe des murs, par DeepFilterNet 3 (MIT / Apache-2.0) dans
le module voix installé à la demande (voice_service).

Le pont renvoie la voix traitée à 100 % ; le dosage (0–100 %) et l'écoute avant / après
se font dans NOVA, sans recalcul. Le clip garde l'original (AudioSuite, R6).
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Callable, Optional

import numpy as np

import stems_service
from voice_service import VoiceError, VoiceService

MAX_SECONDS = 20 * 60


def deverb(svc: VoiceService, job_id: str, audio: np.ndarray, sr: int,
           on_event: Optional[Callable[[dict], None]] = None) -> dict:
    """audio : (canaux, échantillons) float32. Bloquant. Renvoie {audio, sample_rate, seconds, device, engine}."""
    if audio.ndim != 2 or audio.shape[1] < sr // 2:
        raise VoiceError("Clip trop court (une demi-seconde minimum).")
    if audio.shape[1] > sr * MAX_SECONDS:
        raise VoiceError("Clip trop long (20 minutes maximum) : coupe-le d'abord.")
    work = svc.work_dir(job_id)
    try:
        src, dst = work / "voix.wav", work / "sans_reverbe.wav"
        stems_service.write_wav_float(src, audio, sr)
        done = svc.run_job(job_id, "deverb", ["deverb", "--input", src, "--output", dst], on_event)
        out, out_sr = stems_service.read_wav(Path(done.get("path") or dst))
        if out.shape[0] != audio.shape[0]:
            out = np.repeat(out[:1], audio.shape[0], axis=0) if out.shape[0] == 1 else out[: audio.shape[0]]
        n = audio.shape[1]
        out = out[:, :n] if out.shape[1] >= n else np.pad(out, ((0, 0), (0, n - out.shape[1])))
        return {"audio": np.ascontiguousarray(out, dtype=np.float32), "sample_rate": out_sr,
                "seconds": done.get("seconds"), "device": done.get("device", "cpu"), "engine": done.get("engine", "deepfilternet3")}
    finally:
        shutil.rmtree(work, ignore_errors=True)
