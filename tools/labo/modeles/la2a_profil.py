"""
Profil « Leveler 2A » (modèle boîte noire de l'UADx LA-2A Silver, mesuré au labo).

Chaîne : détecteur (sidechain filtré : bouton d'accentuation des aigus) ->
loi statique par position du bouton PEAK REDUCTION (Compress / Limit) ->
cellule optique (montée rapide, relâchement en deux temps : une part rapide
et une part lente qui se charge avec la durée — mémoire de programme)
-> bouton GAIN (gain mesuré) -> étage de sortie à lampes (H2, écrêtage doux)
-> couleur (léger relief dans l'aigu).
"""
import json
import os

import numpy as np

from . import analog_comp as ac

SR = 48000.0
HERE = os.path.dirname(os.path.abspath(__file__))
FIT_FILE = os.path.join(HERE, "la2a_fit.json")
L0, DL, NL = -12.0, 1.0, 71
PR_KNOB = [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0]
LIM_KNOB = [20.0, 40.0, 60.0, 80.0, 100.0]
EMPH_KNOB = [0.0, 10.0, 25.0, 40.0, 50.0, 75.0, 100.0]

DEFAULT_FIT = {
    "thr_pr": None, "tables_pr": None, "thr_lim": None, "tables_lim": None,
    "gain_knob": [0.0, 100.0], "gain_db": [-180.0, 37.7],
    "out_a2": 0.0, "out_a3": 0.0, "out_sat": 0.0, "out_bias": 0.0, "out_ab": 0.0,
    "eq": [],
    "rect_half": 0, "det_rel_ms": 0.0,
    "att_ms": 1.0, "rel_ms": 60.0, "slow_frac": 0.3, "slow_att_ms": 800.0, "slow_rel_ms": 1500.0,
    # filtre du détecteur par position d'accentuation : [g0, fc_hp, q_hp, fc_pk, q_pk, g_pk]
    "sc": [[0.0, 10.0, 0.7, 8000.0, 0.7, 0.0]] * 7,
}


def load_fit():
    fit = json.loads(json.dumps(DEFAULT_FIT))
    if os.path.exists(FIT_FILE):
        with open(FIT_FILE, encoding="utf-8") as f:
            fit.update(json.load(f))
    return fit


def save_fit(fit):
    with open(FIT_FILE, "w", encoding="utf-8") as f:
        json.dump(fit, f, indent=1)


def _table_for(x, knobs, thr, tables):
    """Seuil et table interpolés entre les positions mesurées du bouton."""
    k = np.asarray(knobs, float)
    th = float(np.interp(x, k, thr))
    T = np.asarray(tables, float)
    j = int(np.searchsorted(k, x))
    if j <= 0:
        return th, T[0]
    if j >= len(k):
        return th, T[-1]
    t = (x - k[j - 1]) / (k[j] - k[j - 1])
    return th, T[j - 1] * (1 - t) + T[j] * t


def sc_params(e, fit):
    S = np.asarray(fit["sc"], float)
    return [float(np.interp(e, EMPH_KNOB, S[:, i])) for i in range(S.shape[1])]


def nova_to_internal(p, fit):
    P = np.zeros(ac.NP)
    P[ac.P_PRE] = 1.0
    pr = float(p.get("peakReduction", 50.0))
    if int(p.get("limit", 0)):
        thr, tab = _table_for(max(pr, LIM_KNOB[0]), LIM_KNOB, fit["thr_lim"], fit["tables_lim"])
        if pr < LIM_KNOB[0]:   # sous 20 : seuil prolongé comme en Compress
            thr = float(np.interp(pr, PR_KNOB, fit["thr_pr"])) + (fit["thr_lim"][0] - float(np.interp(20, PR_KNOB, fit["thr_pr"])))
    else:
        thr, tab = _table_for(pr, PR_KNOB, fit["thr_pr"], fit["tables_pr"])
    g0, fh, qh, fp, qp, gp = sc_params(float(p.get("emphasis", 0.0)), fit)
    P[ac.P_THR] = 10 ** ((thr - g0) / 20.0)
    P[ac.P_HP_B0:ac.P_HP_A2 + 1] = ac.biquad("hp", fh, qh, 0.0, SR)
    P[ac.P_SC2:ac.P_SC2 + 5] = ac.biquad("peak", fp, qp, gp, SR)
    P[ac.P_RECT] = float(fit["rect_half"])
    P[ac.P_DET_REL] = ac.coef_from_ms(fit["det_rel_ms"]) if fit["det_rel_ms"] > 0 else 0.0
    P[ac.P_ATT] = ac.coef_from_ms(fit["att_ms"])
    P[ac.P_ATT2] = P[ac.P_ATT]          # cellule optique : deux étages (montée en S)
    P[ac.P_REL_EXP] = ac.coef_from_ms(fit["rel_ms"])
    P[ac.P_HOLD] = -1.0
    P[ac.P_SLOW_FRAC] = fit["slow_frac"]
    P[ac.P_SLOW_ATT] = ac.coef_from_ms(fit["slow_att_ms"])
    P[ac.P_SLOW_REL] = ac.coef_from_ms(fit["slow_rel_ms"])
    g = float(np.interp(p.get("gain", 50.0), fit["gain_knob"], fit["gain_db"]))
    P[ac.P_DRIVE] = 10 ** (g / 20.0)
    P[ac.P_MAKEUP] = 1.0
    P[ac.P_OUT_A2], P[ac.P_OUT_A3], P[ac.P_OUT_SAT], P[ac.P_OUT_BIAS] = fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"]
    P[ac.P_OUT_AB] = fit.get("out_ab", 0.0)
    P[ac.P_OUT_KNEE] = fit.get("out_knee", 0.0)
    for q, (kind, fc, qq, gdb) in enumerate(fit.get("eq", [])[:ac.N_EQ]):
        P[ac.P_EQ + 5 * q:ac.P_EQ + 5 * q + 5] = ac.biquad(kind, fc, qq, gdb, SR)
    P[ac.P_MIX] = min(1.0, max(0.0, p.get("mix", 100.0) / 100.0))
    P[ac.P_LINK] = 0.0
    d2 = fit.get("dyn2_lim") if (int(p.get("limit", 0)) and fit.get("dyn2_lim")) else fit.get("dyn2")
    if d2:
        ac.apply_dyn2(P, d2, 1.0, 1.0, SR)
        if d2.get("fb"):
            P[ac.P_FB] = 1.0
            tab = ac.ff_to_fb(tab, L0, DL)
    ac.apply_lti(P, fit.get("lti"), SR, fit.get("lat", 0))
    ac.apply_ws(P, fit.get("ws"))
    return P, L0, DL, np.ascontiguousarray(tab)


def builder(fit=None, to_nova=None):
    f = fit or load_fit()

    def build(settings):
        q = to_nova(settings) if to_nova else settings
        return nova_to_internal(q, f)
    return build
