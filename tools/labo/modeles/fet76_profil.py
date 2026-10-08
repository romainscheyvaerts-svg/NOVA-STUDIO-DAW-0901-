"""
Profil « FET 76 » (modèle boîte noire de l'UADx 1176AE, mesuré au labo).

Chaîne : entrée (bouton ENTRÉE = gain mesuré, non linéaire) -> élément FET
(réduction de gain + H2 proportionnel à la réduction) -> préampli (saturation
H2/H3 dépendante du niveau interne) -> bouton SORTIE (gain mesuré) -> étage
de sortie (écrêtage doux) -> transformateur (bosse grave).
Détection : seuil fixe (l'entrée pousse dans le seuil), tables G(L) par
bouton de taux (le taux relève aussi le seuil, comme l'original).
Temps : cellule rapide (bouton ATTACK) en parallèle d'une cellule lente qui
se charge avec la durée de la compression (relâchement à deux temps mesuré :
après une crête brève, la réduction revient vite ; après une phrase longue,
au rythme du bouton RELEASE).
"""
import json
import math
import os

import numpy as np

from . import analog_comp as ac

SR = 48000.0
HERE = os.path.dirname(os.path.abspath(__file__))
FIT_FILE = os.path.join(HERE, "fet76_fit.json")
L0, DL, NL = -12.0, 1.0, 71
RATIOS = [2.0, 4.0, 8.0, 20.0, 24.0]          # 24 = « 4:1 + 20:1 » (écrasé)
RATIO_TEXT = {2.0: "2:1", 4.0: "4:1", 8.0: "8:1", 20.0: "20:1", 24.0: "4:1+20:1"}
KNOB17 = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0]

DEFAULT_FIT = {
    "in_knob": [-60.0, 0.0], "in_gain_db": [-30.0, 16.0],
    "out_knob": [-60.0, 0.0], "out_gain_db": [-36.0, 24.0],
    "t_ref_db": -29.6,
    "tables": None,
    "rect_half": 0, "det_rel_ms": 0.0,
    "out_a2": 0.0, "out_a3": 0.0, "out_sat": 0.0, "out_bias": 0.0,
    "final_sat": 0.0, "fet_a2": 0.0,
    "eq": [],
    # temps (cellule rapide = ATTACK ; cellule lente chargée par la durée)
    "att_knob": KNOB17, "att_ms": [2.0] * 13, "att_slew": [0.0] * 13, "slo_att_ms": 15.0, "slo_att_slew": 0.0,
    "rel_knob": KNOB17, "rel_ms": [700, 650, 600, 520, 450, 380, 300, 220, 160, 110, 70, 55, 45],
    "slow_att_ms": 300.0, "fast_det_rel_ms": 1.0,
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


def _interp_log(xs, ys, x):
    return float(np.exp(np.interp(x, xs, np.log(np.maximum(np.asarray(ys, float), 1e-9)))))


def nova_to_internal(p, fit):
    P = np.zeros(ac.NP)
    gin = float(np.interp(p.get("input", -24.0), fit["in_knob"], fit["in_gain_db"]))
    P[ac.P_PRE] = 10 ** (gin / 20.0)
    P[ac.P_THR] = 10 ** (fit["t_ref_db"] / 20.0)
    r = float(p.get("ratio", 4.0))
    if r < 1.0:   # aucun bouton de taux : pas de compression (amplificateur seul)
        tab = np.zeros(NL)
    else:
        j = int(np.argmin([abs(r - x) for x in RATIOS]))
        tab = np.asarray(fit["tables"][j], float)
    P[ac.P_RECT] = float(fit["rect_half"])
    P[ac.P_DET_REL] = ac.coef_from_ms(fit["det_rel_ms"]) if fit["det_rel_ms"] > 0 else 0.0
    # cellule principale : bouton ATTACK (montée), bouton RELEASE (pente de relâchement)
    rel = float(p.get("release", 4.0))
    if int(p.get("slo", 0)):
        fa = fit["slo_att_ms"]
    else:
        fa = _interp_log(fit["att_knob"], fit["att_ms"], float(p.get("attack", 4.0)))
    P[ac.P_ATT] = ac.coef_from_ms(fa)
    # relâchement exponentiel (constante de temps du bouton RELEASE, en ms)
    rms_ = _interp_log(fit["rel_knob"], fit["rel_ms"], rel)
    P[ac.P_REL_SLEW] = 0.0
    P[ac.P_REL_EXP] = ac.coef_from_ms(rms_)
    P[ac.P_HOLD] = -1.0
    # cellule lente en série : une part de la réduction arrive avec la durée de la compression
    P[ac.P_SLOW_FRAC] = fit.get("slow_frac", 0.0)
    P[ac.P_SLOW_ATT] = ac.coef_from_ms(fit.get("slow_att_ms", 300.0))
    P[ac.P_SLOW_REL] = ac.coef_from_ms(rms_ * fit.get("slow_rel_k", 1.0))
    P[ac.P_OUT_A2], P[ac.P_OUT_A3], P[ac.P_OUT_SAT], P[ac.P_OUT_BIAS] = fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"]
    P[ac.P_FET_A2] = fit["fet_a2"]
    P[ac.P_OUT_AB] = fit.get("out_ab", 0.0)
    gout = float(np.interp(p.get("output", -24.0), fit["out_knob"], fit["out_gain_db"]))
    P[ac.P_MAKEUP] = 10 ** (gout / 20.0)
    P[ac.P_FINAL_SAT] = fit["final_sat"]
    for q, (kind, fc, qq, gdb) in enumerate(fit.get("eq", [])[:ac.N_EQ]):
        P[ac.P_EQ + 5 * q:ac.P_EQ + 5 * q + 5] = ac.biquad(kind, fc, qq, gdb, SR)
    P[ac.P_MIX] = min(1.0, max(0.0, p.get("mix", 100.0) / 100.0))
    P[ac.P_LINK] = 0.0
    d2 = fit.get("dyn2")
    if d2:
        if int(p.get("slo", 0)):
            sa = d2.get("slo_scale", 1.0)
        else:
            sa = ac.interp_log(d2["att_knob"], d2["att_scale"], float(p.get("attack", 4.0))) if d2.get("att_scale") else 1.0
        sr = ac.interp_log(d2["rel_knob"], d2["rel_scale"], rel) if d2.get("rel_scale") else 1.0
        ac.apply_dyn2(P, d2, sa, sr, SR)
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
