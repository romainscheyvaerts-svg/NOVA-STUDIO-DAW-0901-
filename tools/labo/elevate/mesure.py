"""Mesures boîte noire du limiteur de mastering (module Transient, limiteur, chaîne de Romain).
Usage : python elevate/mesure.py <groupe>
  groupes : transient, niveaux, durees, bandes, adaptatif, reels, limiteur, romain
Sorties : D:/1 WORK/CONTENU/nova-labo/elevate/mesures_<groupe>.json + audio_vst/*.npy"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
from vst import Elevate, banc, SR, host  # noqa: E402
import bench  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
AUD = os.path.join(OUT, "audio_vst")
os.makedirs(AUD, exist_ok=True)
FREQS = [60.0, 150.0, 400.0, 1000.0, 2500.0, 6000.0, 12000.0]


def burst_signal(freq, level_db, on_ms=300, off_ms=500, count=3, base_db=None):
    """Sinus qui démarre d'un coup (attaque franche), tenu on_ms, puis silence (ou fond) off_ms."""
    per = int((on_ms + off_ms) / 1000 * SR)
    n = per * count + int(0.3 * SR)
    t = np.arange(n) / SR
    amp = np.full(n, 0.0 if base_db is None else 10 ** (base_db / 20))
    starts = []
    for k in range(count):
        s = int(0.3 * SR) + k * per
        amp[s:s + int(on_ms / 1000 * SR)] = 10 ** (level_db / 20)
        starts.append(s)
    x = amp * np.sin(2 * np.pi * freq * t)
    return np.vstack([x, x]), starts


