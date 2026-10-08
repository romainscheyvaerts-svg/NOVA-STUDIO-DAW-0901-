"""
Tour 3 : calage multi-objectifs de la dynamique (CMA-ES) avec le détecteur à
deux voies (charge / décharge AVANT la loi statique) et la cellule en dB.

Coût = moyenne pondérée de :
  - vrais signaux (voix, batterie) rendus par le VST d'origine : null après
    correction linéaire + 4·|écart de niveau| (comme au tour 2) ;
  - corpus de sauts et salves à plusieurs niveaux (tour3/corpus.py) : null
    moyen par segment (borné à −45 dB) ;
  - courbes statiques mesurées (option) : écart moyen + max (dB).
Les poids de chaque famille sont réglables : « calage multi-objectifs ».

Usage : python -m tour3.fit3 <groupe> [--gens N] [--workers W] [--sigma s] [--tag t] [--start best.json]
        python -m tour3.fit3 <groupe> --report [--start best.json]
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tour3 import lowprio  # noqa: E402
from tour3 import corpus as cp  # noqa: E402
from tour2.common import banc_mod, null_db, LABO, SR  # noqa: E402
from scipy import signal as sps  # noqa: E402
from tour2.sets import sets, SIG  # noqa: E402
from tour2.fitdyn import set_d2, import_prof  # noqa: E402
import bench  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402

def lti_correct(a, b, taps=513, nper=8192):
    """Même estimation que tour2.common.lti_correct (FIR de Welch), convolution par FFT (plus rapide)."""
    _, pbb = sps.welch(b, SR, nperseg=nper)
    _, pab = sps.csd(b, a, SR, nperseg=nper)
    h = np.fft.irfft(pab / np.maximum(pbb, 1e-30))
    h = np.roll(h, taps // 2)[:taps] * np.hanning(taps)
    return sps.oaconvolve(b, h, mode="full")[taps // 2: taps // 2 + len(b)], None


# ── Espace des paramètres : (nom, bas, haut, 'log'|'lin') ──────────────────
DET_SPEC = [("att", 0.01, 300.0, "log"), ("rel", 0.5, 30000.0, "log"), ("lin", 1e-5, 200.0, "log"), ("off", -24.0, 24.0, "lin")]
DET_IDX = dict({n: i for i, (n, *_r) in enumerate(DET_SPEC)}, ea=4, er=5, cap=6)
COMP_SPEC = [("f", 0.0, 1.3, "lin"), ("att", 0.01, 2000.0, "log"), ("alpha", -0.25, 0.25, "lin"), ("rel", 0.3, 30000.0, "log"),
             ("beta", -0.3, 0.3, "lin"), ("lin", 1e-3, 3000.0, "log"), ("slew", 0.005, 80.0, "log")]
COMP_IDX = {"f": 0, "att": 1, "alpha": 2, "rel": 3, "beta": 4, "lin": 5, "ea": 6, "er": 7, "slew": 8}


def _fw(v, lo, hi, kind):
    """valeur -> espace libre (logit borné)."""
    if kind == "log":
        v = math.log(min(max(v, lo), hi))
        lo, hi = math.log(lo), math.log(hi)
    t = min(max((v - lo) / (hi - lo), 1e-6), 1 - 1e-6)
    return math.log(t / (1 - t))


def _bw(z, lo, hi, kind):
    if kind == "log":
        lo, hi = math.log(lo), math.log(hi)
    v = lo + (hi - lo) / (1.0 + math.exp(-max(min(z, 40.0), -40.0)))
    return math.exp(v) if kind == "log" else v


class Space:
    """Paramètres libres d'un groupe."""

    def __init__(self, group):
        self.items = []
        for d in group.get("free_dets", []):
            for nm, lo, hi, kd in DET_SPEC:
                if nm in group.get("det_fixed", {}).get(d, ()):
                    continue
                self.items.append((("dets", d, nm), lo, hi, kd))
        for k in group.get("free_comps", []):
            for nm, lo, hi, kd in COMP_SPEC:
                if nm in group.get("comp_fixed", {}).get(k, ()):
                    continue
                self.items.append((("comps", k, nm), lo, hi, kd))
        for nm, lo, hi, kd in group.get("extra", []):
            self.items.append(((nm,), lo, hi, kd))
        for path, lo, hi, kd in group.get("paths", []):
            self.items.append((tuple(path), lo, hi, kd))

    @staticmethod
    def get(d2, path):
        if path[0] == "dets":
            dv = d2["dets"][path[1]]
            i = DET_IDX[path[2]]
            v = dv[i] if i < len(dv) else 0.0
            if path[2] == "cap" and v <= 0.0:
                return 79.0   # 0 = pas de plafond -> borne haute
            return v
        if path[0] == "comps":
            c = d2["comps"][path[1]]
            i = COMP_IDX[path[2]]
            v = c[i] if i < len(c) else 0.0
            if path[2] == "slew" and v <= 0.0:
                return 79.0   # 0 = vitesse illimitée -> borne haute (rendue à 0 au nettoyage)
            return v
        if path[0][:3] in ("sa_", "sr_"):
            which = "att" if path[0][1] == "a" else "rel"
            return d2[which + "_scale"][d2[which + "_knob"].index(float(path[0][3:]))]
        if path[0] == "scale":
            return d2[path[1] + "_scale"][path[2]]
        if path[0] == "lwarp":
            return (d2.get("lwarp") or [0.0] * 4)[path[1]]
        return d2.get(path[0], 0.0)

    @staticmethod
    def put(d2, path, v):
        if path[0] == "dets":
            dv = d2["dets"][path[1]]
            while len(dv) < 7:
                dv.append(0.0)
            dv[DET_IDX[path[2]]] = v
        elif path[0] == "comps":
            c = d2["comps"][path[1]]
            while len(c) < 9:
                c.append(0.0)
            c[COMP_IDX[path[2]]] = v
        elif path[0][:3] in ("sa_", "sr_"):
            which = "att" if path[0][1] == "a" else "rel"
            d2[which + "_scale"][d2[which + "_knob"].index(float(path[0][3:]))] = v
        elif path[0] == "scale":
            d2[path[1] + "_scale"][path[2]] = v
        elif path[0] == "lwarp":
            w = list(d2.get("lwarp") or [0.0] * 4)
            w[path[1]] = v
            d2["lwarp"] = w
        else:
            d2[path[0]] = v

    def to_theta(self, d2):
        # |z| <= 4 : un paramètre posé sur une borne (0 = « absent ») reste atteignable par CMA-ES
        return np.array([min(max(_fw(float(self.get(d2, p)), lo, hi, kd), -4.0), 4.0) for p, lo, hi, kd in self.items])

    def to_d2(self, th, base):
        d2 = copy.deepcopy(base)
        for (path, lo, hi, kd), z in zip(self.items, th):
            self.put(d2, path, _bw(float(z), lo, hi, kd))
        # nettoyage : pente minuscule -> 0 ; vitesse max énorme -> illimitée
        for c in d2["comps"]:
            while len(c) < 9:
                c.append(0.0)
            if c[5] < 2e-3:
                c[5] = 0.0
            if c[8] > 60.0:
                c[8] = 0.0
        for dv in d2.get("dets", []):
            if dv[2] < 2e-5:
                dv[2] = 0.0
            if len(dv) > 6 and dv[6] >= 78.0:
                dv[6] = 0.0
        if d2.get("hold_ms", 0.0) and d2["hold_ms"] < 0.06:
            d2["hold_ms"] = 0.0
        return d2


