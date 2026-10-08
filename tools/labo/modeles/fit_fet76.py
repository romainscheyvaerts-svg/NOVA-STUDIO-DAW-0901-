"""Calage du profil FET 76 sur les mesures de l'UADx 1176AE.
Usage : python -m modeles.fit_fet76 gains shaper eq tables attack release"""
import json
import math
import os
import sys

import numpy as np
from scipy import signal as sps
from scipy.optimize import least_squares, minimize, minimize_scalar

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402
from bancs import fet76 as banc  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402
from modeles import fet76_profil as prof  # noqa: E402
from modeles.pyproc import ModelProc  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo\ua_1176"
M = json.load(open(os.path.join(LABO, "mesures.json"), encoding="utf-8"))
C = json.load(open(os.path.join(LABO, "mesures_carto.json"), encoding="utf-8"))
NAMES = [c["name"] for c in banc.CARTO]


def proc_for(fit):
    return ModelProc(prof.builder(fit, banc.to_nova), "FET76-py")


def fit_gains(fit):
    ik = list(range(-60, 1, 3))
    fit["in_knob"] = [float(i) for i in ik]
    fit["in_gain_db"] = [C[f"c_in{i}"]["tests"]["g"]["rows"][0]["ch0"]["out_db"] + 60 for i in ik]
    g24 = C["c_out-24"]["tests"]["g"]["rows"][0]["ch0"]["out_db"] + 60
    fit["out_knob"] = [float(o) for o in ik]
    fit["out_gain_db"] = [C[f"c_out{o}"]["tests"]["g"]["rows"][0]["ch0"]["out_db"] + 60 - g24 for o in ik]
    # référence : l'entrée -24 à 1 dB de réduction (4:1) -> seuil interne
    s = M["stat_r4:1_in-24"]["tests"]["stat_1k"]["static"]
    i, g = np.array(s["in_db"]), np.array(s["gr_db"])
    k = int(np.argmax(g > 1.0))
    on = float(i[k - 1] + (1 - g[k - 1]) / (g[k] - g[k - 1]) * (i[k] - i[k - 1]))
    gin24 = float(np.interp(-24.0, fit["in_knob"], fit["in_gain_db"]))
    fit["t_ref_db"] = on + gin24
    print("gains ok, seuil interne", round(fit["t_ref_db"], 2))


def lin_rows():
    out = []
    for nm in ["thd_1k", "thd_100"]:
        for r in M["lineaire"]["tests"][nm]["rows"]:
            out.append((nm, r))
    return out


