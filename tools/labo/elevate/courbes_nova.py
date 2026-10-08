"""Rejoue les mesures synthétiques sur l'effet NOVA (cœur TypeScript via Node) et trace
original / NOVA superposés. Écrit mesures_<groupe>_nova.json, graphiques/comparaison_*.png et
un résumé des écarts (ecarts_synthetiques.json).
Usage : python elevate/courbes_nova.py"""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nova  # noqa: E402
from mesure import burst_signal, gain_curve, SR  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
G = os.path.join(OUT, "graphiques")
os.makedirs(G, exist_ok=True)


def curve(m, prm, freq=1000.0, level=-20, on_ms=300, off_ms=500, base_db=None, ramp=0):
    x, st = burst_signal(freq, level, on_ms, off_ms, base_db=base_db)
    if ramp:
        for s0 in st:
            nr = int(ramp / 1000 * SR)
            x[:, s0:s0 + nr] *= np.linspace(0, 1, nr)
    post = on_ms + min(off_ms, 300) if base_db is None and not ramp else 600
    return gain_curve(x, m.run(x, prm), freq, st, post_ms=post)


def main():
    m = nova.MasterTransient()
    C = json.load(open(os.path.join(OUT, "mesures_carto.json"), encoding="utf-8"))
    B = json.load(open(os.path.join(OUT, "mesures_bandes.json"), encoding="utf-8"))
    D = json.load(open(os.path.join(OUT, "mesures_durees.json"), encoding="utf-8"))
    groups = {
        "emphase": [(f"em{e}", C[f"em{e}"]["1000.0"], curve(m, nova.transient_params(e))) for e in (27, 50, 80, 100)],
        "pas": [(f"pas100_{d}", C[f"pas100_{d}"]["1000.0"], curve(m, nova.transient_params(100), base_db=-20 - d)) for d in (1, 3, 10)],
        "silences": [(f"gap100_{g}", C[f"gap100_{g}"]["1000.0"], curve(m, nova.transient_params(100), off_ms=g)) for g in (20, 80, 320)],
        "rampes": [(f"rampe100_{r}", C[f"rampe100_{r}"]["1000.0"], curve(m, nova.transient_params(100), ramp=r)) for r in (5, 20, 60)],
        "durees": [(f"on{o}", D[f"on{o}"]["1000.0"], curve(m, nova.transient_params(100), on_ms=o, off_ms=max(400, o))) for o in (5, 20, 60)],
        "adaptatif": [(f"ad100_{a}", C[f"ad100_{a}"]["1000.0"], curve(m, nova.transient_params(100, a))) for a in (0, 50, 100)],
        "courbe_romain": [(f"romain {f:g} Hz", B["romain_courbe"][str(f)], curve(m, nova.transient_params(100, 0, __import__('bancs.elevate', fromlist=['x']).romain_band_transient()), freq=f))
                          for f in (60.0, 150.0, 1000.0, 12000.0)],
        "dosage": [(f"b8_{v}", B[f"b8_{v}"]["1106.93"], curve(m, nova.transient_params(100, 0, [100.0] * 7 + [float(v)] + [100.0] * 18), freq=1106.93)) for v in (0, 50, 200)],
    }
    m.close()
    summary = {}
    fig, axs = plt.subplots(4, 2, figsize=(16, 18))
    for ax, (gname, rows) in zip(axs.flat, groups.items()):
        errs = []
        for label, mv, nv in rows:
            a, b = np.array(mv), np.array(nv)
            n = min(len(a), len(b))
            t = np.arange(n) * 0.5 - 20
            sel = (t > -10) & (t < 150) & (a[:n] > -100) & (b[:n] > -100)
            e = b[:n][sel] - a[sel]
            pk_a, pk_b = float(np.max(a[:n][(t > -10) & (t < 60)])), float(np.max(b[:n][(t > -10) & (t < 60)]))
            errs.append({"cas": label, "ecart_rms_db": float(np.sqrt(np.mean(e ** 2))), "pic_original_db": pk_a, "pic_nova_db": pk_b})
            line, = ax.plot(t, np.where(a[:n] > -100, a[:n], np.nan), lw=1.4, label=f"{label} original")
            ax.plot(t, np.where(b[:n] > -100, b[:n], np.nan), "--", lw=1.2, color=line.get_color(), label=f"{label} NOVA")
        summary[gname] = errs
        ax.set_xlim(-15, 160)
        ax.set_ylim(-2, 20)
        ax.grid(alpha=.3)
        ax.legend(fontsize=7, ncol=2)
        ax.set_title(gname + " (gain en dB après l'attaque, ms)")
    plt.tight_layout()
    plt.savefig(os.path.join(G, "comparaison_transitoires.png"), dpi=55)
    json.dump(summary, open(os.path.join(OUT, "ecarts_synthetiques.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for g, rows in summary.items():
        print(g, [(r["cas"], round(r["ecart_rms_db"], 2), round(r["pic_original_db"], 2), round(r["pic_nova_db"], 2)) for r in rows])


if __name__ == "__main__":
    main()