# ── Groupes ────────────────────────────────────────────────────────────────
def _jobs(bn, names):
    from tour3.render_real import jobs
    return [j for j in jobs(bn, ("fit", "val")) if j["name"] in names]


GROUPS = {
    # Étape 1 : dynamique aux positions de boutons de Romain (attaque 3, relâchement 3)
    "cl1b_fm": {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "fm"),
                "corpus": [("fm_romain", 1.0), ("fm5", 1.0)],
                "real_from_sets": ["romain_voix"], "real_extra": _jobs("cl1b", ["fm5"]),
                "free_dets": [0, 1], "free_comps": [0, 1, 2],
                "extra": [("pow", 0.15, 2.5, "lin"), ("ant", 0.0, 3.0, "lin")],
                "w_corpus": 1.0},
    "cl1b_man": {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "man"),
                 "corpus": [("man_romain", 1.0), ("man5", 1.0)],
                 "real_from_sets": [], "real_extra": _jobs("cl1b", ["man_romain", "man5"]),
                 "free_dets": [1], "free_comps": [0, 1, 2],
                 "extra": [("pow", 0.15, 2.5, "lin"), ("ant", 0.0, 3.0, "lin")],
                 "w_corpus": 1.0},
    # FET 76 : réglages de Romain (bus 4:1, a5 r6 / a4 r4 calé 5 dB), batterie et courbes statiques dans le même coût
    "fet76": {"banc": "fet76", "prof": "modeles.fet76_profil", "key": ("dyn2",),
              "corpus": [("bus5", 1.0), ("tr", 1.0)],
              "real_from_sets": ["romain_bus", "transitoires"], "real_extra": _jobs("fet76", ["bus5"]),
              "w_drum": 2.0,
              "stat": [("stat_r4:1_in-24", "stat_1k"), ("stat_r4:1_in0", "stat_1k")],
              "w_stat": 1.0,
              "free_dets": [1], "free_comps": [0, 1, 2],
              "extra": [("pow", 0.15, 2.5, "lin"), ("ant", 0.0, 3.0, "lin"),
                        ("sa_2.5", 0.02, 50.0, "log"), ("sa_5.5", 0.02, 50.0, "log"), ("sr_5.5", 0.02, 50.0, "log"), ("sr_7", 0.02, 200.0, "log")],
              "w_corpus": 1.0},
    "voxbox": {"banc": "voxbox", "prof": "modeles.voxbox_profil", "key": ("dyn2",),
               "corpus": [("voix5", 1.0)],
               "real_from_sets": ["romain_voix", "batterie"], "real_extra": _jobs("voxbox", ["voix5"]),
               "w_drum": 2.0,
               "stat": [("stat_th2.5", "stat_1k"), ("stat_th5", "stat_1k")],
               "w_stat": 0.5,
               "free_dets": [1], "free_comps": [0, 1, 2],
               "extra": [("pow", 0.15, 2.5, "lin"), ("ant", 0.0, 3.0, "lin")],
               "w_corpus": 1.0},
    "la2a": {"banc": "la2a", "prof": "modeles.la2a_profil", "key": ("dyn2",),
             "corpus": [("bus", 1.0), ("pr60", 1.0)],
             "real_from_sets": ["romain_bus", "transitoires", "pr45_batterie", "voix_pr55"], "real_extra": _jobs("la2a", ["bus2"]),
             "w_drum": 2.0,
             "stat": [("stat_pr20", "stat_1k"), ("stat_pr50", "stat_1k"), ("stat_pr80", "stat_1k")],
             "w_stat": 0.5,
             "free_dets": [1], "free_comps": [0, 1, 2],
             "extra": [("pow", 0.15, 2.5, "lin"), ("ant", 0.0, 3.0, "lin")],
             "w_corpus": 1.0},
}


