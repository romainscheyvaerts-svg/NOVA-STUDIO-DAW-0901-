"""Tour 3 : corpus VST vs modèle — trajectoires de gain par segment (graphique) + nulls.
Usage : python -m tour3.cmp_corpus <groupe> <corpus> <png> [fichier best json]"""
import json, os, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour3 import lowprio  # noqa
from tour3 import corpus as cp  # noqa
from tour3.diag import gain_trace  # noqa
from tour2.fitdyn import GROUPS, import_prof, MonoProc, set_d2
from tour3.fit3 import GROUPS as G3
GROUPS = dict(GROUPS, **{k: v for k, v in G3.items()})  # noqa
from tour2.common import banc_mod, null_db  # noqa


def gdb(y, x, w=48):
    return 20 * np.log10(np.maximum(np.abs(gain_trace(y, x, w)), 1e-6))


def run_model(group, settings, x, fit=None):
    g = GROUPS[group]
    prof = import_prof(g["prof"])
    banc = banc_mod(g["banc"])
    proc = MonoProc(prof.builder(fit or prof.load_fit(), banc.to_nova))
    proc.configure(settings)
    return proc.run(x[None, :])[0]


def main(group, name, png, best=None):
    g = GROUPS[group]
    banc = banc_mod(g["banc"])
    prof = import_prof(g["prof"])
    fit = prof.load_fit()
    if best:
        set_d2(fit, g["key"], json.load(open(best, encoding="utf-8"))["d2"])
    C = cp.load(banc.ID, name)
    x, y = C["x"], C["y"]
    yb = run_model(group, C["settings"], x, fit)
    ga, gb = gdb(y, x), gdb(yb, x)
    segs = [s for s in C["segs"] if s[0] != "pre"]
    nc = 6
    nr = (len(segs) + nc - 1) // nc
    fig, axs = plt.subplots(nr, nc, figsize=(4 * nc, 2.6 * nr))
    for ax, (nm, a, b) in zip(axs.flat, segs):
        t = (np.arange(a, b) - a) / 48.0
        lx = np.abs(x[a:b])
        m = gain_trace(x[a:b], x[a:b], 48) > 0
        en = np.convolve(x[a:b] ** 2, np.ones(48) / 48, "same")
        mk = en > 1e-10
        A = np.where(mk, ga[a:b], np.nan); B = np.where(mk, gb[a:b], np.nan)
        ax.plot(t, A, lw=.8, label="VST"); ax.plot(t, B, lw=.8, label="NOVA")
        nd = null_db(y[a:b], yb[a:b])
        ax.set_title(f"{nm}  null {nd:.1f}", fontsize=8)
        ax.grid(alpha=.3); ax.tick_params(labelsize=7)
    axs.flat[0].legend(fontsize=7)
    fig.tight_layout(); fig.savefig(png, dpi=70)
    print("null corpus total", round(null_db(y, yb), 2))
    for nm, a, b in segs:
        print(f"  {nm:14s} {null_db(y[a:b], yb[a:b]):6.1f}")


if __name__ == "__main__":
    lowprio()
    main(*sys.argv[1:])
