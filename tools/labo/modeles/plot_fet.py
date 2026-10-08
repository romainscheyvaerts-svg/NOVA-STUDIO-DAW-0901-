import sys, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from modeles import fit_fet76 as F, fet76_profil as prof
import bench
fit = prof.load_fit()
pairs = [a.split(":") for a in sys.argv[2:]]
fig, axs = plt.subplots(len(pairs), 1, figsize=(12, 3 * len(pairs)))
for ax, (key, nm) in zip(np.atleast_1d(axs), pairs):
    settings, tl = F.step_tests(key, [nm])
    t, m = tl[0]
    proc = F.proc_for(fit); proc.configure(settings)
    g = np.array(bench.step_response(proc, t.get("freq", 1000), t["base_db"], t["step_db"], t["hold"], t["rel_obs"])["gr_curve_ms"])
    x = np.arange(len(m)) - 50
    ax.plot(x, m, "k", label="mesure"); ax.plot(x[:len(g)], g[:len(m)], "r--", label="modèle")
    ax.set_xscale("symlog", linthresh=10); ax.grid(alpha=.3); ax.set_title(f"{key} {nm}"); ax.legend()
plt.tight_layout(); plt.savefig(sys.argv[1], dpi=60)