def fit_shaper(fit):
    case = M["lineaire"]
    tests = {"thd_1k": (1000, [r["in_db"] for r in case["tests"]["thd_1k"]["rows"]]),
             "thd_100": (100, [r["in_db"] for r in case["tests"]["thd_100"]["rows"]])}

    def res(x):
        fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"], fit["out_ab"] = float(x[0]), float(x[1]), float(np.exp(x[2])), float(x[3]), float(x[4])
        proc = proc_for(fit)
        proc.configure(case["settings"])
        out = []
        for nm, (f, lv) in tests.items():
            r = bench.tone_levels(proc, f, lv, dur=0.4)
            for a, b in zip(case["tests"][nm]["rows"], r["rows"]):
                out.append((b["ch0"]["out_db"] - a["ch0"]["out_db"]) * 2)
                for h in range(4):  # H2..H5
                    ha, hb = a["ch0"]["harm_rel_db"][h], b["ch0"]["harm_rel_db"][h]
                    if ha > -100:
                        out.append((max(hb, -120) - ha) * 0.5)
        return np.array(out)
    x0 = [0.21, 0.0, np.log(2.0), 0.0, -0.23]
    r = least_squares(res, x0, diff_step=0.02, max_nfev=300, bounds=([-1, -1, -3, -1, -1.5], [1, 1, 3, 1, 0]))
    res(r.x)
    print("shaper", [round(v, 5) for v in (fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"])],
          "rms", round(float(np.sqrt(np.mean(r.fun ** 2))), 3), flush=True)


def fit_eq(fit):
    v = M["lineaire"]["tests"]["fr_-30"]
    f = np.array(v["freqs"])
    m = np.array(v["channels"][0]["mag_db"])
    sel = (f >= 20) & (f <= 18000)
    gin = float(np.interp(-24.0, fit["in_knob"], fit["in_gain_db"]))
    base = gin  # gain total déjà dans P_PRE (et sortie -24 = 0 dB)

    def resp(x):
        h = np.ones(sel.sum(), complex)
        for kind, fc, q, gd in (("peak", x[0], x[1], x[2]), ("hp", x[3], x[4], 0.0)):
            b = ac.biquad(kind, fc, q, gd)
            _, hh = sps.freqz([b[0], b[1], b[2]], [1, b[3], b[4]], worN=f[sel], fs=48000)
            h *= hh
        return 20 * np.log10(np.abs(h)) + base
    r = least_squares(lambda x: resp(x) - m[sel], [50, 0.7, 0.3, 10, 0.7],
                      bounds=([20, 0.2, -3, 2, 0.3], [400, 4, 3, 30, 2]))
    x = r.x
    fit["eq"] = [["peak", float(x[0]), float(x[1]), float(x[2])], ["hp", float(x[3]), float(x[4]), 0.0]]
    print("eq", np.round(x, 3), "max", round(float(np.max(np.abs(r.fun))), 3), flush=True)


def fit_tables(fit):
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    gin24 = float(np.interp(-24.0, fit["in_knob"], fit["in_gain_db"]))
    tabs = []
    for r in ["2:1", "4:1", "8:1", "20:1", "4:1+20:1"]:
        s = C[f"c_ratio{r}"]["tests"]["stat_1k"]["static"]
        L = np.array(s["in_db"]) + gin24 - fit["t_ref_db"]
        G = np.array(s["gr_db"])
        # la saturation du préampli fait déjà baisser le gain à fort niveau :
        # on la retire (mesurée sans compression) pour garder la seule réduction.
        lin = M["lineaire"]["tests"]["thd_1k"]["rows"]
        li = np.array([q["in_db"] for q in lin])
        lg = np.array([q["ch0"]["out_db"] - q["in_db"] for q in lin])
        sat_loss = lg[0] - np.interp(np.array(s["in_db"]) - G, li, lg)
        G = np.maximum(G - np.maximum(sat_loss, 0), 0)
        tab = np.interp(Lg, L, G)
        hi = Lg > L[-1]
        if hi.any():
            sl = (G[-1] - G[-3]) / (L[-1] - L[-3])
            tab[hi] = G[-1] + sl * (Lg[hi] - L[-1])
        tab[Lg < L[0]] = 0.0
        tabs.append(np.maximum(tab, 0).tolist())
    fit["tables"] = tabs
    print("tables ok", flush=True)


def correct_tables(fit, iters=3):
    """Corrige les tables pour que la courbe statique SIMULÉE colle à la mesure."""
    gin24 = float(np.interp(-24.0, fit["in_knob"], fit["in_gain_db"]))
    Lg = prof.L0 + prof.DL * np.arange(prof.NL)
    for it in range(iters):
        worst = 0
        for j, r in enumerate(["2:1", "4:1", "8:1", "20:1", "4:1+20:1"]):
            case = C[f"c_ratio{r}"]
            proc = proc_for(fit)
            proc.configure(case["settings"])
            lv = [q["in_db"] for q in case["tests"]["stat_1k"]["rows"]]
            sim = bench.tone_levels(proc, 1000, lv, dur=1.5)
            err = np.array([b["ch0"]["out_db"] - a["ch0"]["out_db"] for a, b in zip(case["tests"]["stat_1k"]["rows"], sim["rows"])])
            worst = max(worst, float(np.max(np.abs(err))))
            L = np.array(lv) + gin24 - fit["t_ref_db"]
            tab = np.array(fit["tables"][j])
            corr = np.interp(Lg, L, err, left=0.0, right=err[-1])
            tab = np.maximum(tab + corr * (Lg > L[0] - 2), 0)
            fit["tables"][j] = tab.tolist()
        print("correction", it, "écart max avant", round(worst, 3), flush=True)


def step_tests(key, names):
    case = C[key]
    tdefs = {t["name"]: t for t in banc.CARTO[NAMES.index(key)]["tests"]}
    return case["settings"], [(tdefs[n], np.array(case["tests"][n]["gr_curve_ms"])) for n in names]


def residual(fit, settings, tl, w_att=1.0, w_rel=1.0):
    proc = proc_for(fit)
    proc.configure(settings)
    out = []
    for t, m in tl:
        g = np.array(bench.step_response(proc, t.get("freq", 1000), t["base_db"], t["step_db"], t["hold"], t["rel_obs"])["gr_curve_ms"])
        n = min(len(g), len(m))
        h = int(t["hold"] * 1000)
        w = np.zeros(n)
        w[45:50 + h] = w_att
        w[48:80] *= 4.0   # les premières millisecondes (attaque) comptent plus
        w[50 + h + 3:] = w_rel
        out.append((g[:n] - m[:n]) * w)
    return np.concatenate(out)


def fit_global(fit):
    """Part lente (ρ, charge) et relâchement de référence : sur release 4."""
    settings, tl = step_tests("c_rel4.0", ["s30", "s20", "s30h01"])

    def cost(x):
        fit["slow_frac"], fit["slow_att_ms"], fit["slow_rel_k"] = float(1 / (1 + np.exp(-x[0]))), float(np.exp(x[1])), float(np.exp(x[2]))
        return float(np.mean(residual(fit, settings, tl) ** 2))
    x0 = [np.log(0.2 / 0.8), np.log(300.0), np.log(1.0)]
    r = minimize(cost, x0, method="Nelder-Mead", options={"maxfev": 90, "initial_simplex": [x0, [x0[0] + 1, x0[1], x0[2]], [x0[0], x0[1] + 0.7, x0[2]], [x0[0], x0[1], x0[2] + 0.7]]})
    cost(r.x)
    print("global", round(fit["slow_frac"], 3), round(fit["slow_att_ms"], 1), round(fit["slow_rel_k"], 3), "rms", round(math.sqrt(r.fun), 3), flush=True)


def fit_attack(fit):
    for j, a in enumerate(["SLO"] + prof.KNOB17):
        key = f"c_att{a}"
        settings, tl = step_tests(key, ["s30", "s20"])

        def cost(v):
            if a == "SLO":
                fit["slo_att_ms"] = float(np.exp(v))
            else:
                fit["att_ms"][j - 1] = float(np.exp(v))
            return float(np.mean(residual(fit, settings, tl, 1.0, 0.0) ** 2))
        r = minimize_scalar(cost, bounds=(np.log(0.005), np.log(200)), method="bounded", options={"xatol": 0.02})
        cost(r.x)
        print(f"att {a}: {fit['slo_att_ms'] if a == 'SLO' else fit['att_ms'][j - 1]:.3f} ms rms {math.sqrt(r.fun):.3f}", flush=True)


def fit_release(fit):
    for j, rl in enumerate(prof.KNOB17):
        settings, tl = step_tests(f"c_rel{rl}", ["s30", "s20", "s30h01"])

        def cost(v):
            fit["rel_ms"][j] = float(np.exp(v))
            return float(np.mean(residual(fit, settings, tl, 0.3, 1.0) ** 2))
        r = minimize_scalar(cost, bounds=(np.log(5), np.log(5000)), method="bounded", options={"xatol": 0.02})
        cost(r.x)
        print(f"rel {rl}: tau {fit['rel_ms'][j]:.1f} ms rms {math.sqrt(r.fun):.3f}", flush=True)


if __name__ == "__main__":
    fit = prof.load_fit()
    steps = {"gains": fit_gains, "shaper": fit_shaper, "eq": fit_eq, "tables": fit_tables, "correct": correct_tables,
             "global": fit_global, "attack": fit_attack, "release": fit_release}
    for st in sys.argv[1:]:
        steps[st](fit)
        prof.save_fit(fit)
