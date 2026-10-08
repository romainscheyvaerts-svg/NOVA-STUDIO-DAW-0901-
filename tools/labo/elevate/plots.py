"""Graphiques des mesures du module Transient (gain vs temps autour d'une attaque)."""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
G = os.path.join(OUT, "graphiques")
os.makedirs(G, exist_ok=True)


def load(group, suffix=""):
    return json.load(open(os.path.join(OUT, f"mesures_{group}{suffix}.json"), encoding="utf-8"))


def t_axis(n, pre_ms=20, dt=0.5):
    return np.arange(n) * dt - pre_ms


def plot_group(group, keys=None, freqs=None, title="", fname=None, nova=None, xlim=(-10, 400)):
    m = load(group)
    keys = keys or [k for k in m if not k.startswith("_")]
    fig, ax = plt.subplots(figsize=(13, 6))
    for k in keys:
        for f, c in m[k].items():
            if freqs and f not in freqs:
                continue
            c = np.array(c)
            line, = ax.plot(t_axis(len(c)), c, lw=1.2, label=f"{k} {f} Hz")
            if nova and k in nova and f in nova[k]:
                cn = np.array(nova[k][f])
                ax.plot(t_axis(len(cn)), cn, "--", lw=1.0, color=line.get_color())
    ax.set_xlim(*xlim)
    ax.set_xlabel("ms après l'attaque")
    ax.set_ylabel("gain (dB)")
    ax.grid(alpha=.3)
    ax.legend(fontsize=7, ncol=3)
    ax.set_title(title + ("  (trait plein = original, tirets = NOVA)" if nova else ""))
    plt.tight_layout()
    plt.savefig(os.path.join(G, fname or f"{group}.png"), dpi=60)
    plt.close()


if __name__ == "__main__":
    nova = None
    grp = sys.argv[1] if len(sys.argv) > 1 else None
    for g in ["transient", "niveaux", "durees", "bandes", "adaptatif"]:
        if grp and g != grp:
            continue
        if os.path.exists(os.path.join(OUT, f"mesures_{g}_nova.json")):
            nova = load(g, "_nova")
        plot_group(g, title=g, nova=nova)
