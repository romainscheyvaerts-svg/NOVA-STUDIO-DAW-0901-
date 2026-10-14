#!/usr/bin/env python3
"""
NOVA - moteur de séparation de stems (Demucs), lancé par le pont dans
l'environnement dédié %LOCALAPPDATA%\\NovaStudio\\stems\\env (jamais dans le pont
lui-même : PyTorch pèse ~1 Go et n'existe pas pour le Python du pont).

    python stems_worker.py --input mix.wav --outdir DOSSIER --stems 2|4|6|leadback [--model htdemucs] [--device auto|cpu|cuda]
    python stems_worker.py --download-model [--model htdemucs]
    python stems_worker.py --download-karaoke        (modèle voix lead / chœurs, ~53 Mo)
    python stems_worker.py --self-test [--stems leadback]

Jeux de stems :
    2         voix / instru                                   (htdemucs, Demucs, MIT)
    4         voix, batterie, basse, autres                   (htdemucs)
    6         voix, batterie, basse, guitare, piano, autres   (htdemucs_6s, Demucs, MIT)
    leadback  voix lead, chœurs, instru : Demucs sépare la voix, puis le modèle
              « UVR-MDX-NET Karaoke 2 » (Ultimate Vocal Remover, MIT) sépare la voix
              principale des chœurs et des doubles. Chœurs = voix - voix lead : la somme
              des trois stems reste celle des 2 stems.

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
    "2": ["vocals", "instrumental"],
    "4": ["vocals", "drums", "bass", "other"],
    "6": ["vocals", "drums", "bass", "guitar", "piano", "other"],
    "leadback": ["lead_vocals", "backing_vocals", "instrumental"],
}
# Modèle imposé par un jeu de stems (sinon : le modèle installé, htdemucs).
SET_MODELS = {"6": "htdemucs_6s"}

# Voix lead / chœurs : « UVR-MDX-NET Karaoke 2 » (Ultimate Vocal Remover, Anjok07 et aufr33,
# licence MIT ; voir LICENCES_MODELES.md). Réglages relevés dans model_data.json d'UVR
# (empreinte 1d64a6d2c30f709b8c9b4ce1366d96ee) : la sortie du réseau est la partie
# « instrumentale » d'un karaoké, c'est-à-dire tout sauf la voix principale.
KARAOKE = {
    "file": "UVR_MDXNET_KARA_2.onnx",
    "url": "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_KARA_2.onnx",
    "sha256": "bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4",
    "bytes": 52_786_726,
    "n_fft": 5120, "hop": 1024, "dim_f": 2048, "dim_t": 256, "compensate": 1.065, "samplerate": 44100,
}


def emit(event: str, **kw):
    sys.stdout.write(json.dumps({"event": event, **kw}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def models_home() -> Path:
    home = Path(__file__).resolve().parent
    os.environ.setdefault("TORCH_HOME", str(home / "models"))
    return Path(os.environ["TORCH_HOME"])


def karaoke_path() -> Path:
    return models_home() / "uvr" / KARAOKE["file"]


def download_karaoke() -> Path:
    """Télécharge le modèle voix lead / chœurs (empreinte SHA-256 vérifiée) ; progression en JSON."""
    import hashlib
    import urllib.request
    dst = karaoke_path()
    if dst.is_file() and dst.stat().st_size == KARAOKE["bytes"]:
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    h = hashlib.sha256()
    got, last = 0, 0.0
    with urllib.request.urlopen(KARAOKE["url"], timeout=60) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            got += len(chunk)
            now = time.time()
            if now - last > 0.3:
                last = now
                emit("progress", pct=round(100 * got / KARAOKE["bytes"], 1),
                     message=f"Téléchargement du modèle voix lead / chœurs ({got / 1e6:.0f} / {KARAOKE['bytes'] / 1e6:.0f} Mo)")
    if h.hexdigest() != KARAOKE["sha256"]:
        tmp.unlink(missing_ok=True)
        raise ValueError("Modèle voix lead / chœurs corrompu (empreinte différente) : réessaie")
    os.replace(tmp, dst)
    return dst


class Karaoke:
    """MDX-Net (UVR) en ONNX : spectrogramme -> réseau -> spectrogramme de la partie
    « sans voix principale ». onnxruntime sur la carte graphique (onnxruntime-gpu) ou
    le processeur. Morceaux de 5,9 s dont on jette les bords : aucune couture."""

    def __init__(self, device: str):
        import torch
        import onnxruntime as ort
        if device == "cuda":
            try:  # bibliothèques CUDA / cuDNN de PyTorch (déjà là) : rien de plus à installer
                ort.preload_dlls(directory=os.path.join(os.path.dirname(torch.__file__), "lib"))
            except Exception:
                pass
        want = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
        avail = set(ort.get_available_providers())
        providers = [p for p in want if p in avail] or ["CPUExecutionProvider"]
        so = ort.SessionOptions()
        so.log_severity_level = 3
        threads = os.environ.get("NOVA_STEMS_THREADS")
        if threads:
            so.intra_op_num_threads = int(threads)
        try:
            self.sess = ort.InferenceSession(str(karaoke_path()), sess_options=so, providers=providers)
        except Exception as e:  # pilote CUDA absent ou carte coupée (mode MAO) : processeur
            if providers == ["CPUExecutionProvider"]:
                raise
            emit("fallback", message=f"Voix lead / chœurs : carte graphique inutilisable ({str(e)[:100]}), calcul sur le processeur")
            self.sess = ort.InferenceSession(str(karaoke_path()), sess_options=so, providers=["CPUExecutionProvider"])
        self.device = "cuda" if self.sess.get_providers()[0] == "CUDAExecutionProvider" else "cpu"
        self.input = self.sess.get_inputs()[0].name
        k = KARAOKE
        self.n_fft, self.hop, self.dim_f, self.dim_t = k["n_fft"], k["hop"], k["dim_f"], k["dim_t"]
        self.n_bins = self.n_fft // 2 + 1
        self.chunk = self.hop * (self.dim_t - 1)
        self.window = torch.hann_window(self.n_fft, periodic=True)

    def _stft(self, x):
        import torch
        x = x.reshape(-1, self.chunk)
        spec = torch.stft(x, n_fft=self.n_fft, hop_length=self.hop, window=self.window, center=True, return_complex=True)
        spec = torch.view_as_real(spec).permute(0, 3, 1, 2)                      # (2c, 2, bins, t)
        spec = spec.reshape(-1, 2, 2, self.n_bins, self.dim_t).reshape(-1, 4, self.n_bins, self.dim_t)
        return spec[:, :, : self.dim_f]

    def _istft(self, spec):
        import torch
        pad = torch.zeros(spec.shape[0], 4, self.n_bins - self.dim_f, self.dim_t)
        spec = torch.cat([spec, pad], 2).reshape(-1, 2, 2, self.n_bins, self.dim_t).reshape(-1, 2, self.n_bins, self.dim_t)
        spec = torch.view_as_complex(spec.permute(0, 2, 3, 1).contiguous())
        x = torch.istft(spec, n_fft=self.n_fft, hop_length=self.hop, window=self.window, center=True, length=self.chunk)
        return x.reshape(-1, 2, self.chunk)

    def instrumental(self, voc, progress=None):
        """voc : tenseur (2, n) à 44,1 kHz. Renvoie la partie sans voix principale (2, n)."""
        import numpy as np
        import torch
        n = voc.shape[1]
        trim = self.n_fft // 2
        step = self.chunk - 2 * trim
        pad = (step - n % step) % step
        padded = torch.cat([torch.zeros(2, trim), voc, torch.zeros(2, pad + trim)], 1)
        starts = list(range(0, n + pad, step))
        out = []
        for i, s0 in enumerate(starts):
            part = padded[:, s0: s0 + self.chunk]
            spec = self._stft(part[None]).numpy().astype(np.float32)
            pred = self.sess.run(None, {self.input: spec})[0]
            wave = self._istft(torch.from_numpy(pred))[0]
            out.append(wave[:, trim: trim + step])
            if progress is not None:
                progress(i + 1, len(starts))
        return torch.cat(out, 1)[:, :n] * KARAOKE["compensate"]


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


def separate(mix, sr: int, model, device: str, stem_set: str, progress: _Progress, karaoke=None):
    """mix : tableau numpy (canaux, échantillons). Renvoie {clé: (canaux, échantillons)},
    chaque stem à la fréquence et à la longueur exactes du morceau d'origine."""
    import numpy as np
    import torch
    import julius
    import demucs.apply as dapply

    stem_set = str(stem_set)
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
    out = (out * std + mean).cpu()
    sources = {name: out[i] for i, name in enumerate(model.sources)}
    if stem_set in ("2", "leadback"):
        rest = sum(v for k, v in sources.items() if k != "vocals")
        sources = {"vocals": sources["vocals"], "instrumental": rest}
    if stem_set == "leadback":
        if karaoke is None:
            raise ValueError("Modèle voix lead / chœurs absent")
        voc = sources["vocals"]
        if model.samplerate != KARAOKE["samplerate"]:
            voc = julius.resample_frac(voc, model.samplerate, KARAOKE["samplerate"])

        def kprog(i, total):
            emit("progress", pct=round(progress.base + progress.span + (95 - progress.base - progress.span) * i / max(1, total), 1),
                 message="Séparation voix lead / chœurs")

        emit("progress", pct=round(progress.base + progress.span, 1), message="Séparation voix lead / chœurs")
        with torch.no_grad():
            back = karaoke.instrumental(voc.float(), kprog)
        if model.samplerate != KARAOKE["samplerate"]:
            back = julius.resample_frac(back, KARAOKE["samplerate"], model.samplerate)
        n_voc = sources["vocals"].shape[1]
        back = back[:, :n_voc]
        if back.shape[1] < n_voc:
            back = torch.nn.functional.pad(back, (0, n_voc - back.shape[1]))
        # Chœurs + voix lead = voix de Demucs, à l'échantillon près.
        sources = {"lead_vocals": sources["vocals"] - back, "backing_vocals": back,
                   "instrumental": sources["instrumental"]}
    result = {}
    for key in STEM_SETS[stem_set]:
        s = sources[key]
        if sr != model.samplerate:
            s = julius.resample_frac(s, model.samplerate, sr)
        s = s[:, : mix.shape[1]]
        if s.shape[1] < mix.shape[1]:
            s = torch.nn.functional.pad(s, (0, mix.shape[1] - s.shape[1]))
        if channels_in == 1:
            s = s.mean(0, keepdim=True)
        result[key] = s.cpu().numpy()
    # Somme des stems = morceau d'origine, à l'arrondi près : ce que le modèle n'a rangé
    # nulle part (jusqu'à -1,8 dB vers 800 Hz mesurés en 6 stems sur une prod guitares /
    # piano / sax) va dans « Autres » (ou « Instru »). Rien ne disparaît quand on
    # remet tous les stems ensemble.
    absorb = "instrumental" if stem_set in ("2", "leadback") else "other"
    ref = mix[:2] if mix.shape[0] > 2 else mix
    total = sum(result.values())
    result[absorb] = (result[absorb] + (ref - total)).astype(np.float32)
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
    stem_set = str(args.stems)
    model_name = SET_MODELS.get(stem_set, args.model)
    emit("progress", pct=3, message=f"Chargement du modèle {model_name}")
    model = load_model(model_name)
    device = pick_device(args.device)
    threads = os.environ.get("NOVA_STEMS_THREADS")
    if device == "cpu" and threads:
        torch.set_num_threads(int(threads))
    karaoke = None
    if stem_set == "leadback":
        if not karaoke_path().is_file():
            raise FileNotFoundError("Modèle voix lead / chœurs introuvable : installe-le depuis NOVA")
        karaoke = Karaoke(device)
    n_models = len(getattr(model, "models", [model]))
    emit("device", device=device,
         name=(torch.cuda.get_device_name(0) if device == "cuda" else "processeur"))
    span = 55.0 if stem_set == "leadback" else 90.0
    try:
        stems = separate(mix, sr, model, device, stem_set, _Progress(n_models, span=span), karaoke)
    except Exception as e:  # mémoire GPU pleine, pilote qui lâche (carte coupée en route)…
        if device != "cuda":
            raise
        emit("fallback", message=f"Échec sur la carte graphique ({str(e)[:120]}) : nouvel essai sur le processeur")
        torch.cuda.empty_cache()
        device = "cpu"
        if karaoke is not None:
            karaoke = Karaoke("cpu")
        stems = separate(mix, sr, model, device, stem_set, _Progress(n_models, span=span), karaoke)

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
         duration=round(mix.shape[1] / sr, 3), model=model_name,
         karaoke_device=(karaoke.device if karaoke is not None else None))
    return 0


