#!/usr/bin/env python3
"""
NOVA - moteur de séparation de stems (Demucs), lancé par le pont dans
l'environnement dédié %LOCALAPPDATA%\\NovaStudio\\stems\\env (jamais dans le pont
lui-même : PyTorch pèse ~1 Go et n'existe pas pour le Python du pont).

    python stems_worker.py --input mix.wav --outdir DOSSIER --stems 4 [--model htdemucs] [--device auto|cpu|cuda]
    python stems_worker.py --download-model [--model htdemucs]
    python stems_worker.py --self-test

Sortie standard : une ligne JSON par événement
    {"event": "progress", "pct": 37.5, "message": "..."}
    {"event": "device", "device": "cuda", "name": "..."}  /  {"event": "fallback", "message": "..."}
    {"event": "done", "stems": [{"key": "vocals", "path": "...", "rms": 0.05}], "seconds": 12.3}
    {"event": "error", "message": "..."}

Les WAV (float 32 bits, fréquence d'origine) sont écrits dans DOSSIER\\.partiel puis
déplacés d'un coup à la fin : une séparation annulée ne laisse rien de bancal.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

# 2 stems : voix + tout le reste (somme des autres sources, comme « demucs --two-stems »)
STEM_SETS = {
    2: ["vocals", "instrumental"],
    4: ["vocals", "drums", "bass", "other"],
}


def emit(event: str, **kw):
    sys.stdout.write(json.dumps({"event": event, **kw}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def models_home() -> Path:
    home = Path(__file__).resolve().parent
    os.environ.setdefault("TORCH_HOME", str(home / "models"))
    return Path(os.environ["TORCH_HOME"])


def load_model(name: str):
    models_home()
    from demucs.pretrained import get_model
    model = get_model(name)
    model.eval()
    return model


class _Progress:
    """Remplace tqdm dans demucs.apply : compte les morceaux traités (tous les
    modèles d'un « bag » compris) et l'écrit en JSON."""

    def __init__(self, n_models: int, base: float = 5.0, span: float = 90.0):
        self.n_models = max(1, n_models)
        self.done = 0
        self.base = base
        self.span = span
        self.last = 0.0

    def tqdm(self, iterable, **_kw):
        items = list(iterable)
        total = len(items) * self.n_models
        for it in items:
            yield it
            self.done += 1
            pct = self.base + self.span * min(1.0, self.done / max(1, total))
            now = time.time()
            if now - self.last > 0.25 or self.done >= total:
                self.last = now
                emit("progress", pct=round(pct, 1), message="Séparation en cours")


def separate(mix, sr: int, model, device: str, n_stems: int, progress: _Progress):
    """mix : tableau numpy (canaux, échantillons). Renvoie {clé: (canaux, échantillons)}."""
    import numpy as np
    import torch
    import julius
    import demucs.apply as dapply

    channels_in = mix.shape[0]
    wav = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32))
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    elif wav.shape[0] > 2:
        wav = wav[:2]
    if sr != model.samplerate:
        wav = julius.resample_frac(wav, sr, model.samplerate)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    std = std if float(std) > 1e-8 else torch.tensor(1.0)
    norm = (wav - mean) / std

    class _TqdmShim:  # demucs.apply fait « tqdm.tqdm(futures, ...) »
        tqdm = staticmethod(progress.tqdm)

    old = dapply.tqdm
    dapply.tqdm = _TqdmShim
    try:
        with torch.no_grad():
            out = dapply.apply_model(model, norm[None], device=device, shifts=1, split=True,
                                     overlap=0.25, progress=True, num_workers=0)[0]
    finally:
        dapply.tqdm = old
    out = out * std + mean
    sources = {name: out[i] for i, name in enumerate(model.sources)}
    if n_stems == 2:
        rest = sum(v for k, v in sources.items() if k != "vocals")
        sources = {"vocals": sources["vocals"], "instrumental": rest}
    result = {}
    for key in STEM_SETS[n_stems]:
        s = sources[key]
        if sr != model.samplerate:
            s = julius.resample_frac(s, model.samplerate, sr)
        s = s[:, : mix.shape[1]]
        if s.shape[1] < mix.shape[1]:
            s = torch.nn.functional.pad(s, (0, mix.shape[1] - s.shape[1]))
        if channels_in == 1:
            s = s.mean(0, keepdim=True)
        result[key] = s.cpu().numpy()
    return result


def pick_device(wanted: str):
    import torch
    if wanted == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        try:
            torch.zeros(1, device="cuda")  # pilote réellement utilisable ?
            return "cuda"
        except Exception as e:
            emit("fallback", message=f"Carte graphique inutilisable ({e}) : calcul sur le processeur")
            return "cpu"
    if wanted == "cuda":
        emit("fallback", message="Carte graphique indisponible (désactivée ?) : calcul sur le processeur")
    return "cpu"


def run_separation(args) -> int:
    import numpy as np
    import soundfile as sf
    import torch

    t0 = time.time()
    emit("progress", pct=1, message="Lecture du morceau")
    data, sr = sf.read(args.input, dtype="float32", always_2d=True)
    mix = data.T  # (canaux, échantillons)
    if mix.shape[1] < sr * 0.5:
        raise ValueError("Morceau trop court (moins d'une demi-seconde)")
    emit("progress", pct=3, message=f"Chargement du modèle {args.model}")
    model = load_model(args.model)
    device = pick_device(args.device)
    threads = os.environ.get("NOVA_STEMS_THREADS")
    if device == "cpu" and threads:
        torch.set_num_threads(int(threads))
    n_models = len(getattr(model, "models", [model]))
    emit("device", device=device,
         name=(torch.cuda.get_device_name(0) if device == "cuda" else "processeur"))
    try:
        stems = separate(mix, sr, model, device, args.stems, _Progress(n_models))
    except Exception as e:  # mémoire GPU pleine, pilote qui lâche (carte coupée en route)…
        if device != "cuda":
            raise
        emit("fallback", message=f"Échec sur la carte graphique ({str(e)[:120]}) : nouvel essai sur le processeur")
        torch.cuda.empty_cache()
        device = "cpu"
        stems = separate(mix, sr, model, device, args.stems, _Progress(n_models))

    outdir = Path(args.outdir)
    tmp = outdir / ".partiel"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    emit("progress", pct=96, message="Écriture des WAV")
    written = []
    for key, audio in stems.items():
        name = f"{key}.wav"
        sf.write(str(tmp / name), audio.T, sr, subtype="FLOAT")
        written.append((key, name, float(np.sqrt(np.mean(np.square(audio))))))
    final = []
    for key, name, rms in written:
        dst = outdir / name
        if dst.exists():
            dst.unlink()
        os.replace(tmp / name, dst)
        final.append({"key": key, "path": str(dst), "rms": round(rms, 6)})
    shutil.rmtree(tmp, ignore_errors=True)
    emit("done", stems=final, seconds=round(time.time() - t0, 2), device=device, sample_rate=sr,
         duration=round(mix.shape[1] / sr, 3))
    return 0


def self_test(args) -> int:
    """Quelques secondes de bruit + sinus séparés sur le processeur : torch, demucs
    et les poids du modèle répondent."""
    import numpy as np
    import torch
    model = load_model(args.model)
    sr = model.samplerate
    t = np.arange(sr * 3) / sr
    mix = np.stack([0.3 * np.sin(2 * np.pi * 220 * t), 0.3 * np.sin(2 * np.pi * 330 * t)]).astype("float32")
    mix += 0.02 * np.random.default_rng(0).standard_normal(mix.shape).astype("float32")
    t0 = time.time()
    out = separate(mix, sr, model, "cpu", 4, _Progress(len(getattr(model, "models", [model])), 0, 100))
    ok = all(v.shape == mix.shape and np.isfinite(v).all() for v in out.values())
    cuda = bool(torch.cuda.is_available())
    print(json.dumps({"ok": ok, "torch": torch.__version__, "cuda_build": torch.version.cuda,
                      "cuda_available": cuda, "gpu": torch.cuda.get_device_name(0) if cuda else None,
                      "self_test_seconds": round(time.time() - t0, 2),
                      "sources": list(getattr(model, "sources", []))}))
    return 0 if ok else 1


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    ap.add_argument("--outdir")
    ap.add_argument("--stems", type=int, default=4, choices=[2, 4])
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--download-model", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.download_model:
            load_model(a.model)
            emit("done", message="Modèle prêt")
            return 0
        if a.self_test:
            return self_test(a)
        if not a.input or not a.outdir:
            raise ValueError("--input et --outdir sont obligatoires")
        return run_separation(a)
    except Exception as e:
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