CAP = [(("dets", 0, "cap"), 5.0, 80.0, "lin"), (("dets", 1, "cap"), 5.0, 80.0, "lin")]
LWARP = [(("lwarp", 0), -12.0, 12.0, "lin"), (("lwarp", 1), -0.4, 0.4, "lin"), (("lwarp", 2), -1.0, 1.0, "lin"), (("lwarp", 3), -0.3, 0.3, "lin")]
for _g in ("cl1b_fm", "cl1b_man", "fet76", "voxbox", "la2a"):
    GROUPS[_g + "_h"] = dict(GROUPS[_g], paths=list(GROUPS[_g].get("paths", [])) + LWARP + [(("trim_db",), -1.0, 1.0, "lin")]
                             + (CAP if _g.startswith("cl1b_fm") else CAP[1:]), w_corpus=3.0)
GROUPS["cl1b_fm_h"]["corpus"] = GROUPS["cl1b_fm"]["corpus"] + [("fm_haut", 1.0)]
GROUPS["cl1b_man_h"]["corpus"] = GROUPS["cl1b_man"]["corpus"] + [("man_haut", 1.0)]

# Variantes finales : poids du corpus 1 (la voix prime), corpus chaud inclus, loi interne / trim / plafond libres
for _g in ("cl1b_fm", "cl1b_man"):
    GROUPS[_g + "_f"] = dict(GROUPS[_g + "_h"], w_corpus=1.0)
# FET 76 et Vox Strip : cellule du tour 2 (détecteur instantané) recalée en multi-objectifs (voix + batterie + statique)
_C3 = [(("comps", k, n), lo, hi, kd) for k in range(3) for (n, lo, hi, kd) in COMP_SPEC]
for _g in ("fet76", "voxbox"):
    GROUPS[_g + "_t"] = dict(GROUPS[_g], free_dets=[], free_comps=[], w_corpus=1.0,
                             extra=[("ant", 0.0, 3.0, "lin"), ("thr_db", -8.0, 8.0, "lin")] + [e for e in GROUPS[_g]["extra"] if e[0][:3] in ("sa_", "sr_")],
                             paths=_C3 + LWARP + [(("trim_db",), -1.0, 1.0, "lin")])

