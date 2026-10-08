"""Trajectoire de gain VST vs modèle (dyn2 donné) sur un vrai signal (tour 3, y compris rendus tour3)."""
import os, sys, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour3 import fit3
from tour3.diag import gain_trace
from tour2.common import banc_mod
from tour2.fitdyn import set_d2
from scipy.ndimage import uniform_filter1d
g, case, sig, png, best = sys.argv[1:6]
t0, t1 = (float(sys.argv[6]), float(sys.argv[7])) if len(sys.argv) > 7 else (None, None)
G = fit3.GROUPS[g]; prof = fit3.import_prof(G["prof"]); banc = banc_mod(G["banc"])
fit = prof.load_fit(); set_d2(fit, G["key"], json.load(open(best))["d2"])
it = next(i for i in fit3.load_items(g, ("fit", "val")) if i["name"] == case and i["sig"] == sig)
yb = fit3.run_model(prof, banc, fit, it["settings"], it["x"]); x = it["x"]; y = it["y"]
w = 120
ga = 20 * np.log10(np.maximum(np.abs(gain_trace(y, x, w)), 1e-6)); gb = 20 * np.log10(np.maximum(np.abs(gain_trace(yb, x, w)), 1e-6))
lx = 10 * np.log10(np.maximum(uniform_filter1d(x * x, w), 1e-12)); m = lx > lx.max() - 45
ga[~m] = np.nan; gb[~m] = np.nan; t = np.arange(len(x)) / 48000
fig, ax = plt.subplots(3, 1, figsize=(16, 9), sharex=True)
ax[0].plot(t, ga, lw=.7, label="VST"); ax[0].plot(t, gb, lw=.7, label="NOVA"); ax[0].legend(); ax[0].grid(alpha=.3)
ax[1].plot(t, gb - ga, lw=.7, color="r"); ax[1].set_ylim(-3, 3); ax[1].grid(alpha=.3)
ax[2].plot(t, x, lw=.3, color="gray"); ax[2].grid(alpha=.3)
if t0 is not None: ax[2].set_xlim(t0, t1)
fig.tight_layout(); fig.savefig(png, dpi=75)
