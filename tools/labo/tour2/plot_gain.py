"""Trace les trajectoires de gain court terme (2 ms) VST vs modèle sur un signal réel."""
import sys, os
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour2.common import *  # noqa

def st(x, y, w):
    n = (len(x) // w) * w
    ex = np.sqrt(np.mean(x[:n].reshape(-1, w) ** 2, 1)); ey = np.sqrt(np.mean(y[:n].reshape(-1, w) ** 2, 1))
    return 20*np.log10(np.maximum(ey,1e-9)/np.maximum(ex,1e-9)), 20*np.log10(np.maximum(ex,1e-9))

def plot(x, yv, ym, out, t0=0, t1=None, w=96, title=""):
    gv, lx = st(x[0], yv[0], w); gm, _ = st(x[0], ym[0], w)
    t = np.arange(len(gv)) * w / SR
    m = lx > -45
    sel = (t >= t0) & (t <= (t1 or t[-1]))
    fig, ax = plt.subplots(2, 1, figsize=(16, 7), sharex=True)
    ax[0].plot(t[sel], lx[sel], color="0.5"); ax[0].set_ylabel("entrée dB"); ax[0].set_title(title)
    ax[1].plot(t[sel], np.where(m, gv, np.nan)[sel], "k", lw=1, label="VST")
    ax[1].plot(t[sel], np.where(m, gm, np.nan)[sel], "r", lw=1, alpha=.7, label="modèle")
    ax[1].legend(); ax[1].grid(alpha=.3)
    plt.tight_layout(); plt.savefig(out, dpi=55); plt.close()