GROUPS["fet76_ts"] = dict(GROUPS["fet76_t"], w_stat=3.0, stat=[("stat_r4:1_in-24", "stat_1k"), ("stat_r4:1_in-12", "stat_1k"),
                                                                ("stat_r8:1_in-24", "stat_1k"), ("stat_r4:1_in0", "stat_1k")])
GROUPS["la2a_t"] = dict(GROUPS["la2a"], free_dets=[], free_comps=[], w_corpus=1.0, w_drum=3.0, w_stat=1.0,
                        extra=[("ant", 0.0, 3.0, "lin"), ("thr_db", -8.0, 8.0, "lin"), ("hold_ms", 0.05, 500.0, "log")],
                        paths=_C3 + LWARP + [(("trim_db",), -1.0, 1.0, "lin")])

# ── Étape 2 : vitesses par position de bouton (la dynamique de l'étape 1 est figée) ──
CL1B_KN = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0]
FET_KN = [1.0, 2.5, 4.0, 5.5, 7.0]
_EXP = [(("dets", 1, "ea"), 0.0, 1.5, "lin"), (("dets", 1, "er"), 0.0, 1.5, "lin"),
        (("comps", 1, "ea"), 0.0, 1.5, "lin"), (("comps", 1, "er"), 0.0, 1.5, "lin"),
        (("comps", 2, "ea"), 0.0, 1.5, "lin"), (("comps", 2, "er"), 0.0, 1.5, "lin")]
GROUPS["cl1b_fm_k"] = {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "fm"),
                       "corpus": [(f"mfm_{t}", 0.5) for t in ("a0r0", "a1r1", "a2r2", "a4r4", "a5r5", "a6r6", "a7r7", "a8r8", "a10r10", "a3r8", "a8r3")]
                       + [("fm_romain", 0.5)],
                       "real_from_sets": ["romain_voix", "fm_a6r6", "fm_a1r1", "fm_batterie"], "real_extra": _jobs("cl1b", ["fm5"]),
                       "paths": _EXP,
                       "extra": [(f"sa_{k:g}", 0.003, 300.0, "log") for k in CL1B_KN if k != 3.0]
                       + [(f"sr_{k:g}", 0.003, 300.0, "log") for k in CL1B_KN if k != 3.0],
                       "anchors": {"att": CL1B_KN, "rel": CL1B_KN, "ref": 3.0}}
GROUPS["cl1b_man_k"] = {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "man"),
                        "corpus": [(f"mman_{t}", 0.5) for t in ("a0r0", "a1r1", "a2r2", "a4r4", "a5r5", "a6r6", "a7r7", "a8r8", "a10r10", "a3r8", "a8r3")]
                        + [("man_romain", 0.5)],
                        "real_from_sets": ["voix_man", "man_a5r5", "man_a0r0", "man_a8r8", "transitoires"],
                        "real_extra": _jobs("cl1b", ["man_romain", "man5"]),
                        "paths": _EXP,
                        "extra": [(f"sa_{k:g}", 0.003, 300.0, "log") for k in CL1B_KN if k != 3.0]
                        + [(f"sr_{k:g}", 0.003, 300.0, "log") for k in CL1B_KN if k != 3.0],
                        "anchors": {"att": CL1B_KN, "rel": CL1B_KN, "ref": 3.0}}
GROUPS["fet76_k"] = {"banc": "fet76", "prof": "modeles.fet76_profil", "key": ("dyn2",),
                     "corpus": [(f"mf_{t}", 0.5) for t in ("a1r1", "a2.5r2.5", "a4r4", "a5.5r5.5", "a7r7", "a1r7", "a7r1", "slo_r4")]
                     + [("tr", 0.5)],
                     "real_from_sets": ["romain_bus", "voix_r8", "transitoires", "a1r1", "a7r7", "slo", "r20", "r2_a4r2"],
                     "real_extra": _jobs("fet76", ["bus5"]), "w_drum": 2.0,
                     "paths": [(("dets", 1, "ea"), 0.0, 1.5, "lin"), (("dets", 1, "er"), 0.0, 1.5, "lin"),
                               (("comps", 0, "ea"), 0.0, 1.5, "lin"), (("comps", 0, "er"), 0.0, 1.5, "lin"),
                               (("comps", 1, "ea"), 0.0, 1.5, "lin"), (("comps", 1, "er"), 0.0, 1.5, "lin"),
                               (("comps", 2, "ea"), 0.0, 1.5, "lin"), (("comps", 2, "er"), 0.0, 1.5, "lin")],
                     "extra": [(f"sa_{k:g}", 0.003, 300.0, "log") for k in FET_KN if k != 4.0]
                     + [(f"sr_{k:g}", 0.003, 300.0, "log") for k in FET_KN if k != 4.0] + [("slo_scale", 0.001, 10.0, "log")]}
