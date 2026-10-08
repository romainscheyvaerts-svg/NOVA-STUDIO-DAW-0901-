"""Tour 3 : trajectoire de gain VST vs modèle sur un vrai signal (graphique).
Usage : python -m tour3.plot_gain <groupe> <cas> <sig> <png> [t0 t1]"""
import os, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour3 import lowprio  # noqa
from tour3.diag import gain_trace  # noqa
from tour2.fitdyn import GROUPS, import_prof, load_real, MonoProc  # noqa
from tour2.common import banc_mod  # noqa


def main(group, case, sig, png, t0=None, t1=None):
    g = GROUPS[group]
    prof = import_prof(g["prof"])
    banc = banc_mod(g["banc"])
    proc = MonoProc(prof.builder(prof.load_fit(), banc.to_nova))
    r = next(r for r in load_real(group, ("fit", "val")) if r["name"] == case and r["sig"] == sig)
    proc.configure(r["settings"])
    yb = proc.run(r["x"])[0]
    x = r["x"][0]
    w = 120
    ga = 20 * np.log10(np.maximum(np.abs(gain_trace(r["y"], x, w)), 1e-6))
    gb = 20 * np.log10(np.maximum(np.abs(gain_trace(yb, x, w)), 1e-6))
    from scipy.ndimage import uniform_filter1d
    lx = 10 * np.log10(np.maximum(uniform_filter1d(x * x, w), 1e-12))
    t = np.arange(len(x)) / 48000
    m = lx > lx.max() - 40
    ga[~m] = np.nan; gb[~m] = np.nan
    fig, ax = plt.subplots(2, 1, figsize=(16, 8), sharex=True)
    ax[0].plot(t, ga, lw=0.7, label="VST"); ax[0].plot(t, gb, lw=0.7, label="NOVA"); ax[0].legend(); ax[0].grid(alpha=.3)
    ax[0].set_ylabel("gain dB")
    ax[1].plot(t, gb - ga, lw=0.7, color="r"); ax[1].plot(t, (lx - lx.max()) / 10, lw=0.5, color="gray")
    ax[1].set_ylim(-4, 4); ax[1].grid(alpha=.3); ax[1].set_ylabel("NOVA-VST dB")
    if t0 is not None:
        ax[1].set_xlim(float(t0), float(t1))
    fig.tight_layout(); fig.savefig(png, dpi=80)


if __name__ == "__main__":
    lowprio()
    main(*sys.argv[1:])
