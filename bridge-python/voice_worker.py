#!/usr/bin/env python3
"""
NOVA - moteur « voix par l'IA locale » (R24), lancé par le pont dans l'environnement
dédié %LOCALAPPDATA%\\NovaStudio\\voice\\env (jamais dans le pont lui-même).

    python voice_worker.py transcribe --input voix.wav [--language fr|en|mix|auto] [--model large-v3-turbo] [--device auto|cpu|cuda]
    python voice_worker.py deverb --input voix.wav --output sans_reverbe.wav [--jobs 4]
    python voice_worker.py self-test transcribe|deverb

Sortie standard : une ligne JSON par événement
    {"event": "progress", "pct": 37.5, "message": "..."}
    {"event": "device", "device": "cuda", "name": "..."}  /  {"event": "fallback", "message": "..."}
    {"event": "done", ...}   |   {"event": "error", "message": "..."}

Transcription : faster-whisper (CTranslate2, MIT) et les poids Whisper d'OpenAI (MIT)
convertis (models\\whisper\\<modèle>). Carte graphique NVIDIA si elle répond (cuBLAS
dans cuda\\), sinon le processeur (int8).
Déréverbération : DeepFilterNet 3 (MIT / Apache-2.0), exécutable officiel deep-filter
(tools\\deep-filter.exe), en morceaux traités en parallèle sur le processeur, puis
retrait de la réverbe tardive (B7 : estimateur de Lebart / Habets, code NOVA en numpy) :
la queue de la pièce qui reste après DeepFilterNet est prédite à partir du son 40 ms plus
tôt et de la durée de réverbération (RT60) lue sur la prise, puis atténuée (12 dB au plus).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from math import gcd
from pathlib import Path

HOME = Path(__file__).resolve().parent
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_MODEL = "large-v3-turbo"

# Phrases que Whisper invente sur du silence ou de la musique (génériques de sous-titres).
HALLUCINATIONS = re.compile(
    r"sous-?titr|amara\.org|merci d'avoir regard|abonnez-vous|thanks? for watching|subtitles? by|st' ?\d{3}",
    re.IGNORECASE)


def emit(event: str, **kw):
    sys.stdout.write(json.dumps({"event": event, **kw}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def resample(x, sr_from: int, sr_to: int):
    import numpy as np
    if sr_from == sr_to:
        return x.astype(np.float32)
    from scipy.signal import resample_poly
    g = gcd(int(sr_from), int(sr_to))
    return resample_poly(x, sr_to // g, sr_from // g, axis=-1).astype(np.float32)


def read_audio(path):
    """(canaux, échantillons) float32 et la fréquence."""
    import soundfile as sf
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data.T.copy(), int(sr)


# ─── Transcription ───────────────────────────────────────────────────────────

def cuda_dir() -> Path:
    return HOME / "cuda"


def enable_cuda_libs() -> bool:
    """cuBLAS (liens vers celui de PyTorch du module stems, ou paquet NVIDIA) : CTranslate2
    le charge par son nom, il doit être dans le PATH du processus."""
    dirs = [cuda_dir()]
    nv = HOME / "env" / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin"
    dirs.append(nv)
    found = False
    for d in dirs:
        if (d / "cublas64_12.dll").is_file() or (d / "libcublas.so.12").is_file():
            os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
            try:
                os.add_dll_directory(str(d))
            except (AttributeError, OSError):
                pass
            found = True
    return found


def whisper_path(model: str) -> Path:
    return HOME / "models" / "whisper" / model


def load_whisper(model: str, device: str):
    from faster_whisper import WhisperModel
    path = whisper_path(model)
    src = str(path) if (path / "model.bin").is_file() else model
    if device == "cuda":
        return WhisperModel(src, device="cuda", compute_type="float16")
    threads = int(os.environ.get("NOVA_VOICE_THREADS") or max(1, min(8, (os.cpu_count() or 4) - 1)))
    return WhisperModel(src, device="cpu", compute_type="int8", cpu_threads=threads)


def gpu_name() -> str | None:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                           timeout=10, creationflags=NO_WINDOW)
        name = r.stdout.decode("utf-8", "replace").strip().splitlines()
        return name[0] if r.returncode == 0 and name else None
    except Exception:
        return None


def pick_device(wanted: str) -> str:
    if wanted == "cpu":
        return "cpu"
    try:
        import ctranslate2
        if enable_cuda_libs() and ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    if wanted == "cuda":
        emit("fallback", message="Carte graphique indisponible (désactivée ?) : calcul sur le processeur")
    return "cpu"


LANGUAGES = {"fr": "fr", "en": "en", "auto": None, "mix": "fr"}


def transcribe_audio(model, mono16k, language: str | None, on_progress=None, vad: bool = True):
    """Mots horodatés. Renvoie (mots, segments, langue)."""
    segs, info = model.transcribe(
        mono16k, language=language, word_timestamps=True, vad_filter=vad, beam_size=5,
        condition_on_previous_text=False)  # détecteur de voix : réglages par défaut (mesurés les meilleurs sur du chant)
    words, segments = [], []
    dur = max(0.1, float(info.duration))
    for s in segs:
        text = (s.text or "").strip()
        if not text or HALLUCINATIONS.search(text) or (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0):
            continue
        segments.append({"s": round(s.start, 3), "e": round(s.end, 3), "text": text})
        first = True
        for w in s.words or []:
            token = w.word.strip()
            if not token:
                continue
            # Élision coupée par Whisper (« J » + « 'ai », « c » + « 'est ») : un seul mot.
            if not first and words and not w.word[:1].isspace() and token[:1] in "'’-":
                prev = words[-1]
                prev["w"] += token
                prev["e"] = round(w.end, 3)
                prev["p"] = round(min(prev["p"], float(w.probability)), 3)
                continue
            item = {"w": token, "s": round(w.start, 3), "e": round(w.end, 3), "p": round(float(w.probability), 3)}
            if first:
                item["b"] = True
                first = False
            words.append(item)
        if on_progress:
            on_progress(min(1.0, s.end / dur))
    return words, segments, info.language


def phrase_spans(mono16k, max_s: float = 25.0):
    """Phrases chantées (détecteur de voix Silero de faster-whisper) : (début, fin) en échantillons."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    spans = get_speech_timestamps(mono16k, VadOptions(min_silence_duration_ms=400, speech_pad_ms=150))
    out = []
    for sp in spans:
        s, e = int(sp["start"]), int(sp["end"])
        # Bouts très courts (« yeah ») collés à la phrase d'avant s'ils sont proches.
        if out and (s - out[-1][1] < 0.25 * 16000 or e - s < 0.6 * 16000) and e - out[-1][0] < max_s * 16000:
            out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