def gain_curve(x, y, freq, starts, pre_ms=20, post_ms=600):
    """Gain (dB) autour de chaque attaque (moindres carrés sur une demi-période, 1 ms min) ; pas de 0,5 ms."""
    w = max(int(SR / freq / 2), 24)
    k = np.ones(w)
    num = np.convolve(y[0] * x[0], k, "same")
    den = np.convolve(x[0] * x[0], k, "same")
    g = 20 * np.log10(np.maximum(np.abs(num / np.maximum(den, 1e-30)), 1e-9))
    curves = [g[s - int(pre_ms / 1000 * SR):s + int(post_ms / 1000 * SR)] for s in starts]
    c = np.median(np.array(curves), axis=0)
    return c[::SR // 2000].round(3).tolist()


def run_bursts(e, s, freqs, level, on_ms=300, off_ms=500):
    e.configure(s)
    res = {}
    for f in freqs:
        x, st = burst_signal(f, level, on_ms, off_ms)
        res[str(f)] = gain_curve(x, e.run(x), f, st, post_ms=on_ms + min(off_ms, 300))
    return res


def real_input(name, rms):
    path, sec, off = (banc.BATTERIE, 8, 0.0) if name == "batterie" else (banc.MIX, 12, 2.0)
    return bench.load_audio(path, sec, off, rms)


def main(group):
    host.hide_console()
    e = Elevate()
    R = {"_meta": {"latency": e.latency, "sr": SR, "date": time.strftime("%Y-%m-%d %H:%M"), "dt_ms": 0.5, "pre_ms": 20}}
    if group == "transient":
        for em in (0, 27, 50, 100):
            R[f"em{em}"] = run_bursts(e, banc.transient_only(em), FREQS, -20)
    elif group == "niveaux":
        for lv in (-40, -30, -12, -6):
            R[f"lv{lv}"] = run_bursts(e, banc.transient_only(100), [150.0, 1000.0, 6000.0], lv)
    elif group == "durees":
        for on in (5, 20, 60, 1000):
            R[f"on{on}"] = run_bursts(e, banc.transient_only(100), [1000.0], -20, on_ms=on, off_ms=max(400, on))
        for off in (20, 50, 100, 200):
            R[f"off{off}"] = run_bursts(e, banc.transient_only(100), [1000.0], -20, on_ms=200, off_ms=off)
        for bd in (-40, -30, -26):
            e.configure(banc.transient_only(100))
            x, st = burst_signal(1000.0, -20, 300, 500, base_db=bd)
            R[f"fond{bd}"] = {"1000.0": gain_curve(x, e.run(x), 1000.0, st, post_ms=600)}
    elif group == "bandes":
        for k, fc in ((4, 351.0), (8, 1106.93), (15, 3964.3)):
            for v in (0.0, 50.0, 200.0):
                b = [100.0] * 26
                b[k - 1] = v
                R[f"b{k}_{int(v)}"] = run_bursts(e, banc.transient_only(100, bands=b), [fc], -20)
            b = [0.0] * 26
            b[k - 1] = 100.0
            R[f"seule{k}"] = run_bursts(e, banc.transient_only(100, bands=b), [fc, fc * 1.5, fc / 1.5], -20)
        R["romain_courbe"] = run_bursts(e, banc.transient_only(100, bands=banc.romain_band_transient()), FREQS, -20)
    elif group == "adaptatif":
        for ad in (0, 50, 100):
            R[f"ad{ad}"] = run_bursts(e, banc.transient_only(50, ad), [150.0, 1000.0, 6000.0], -20)
            e.configure(banc.transient_only(50, ad))
            x, st = burst_signal(1000.0, -20, 300, 500, base_db=-30)
            R[f"ad{ad}_fond"] = {"1000.0": gain_curve(x, e.run(x), 1000.0, st)}
    elif group == "carto":
        for em in (5, 10, 20, 27, 35, 40, 50, 60, 70, 80, 90, 100):
            R[f"em{em}"] = run_bursts(e, banc.transient_only(em), [1000.0], -20)
        for em in (27, 50, 100):
            for d in (1, 2, 3, 6, 10, 20):
                e.configure(banc.transient_only(em))
                x, st = burst_signal(1000.0, -20, 300, 500, base_db=-20 - d)
                R[f"pas{em}_{d}"] = {"1000.0": gain_curve(x, e.run(x), 1000.0, st, post_ms=600)}
            for gap in (5, 10, 20, 40, 80, 160, 320):
                R[f"gap{em}_{gap}"] = run_bursts(e, banc.transient_only(em), [1000.0], -20, on_ms=300, off_ms=gap)
            # montée progressive (attaque lente)
            for ramp in (5, 20, 60):
                e.configure(banc.transient_only(em))
                x, st = burst_signal(1000.0, -20, 300, 500)
                for s0 in st:
                    nr = int(ramp / 1000 * SR)
                    x[:, s0:s0 + nr] *= np.linspace(0, 1, nr)
                R[f"rampe{em}_{ramp}"] = {"1000.0": gain_curve(x, e.run(x), 1000.0, st)}
        for g, bv in ((50, 200.0), (100, 50.0), (27, 43.0), (27, 65.0), (100, 27.0), (50, 54.0), (100, 150.0)):
            b = [100.0] * 26
            b[7] = bv
            R[f"dos{g}_{int(bv)}"] = run_bursts(e, banc.transient_only(g, bands=b), [1106.93], -20)
        for ad in (0, 25, 50, 75, 100):
            for em in (27, 100):
                R[f"ad{em}_{ad}"] = run_bursts(e, banc.transient_only(em, ad), [1000.0], -20)
                # même salve, avec un grave tenu fort (150 Hz, -14 dBFS) : interaction entre bandes ?
                e.configure(banc.transient_only(em, ad))
                x, st = burst_signal(1000.0, -20, 300, 500)
                t = np.arange(x.shape[1]) / SR
                xb = x + 10 ** (-14 / 20) * np.sin(2 * np.pi * 150 * t)
                y = e.run(xb)
                R[f"adgrave{em}_{ad}"] = {"1000.0": gain_curve(x, y - (e.run(xb - x)), 1000.0, st)}
                # salve large bande (bruit rose)
                n = x.shape[1]
                pn = bench.pink(n, seed=5)
                env = np.abs(x[0]) > 0
                env = np.convolve(env.astype(float), np.ones(48) / 48, "same") > 0
                xn = pn * env * 10 ** (-20 / 20)
                xn = np.vstack([xn, xn])
                yn = e.run(xn)
                w = 48
                gg = 10 * np.log10(np.convolve(yn[0] ** 2, np.ones(w), "same") / np.maximum(np.convolve(xn[0] ** 2, np.ones(w), "same"), 1e-20))
                cs = [gg[s - int(0.02 * SR):s + int(0.6 * SR)] for s in st]
                R[f"adbruit{em}_{ad}"] = {"rose": np.median(np.array(cs), axis=0)[::SR // 2000].round(3).tolist()}
    elif group == "reels":
        for name in ("batterie", "mix"):
            x = real_input(name, -20)
            np.save(os.path.join(AUD, f"in_{name}.npy"), x.astype(np.float32))
            for tag, s in (("t100", banc.transient_only(100)), ("t27", banc.transient_only(27)),
                           ("t27a50r", banc.transient_only(27, 50, banc.romain_band_transient())),
                           ("t100a50", banc.transient_only(100, 50)), ("t50a100", banc.transient_only(50, 100))):
                e.configure(s)
                y = e.run(x)
                np.save(os.path.join(AUD, f"{tag}_{name}.npy"), y.astype(np.float32))
                R[f"{tag}_{name}"] = {"in_rms": float(20 * np.log10(np.std(x))), "out_rms": float(20 * np.log10(np.std(y)))}
    elif group == "limiteur":
        for name in ("batterie", "mix"):
            x = real_input(name, -16)
            np.save(os.path.join(AUD, f"in16_{name}.npy"), x.astype(np.float32))
            for tag, s in (("lim_romain", banc.limiter_only()),
                           ("lim_g8_noadapt", banc.limiter_only(again=0.0, aspeed=0.0)),
                           ("lim_g8_s5", banc.limiter_only(speed_ms=5.0, again=0.0, aspeed=0.0)),
                           ("lim_g4_noadapt", banc.limiter_only(gain_db=4.0, again=0.0, aspeed=0.0)),
                           ("lim_g8_a6_s0", banc.limiter_only(aspeed=0.0)),
                           ("lim_g8_a0_s100", banc.limiter_only(again=0.0))):
                e.configure(s)
                y = e.run(x)
                np.save(os.path.join(AUD, f"{tag}_{name}.npy"), y.astype(np.float32))
                R[f"{tag}_{name}"] = {"in_rms": float(20 * np.log10(np.std(x))), "out_rms": float(20 * np.log10(np.std(y))),
                                      "out_peak": float(20 * np.log10(np.max(np.abs(y))))}
        e.configure(banc.limiter_only(again=0.0, aspeed=0.0))
        rows = []
        for L in (-30, -20, -14, -10, -8, -6, -3, 0):
            t = np.arange(int(1.0 * SR)) / SR
            x = 10 ** (L / 20) * np.sin(2 * np.pi * 1000 * t)
            y = e.run(np.vstack([x, x]))
            rows.append([L, float(20 * np.log10(np.max(np.abs(y[0, SR // 2:]))))])
        R["statique_g8"] = rows
        for tag, s in (("saut_s1", banc.limiter_only(again=0.0, aspeed=0.0)),
                       ("saut_s5", banc.limiter_only(speed_ms=5.0, again=0.0, aspeed=0.0)),
                       ("saut_romain", banc.limiter_only())):
            e.configure(s)
            n = int(2.5 * SR)
            p = bench.pink(n, seed=3) * 10 ** (-26 / 20)
            amp = np.ones(n)
            amp[SR:SR + SR // 2] = 10 ** (12 / 20)
            x = np.vstack([p * amp, p * amp])
            y = e.run(x)
            w = 240
            g = 10 * np.log10(np.convolve(y[0] ** 2, np.ones(w), "same") / np.maximum(np.convolve(x[0] ** 2, np.ones(w), "same"), 1e-20))
            R[tag] = g[::SR // 1000].round(3).tolist()
    elif group == "romain":
        for name in ("batterie", "mix"):
            x = real_input(name, -16)
            e.configure(banc.romain_settings())
            y = e.run(x)
            np.save(os.path.join(AUD, f"romain_{name}.npy"), y.astype(np.float32))
            R[f"romain_{name}"] = {"in_rms": float(20 * np.log10(np.std(x))), "out_rms": float(20 * np.log10(np.std(y))),
                                   "out_peak": float(20 * np.log10(np.max(np.abs(y))))}
    with open(os.path.join(OUT, f"mesures_{group}.json"), "w", encoding="utf-8") as f:
        json.dump(R, f)
    print("ok", group)


if __name__ == "__main__":
    main(sys.argv[1])
