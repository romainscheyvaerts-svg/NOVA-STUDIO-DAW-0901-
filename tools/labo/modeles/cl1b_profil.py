"""
Profil « Opto Vintage » (modèle boîte noire du Tube-Tech CL 1B mk II, Softube).

Tables mesurées au labo (cartographie des boutons, 08/10/2026) :
  - SEUIL : position du bouton -> niveau d'entrée (dBFS crête, sinus 1 kHz) où
    la réduction atteint 1 dB au taux 4:1 (définition du constructeur) ;
  - TAUX  : courbes de réduction G(L) pour 11 positions du bouton (2:1 à 10:1),
    L = niveau au-dessus du seuil ; saturation de la cellule vers ~31 dB ;
  - TEMPS : coefficients d'attaque / relâchement par position (calés par
    moindres carrés sur les sauts de niveau, voir fit_cl1b.py).
Ce fichier est la SOURCE des tables recopiées dans engine/optoVintageProfile.ts.
"""
import json
import math
import os

import numpy as np

from . import analog_comp as ac

SR = 48000.0
HERE = os.path.dirname(os.path.abspath(__file__))
FIT_FILE = os.path.join(HERE, "cl1b_fit.json")

THR_KNOB = [2.0, 0.0, -5.0, -10.0, -15.0, -20.0, -25.0, -30.0, -35.0, -40.0, -41.0]
RATIO_KNOB = [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
L0, DL, NL = -12.0, 1.0, 71  # L de -12 à +58 dB
ATT_KNOB = [0.0, 1.0, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 8.0, 9.0, 10.0]
OUT_KNOB = [-30.0, -20.0, -10.0, -5.0, 0.0, 3.0, 6.0, 10.0, 15.0, 20.0, 25.0, 30.0]
OUT_DB = [-17.94, -14.35, -9.77, -4.07, 0.0, 3.35, 6.48, 12.15, 16.95, 20.93, 25.63, 27.87]

DEFAULT_FIT = {
    "thr_1db": None,              # rempli par fit_cl1b.build_static
    "tables": None,               # [len(RATIO_KNOB)][NL]
    "det_att_ms": 0.0,
    "det_rel_ms": 0.0,
    "rect_half": 1,
    "att_ms": [0.2, 0.3, 0.4, 0.6, 2.0, 7.0, 15.0, 30.0, 60.0, 90.0, 120.0],    # détecteur : montée, par position 0..10
    "cell_att_ms": 0.3,           # cellule : montée (domaine A)
    "cell_att_slew": 80.0,        # A/s : vitesse max de montée de la cellule
    "rel_slew": [230.0, 120.0, 70.0, 40.0, 20.0, 9.0, 5.5, 3.0, 2.0, 1.4, 1.1],  # A/s
    "rel_exp_ms": [0.0] * 11,     # 0 = pas de part exponentielle
    "fix_att_ms": 0.3,
    "fix_rel_slew": 2000.0,
    "fm_delay_ms": [0.5, 1, 2, 4, 8, 16, 30, 60, 100, 180, 300],
}


def load_fit():
    fit = dict(DEFAULT_FIT)
    if os.path.exists(FIT_FILE):
        with open(FIT_FILE, encoding="utf-8") as f:
            fit.update(json.load(f))
    return fit


def _interp_knob(knobs, values, k):
    """Interpolation linéaire par position de bouton (valeurs en log si positives)."""
    return float(np.interp(k, knobs, values))


def _interp_log(knobs, values, k):
    v = np.log(np.maximum(np.asarray(values, float), 1e-9))
    return float(np.exp(np.interp(k, knobs, v)))


def nova_to_internal(p, fit):
    """Paramètres NOVA (positions de boutons) -> vecteur P du cœur + table."""
    P = np.zeros(ac.NP)
    P[ac.P_PRE] = 1.0
    # Seuil NOVA = niveau (dBFS crête, sinus) où la réduction atteint 1 dB au taux 4:1
    thr = p.get("threshold", -30.0)
    P[ac.P_THR] = 10 ** (thr / 20.0)
    ratio = min(10.0, max(2.0, p.get("ratio", 4.0)))
    tabs = np.asarray(fit["tables"], float)
    j = np.searchsorted(RATIO_KNOB, ratio)
    if j <= 0:
        tab = tabs[0]
    elif j >= len(RATIO_KNOB):
        tab = tabs[-1]
    else:
        t = (ratio - RATIO_KNOB[j - 1]) / (RATIO_KNOB[j] - RATIO_KNOB[j - 1])
        tab = tabs[j - 1] * (1 - t) + tabs[j] * t
    P[ac.P_FB] = 0.0
    P[ac.P_RECT] = float(fit["rect_half"])
    P[ac.P_DET_REL] = ac.coef_from_ms(fit["det_rel_ms"]) if fit["det_rel_ms"] > 0 else 0.0
    if int(p.get("mode", 2)) != 2:
        P[ac.P_DET_ATT] = 0.0
    if int(p.get("mode", 2)) == 0 and fit.get("fix_det_rel_ms"):
        P[ac.P_DET_REL] = ac.coef_from_ms(fit["fix_det_rel_ms"])
    knob = [float(i) for i in range(11)]
    aknob = fit.get("att_knob", knob)
    att, rel = p.get("attack", 5.0), p.get("release", 5.0)
    mode = int(p.get("mode", 2))  # 0 Fix, 1 F/M, 2 Man
    rel_slew = _interp_log(knob, fit["rel_slew"], rel)
    rel_exp = _interp_knob(knob, fit["rel_exp_ms"], rel)
    if mode == 2:
        ams = _interp_log(aknob, fit["att_ms"], att)
        ca = ac.coef_from_ms(ams)
        kd = fit.get("det_att_k", 0.0)
        P[ac.P_DET_ATT] = ac.coef_from_ms(ams * kd) if kd > 0 else 0.0
        P[ac.P_ATT] = ca
        P[ac.P_ATT2] = ca
        asl = _interp_log(aknob, fit["att_slew_k"], att) if "att_slew_k" in fit else fit["cell_att_slew"]
        P[ac.P_ATT_SLEW] = asl / SR if asl > 0 else 0.0
        P[ac.P_REL_SLEW] = rel_slew / SR
        P[ac.P_REL_EXP] = ac.coef_from_ms(rel_exp) if rel_exp > 0 else 0.0
        P[ac.P_HOLD] = -1.0
    elif mode == 0:
        P[ac.P_ATT] = ac.coef_from_ms(fit["fix_att_ms"])
        P[ac.P_ATT2] = P[ac.P_ATT]
        P[ac.P_REL_SLEW] = fit["fix_rel_slew"] / SR
        P[ac.P_HOLD] = -1.0
    else:
        # FIX./MAN. : cellule lente (bouton ATTACK = temps de charge, RELEASE manuel)
        # en parallèle d'une cellule rapide fixe ; la réduction suit la plus forte.
        fk = fit.get("fm_knob", knob)
        ca = ac.coef_from_ms(_interp_log(fk, fit.get("fm_att_ms", [1.0] * len(fk)), att))
        P[ac.P_ATT] = ca
        P[ac.P_ATT2] = 0.0
        P[ac.P_ATT_SLEW] = 0.0
        P[ac.P_DET_REL] = ac.coef_from_ms(fit.get("fast_det_rel_ms", 2.0))
        P[ac.P_REL_SLEW] = rel_slew / SR
        P[ac.P_HOLD] = -1.0
        P[ac.P_FAST_ATT] = ac.coef_from_ms(fit.get("fast_att_ms", 0.5))
        P[ac.P_FAST_REL] = fit.get("fast_rel_slew", 3000.0) / SR
        P[ac.P_FAST_DET_REL] = ac.coef_from_ms(fit.get("fast_det_rel_ms", 2.0))
    P[ac.P_REL2_FOLLOW] = ac.coef_from_ms(fit.get("cell_rel_follow_ms", 0.5))
    out = p.get("output", 0.0)   # gain réel en dB
    P[ac.P_MAKEUP] = 10 ** (out / 20.0)
    if int(p.get("vintage", 0)) and fit.get("vintage_eq"):
        P[ac.P_MAKEUP] *= 10 ** (fit.get("vintage_gain_db", 0.0) / 20.0)
        for q, (kind, fc, qq, gdb) in enumerate(fit["vintage_eq"][:ac.N_EQ]):
            P[ac.P_EQ + 5 * q:ac.P_EQ + 5 * q + 5] = ac.biquad(kind, fc, qq, gdb, SR)
    P[ac.P_MIX] = min(1.0, max(0.0, p.get("mix", 100.0) / 100.0))
    sc = p.get("scLowCut", 0)
    scf = fit.get("sc_filters", {}).get(str(int(sc))) if sc else None
    hp = ac.hpf_coefs(scf[0], SR, scf[1]) if scf else (ac.hpf_coefs(sc, SR, 0.7071) if sc else [0.0] * 5)
    P[ac.P_HP_B0:ac.P_HP_A2 + 1] = hp
    P[ac.P_LINK] = 0.0
    d2 = (fit.get("dyn2") or {}).get({0: "fix", 1: "fm", 2: "man"}[mode])
    if d2:
        sa = ac.interp_log(d2["att_knob"], d2["att_scale"], att) if d2.get("att_scale") else 1.0
        sr = ac.interp_log(d2["rel_knob"], d2["rel_scale"], rel) if d2.get("rel_scale") else 1.0
        ac.apply_dyn2(P, d2, sa, sr, SR)
        if d2.get("fb"):
            P[ac.P_FB] = 1.0
            tab = ac.ff_to_fb(tab, L0, DL)
    ac.apply_lti(P, fit.get("lti"), SR, fit.get("lat", 0))
    ac.apply_ws(P, fit.get("ws"))
    return P, L0, DL, np.ascontiguousarray(tab)


def knob_to_threshold_db(knob, fit=None):
    """Bouton « Threshold » du plugin d'origine -> seuil NOVA (dBFS)."""
    f = fit or load_fit()
    if str(knob) == "Off":
        return 40.0
    k = float(knob)
    knobs = THR_KNOB[::-1]
    vals = list(f["thr_1db"])[::-1]
    if k > THR_KNOB[0]:
        return vals[-1] + (k - THR_KNOB[0]) * 1.35
    return float(np.interp(k, knobs, vals))


def knob_to_output_db(knob):
    return float(np.interp(float(knob), OUT_KNOB, OUT_DB))


def builder(fit=None, to_nova=None):
    f = fit or load_fit()

    def build(settings):
        p = to_nova(settings) if to_nova else settings
        return nova_to_internal(p, f)
    return build


def save_fit(fit):
    with open(FIT_FILE, "w", encoding="utf-8") as f:
        json.dump(fit, f, indent=1)