def phrase_language(model, chunk, allowed=("fr", "en")) -> str:
    """Langue d'une phrase : le français d'abord ; l'anglais seulement s'il est nettement plus
    probable (une phrase française avec « game », « baby », « flow » reste en français)."""
    try:
        _lang, _p, probs = model.detect_language(chunk)
    except Exception:
        return allowed[0]
    p = {k: v for k, v in probs if k in allowed}
    fr, en = p.get("fr", 0.0), p.get("en", 0.0)
    return "en" if en > 0.5 and en > 3 * fr else "fr"


def transcribe_by_phrase(model, mono16k, on_progress=None):
    """Mode « Français + anglais (rap) » : la langue est choisie phrase par phrase (Whisper n'en
    choisit qu'une pour 30 s de son, et traduit ou saute une phrase anglaise au milieu d'un texte
    français). Les phrases voisines de même langue sont transcrites ensemble, pour garder le
    contexte : un texte tout en français donne le même résultat qu'en mode « fr ».
    Renvoie (mots, segments, langue de chaque phrase)."""
    spans = phrase_spans(mono16k)
    langs = [phrase_language(model, mono16k[s:e]) for s, e in spans]
    blocks = []  # (début, fin, langue) : suites de phrases de même langue
    for (s, e), lang in zip(spans, langs):
        if blocks and blocks[-1][2] == lang:
            blocks[-1] = (blocks[-1][0], e, lang)
        else:
            blocks.append((s, e, lang))
    if len(blocks) <= 1:  # une seule langue : exactement comme le mode d'une langue (tout le son, même découpe)
        w, seg, _ = transcribe_audio(model, mono16k, blocks[0][2] if blocks else "fr", on_progress)
        return w, seg, langs
    words, segments = [], []
    for k, (s, e, lang) in enumerate(blocks):
        # Un peu de marge autour du bloc (début et fin de mot), sans déborder sur le bloc voisin.
        a = max(0, s - 2400 if k == 0 or blocks[k - 1][1] < s - 2400 else blocks[k - 1][1])
        b = min(len(mono16k), e + 2400 if k + 1 == len(blocks) or blocks[k + 1][0] > e + 2400 else blocks[k + 1][0])
        w, seg, _ = transcribe_audio(model, mono16k[a:b], lang, vad=False)
        off = a / 16000
        for x in w:
            x["s"] = round(x["s"] + off, 3)
            x["e"] = round(x["e"] + off, 3)
        for x in seg:
            x["s"] = round(x["s"] + off, 3)
            x["e"] = round(x["e"] + off, 3)
            x["language"] = lang
        words += w
        segments += seg
        if on_progress:
            on_progress((k + 1) / max(1, len(blocks)))
    return words, segments, langs


