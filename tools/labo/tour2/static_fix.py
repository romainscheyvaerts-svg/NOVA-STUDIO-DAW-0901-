"""
Tour 2 : correction des lois statiques APRÈS le calage de la dynamique (la
nouvelle cellule change le niveau d'équilibre sur un sinus). Itère : simule les
courbes statiques mesurées (cartographie), reporte l'écart dans les tables.
Usage : python -m tour2.static_fix <banc> [iters]
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402


def cl1b(iters=3):
    from bancs import cl1b as banc
    from modeles import cl1b_profil as prof
    from modeles.pyproc import ModelProc
    C = json.load(open(r"D:\1 WORK\CONTENU\nova-labo\tubetech_cl1b\mesures_carto.json", encoding="utf-8"))
    fit = prof.load_fit()
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    for it in range(iters):
        worst = 0.0
        # 1) tables par position du TAUX (seuil -25)
        thr25 = prof.knob_to_threshold_db(-25.0, fit)
        for j, r in enumerate(prof.RATIO_KNOB):
            key = f"c_ratio{r:g}"
            case = C[key]
            proc = ModelProc(prof.builder(fit, banc.to_nova))
            proc.configure(case["settings"])
            rows = case["tests"]["stat_1k"]["rows"]
            lv = [q["in_db"] for q in rows]
            sim = bench.tone_levels(proc, 1000, lv, dur=2.5)
            err = np.array([b["ch0"]["out_db"] - a["ch0"]["out_db"] for a, b in zip(rows, sim["rows"])])
            worst = max(worst, float(np.max(np.abs(err))))
            L = np.array(lv) - thr25
            tab = np.array(fit["tables"][j])
            corr = np.interp(Lg, L, err, left=0.0, right=err[-1])
            fit["tables"][j] = np.maximum(tab + corr * (Lg > L[0] - 2), 0).tolist()
        # 2) seuils : décalage qui aligne la courbe simulée sur la mesure (4:1)
        thr = list(fit["thr_1db"])
        for k, t in enumerate(prof.THR_KNOB):
            case = C.get(f"c_thr{int(t)}")
            if not case:
                continue
            rows = case["tests"]["stat_1k"]["rows"]
            proc = ModelProc(prof.builder(fit, banc.to_nova))
            proc.configure(case["settings"])
            lv = [q["in_db"] for q in rows]
            sim = bench.tone_levels(proc, 1000, lv, dur=2.5)
            gi = np.array([a["ch0"]["out_db"] - a["in_db"] for a in rows])
            gs = np.array([b["ch0"]["out_db"] - b["in_db"] for b in sim["rows"]])
            m = (gi[0] - gi) > 0.5      # zone qui comprime
            if m.sum() < 2:
                continue
            err = gs - gi
            worst = max(worst, float(np.max(np.abs(err[m]))))
            # pente locale de la réduction : ~ (1 - 1/taux) -> décalage de seuil équivalent
            sl = np.gradient(gi[0] - gi, np.array(lv))
            shift = float(np.median(err[m] / np.maximum(sl[m], 0.2)))
            thr[k] -= shift  # NOVA trop fort (err > 0 : comprime moins) -> seuil abaissé
        fit["thr_1db"] = thr
        prof.save_fit(fit)
        print("cl1b correction", it, "écart max avant", round(worst, 3), flush=True)


def generic(name, iters=3):
    import importlib
    mod = importlib.import_module(f"modeles.fit_{name}")
    fit = mod.prof.load_fit()
    mod.correct_tables(fit, iters)
    mod.prof.save_fit(fit)


if __name__ == "__main__":
    bn = sys.argv[1]
    it = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    if bn == "cl1b":
        cl1b(it)
    else:
        generic({"la2a": "la2a", "fet76": "fet76", "voxbox": "voxbox"}[bn], it)
