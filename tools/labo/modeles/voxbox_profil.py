"""
Profil « Vox Strip » (modèle boîte noire de l'UADx Manley VOXBOX, mesuré au labo).

Chaîne (comme l'original : compresseur optique passif AVANT le préampli) :
bouton ENTRÉE (gain mesuré) -> coupe-bas (6 dB/oct) -> compresseur optique
(tables par position du seuil, temps par couple attaque / relâchement, part
lente) -> préampli à lampes (H2) -> égaliseur passif (grave, creux médium,
aigu : formes mesurées par fréquence et par gain) -> transformateur de sortie
(saturation du fer dans le grave, H3) -> sortie.
Le de-esser / limiteur de l'original n'est pas modélisé (NOVA a son de-esser).
"""
import json
import os

import numpy as np

from . import analog_comp as ac

SR = 48000.0
HERE = os.path.dirname(os.path.abspath(__file__))
FIT_FILE = os.path.join(HERE, "voxbox_fit.json")
L0, DL, NL = -12.0, 1.0, 71
TH_KNOB = [float(t) for t in range(11)]
ATT_POS = ["Fast", "Med Fast", "Medium", "Med Slow", "Slow"]
REL_POS = ["Fast", "Med Fast", "Medium", "Med Slow", "Slow"]
LO_F = [20.0, 35.0, 50.0, 70.0, 100.0, 150.0, 200.0, 300.0, 500.0, 700.0, 1000.0]
MID_F = [200.0, 300.0, 500.0, 700.0, 1000.0, 1500.0, 2000.0, 3000.0, 4000.0, 5000.0, 7000.0]
HI_F = [1500.0, 2000.0, 3000.0, 4000.0, 5000.0, 6400.0, 8000.0, 10000.0, 12000.0, 16000.0, 20000.0]

DEFAULT_NOVA = {"input": 5.0, "compOn": 1, "compThresh": 6.0, "attack": 2, "release": 2, "eqOn": 0,
                "loPeak": 0.0, "loFreq": 3, "midDip": 0.0, "midFreq": 1, "hiPeak": 0.0, "hiFreq": 8,
                "lowCut": 0, "transformer": 1, "output": 0.0, "mix": 100}