def self_test(args) -> int:
    """Quelques secondes de bruit + sinus séparés sur le processeur : torch, demucs
    et les poids du modèle répondent."""
    import numpy as np
    import torch
    stem_set = str(args.stems or "4")
    model = load_model(SET_MODELS.get(stem_set, args.model))
    sr = model.samplerate
    t = np.arange(sr * 3) / sr
    mix = np.stack([0.3 * np.sin(2 * np.pi * 220 * t), 0.3 * np.sin(2 * np.pi * 330 * t)]).astype("float32")
    mix += 0.02 * np.random.default_rng(0).standard_normal(mix.shape).astype("float32")
    t0 = time.time()
    karaoke = None
    if stem_set == "leadback":
        # Sur la carte graphique, le 1er passage compile les noyaux de calcul (jusqu'à ~1 min
        # sur une RTX 50xx, gardés ensuite en cache par le pilote) : fait ici, pendant
        # l'installation, plutôt qu'à la première séparation.
        karaoke = Karaoke(pick_device(args.device))
    device = "cpu" if karaoke is None else karaoke.device
    out = separate(mix, sr, model, device, stem_set, _Progress(len(getattr(model, "models", [model])), 0, 60), karaoke)
    ok = all(v.shape == mix.shape and np.isfinite(v).all() for v in out.values())
    cuda = bool(torch.cuda.is_available())
    print(json.dumps({"ok": ok, "torch": torch.__version__, "cuda_build": torch.version.cuda,
                      "cuda_available": cuda, "gpu": torch.cuda.get_device_name(0) if cuda else None,
                      "self_test_seconds": round(time.time() - t0, 2), "stems": stem_set,
                      "karaoke_device": karaoke.device if karaoke is not None else None,
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
    ap.add_argument("--stems", default=None, choices=list(STEM_SETS))
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--download-model", action="store_true")
    ap.add_argument("--download-karaoke", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.download_model:
            load_model(a.model)
            emit("done", message="Modèle prêt")
            return 0
        if a.download_karaoke:
            download_karaoke()
            emit("done", message="Modèle voix lead / chœurs prêt")
            return 0
        if a.self_test:
            return self_test(a)
        if not a.input or not a.outdir:
            raise ValueError("--input et --outdir sont obligatoires")
        a.stems = a.stems or "4"
        return run_separation(a)
    except Exception as e:
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