def run_transcribe(a) -> int:
    import numpy as np
    t0 = time.time()
    emit("progress", pct=1, message="Lecture de la voix")
    audio, sr = read_audio(a.input)
    mono = resample(audio.mean(0), sr, 16000)
    duration = len(mono) / 16000
    if duration < 0.3:
        raise ValueError("Clip trop court pour être transcrit")
    device = pick_device(a.device)
    emit("device", device=device, name=(gpu_name() or "carte graphique") if device == "cuda" else "processeur")
    emit("progress", pct=3, message="Chargement du modèle " + a.model + (" (première fois sur la carte graphique : jusqu'à une minute)" if device == "cuda" else ""))
    try:
        model = load_whisper(a.model, device)
    except Exception as e:
        if device != "cuda":
            raise
        emit("fallback", message=f"Carte graphique inutilisable ({str(e)[:120]}) : calcul sur le processeur")
        device = "cpu"
        model = load_whisper(a.model, device)
    lang = LANGUAGES.get(a.language, "fr")

    def progress(f):
        emit("progress", pct=round(8 + 90 * f, 1), message="Transcription en cours")

    emit("progress", pct=8, message="Transcription en cours")

    def go(m):
        if a.language == "mix":  # langue choisie phrase par phrase
            w, seg, langs = transcribe_by_phrase(m, mono, progress)
            return w, seg, ("en" if langs and langs.count("en") > len(langs) / 2 else "fr")
        return transcribe_audio(m, mono, lang, progress)

    try:
        words, segments, detected = go(model)
    except Exception as e:  # mémoire de la carte pleine, pilote qui lâche
        if device != "cuda":
            raise
        emit("fallback", message=f"Échec sur la carte graphique ({str(e)[:120]}) : nouvel essai sur le processeur")
        device = "cpu"
        model = load_whisper(a.model, device)
        words, segments, detected = go(model)
    emit("done", words=words, segments=segments, language=detected or lang or "fr", model=a.model,
         device=device, seconds=round(time.time() - t0, 2), duration=round(duration, 3))
    return 0


# ─── Déréverbération ─────────────────────────────────────────────────────────

DF_SR = 48000

# ─── Réverbe tardive (B7) ────────────────────────────────────────────────────
LATE_NFFT = 1024
LATE_HOP = 256


def rt60_estimate(x, sr: int, hop_s: float = 0.01):
    """Durée de réverbération (s) lue sur la prise elle-même : pentes des descentes libres
    de l'énergie (fins de phrase). Les descentes les plus lentes sont celles de la pièce
    (la voix qui s'arrête net descend plus vite). Renvoie (RT60, nombre de descentes)."""
    import numpy as np
    mono = np.asarray(x, np.float64)
    if mono.ndim > 1:
        mono = mono.mean(0)
    n = max(1, int(hop_s * sr))
    m = len(mono) // n
    if m < 30:
        return 0.5, 0
    e = 10 * np.log10(np.mean(np.square(mono[: m * n].reshape(m, n)), 1) + 1e-14)
    top = np.percentile(e, 99)
    L = 12  # 120 ms
    t = np.arange(L) * hop_s
    slopes = []
    i = 0
    while i < m - L:
        seg = e[i: i + L]
        if seg[0] > top - 30 and np.all(np.diff(seg) < 0.5) and seg[0] - seg[-1] > 6:
            k = np.polyfit(t, seg, 1)[0]
            if k < 0:
                slopes.append(k)
            i += L
        else:
            i += 1
    if not slopes:
        return 0.5, 0
    return float(np.clip(-60.0 / np.percentile(slopes, 70), 0.2, 1.5)), len(slopes)


