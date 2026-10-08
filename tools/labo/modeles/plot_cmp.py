"""Superpose les courbes de réduction (mesure / modèle) pour un jeu de cas carto."""
import sys, json, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from modeles import fit_cl1b as F
from modeles import cl1b_profil as prof

def main(cases, out):
    fit = prof.load_fit()
    proc = F.proc_for(fit)
    fig, axs = plt.subplots(len(cases), 1, figsize=(12, 3.2 * len(cases)))
    axs = np.atleast_1d(axs)
    names = [c["name"] for c in F.banc.CARTO]
    for ax, (cname, tname) in zip(axs, cases):
        src = F.C if cname in names else F.M
        case = src[cname]
        tl = (F.banc.CARTO if cname in names else F.banc.CASES)
        tdef = [t for t in tl[[c["name"] for c in tl].index(cname)]["tests"] if (t.get("name") or t["type"]) == tname][0]
        meas = np.array(case["tests"][tname]["gr_curve_ms"])
        g = F.gr_curve(proc, case["settings"], tdef)
        t = np.arange(len(meas)) - 50
        ax.plot(t, meas, "k", label="mesure")
        ax.plot(t[:len(g)], g[:len(meas)], "r--", label="modèle")
        ax.set_xscale("symlog", linthresh=10); ax.grid(alpha=.3); ax.set_title(f"{cname} {tname}"); ax.legend()
    plt.tight_layout(); plt.savefig(out, dpi=65)

if __name__ == "__main__":
    pairs = [tuple(a.split(":")) for a in sys.argv[2:]]
    main(pairs, sys.argv[1])
