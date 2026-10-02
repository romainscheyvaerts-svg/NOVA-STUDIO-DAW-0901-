"""
Capture l'empreinte (réponse impulsionnelle) d'une reverb VST3 pour la reverb à
convolution de Nova (ReverbNode, paramètre irUrl).

Méthode de Farina : balayage sinusoïdal exponentiel 20 Hz → 20 kHz passé dans
la reverb réglée 100 % wet, puis déconvolution par le filtre inverse. Bien plus
propre qu'un clic (rapport signal/bruit, pas de saturation). La queue est
coupée à -80 dB sous la crête, puis normalisée.

Exemples :
  python capture_ir.py --plugin "C:/Program Files/Common Files/VST3/ValhallaDSP/ValhallaRoom.vst3" --out ../public/ir/test.wav
  python capture_ir.py --plugin ... --preset "Ma reverb.vstpreset" --out ...
  python capture_ir.py --plugin ... --state-file etat.b64 --out ...   (état brut du plugin, ex. extrait d'un .als)
  python capture_ir.py --plugin ... --set "Decay=2.1" --set "Mix=100" --out ...
Le mélange dry/wet est mis à 100 % wet automatiquement si un paramètre
« mix / wet / dry_wet » existe (sinon le dry direct est retiré par mesure).
"""
import argparse
import base64
import sys

import wave

import numpy as np
from pedalboard import load_plugin

SR = 48000


def write_wav24(path: str, data: np.ndarray, sr: int):
    """data : (canaux, échantillons) en flottant -1..1 → WAV PCM 24 bits."""
    x = np.clip(data.T, -1.0, 1.0)
    ints = np.round(x * 8388607).astype(np.int32).reshape(-1)
    b = np.empty((ints.size, 3), dtype=np.uint8)
    b[:, 0] = ints & 0xFF
    b[:, 1] = (ints >> 8) & 0xFF
    b[:, 2] = (ints >> 16) & 0xFF
    with wave.open(path, "wb") as w:
        w.setnchannels(data.shape[0])
        w.setsampwidth(3)
        w.setframerate(sr)
        w.writeframes(b.tobytes())


def sweep(sr: int, seconds: float, f1: float = 20.0, f2: float = 20000.0):
    t = np.arange(int(sr * seconds)) / sr
    k = np.log(f2 / f1)
    x = np.sin(2 * np.pi * f1 * seconds / k * (np.exp(t * k / seconds) - 1))
    # Fondus de 10 ms : pas de clic aux extrémités
    n = int(0.01 * sr)
    w = np.ones_like(x)
    w[:n] = np.linspace(0, 1, n)
    w[-n:] = np.linspace(1, 0, n)
    x = x * w
    # Filtre inverse : balayage retourné, atténué de 6 dB/oct
    inv = x[::-1] * np.exp(-t * k / seconds)
    return x.astype(np.float32), inv.astype(np.float64)


def fft_convolve(a, b):
    n = len(a) + len(b) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(a, size) * np.fft.rfft(b, size), size)[:n]


def set_wet(plugin):
    """Met le plugin à 100 % wet si un paramètre de mélange existe. Renvoie le nom réglé."""
    for name, p in plugin.parameters.items():
        low = name.lower()
        if low in ("mix", "wet", "dry_wet", "drywet", "dry_wet_mix", "wet_dry", "mix_percent") or low.endswith("_mix") or "dry_wet" in low:
            try:
                rng = p.range  # (min, max, step)
                setattr(plugin, name, rng[1])
            except Exception:
                try:
                    setattr(plugin, name, 100.0)
                except Exception:
                    continue
            return name
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plugin", required=True)
    ap.add_argument("--plugin-name", default=None, help="Shell VST3 contenant plusieurs plugins")
    ap.add_argument("--preset", default=None)
    ap.add_argument("--state-file", default=None)
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--tail", type=float, default=8.0)
    ap.add_argument("--no-auto-wet", action="store_true")
    a = ap.parse_args()

    plugin = load_plugin(a.plugin, plugin_name=a.plugin_name) if a.plugin_name else load_plugin(a.plugin)
    if a.state_file:
        plugin.raw_state = base64.b64decode(open(a.state_file, "rb").read())
    if a.preset:
        plugin.load_preset(a.preset)
    for kv in a.set:
        k, v = kv.split("=", 1)
        try:
            setattr(plugin, k, float(v))
        except ValueError:
            setattr(plugin, k, v)
    wet = None if a.no_auto_wet else set_wet(plugin)

    x, inv = sweep(SR, a.seconds)
    pad = np.zeros(int(SR * a.tail), dtype=np.float32)
    sig = np.concatenate([x, pad])
    stereo_in = np.stack([sig, sig]) * 0.5  # -6 dBFS : marge pour la reverb
    plugin.reset()
    y = plugin(stereo_in, SR)

    irs = []
    for ch in range(min(2, y.shape[0])):
        h = fft_convolve(y[ch].astype(np.float64), inv)
        irs.append(h)
    irs = np.stack(irs)
    # Le pic direct tombe à len(x)-1 (balayage + inverse) ; on garde à partir de 1 ms avant.
    peak_at = len(x) - 1
    start = max(0, peak_at - int(0.001 * SR))
    irs = irs[:, start:start + int(SR * a.tail)]
    if wet is None:
        # Sans réglage de mix : on retire le son direct (premières 0,5 ms autour du pic)
        d0 = int(0.001 * SR)
        irs[:, : d0 + int(0.0005 * SR)] *= np.linspace(0, 1, d0 + int(0.0005 * SR))
    # Coupe la queue à -80 dB sous la crête (enveloppe glissante de 10 ms)
    env = np.max(np.abs(irs), axis=0)
    win = int(0.01 * SR)
    env = np.convolve(env, np.ones(win) / win, mode="same")
    thr = env.max() * 10 ** (-80 / 20)
    above = np.where(env > thr)[0]
    end = int(above[-1]) + win if len(above) else irs.shape[1]
    irs = irs[:, :end]
    fade = min(int(0.05 * SR), irs.shape[1] // 4)
    irs[:, -fade:] *= np.linspace(1, 0, fade)
    irs = irs / (np.max(np.abs(irs)) + 1e-12) * 0.9

    write_wav24(a.out, irs, SR)
    print(f"OK {a.out} : {irs.shape[1] / SR:.2f} s, {irs.shape[0]} canaux, mix={'auto:' + wet if wet else 'non trouvé'}")


if __name__ == "__main__":
    sys.exit(main())