def suppress_late_reverb(y, sr: int, rt60: float, delay_ms: float = 40.0, alpha: float = 0.7,
                         floor_db: float = -12.0, smooth: float = 0.6):
    """Atténue la réverbe tardive de `y` (canaux × échantillons) : sa puissance est prédite
    par la puissance lissée `delay_ms` plus tôt, décrue selon le RT60 (Lebart 2001, Habets
    2007), puis retirée par un gain spectral (même gain sur tous les canaux : l'image stéréo
    ne bouge pas), jamais plus bas que `floor_db`. Même longueur en sortie."""
    import numpy as np
    y = np.asarray(y, np.float32)
    if y.ndim == 1:
        y = y[None]
    nfft, hop = LATE_NFFT, LATE_HOP
    n = y.shape[1]
    if n < nfft * 2:
        return y.copy()
    win = np.hanning(nfft + 1)[:-1].astype(np.float32)
    padded = np.pad(y, ((0, 0), (nfft, nfft + hop)))
    nfr = 1 + (padded.shape[1] - nfft) // hop
    idx = np.arange(nfft)[None, :] + hop * np.arange(nfr)[:, None]
    X = np.fft.rfft(padded[:, idx] * win, axis=2)  # canaux × trames × bandes
    P = np.mean(np.abs(X) ** 2, axis=0)  # trames × bandes (moyenne des canaux)
    Ne = max(1, int(round(delay_ms / 1000 * sr / hop)))
    decay = float(np.exp(-2 * (3 * np.log(10) / (max(0.1, rt60) * sr)) * Ne * hop))
    Ps = np.empty_like(P)
    acc = P[0].copy()
    for l in range(nfr):
        acc = smooth * acc + (1 - smooth) * P[l]
        Ps[l] = acc
    late = np.zeros_like(P)
    late[Ne:] = decay * Ps[:-Ne]
    g_floor = 10 ** (floor_db / 20)
    G = np.maximum(np.maximum(Ps - alpha * late, 0) / (Ps + 1e-12), g_floor)
    g = G[0].copy()
    for l in range(nfr):  # gain lissé dans le temps (pas de « gargouillis »)
        g = 0.4 * g + 0.6 * G[l]
        G[l] = g
    frames = np.fft.irfft(X * G[None], n=nfft, axis=2).astype(np.float32) * win
    out = np.zeros((y.shape[0], padded.shape[1]), np.float32)
    wsum = np.zeros(padded.shape[1], np.float32)
    for l in range(nfr):
        out[:, l * hop: l * hop + nfft] += frames[:, l]
        wsum[l * hop: l * hop + nfft] += win ** 2
    out /= np.maximum(wsum, 1e-6)
    return out[:, nfft: nfft + n]


def tail_reduction_db(before, after, sr: int):
    """Réverbe retirée, mesurée sans voix sèche : aux fins de phrase lues sur `after` (chute
    de 15 dB), énergie 20 à 250 ms après la fin rapportée aux 250 ms d'avant, avant et après
    traitement. Renvoie (écart en dB, nombre de fins de phrase) ; (None, 0) sans fin nette."""
    import numpy as np
    b = np.asarray(before, np.float64)
    a = np.asarray(after, np.float64)
    b = b.mean(0) if b.ndim > 1 else b
    a = a.mean(0) if a.ndim > 1 else a
    n = max(1, int(0.01 * sr))
    m = min(len(a), len(b)) // n
    if m < 60:
        return None, 0
    e = 10 * np.log10(np.mean(np.square(a[: m * n].reshape(m, n)), 1) + 1e-14)
    top = np.percentile(e, 99)
    ends = []
    i = 5
    while i < m - 30:
        if e[i - 5: i].mean() > top - 25 and e[i + 10: i + 25].mean() < e[i - 5: i].mean() - 15:
            ends.append(i * n)
            i += 30
            continue
        i += 1

    def tail(sig):
        vals = []
        A, B, C = int(0.25 * sr), int(0.02 * sr), int(0.25 * sr)
        for p in ends:
            if p - A < 0 or p + C > len(sig):
                continue
            pre = np.mean(sig[p - A: p] ** 2)
            post = np.mean(sig[p + B: p + C] ** 2)
            if pre > 0:
                vals.append(10 * np.log10(post / pre + 1e-14))
        return vals

    tb, ta = tail(b), tail(a)
    if not tb or len(tb) != len(ta):
        return None, 0
    return round(float(np.mean(ta) - np.mean(tb)), 1), len(tb)