DEFAULT_FIT = {
    "in_knob": TH_KNOB, "in_gain_db": [0.0] * 11,
    "thr_th": None, "tables_th": None,
    "att_ms": [[10.0] * 5 for _ in range(5)], "rel_ms": [[500.0] * 5 for _ in range(5)],
    "slow_frac": 0.2, "slow_att_ms": 300.0, "slow_rel_ms": 1500.0,
    "out_a2": 0.0, "out_a3": 0.0, "out_sat": 0.0, "out_bias": 0.0, "out_ab": 0.0, "out_knee": 0.0,
    "xf_k": 0.0, "xf_fc": 20.0, "eq_base": [],
    # par bande : par position de fréquence, [fc, Q@5, Q@10, gain réel@5, gain réel@10] et type
    "lo": None, "mid": None, "hi": None, "lo_kind": "peak", "mid_kind": "peak", "hi_kind": "peak",
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


def band_biquad(kind, rows, idx, knob):
    """Biquad d'une bande : position de fréquence `idx`, gain du bouton (0..10, signe compris)."""
    if not rows or abs(knob) < 1e-3:
        return None
    fc, q5, q10, g5, g10 = rows[int(idx)]
    a = abs(knob)
    if a <= 5:
        q, g = q5, g5 * a / 5.0
    else:
        t = (a - 5) / 5.0
        q, g = q5 + (q10 - q5) * t, g5 + (g10 - g5) * t
    return ac.biquad(kind, fc, max(q, 0.1), g if knob > 0 else -abs(g), SR)


def hp1(fc, sr=SR):
    w = np.tan(np.pi * fc / sr)
    b0 = 1.0 / (1.0 + w)
    return [b0, -b0, 0.0, (w - 1.0) / (w + 1.0), 0.0]


def nova_to_internal(p, fit):
    q = dict(DEFAULT_NOVA)
    q.update(p or {})
    P = np.zeros(ac.NP)
    gin = float(np.interp(q["input"], fit["in_knob"], fit["in_gain_db"]))
    P[ac.P_PRE] = 10 ** (gin / 20.0)
    if int(q["compOn"]) and fit.get("tables_th"):
        th = float(q["compThresh"])
        k = np.asarray(TH_KNOB)
        thr = float(np.interp(th, k, fit["thr_th"]))
        T = np.asarray(fit["tables_th"], float)
        j = int(np.searchsorted(k, th))
        if j <= 0:
            tab = T[0]
        elif j >= len(k):
            tab = T[-1]
        else:
            t = (th - k[j - 1]) / (k[j] - k[j - 1])
            tab = T[j - 1] * (1 - t) + T[j] * t
        # le seuil est mesuré en niveau d'entrée : ramené au niveau après le bouton ENTRÉE
        g5 = float(np.interp(5.0, fit["in_knob"], fit["in_gain_db"]))
        P[ac.P_THR] = 10 ** ((thr + g5) / 20.0)
    else:
        tab = np.zeros(NL)
        P[ac.P_THR] = 1e6
    ai, ri = int(round(q["attack"])), int(round(q["release"]))
    P[ac.P_ATT] = ac.coef_from_ms(fit["att_ms"][ai][ri])
    P[ac.P_ATT2] = P[ac.P_ATT]
    P[ac.P_REL_EXP] = ac.coef_from_ms(fit["rel_ms"][ai][ri])
    P[ac.P_HOLD] = -1.0
    P[ac.P_SLOW_FRAC] = fit["slow_frac"]
    P[ac.P_SLOW_ATT] = ac.coef_from_ms(fit["slow_att_ms"])
    P[ac.P_SLOW_REL] = ac.coef_from_ms(fit["slow_rel_ms"])
    lc = int(q["lowCut"])
    if lc:
        P[ac.P_IN_A2] = 0.0
    # coupe-bas de l'entrée : 1er ordre, placé en couleur (premier biquad)
    eqs = []
    if lc:
        eqs.append(ac.biquad("hp1", float(lc), 0.7071, 0.0, SR))
    if int(q["eqOn"]):
        for band, kidx, kval in (("lo", "loFreq", "loPeak"), ("mid", "midFreq", "midDip"), ("hi", "hiFreq", "hiPeak")):
            bq = band_biquad(fit[f"{band}_kind"], fit.get(band), q[kidx], float(q[kval]))
            if bq is not None:
                eqs.append(bq)
    for kind, fc, qq, gdb in fit.get("eq_base", []):
        eqs.append(ac.biquad(kind, fc, qq, gdb, SR))
    for i, bq in enumerate(eqs[:2 * ac.N_EQ]):
        o = ac.P_EQ + 5 * i if i < ac.N_EQ else ac.P_EQ2 + 5 * (i - ac.N_EQ)
        P[o:o + 5] = bq
    P[ac.P_OUT_A2], P[ac.P_OUT_A3], P[ac.P_OUT_SAT], P[ac.P_OUT_BIAS] = fit["out_a2"], fit["out_a3"], fit["out_sat"], fit["out_bias"]
    P[ac.P_OUT_AB], P[ac.P_OUT_KNEE] = fit["out_ab"], fit["out_knee"]
    if int(q["transformer"]):
        P[ac.P_XF_K] = fit["xf_k"]
        P[ac.P_XF_A] = 1.0 - np.exp(-2 * np.pi * fit["xf_fc"] / SR)
    P[ac.P_MAKEUP] = 10 ** (float(q["output"]) / 20.0)
    P[ac.P_MIX] = min(1.0, max(0.0, float(q["mix"]) / 100.0))
    P[ac.P_LINK] = 0.0
    return P, L0, DL, np.ascontiguousarray(tab)


def builder(fit=None, to_nova=None):
    f = fit or load_fit()

    def build(settings):
        qq = to_nova(settings) if to_nova else settings
        return nova_to_internal(qq, f)
    return build
