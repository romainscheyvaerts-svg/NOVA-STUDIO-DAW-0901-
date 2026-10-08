"""Tour 3 : où est l'écart ? Pour chaque vrai signal d'un groupe :
null brut du modèle, null après correction LTI, plafond « gain parfait »
(sortie du VST expliquée par x · g(t) lissé + FIR LTI) à plusieurs fenêtres,
et erreur de la trajectoire de gain (dB rms, fenêtres de 2,5 ms).
Usage : python -m tour3.diag <groupe> [roles=fit,val]"""
import os, sys
import numpy as np
from scipy.ndimage import uniform_filter1d
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour3 import lowprio  # noqa
from tour2.fitdyn import GROUPS, import_prof, load_real, MonoProc  # noqa
from tour2.common import banc_mod, null_db, lti_correct  # noqa
from modeles import analog_comp as ac  # noqa


def gain_trace(y, x, w):
    return uniform_filter1d(y * x, w) / np.maximum(uniform_filter1d(x * x, w), 1e-14)


def ceiling(y, x, w):
    g = gain_trace(y, x, w)
    yl, _ = lti_correct(y, x * g)
    return null_db(y, yl)


def gerr(y, yb, x, w=120):
    ga = gain_trace(y, x, w)
    gb = gain_trace(yb, x, w)
    e = uniform_filter1d(x * x, w)
    m = e > np.max(e) * 1e-4
    d = 20 * np.log10(np.maximum(np.abs(gb[m]), 1e-6) / np.maximum(np.abs(ga[m]), 1e-6))
    return float(np.sqrt(np.average(d ** 2, weights=e[m]))), float(np.average(d, weights=e[m]))


def main(group, roles):
    g = GROUPS[group]
    prof = import_prof(g["prof"])
    banc = banc_mod(g["banc"])
    fit = prof.load_fit()
    proc = MonoProc(prof.builder(fit, banc.to_nova))
    for r in load_real(group, roles):
        proc.configure(r["settings"])
        yb = proc.run(r["x"])[0]
        x = r["x"][0]
        y = r["y"]
        raw = null_db(y, yb)
        cor = null_db(y, lti_correct(y, yb)[0])
        ce = [ceiling(y, x, w) for w in (48, 120, 240)]
        ge = gerr(y, yb, x)
        print(f"{r['name']:14s} {r['sig']} brut {raw:6.1f} LTI {cor:6.1f} | plafond gain 1/2.5/5 ms {ce[0]:6.1f} {ce[1]:6.1f} {ce[2]:6.1f} | err gain rms {ge[0]:5.2f} dB moy {ge[1]:+5.2f}", flush=True)


if __name__ == "__main__":
    lowprio()
    roles = tuple(sys.argv[2].split(",")) if len(sys.argv) > 2 else ("fit", "val")
    main(sys.argv[1], roles)