def deep_filter_exe() -> Path:
    return HOME / "tools" / ("deep-filter.exe" if os.name == "nt" else "deep-filter")


def _df_chunk(exe: Path, chunk, workdir: Path, idx: int):
    import numpy as np
    import soundfile as sf
    src = workdir / f"c{idx}.wav"
    out = workdir / f"o{idx}"
    sf.write(str(src), chunk.T, DF_SR, subtype="FLOAT")
    r = subprocess.run([str(exe), "-D", "-o", str(out), str(src)], capture_output=True, creationflags=NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError("deep-filter : " + (r.stderr or r.stdout).decode("utf-8", "replace")[-300:])
    y, _ = sf.read(str(out / src.name), dtype="float32", always_2d=True)
    y = y.T
    if y.shape[1] < chunk.shape[1]:
        y = np.pad(y, ((0, 0), (0, chunk.shape[1] - y.shape[1])))
    return y[:, : chunk.shape[1]]


def deverb(audio, sr: int, jobs: int = 4, on_progress=None, chunk_s: float = 12.0, preroll_s: float = 1.5, xfade_s: float = 0.05,
           late: bool = True, info: dict | None = None):
    """Voix sans la réverbe de la pièce (100 %, même longueur, même fréquence, mêmes canaux).
    Morceaux de ~12 s traités en parallèle ; 1,5 s d'avance pour que le filtre soit
    « chaud » au début de chaque morceau ; fondu de 50 ms entre deux morceaux.
    `late` : retrait de la réverbe tardive après DeepFilterNet (RT60 lu sur toute la prise).
    `info` (facultatif) reçoit le RT60 estimé."""
    import numpy as np
    exe = deep_filter_exe()
    if not exe.is_file():
        raise FileNotFoundError("deep-filter introuvable : réinstalle la déréverbération")
    x = resample(audio, sr, DF_SR)
    n = x.shape[1]
    rt60, n_decays = rt60_estimate(x, DF_SR) if late else (None, 0)
    if info is not None:
        info.update({"rt60": None if rt60 is None else round(rt60, 2), "rt60_decays": n_decays})
    step = int(chunk_s * DF_SR)
    pre = int(preroll_s * DF_SR)
    xf = int(xfade_s * DF_SR)
    bounds = [(a, min(n, a + step)) for a in range(0, n, step)]
    if len(bounds) > 1 and bounds[-1][1] - bounds[-1][0] < DF_SR:  # dernier morceau trop court : fusionné
        bounds[-2] = (bounds[-2][0], n)
        bounds.pop()
    out = np.zeros_like(x)
    work = Path(tempfile.mkdtemp(prefix="nova-deverb-"))
    done = [0]
    try:
        def job(i):
            a, b = bounds[i]
            s0, s1 = max(0, a - pre), min(n, b + xf)
            y = _df_chunk(exe, x[:, s0:s1], work, i)
            if late:
                y = suppress_late_reverb(y, DF_SR, rt60)
            done[0] += 1
            if on_progress:
                on_progress(done[0] / len(bounds))
            return i, s0, y

        with ThreadPoolExecutor(max_workers=max(1, jobs)) as ex:
            results = sorted(ex.map(job, range(len(bounds))))
        for i, s0, y in results:
            a, b = bounds[i]
            seg = y[:, a - s0: b - s0]
            if i > 0 and xf > 0:
                # Fondu : la fin du morceau précédent (déjà écrite au-delà de a) se mêle au début de celui-ci.
                k = min(xf, seg.shape[1])
                ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)
                out[:, a: a + k] = out[:, a: a + k] * (1 - ramp) + seg[:, :k] * ramp
                out[:, a + k: b] = seg[:, k:]
            else:
                out[:, a:b] = seg
            # Prolongement (fondu avec le morceau suivant)
            tail = y[:, b - s0: b - s0 + xf]
            if tail.shape[1]:
                out[:, b: b + tail.shape[1]] = tail
    finally:
        shutil.rmtree(work, ignore_errors=True)
    y = resample(out, DF_SR, sr)
    if y.shape[1] < audio.shape[1]:
        y = np.pad(y, ((0, 0), (0, audio.shape[1] - y.shape[1])))
    return y[:, : audio.shape[1]].astype(np.float32)