GROUPS["voxbox_k"] = {"banc": "voxbox", "prof": "modeles.voxbox_profil", "key": ("dyn2",),
                      "corpus": [(f"mv_{t}", 0.5) for t in ("FF", "MFMF", "MSMS", "SS", "FS", "SF")] + [("voix5", 0.5)],
                      "real_from_sets": ["romain_voix", "aFast_rFast", "aSlow_rSlow", "aFast_rSlow", "aSlow_rFast", "aMedFast_rMedSlow", "batterie"],
                      "real_extra": _jobs("voxbox", ["voix5"]), "w_drum": 2.0,
                      "paths": _EXP + [(("scale", w, i), 0.003, 300.0, "log") for w in ("att", "rel") for i in (0, 1, 3, 4)]}


GROUPS["cl1b_fm_kb"] = dict(GROUPS["cl1b_fm_k"], w_drum=3.0, paths=list(GROUPS["cl1b_fm_k"]["paths"]) + LWARP,
                           corpus=[(f"mfm_{t}", 0.3) for t in ("a1r1", "a2r2", "a4r4", "a6r6", "a8r8")] + [("fm_romain", 0.5)])


# Raffinement final : null BRUT (NOVA_RAW=1), autres positions de boutons dans le coût (pas de régression)
GROUPS["fet76_r"] = dict(GROUPS["fet76_ts"], real_from_sets=GROUPS["fet76_ts"]["real_from_sets"] + ["voix_r8", "a1r1", "a7r7", "slo", "r20", "r2_a4r2"])
GROUPS["voxbox_r"] = dict(GROUPS["voxbox_t"], real_from_sets=GROUPS["voxbox_t"]["real_from_sets"] + ["aFast_rFast", "aSlow_rSlow", "aFast_rSlow", "aSlow_rFast", "aMedFast_rMedSlow"])
GROUPS["la2a_r"] = dict(GROUPS["la2a_t"], real_from_sets=GROUPS["la2a_t"]["real_from_sets"] + ["pr40", "pr75"])


GROUPS["cl1b_fm_r"] = dict(GROUPS["cl1b_fm_k"], w_drum=2.0, paths=list(GROUPS["cl1b_fm_k"]["paths"]) + LWARP,
                          corpus=[("fm_romain", 0.5), ("fm5", 0.5), ("mfm_a1r1", 0.3), ("mfm_a6r6", 0.3)])


# Vox Strip et Leveler 2A : sans loi interne (la relecture de la loi dégradait les autres seuils), toutes les statiques
GROUPS["voxbox_s"] = dict(GROUPS["voxbox_r"], w_stat=2.0, paths=[q for q in GROUPS["voxbox_r"]["paths"] if q[0][0] != "lwarp"],
                          stat=[("stat_th2.5", "stat_1k"), ("stat_th5", "stat_1k"), ("stat_th7.5", "stat_1k"), ("stat_th10", "stat_1k")])
GROUPS["la2a_s"] = dict(GROUPS["la2a_r"], w_stat=2.0, paths=[q for q in GROUPS["la2a_r"]["paths"] if q[0][0] != "lwarp"],
                        stat=[("stat_pr20", "stat_1k"), ("stat_pr40", "stat_1k"), ("stat_pr60", "stat_1k"), ("stat_pr80", "stat_1k"), ("stat_pr100", "stat_1k")])


def stage2_base(gname, start):
    """Base de l'étape 2 : dynamique de l'étape 1 + ancres de vitesse par bouton (départ : temps du tour 1)."""
    d2 = copy.deepcopy(json.load(open(start, encoding="utf-8"))["d2"])
    g = GROUPS[gname]
    an = g.get("anchors")
    if gname.startswith("cl1b"):
        # départ : bouton log-linéaire (attaque ~0,5 ms -> 300 ms, relâchement ~50 ms -> 10 s sur 0..10)
        d2["att_knob"] = list(an["att"])
        d2["att_scale"] = [float(600.0 ** ((an["ref"] - k) / 10.0)) for k in an["att"]]
        d2["rel_knob"] = list(an["rel"])
        d2["rel_scale"] = [float(200.0 ** ((an["ref"] - k) / 10.0)) for k in an["rel"]]
    for c in d2["comps"]:
        while len(c) < 9:
            c.append(0.0)
    for dv in d2.get("dets", []):
        while len(dv) < 6:
            dv.append(0.0)
    return d2


