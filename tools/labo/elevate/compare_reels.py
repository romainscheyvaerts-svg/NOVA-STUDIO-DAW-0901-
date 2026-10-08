"""Comparaison NOVA / original sur vraie batterie et vrai mix (module Transient, limiteur, chaîne de Romain).
Écrit elevate/ecarts_reels.json et les fichiers d'écoute (avant / original / nova / différence).
Usage : python elevate/compare_reels.py"""
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import nova  # noqa: E402
from bancs import elevate as banc  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
AUD = os.path.join(OUT, "audio_vst")
ECO = os.path.join(OUT, "ecoute")
os.makedirs(ECO, exist_ok=True)
RB = banc.romain_band_transient()

CASES = [  # (tag VST, entrée, réglages NOVA, libellé)
    ("t100", "in", nova.transient_params(100), "Transient seul, emphase 100 %"),
    ("t27", "in", nova.transient_params(27), "Transient seul, emphase 27 %"),
    ("t27a50r", "in", nova.transient_params(27, 50, RB), "Transient de Romain (27 %, adaptatif 50 %, courbe par bande)"),
    ("t100a50", "in", nova.transient_params(100, 50), "Transient 100 %, adaptatif 50 %"),
    ("t50a100", "in", nova.transient_params(50, 100), "Transient 50 %, adaptatif 100 %"),
    ("lim_g8_noadapt", "in16", dict(nova.transient_params(0), limiterOn=True, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0, ceilingDb=-0.1, truePeak=True, transientOn=False), "Limiteur seul +8 dB, sans adaptatif"),
    ("lim_romain", "in16", dict(nova.transient_params(0), limiterOn=True, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=6.0, adaptiveSpeed=100.0, ceilingDb=-0.1, truePeak=True, transientOn=False), "Limiteur de Romain (+8 dB, 1 ms, adaptatif 6 dB / 100 %, −0,1 dBTP)"),
    ("romain", "in16", nova.romain_params(), "Chaîne complète « PRE MASTER Romain »"),
]


def st(y, w):
    n = (y.shape[1] // w) * w
    return 10 * np.log10(np.mean(y[:, :n].reshape(2, -1, w) ** 2, axis=(0, 2)) + 1e-12)


def emphasis_err(x, yv, yn, w=96):
    """Écart du gain d'emphase court terme (2 ms) là où le signal est présent : moyenne, rms, p95 (dB)."""
    gx, gv, gn = st(x, w), st(yv, w), st(yn, w)
    sel = gx > -55
    d = (gn - gx)[sel] - (gv - gx)[sel]
    att = sel & ((gv - gx) > 1.0)  # instants où l'original accentue de plus de 1 dB (attaques)
    da = (gn - gv)[att]
    return {"moy": float(np.mean(d)), "rms": float(np.sqrt(np.mean(d ** 2))), "p95": float(np.percentile(np.abs(d), 95)),
            "attaques_n": int(att.sum()), "attaques_rms": float(np.sqrt(np.mean(da ** 2))) if att.any() else None,
            "emph_orig_moy_attaques": float(np.mean((gv - gx)[att])) if att.any() else None,
            "emph_nova_moy_attaques": float(np.mean((gn - gx)[att])) if att.any() else None}


def plot_env(x, yv, yn, fn, title, t0=0.5, t1=3.0, w=96):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    gx, gv, gn = st(x, w), st(yv, w), st(yn, w)
    t = np.arange(len(gx)) * w / 48000
    s = (t >= t0) & (t <= t1)
    fig, ax = plt.subplots(2, 1, figsize=(15, 7), sharex=True)
    ax[0].plot(t[s], gx[s], color="0.5", lw=0.8, label="entrée (dB, 2 ms)")
    ax[0].legend(fontsize=8)
    ax[0].set_title(title)
    m = gx > -55
    ax[1].plot(t[s], np.where(m, gv - gx, np.nan)[s], "k", lw=1, label="gain de l'original (dB)")
    ax[1].plot(t[s], np.where(m, gn - gx, np.nan)[s], "r", lw=1, alpha=.75, label="gain NOVA (dB)")
    ax[1].legend(fontsize=8)
    ax[1].grid(alpha=.3)
    plt.tight_layout()
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    plt.savefig(fn, dpi=55)
    plt.close()


def main():
    m = nova.MasterTransient()
    res = {}
    for name in ("batterie", "mix"):
        for tag, inp, prm, label in CASES:
            fv = os.path.join(AUD, f"{tag}_{name}.npy")
            if not os.path.exists(fv):
                continue
            x = np.load(os.path.join(AUD, f"{inp}_{name}.npy")).astype(np.float64)
            yv = np.load(fv).astype(np.float64)
            yn = m.run(x, prm)
            d = yv - yn
            null = float(10 * np.log10(np.sum(d ** 2) / np.sum(yv ** 2)))
            effet = float(10 * np.log10(np.sum((yv - x) ** 2) / np.sum(yv ** 2)))  # taille de l'effet de l'original
            r = {"libelle": label, "null_db": null, "effet_original_db": effet, "rms_orig": float(20 * np.log10(np.std(yv))),
                 "rms_nova": float(20 * np.log10(np.std(yn))), "crete_orig": float(20 * np.log10(np.max(np.abs(yv)))),
                 "crete_nova": float(20 * np.log10(np.max(np.abs(yn)))), "emphase": emphasis_err(x, yv, yn)}
            res[f"{tag}_{name}"] = r
            if tag in ("t100", "t27a50r", "romain", "lim_romain"):
                for k, y in (("avant", x), ("original", yv), ("nova", yn), ("difference", d)):
                    sf.write(os.path.join(ECO, f"{tag}__{name}__{k}.wav"), np.clip(y.T, -1, 1).astype(np.float32), 48000, subtype="FLOAT")
                plot_env(x, yv, yn, os.path.join(OUT, "graphiques", f"reel_{tag}_{name}.png"), f"{label} — {name}")
            print(f"{tag:16s} {name:9s} null {null:6.1f} dB (effet {effet:6.1f}) rms {r['rms_orig']:6.2f}/{r['rms_nova']:6.2f} "
                  f"emph rms {r['emphase']['rms']:.2f} att {r['emphase']['attaques_rms']}", flush=True)
    m.close()
    json.dump(res, open(os.path.join(OUT, "ecarts_reels.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