def run_deverb(a) -> int:
    import numpy as np
    import soundfile as sf
    t0 = time.time()
    emit("progress", pct=1, message="Lecture de la voix")
    audio, sr = read_audio(a.input)
    if audio.shape[1] < sr * 0.3:
        raise ValueError("Clip trop court")
    emit("device", device="cpu", name="processeur")
    emit("progress", pct=4, message="Retrait de la réverbe de la pièce")

    def progress(f):
        emit("progress", pct=round(4 + 92 * f, 1), message="Retrait de la réverbe de la pièce")

    info: dict = {}
    y = deverb(audio, sr, jobs=a.jobs, on_progress=progress, late=not a.no_late, info=info)
    reduction, n_ends = tail_reduction_db(audio, y, sr)
    out = Path(a.output)
    tmp = out.with_suffix(".partiel.wav")
    sf.write(str(tmp), y.T, sr, subtype="FLOAT")
    os.replace(tmp, out)
    emit("done", path=str(out), sample_rate=sr, channels=int(y.shape[0]), engine="deepfilternet3" + ("" if a.no_late else "+queue"),
         device="cpu", seconds=round(time.time() - t0, 2), duration=round(audio.shape[1] / sr, 3),
         rt60=info.get("rt60"), reverb_db=reduction, phrase_ends=n_ends,
         rms_in=round(float(np.sqrt(np.mean(audio ** 2))), 6), rms_out=round(float(np.sqrt(np.mean(y ** 2))), 6))
    return 0


# ─── Vérification ────────────────────────────────────────────────────────────

def self_test(feature: str, model: str) -> int:
    import numpy as np
    t0 = time.time()
    if feature == "deverb":
        sr = 48000
        t = np.arange(sr * 3) / sr
        x = (0.2 * np.sin(2 * np.pi * 220 * t) * (np.sin(2 * np.pi * 2 * t) > 0)).astype("float32")[None]
        y = deverb(x, sr, jobs=2, chunk_s=1.5)
        ok = y.shape == x.shape and bool(np.isfinite(y).all())
        print(json.dumps({"ok": ok, "feature": feature, "engine": "deepfilternet3", "self_test_seconds": round(time.time() - t0, 2)}))
        return 0 if ok else 1
    device = pick_device("auto")
    m = load_whisper(model, device)
    noise = (1e-3 * np.random.default_rng(0).standard_normal(16000 * 2)).astype("float32")
    words, _, _ = transcribe_audio(m, noise, "fr")
    print(json.dumps({"ok": True, "feature": feature, "model": model, "device": device,
                      "gpu": gpu_name() if device == "cuda" else None, "self_test_seconds": round(time.time() - t0, 2),
                      "words_on_noise": len(words)}))
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    os.environ.setdefault("HF_HUB_OFFLINE", "1")  # jamais de téléchargement pendant un calcul
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["transcribe", "deverb", "self-test"])
    ap.add_argument("feature", nargs="?", default="transcribe")
    ap.add_argument("--input")
    ap.add_argument("--output")
    ap.add_argument("--language", default="fr", choices=list(LANGUAGES))
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--no-late", action="store_true", help="DeepFilterNet seul (sans le retrait de la réverbe tardive)")
    ap.add_argument("--jobs", type=int, default=max(1, min(4, (os.cpu_count() or 4) // 2)))
    a = ap.parse_args(argv)
    try:
        if a.command == "self-test":
            return self_test(a.feature, a.model)
        if not a.input:
            raise ValueError("--input est obligatoire")
        if a.command == "transcribe":
            return run_transcribe(a)
        if not a.output:
            raise ValueError("--output est obligatoire")
        return run_deverb(a)
    except Exception as e:
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