def init_d2(gname):
    """Point de départ. F/M : voie rapide fixe (comp 0) + voie manuelle (comp 1, 2), la plus forte l'emporte."""
    if gname.startswith("cl1b_fm"):
        return {"max": 1, "pow": 1.0, "rect": 0, "ant": 0.0, "thr_db": 0.0, "hold_ms": 0.0,
                "dets": [[0.05, 10.0, 0.0, -3.0, 0.0, 0.0], [15.0, 400.0, 0.0, -2.0, 1.0, 1.0]],
                "sel": [0, 1, 1],
                "comps": [[1.0, 0.05, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                          [1.0, 1.0, 0.0, 10.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                          [0.3, 50.0, 0.0, 800.0, 0.0, 0.0, 1.0, 1.0, 0.0]]}
    if gname.startswith("cl1b_man"):
        return {"max": 0, "pow": 1.0, "rect": 0, "ant": 0.0, "thr_db": 0.0, "hold_ms": 0.0,
                "dets": [[0.05, 10.0, 0.0, -60.0, 0.0, 0.0], [15.0, 400.0, 0.0, -2.0, 1.0, 1.0]],
                "sel": [1, 1, 1],
                "comps": [[0.8, 1.0, 0.0, 10.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                          [0.15, 30.0, 0.0, 300.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                          [0.05, 300.0, 0.0, 3000.0, 0.0, 0.0, 1.0, 1.0, 0.0]]}
    if gname.startswith("fet76"):
        f = import_prof("modeles.fet76_profil").load_fit()
        ak, am, rm = f["att_knob"], f["att_ms"], f["rel_ms"]
        i4 = ak.index(4.0)
        kn = [1.0, 2.5, 4.0, 5.5, 7.0]
        return {"max": 0, "pow": 1.0, "rect": 0, "ant": 0.0, "thr_db": 1.0, "hold_ms": 0.0,
                "dets": [[0.05, 10.0, 0.0, -60.0, 0.0, 0.0], [am[i4], rm[i4] * 0.6, 0.0, 0.0, 1.0, 1.0]],
                "sel": [1, 1, 1],
                "comps": [[0.8, 0.02, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                          [0.05, 20.0, 0.0, 2000.0, 0.0, 0.0, 0.5, 0.5, 0.0],
                          [0.15, 170.0, 0.0, 420.0, 0.0, 0.0, 0.1, 0.25, 0.0]],
                "att_knob": kn, "att_scale": [float(am[i4] / ac.interp_log(ak, am, k)) for k in kn],
                "rel_knob": kn, "rel_scale": [float(rm[i4] / ac.interp_log(ak, rm, k)) for k in kn],
                "slo_scale": float(am[i4] / f["slo_att_ms"])}
    if gname.startswith("voxbox"):
        return {"max": 0, "pow": 1.0, "rect": 0, "ant": 0.0, "thr_db": 0.6, "hold_ms": 0.0,
                "dets": [[0.05, 10.0, 0.0, -60.0, 0.0, 0.0], [5.0, 120.0, 0.0, 0.0, 1.0, 1.0]],
                "sel": [1, 1, 1],
                "comps": [[0.6, 2.0, 0.0, 30.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                          [0.4, 300.0, 0.0, 1400.0, 0.0, 0.0, 0.75, 0.0, 0.0],
                          [0.01, 50.0, 0.0, 16000.0, 0.0, 0.0, 0.6, 0.3, 0.0]],
                "att_scale": [4.0, 2.0, 1.0, 0.5, 0.25], "rel_scale": [4.0, 2.0, 1.0, 0.5, 0.25]}
    if gname.startswith("la2a"):
        return {"max": 0, "pow": 1.0, "rect": 0, "ant": 0.0, "thr_db": 1.6, "hold_ms": 0.0,
                "dets": [[0.05, 10.0, 0.0, -60.0, 0.0, 0.0], [1.0, 60.0, 0.0, 0.0, 0.0, 0.0]],
                "sel": [1, 1, 1],
                "comps": [[0.37, 0.3, 0.0, 6.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                          [0.25, 0.75, 0.0, 175.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                          [0.38, 46.0, 0.0, 620.0, 0.0, 0.0, 0.0, 0.0, 0.0]]}
    raise ValueError(gname)


# ── Données ────────────────────────────────────────────────────────────────
def _real(banc, e, sub, w):
    fn = os.path.join(LABO, banc.ID, sub, "vst", f"{e['name']}__{e['sig']}.npy")
    if not os.path.exists(fn):
        return None
    path, off, sec = SIG[e["sig"]]
    x = bench.load_audio(path, sec, off, e["rms_db"])
    y = np.load(fn).astype(np.float64)
    n = min(x.shape[1], y.shape[1])
    return {"kind": "real", "name": e["name"], "sig": e["sig"], "role": e["role"], "settings": e["settings"],
            "x": np.ascontiguousarray(x[0, :n]), "y": y[0, :n], "w": w}


def load_items(gname, roles=("fit",)):
    g = GROUPS[gname]
    banc = banc_mod(g["banc"])
    items = []
    for e in sets(g["banc"]):
        if e["name"] in g.get("real_from_sets", []) and e["role"] in roles:
            it = _real(banc, e, "tour2", g.get("w_drum", 1.0) if e["sig"] == "D" else 1.0)
            if it:
                items.append(it)
    for e in g.get("real_extra", []):
        if e["role"] in roles:
            it = _real(banc, e, "tour3", e.get("w", 1.0))
            if it:
                items.append(it)
    if "fit" in roles and g.get("stat"):
        M = json.load(open(os.path.join(LABO, banc.ID, "mesures.json"), encoding="utf-8"))
        defs = {c["name"]: c for c in banc.CASES}
        for cn, tn in g["stat"]:
            if cn not in defs or cn not in M:
                continue
            t = next(t for t in defs[cn]["tests"] if t.get("name") == tn)
            rows = M[cn]["tests"][tn]["rows"][::2]
            items.append({"kind": "stat", "name": cn, "sig": "S", "role": "fit", "settings": defs[cn]["settings"],
                          "freq": t["freq"], "dur": min(t.get("dur", 2.5), 2.5),
                          "levels": [r["in_db"] for r in rows], "out": [r["ch0"]["out_db"] for r in rows],
                          "w": g.get("w_stat", 1.0)})
    if "fit" in roles:
        for name, w in g.get("corpus", []):
            C = cp.load(banc.ID, name)
            items.append({"kind": "corpus", "name": name, "sig": "C", "role": "fit", "settings": C["settings"],
                          "x": np.ascontiguousarray(C["x"]), "y": C["y"], "segs": [s for s in C["segs"] if s[0] != "pre"],
                          "w": w * g.get("w_corpus", 1.0)})
    return items


def run_model(prof, banc, fit, settings, x):
    P, l0, dl, tab = prof.nova_to_internal(banc.to_nova(settings), fit)
    y, _ = ac.process(np.ascontiguousarray(x[None, :], dtype=np.float64), P, float(l0), float(dl),
                      np.ascontiguousarray(tab, dtype=np.float64))
    return ac.compensate(y, P)[0]


def stat_err(prof, banc, fit, it):
    """Courbe statique : sinus par paliers (chaque palier depuis l'état de repos, comme bench.tone_levels)."""
    if bench._CAL is None:
        bench._CAL = bench._harm_cal()
    n = int(it["dur"] * SR)
    t = np.arange(n) / SR
    na = int(0.4 * SR)
    fi = int(0.002 * SR)
    err = []
    for L, vo in zip(it["levels"], it["out"]):
        x = 10 ** (L / 20.0) * np.sin(2 * np.pi * it["freq"] * t)
        x[:fi] *= np.arange(fi) / fi
        yb = run_model(prof, banc, fit, it["settings"], x)
        h1 = bench._harmonics(yb[-na:], it["freq"], 1)[0] / bench._CAL
        err.append(abs(20 * math.log10(max(h1, 1e-12)) - vo))
    return np.array(err)


def evaluate(fit, items, prof, banc, detail=False):
    tot, wt, det = 0.0, 0.0, []
    for it in items:
        if it["kind"] == "stat":
            e = stat_err(prof, banc, fit, it)
            c = 4.0 * float(np.mean(e)) + 2.0 * float(np.max(e))
            det.append((it["name"], "statique", round(float(np.mean(e)), 3), round(float(np.max(e)), 3)))
            tot += it["w"] * c
            wt += it["w"]
            continue
        yb = run_model(prof, banc, fit, it["settings"], it["x"])
        if not np.all(np.isfinite(yb)):
            return 1e3, []
        y = it["y"]
        if it["kind"] == "real":
            raw = null_db(y, yb)
            cor = null_db(y, lti_correct(y, yb)[0])
            lev = 20 * math.log10(math.sqrt(np.mean(yb ** 2)) / math.sqrt(np.mean(y ** 2)) + 1e-12)
            c = cor + 4.0 * abs(lev)
            det.append((it["name"], it["sig"], it["role"], round(raw, 2), round(cor, 2), round(lev, 2)))
        else:
            ns = [max(null_db(y[a:b], yb[a:b]), -45.0) for _, a, b in it["segs"]]
            c = float(np.mean(ns))
            det.append((it["name"], "corpus", round(c, 2), [round(v, 1) for v in ns] if detail else None))
        tot += it["w"] * c
        wt += it["w"]
    return tot / max(wt, 1e-9), det


_W = {}


def _init(gname, base):
    lowprio()
    g = GROUPS[gname]
    _W["g"] = gname
    _W["prof"] = import_prof(g["prof"])
    _W["banc"] = banc_mod(g["banc"])
    _W["items"] = load_items(gname)
    _W["fit"] = _W["prof"].load_fit()
    _W["base"] = base
    _W["space"] = Space(g)


def _cost(th):
    try:
        d2 = _W["space"].to_d2(th, _W["base"])
        fit = copy.deepcopy(_W["fit"])
        set_d2(fit, GROUPS[_W["g"]]["key"], d2)
        c, _ = evaluate(fit, _W["items"], _W["prof"], _W["banc"])
    except Exception:
        c = 1e3
    return c if np.isfinite(c) else 1e3


def best_path(gname, tag):
    return os.path.join(LABO, banc_mod(GROUPS[gname]["banc"]).ID, "tour3", f"best_{gname}{tag}.json")


def run(gname, gens, workers, sigma, tag, start=None, popsize=None):
    import cma
    from multiprocessing import Pool
    g = GROUPS[gname]
    if gname.endswith("_k") and start and not start.endswith("_k.json") and "best_" in start and "_k" not in os.path.basename(start):
        base = stage2_base(gname, start)
    else:
        base = json.load(open(start, encoding="utf-8"))["d2"] if start else init_d2(gname)
    sp = Space(g)
    th0 = sp.to_theta(base)
    bf = best_path(gname, tag)
    os.makedirs(os.path.dirname(bf), exist_ok=True)
    es = cma.CMAEvolutionStrategy(th0.tolist(), sigma, {"popsize": popsize or (8 + int(3 * math.log(len(th0)))),
                                                         "maxiter": gens, "verbose": -9, "tolfun": 1e-4})
    log = open(bf.replace(".json", ".log"), "a", encoding="utf-8")
    best = (None, 1e9)
    t0 = time.time()
    with Pool(workers, initializer=_init, initargs=(gname, base)) as pool:
        while not es.stop():
            X = es.ask()
            F = pool.map(_cost, X)
            es.tell(X, F)
            i = int(np.argmin(F))
            if F[i] < best[1]:
                best = (np.array(X[i]), F[i])
                with open(bf, "w", encoding="utf-8") as f:
                    json.dump({"cost": float(F[i]), "d2": sp.to_d2(best[0], base)}, f, indent=1)
            log.write(f"{time.strftime('%H:%M:%S')} it {es.countiter} best {best[1]:.3f} gen {min(F):.3f} ({time.time() - t0:.0f}s)\n")
            log.flush()
    return best


def report(gname, start=None, roles=("fit", "val")):
    g = GROUPS[gname]
    prof = import_prof(g["prof"])
    banc = banc_mod(g["banc"])
    fit = prof.load_fit()
    if start:
        set_d2(fit, g["key"], json.load(open(start, encoding="utf-8"))["d2"])
    items = load_items(gname, roles)
    c, det = evaluate(fit, items, prof, banc, detail=True)
    print(gname, "coût", round(c, 3))
    for d in det:
        print("  ", d)


if __name__ == "__main__":
    lowprio()
    ap = argparse.ArgumentParser()
    ap.add_argument("group")
    ap.add_argument("--gens", type=int, default=300)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--sigma", type=float, default=0.8)
    ap.add_argument("--pop", type=int, default=None)
    ap.add_argument("--tag", default="")
    ap.add_argument("--start", default=None)
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    if a.report:
        report(a.group, a.start)
    else:
        b = run(a.group, a.gens, a.workers, a.sigma, a.tag, a.start, a.pop)
        print("meilleur", b[1])
