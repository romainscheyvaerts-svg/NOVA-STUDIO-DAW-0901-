"""
Tour 2 du labo : calage de la cellule multi-composantes (dB) par CMA-ES.

Fonction de coût = somme des erreurs, sur le portage numba du cœur :
  - null test (après correction LTI : on cale ici la DYNAMIQUE seule) sur de
    vraies voix et une vraie batterie rendues par le VST d'origine ;
  - écart de niveau RMS sur ces signaux (la loi statique compte aussi) ;
  - courbes de réduction de gain des sauts de niveau mesurés (cartographie).
La validation se fait sur des voix JAMAIS vues pendant le calage (rôle 'val').

Usage : python -m tour2.fitdyn <groupe> [--gens N] [--workers W] [--init]
Groupes : cl1b_man, cl1b_fm, cl1b_fix, fet76, la2a, la2a_lim, voxbox
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
import bench  # noqa: E402
from tour2.common import banc_mod, lti_correct, null_db, LABO, SR  # noqa: E402
from tour2.sets import sets, SIG  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402

# ── Groupes de calage ───────────────────────────────────────────────────────
GROUPS = {
    "cl1b_man": {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "man"),
                 "real": ["voix_man", "transitoires", "man_a5r5", "man_a0r0", "man_a8r8"],
                 "steps": ["c_att2.5", "c_att5", "c_att8", "c_rel2", "c_rel5", "c_rel8"],
                 "knobs": {"att": [0, 1, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 8, 9, 10], "rel": list(range(11))},
                 "anchors": {"att": [0, 2, 3.5, 5, 6.5, 8, 10], "rel": [0, 2, 4, 5, 6, 8, 10], "ref_att": 2, "ref_rel": 4}},
    "cl1b_fm": {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "fm"),
                "real": ["romain_voix", "fm_a6r6", "fm_a1r1", "fm_batterie"],
                "steps": ["c_fm_att3", "c_fm_att5", "c_fm_att7", "c_fm_rel5"],
                "knobs": {"att": [0, 2, 3, 4, 5, 6, 7, 8, 10], "rel": list(range(11))},
                "anchors": {"att": [0, 1, 3, 5, 6, 7, 10], "rel": [0, 1, 3, 5, 6, 8, 10], "ref_att": 3, "ref_rel": 3}},
    "cl1b_fix": {"banc": "cl1b", "prof": "modeles.cl1b_profil", "key": ("dyn2", "fix"),
                 "real": ["fix"], "steps_cases": ["mode_Fix"], "steps": [], "knobs": {}},
    "fet76": {"banc": "fet76", "prof": "modeles.fet76_profil", "key": ("dyn2",),
              "real": ["romain_bus", "voix_r8", "transitoires", "a1r1", "a7r7", "slo", "r20", "r2_a4r2"],
              "steps": ["c_att1.0", "c_att4.0", "c_att7.0", "c_rel1.0", "c_rel4.0", "c_rel7.0", "c_attSLO"],
              "knobs": {"att": [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7], "rel": [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7]},
              "anchors": {"att": [1, 2.5, 4, 5.5, 7], "rel": [1, 2.5, 4, 5.5, 7], "ref_att": 4, "ref_rel": 4, "slo": True},
              "stat": [("stat_r4:1_in-24", "stat_1k"), ("stat_r4:1_in-12", "stat_1k"), ("stat_r8:1_in-24", "stat_1k"), ("stat_r4:1_in0", "stat_1k")]},
    "la2a": {"banc": "la2a", "prof": "modeles.la2a_profil", "key": ("dyn2",),
             "real": ["romain_bus", "voix_pr55", "transitoires", "pr40", "pr75", "pr45_batterie"],
             "steps": ["c_t_pr40", "c_t_pr60", "c_t_pr80"], "knobs": {},
             "harm": [("thd_comp", "thd_1k"), ("thd_comp", "thd_100")],
             "stat": [("stat_pr20", "stat_1k"), ("stat_pr50", "stat_1k"), ("stat_pr80", "stat_1k"), ("stat_limit_pr60", "stat_1k")]},
    "la2a_lim": {"banc": "la2a", "prof": "modeles.la2a_profil", "key": ("dyn2_lim",),
                 "real": ["lim60"], "steps": ["c_t_lim60"], "knobs": {}},
    "voxbox": {"banc": "voxbox", "prof": "modeles.voxbox_profil", "key": ("dyn2",),
               "real": ["romain_voix", "aFast_rFast", "aSlow_rSlow", "aFast_rSlow", "aSlow_rFast", "aMedFast_rMedSlow", "batterie"],
               "steps": ["c_t_aFast_rFast", "c_t_aMedium_rMedium", "c_t_aSlow_rSlow", "c_t_aFast_rSlow", "c_t_aSlow_rFast"],
               "knobs": {"att5": 5, "rel5": 5},
               "anchors": {"att": [0, 1, 2, 3, 4], "rel": [0, 1, 2, 3, 4], "ref_att": 2, "ref_rel": 2, "pos5": True},
               "harm": [("stat_th5_freq", "stat_100"), ("stat_th5_freq", "thd_100")],
               "steps_cases": ["temps_aMedium_rMedium", "temps_aFast_rMedium", "temps_aMedium_rFast", "temps_aMedium_rSlow"],
               "stat": [("stat_th2.5", "stat_1k"), ("stat_th5", "stat_1k"), ("stat_th7.5", "stat_1k")]},
}

RAW = os.environ.get("NOVA_RAW", "0") == "1"   # coût sur le null BRUT (une fois la phase / le linéaire calés)
W_DRUM = float(os.environ.get("NOVA_W_DRUM", "1.0"))   # poids de la batterie dans le coût (les attaques)

INIT_COMPS = [[0.7, 1.0, 0.0, 80.0, 0.0, 0.0, 1.0, 1.0],
              [0.2, 30.0, 0.0, 600.0, 0.0, 0.0, 0.5, 0.5],
              [0.1, 300.0, 0.0, 3000.0, 0.0, 0.0, 0.2, 0.2]]


def import_prof(name):
    import importlib
    return importlib.import_module(name)


def get_d2(fit, key):
    d = fit
    for k in key:
        d = (d or {}).get(k)
    return d


def set_d2(fit, key, d2):
    if len(key) == 1:
        fit[key[0]] = d2
    else:
        fit.setdefault(key[0], {})
        fit[key[0]][key[1]] = d2


# ── Vecteur θ <-> dyn2 ──────────────────────────────────────────────────────
def _sig(v, lo, hi):
    return lo + (hi - lo) / (1.0 + math.exp(-v))


def _isig(x, lo, hi):
    t = min(max((x - lo) / (hi - lo), 1e-6), 1 - 1e-6)
    return math.log(t / (1 - t))


def theta_spec(group):
    has_knobs = bool(GROUPS[group]["knobs"])
    spec = []
    for k in range(3):
        spec += [(f"z{k}", None)] if k > 0 else []
        spec += [(f"att{k}", "log"), (f"alpha{k}", (-0.25, 0.25)), (f"rel{k}", "log"), (f"beta{k}", (-0.3, 0.3)), (f"lin{k}", "log"), (f"slew{k}", "log")]
        if has_knobs and k > 0:
            spec += [(f"ea{k}", (0.0, 1.0)), (f"er{k}", (0.0, 1.0))]
    spec += [("ant", (0.0, 3.0)), ("thr", (-8.0, 8.0)), ("datt", "log"), ("drel", "log"), ("hold", "log")]
    an = GROUPS[group].get("anchors")
    if an:
        spec += [(f"sa_{k}", "log") for k in an["att"] if k != an["ref_att"]]
        spec += [(f"sr_{k}", "log") for k in an["rel"] if k != an["ref_rel"]]
        if an.get("slo"):
            spec += [("slo", "log")]
    return spec


def _scale_at(d2, which, k):
    """Valeur de la table de vitesse (att/rel) au bouton k (interpolation log)."""
    kn, sc = d2.get(which + "_knob"), d2.get(which + "_scale")
    if not sc:
        return 1.0
    if kn is None:   # Vox Strip : 5 positions
        return float(sc[int(k)])
    return ac.interp_log(kn, sc, k)


def d2_to_theta(d2, group):
    comps = d2["comps"]
    fr = [max(c[0], 1e-4) for c in comps]
    det = d2.get("det") or [0, 0.0, 0.0, 0]
    out = []
    for name, kind in theta_spec(group):
        k = int(name[-1]) if name[-1].isdigit() else None
        if name.startswith("z"):
            if d2.get("max"):
                out.append(_isig(min(max(fr[k], 1e-4), 1 - 1e-4), 0.0, 1.0))
            else:
                out.append(math.log(fr[k] / fr[0]))
        elif name.startswith("att"):
            out.append(math.log(comps[k][1]))
        elif name.startswith("alpha"):
            out.append(_isig(comps[k][2], *kind))
        elif name.startswith("rel"):
            out.append(math.log(comps[k][3] if comps[k][3] > 0 else 1e6))
        elif name.startswith("beta"):
            out.append(_isig(comps[k][4], *kind))
        elif name.startswith("lin"):
            out.append(math.log(comps[k][5] if comps[k][5] > 0 else 0.0019))
        elif name.startswith("slew"):
            out.append(math.log(comps[k][8] if len(comps[k]) > 8 and comps[k][8] > 0 else 65.0))
        elif name.startswith("ea"):
            out.append(_isig(comps[k][6], *kind))
        elif name.startswith("er"):
            out.append(_isig(comps[k][7], *kind))
        elif name == "ant":
            out.append(_isig(d2.get("ant", 0.0), *kind))
        elif name == "thr":
            out.append(_isig(d2.get("thr_db", 0.0), *kind))
        elif name == "datt":
            out.append(math.log(det[1] if det[1] > 0 else 0.0019))
        elif name == "drel":
            out.append(math.log(det[2] if det[2] > 0 else 0.0019))
        elif name == "hold":
            out.append(math.log(d2["hold_ms"] if d2.get("hold_ms", 0.0) > 0 else 0.045))
        elif name.startswith("sa_"):
            out.append(math.log(max(_scale_at(d2, "att", float(name[3:])), 1e-4)))
        elif name.startswith("sr_"):
            out.append(math.log(max(_scale_at(d2, "rel", float(name[3:])), 1e-4)))
        elif name == "slo":
            out.append(math.log(max(d2.get("slo_scale", 0.1), 1e-4)))
    return np.array(out)


def theta_to_d2(th, group, base):
    d2 = copy.deepcopy(base)
    comps = [list(c) for c in d2["comps"]]
    z = [0.0, 0.0, 0.0]
    det = list(d2.get("det") or [0, 0.0, 0.0, 0])
    for (name, kind), v in zip(theta_spec(group), th):
        v = float(v)
        k = int(name[-1]) if name[-1].isdigit() else None
        if name.startswith("z"):
            z[k] = v
        elif name.startswith("att"):
            comps[k][1] = math.exp(v)
        elif name.startswith("alpha"):
            comps[k][2] = _sig(v, *kind)
        elif name.startswith("rel"):
            comps[k][3] = math.exp(v) if math.exp(v) < 5e5 else 0.0
        elif name.startswith("beta"):
            comps[k][4] = _sig(v, *kind)
        elif name.startswith("lin"):
            lv = math.exp(v)
            comps[k][5] = lv if lv > 2e-3 else 0.0
        elif name.startswith("slew"):
            while len(comps[k]) < 9:
                comps[k].append(1.0 if len(comps[k]) in (6, 7) else 0.0)
            sv = math.exp(v)
            comps[k][8] = sv if sv < 60.0 else 0.0
        elif name.startswith("ea"):
            comps[k][6] = _sig(v, *kind)
        elif name.startswith("er"):
            comps[k][7] = _sig(v, *kind)
        elif name == "ant":
            d2["ant"] = _sig(v, *kind)
        elif name == "thr":
            d2["thr_db"] = _sig(v, *kind)
        elif name == "datt":
            det[1] = math.exp(v) if math.exp(v) > 2e-3 else 0.0
        elif name == "drel":
            det[2] = math.exp(v) if math.exp(v) > 2e-3 else 0.0
        elif name == "hold":
            d2["hold_ms"] = math.exp(v) if math.exp(v) > 0.05 else 0.0
    an = GROUPS[group].get("anchors")
    if an:
        vals = {n: float(v) for (n, _), v in zip(theta_spec(group), th)}
        for which, key in (("att", "sa_"), ("rel", "sr_")):
            ks = an[which]
            sc = [1.0 if k == an["ref_" + which] else math.exp(vals[f"{key}{k}"]) for k in ks]
            if an.get("pos5"):
                d2[which + "_scale"] = sc
                d2.pop(which + "_knob", None)
            else:
                d2[which + "_knob"] = [float(k) for k in ks]
                d2[which + "_scale"] = sc
        if an.get("slo"):
            d2["slo_scale"] = math.exp(vals["slo"])
    if d2.get("max"):
        comps[0][0] = 1.0
        for k in (1, 2):
            comps[k][0] = float(_sig(z[k], 0.0, 1.0))
    else:
        ez = np.exp(np.array(z) - max(z))
        fr = ez / ez.sum()
        for k in range(3):
            comps[k][0] = float(fr[k])
    d2["comps"] = comps
    d2["det"] = det
    return d2


# ── Données ────────────────────────────────────────────────────────────────
class MonoProc:
    def __init__(self, build):
        self.build = build
        self.cfg = None

    def configure(self, settings):
        self.cfg = self.build(settings)
        return settings

    def run(self, x):
        P, l0, dl, tab = self.cfg
        y, _ = ac.process(np.ascontiguousarray(x[:1], dtype=np.float64), P, float(l0), float(dl),
                          np.ascontiguousarray(tab, dtype=np.float64))
        y = ac.compensate(y, P)
        return np.vstack([y[0], y[0]])


def load_real(group, roles=("fit",)):
    g = GROUPS[group]
    banc = banc_mod(g["banc"])
    out = []
    for e in sets(g["banc"]):
        if e["role"] not in roles or e["name"] not in g["real"]:
            continue
        fn = os.path.join(LABO, banc.ID, "tour2", "vst", f"{e['name']}__{e['sig']}.npy")
        if not os.path.exists(fn):
            continue
        path, off, sec = SIG[e["sig"]]
        x = bench.load_audio(path, sec, off, e["rms_db"])
        y = np.load(fn).astype(np.float64)
        n = min(x.shape[1], y.shape[1])
        out.append({"name": e["name"], "sig": e["sig"], "settings": e["settings"], "x": np.ascontiguousarray(x[:1, :n]),
                    "y": y[0, :n], "w": W_DRUM if e["sig"] == "D" else 1.0})
    return out


def load_harm(group):
    """Harmoniques EN COMPRESSION (modulation du gain par la cellule) : tests mesurés."""
    g = GROUPS[group]
    banc = banc_mod(g["banc"])
    M = json.load(open(os.path.join(LABO, banc.ID, "mesures.json"), encoding="utf-8"))
    defs = {c["name"]: c for c in banc.CASES}
    out = []
    for cn, tn in g.get("harm", []):
        t = next(t for t in defs[cn]["tests"] if t.get("name") == tn)
        rows = M[cn]["tests"][tn]["rows"]
        out.append({"settings": defs[cn]["settings"], "freq": t["freq"], "dur": t.get("dur", 2.5), "rows": rows})
    for cn, tn in g.get("stat", []):
        if cn not in defs or cn not in M:
            continue
        t = next(t for t in defs[cn]["tests"] if t.get("name") == tn)
        rows = M[cn]["tests"][tn]["rows"][::2]
        out.append({"settings": defs[cn]["settings"], "freq": t["freq"], "dur": t.get("dur", 2.5), "rows": rows, "stat": True})
    return out


def load_steps(group):
    g = GROUPS[group]
    banc = banc_mod(g["banc"])
    out = []
    carto = os.path.join(LABO, banc.ID, "mesures_carto.json")
    C = json.load(open(carto, encoding="utf-8")) if os.path.exists(carto) else {}
    M = json.load(open(os.path.join(LABO, banc.ID, "mesures.json"), encoding="utf-8"))
    defs = {c["name"]: c for c in list(getattr(banc, "CARTO", [])) + list(banc.CASES)}
    names = list(g.get("steps", [])) + list(g.get("steps_cases", []))
    for nm in names:
        src = C.get(nm) or M.get(nm)
        if not src or nm not in defs:
            continue
        for t in defs[nm]["tests"]:
            if t["type"] != "step_response":
                continue
            r = src["tests"].get(t["name"])
            if not r or "gr_curve_ms" not in r:
                continue
            out.append({"case": nm, "test": t, "settings": defs[nm]["settings"], "curve": np.array(r["gr_curve_ms"])})
    return out


# ── Coût ───────────────────────────────────────────────────────────────────
_W = {}


def _init_worker(group, base_d2):
    g = GROUPS[group]
    prof = import_prof(g["prof"])
    _W["group"] = group
    _W["prof"] = prof
    _W["banc"] = banc_mod(g["banc"])
    _W["real"] = load_real(group)
    _W["steps"] = load_steps(group)
    _W["harm"] = load_harm(group)
    _W["fit"] = prof.load_fit()
    set_d2(_W["fit"], g["key"], base_d2)


def evaluate(fit, real, steps, banc, prof, detail=False, lti=True, harm=None):
    build = prof.builder(fit, banc.to_nova)
    proc = MonoProc(build)
    terms = []
    det = []
    for r in real:
        proc.configure(r["settings"])
        P, l0, dl, tab = proc.cfg
        y, _ = ac.process(r["x"], P, float(l0), float(dl), np.ascontiguousarray(tab, dtype=np.float64))
        y = ac.compensate(y, P)[0]
        if not np.all(np.isfinite(y)):
            return 1e3, []
        raw = null_db(r["y"], y)
        cor = null_db(r["y"], lti_correct(r["y"], y)[0]) if (lti and not RAW) else raw
        lev = 20 * math.log10(math.sqrt(np.mean(y ** 2)) / math.sqrt(np.mean(r["y"] ** 2)) + 1e-12)
        terms.append(r["w"] * (cor + 4.0 * abs(lev)))
        det.append((r["name"], r["sig"], round(raw, 2), round(cor, 2), round(lev, 2)))
    serr = []
    for s in steps:
        proc.configure(s["settings"])
        t = s["test"]
        res = bench.step_response(proc, t.get("freq", 1000), t["base_db"], t["step_db"], t["hold"], min(t["rel_obs"], 6.0))
        c = np.array(res["gr_curve_ms"])
        n = min(len(c), len(s["curve"]))
        w = np.ones(n)
        w[:48] = 0.0
        e = float(np.sqrt(np.mean(((c[:n] - s["curve"][:n]) * w) ** 2)))
        serr.append(e)
        det.append((s["case"], t["name"], round(e, 3)))
    herr = []
    sterr = []
    for h in (harm or []):
        proc.configure(h["settings"])
        lv = [r_["in_db"] for r_ in h["rows"]]
        if h.get("stat"):
            sim = bench.tone_levels(proc, h["freq"], lv, dur=h["dur"])
            e_ = [abs(b["ch0"]["out_db"] - a["ch0"]["out_db"]) for a, b in zip(h["rows"], sim["rows"])]
            sterr += e_
            det.append(("stat", h["freq"], round(float(np.max(e_)), 2)))
            continue
        sim = bench.tone_levels(proc, h["freq"], lv, dur=min(h["dur"], 2.0))
        for a, b in zip(h["rows"], sim["rows"]):
            for k in range(2):
                ha, hb = a["ch0"]["harm_rel_db"][k], b["ch0"]["harm_rel_db"][k]
                if max(ha, hb) > -80:
                    herr.append(abs(max(hb, -100) - max(ha, -100)))
        det.append(("harm", h["freq"], round(float(np.mean(herr)) if herr else 0.0, 2)))
    wr = sum(r["w"] for r in real) or 1.0
    cost = (sum(terms) / wr) + (6.0 * float(np.mean(serr)) if serr else 0.0) + (0.15 * float(np.mean(herr)) if herr else 0.0)         + (4.0 * float(np.mean(sterr)) + 2.0 * float(np.max(sterr)) if sterr else 0.0)
    return cost, det


def _cost_worker(th):
    group = _W["group"]
    g = GROUPS[group]
    fit = copy.deepcopy(_W["fit"])
    base = get_d2(fit, g["key"])
    d2 = theta_to_d2(th, group, base)
    set_d2(fit, g["key"], d2)
    try:
        c, _ = evaluate(fit, _W["real"], _W["steps"], _W["banc"], _W["prof"], harm=_W["harm"])
    except Exception:
        c = 1e3
    return c if np.isfinite(c) else 1e3


def initial_d2(group, fit):
    g = GROUPS[group]
    d2 = get_d2(fit, g["key"])
    if d2:
        return d2
    bf = os.path.join(LABO, banc_mod(g["banc"]).ID, "tour2", f"best_{group}_sq0.json")
    if os.path.exists(bf):
        return json.load(open(bf, encoding="utf-8"))["d2"]
    if group in ("cl1b_man", "cl1b_fm"):
        # départ = temps du tour 1 (par position de bouton), traduits en cellule dB
        an = g["anchors"]
        rs = np.asarray(fit["rel_slew"], float)
        relk = list(range(11))
        lin_ref = 8.686 * float(np.interp(an["ref_rel"], relk, rs))   # A/s -> dB/s (à A = 1 ; exp(-0,115 g) ensuite)
        if group == "cl1b_man":
            ak, am = fit["att_knob"], fit["att_ms"]
            a_ref = ac.interp_log(ak, am, an["ref_att"])
            d2 = {"comps": [[0.85, a_ref, 0.0, 0.0, -0.115, lin_ref, 1.0, 1.0, 0.0],
                            [0.1, 30.0, 0.0, 500.0, 0.0, 0.0, 0.5, 0.5, 0.0],
                            [0.05, 300.0, 0.0, 3000.0, 0.0, 0.0, 0.2, 0.2, 0.0]],
                  "ant": 0.0, "thr_db": 0.0, "det": [0, 0.0, float(fit.get("det_rel_ms", 0.0)), int(fit.get("rect_half", 1))],
                  "att_knob": [float(k) for k in an["att"]], "att_scale": [a_ref / ac.interp_log(ak, am, k) for k in an["att"]],
                  "rel_knob": [float(k) for k in an["rel"]], "rel_scale": [float(np.interp(k, relk, rs)) / float(np.interp(an["ref_rel"], relk, rs)) for k in an["rel"]]}
        else:
            fk, fa = fit["fm_knob"], fit["fm_att_ms"]
            a_ref = ac.interp_log(fk, fa, an["ref_att"])
            fast_lin = 8.686 * fit.get("fast_rel_slew", 3000.0)
            d2 = {"max": 1,
                  "comps": [[1.0, fit.get("fast_att_ms", 0.8), 0.0, 0.0, -0.115, fast_lin, 0.0, 0.0, 0.0],
                            [0.95, a_ref, 0.0, 0.0, -0.115, lin_ref, 1.0, 1.0, 0.0],
                            [0.3, 300.0, 0.0, 3000.0, 0.0, 0.0, 0.2, 0.2, 0.0]],
                  "ant": 0.0, "thr_db": 0.0, "det": [0, 0.0, fit.get("fast_det_rel_ms", 2.0), int(fit.get("rect_half", 1))],
                  "att_knob": [float(k) for k in an["att"]], "att_scale": [a_ref / ac.interp_log(fk, fa, k) for k in an["att"]],
                  "rel_knob": [float(k) for k in an["rel"]], "rel_scale": [float(np.interp(k, relk, rs)) / float(np.interp(an["ref_rel"], relk, rs)) for k in an["rel"]]}
        return d2
    d2 = {"comps": copy.deepcopy(INIT_COMPS), "ant": 0.0, "thr_db": 0.0, "det": [0, 0.0, 0.0, int(fit.get("rect_half", 0))]}
    kn = g["knobs"]
    if "att" in kn:
        d2["att_knob"] = [float(k) for k in kn["att"]]
        d2["att_scale"] = [1.0] * len(kn["att"])
        d2["rel_knob"] = [float(k) for k in kn["rel"]]
        d2["rel_scale"] = [1.0] * len(kn["rel"])
        if group == "fet76":
            d2["slo_scale"] = 0.1
            a = np.asarray(fit["att_ms"], float)
            r = np.asarray(fit["rel_ms"], float)
            i4 = list(fit["att_knob"]).index(4.0)
            d2["att_scale"] = (a[i4] / a).tolist()
            d2["rel_scale"] = (r[i4] / r).tolist()
            d2["slo_scale"] = float(a[i4] / fit["slo_att_ms"])
        if group == "cl1b_man":
            rs = np.asarray(fit["rel_slew"], float)
            d2["rel_scale"] = (rs / rs[3]).tolist()
        if group == "cl1b_fm":
            rs = np.asarray(fit["rel_slew"], float)
            d2["rel_scale"] = (rs / rs[3]).tolist()
            fa = np.asarray(fit["fm_att_ms"], float)
            d2["att_scale"] = (fa[2] / fa).tolist()
    if "att5" in kn:
        d2["att_scale"] = [4.0, 2.0, 1.0, 0.5, 0.25]
        d2["rel_scale"] = [4.0, 2.0, 1.0, 0.5, 0.25]
    return d2


def run_cma(group, gens, workers, sigma=0.6, popsize=None, sq=None, reinit=False, tag="", fb=None):
    import cma
    from multiprocessing import Pool
    g = GROUPS[group]
    prof = import_prof(g["prof"])
    fit = prof.load_fit()
    if reinit:
        set_d2(fit, g["key"], None)
    d2 = initial_d2(group, fit)
    if fb is not None:
        d2 = copy.deepcopy(d2)
        d2["fb"] = int(fb)
    if sq is not None:
        d2 = copy.deepcopy(d2)
        d2["det"] = list(d2.get("det") or [0, 0.0, 0.0, 0])
        d2["det"][0] = int(sq)
    th0 = d2_to_theta(d2, group)
    best_file = os.path.join(LABO, banc_mod(g["banc"]).ID, "tour2", f"best_{group}{tag}.json")
    es = cma.CMAEvolutionStrategy(th0.tolist(), sigma, {"popsize": popsize or (8 + int(3 * math.log(len(th0)))), "maxiter": gens,
                                                         "verbose": -9, "tolfun": 1e-4})
    log = open(os.path.join(LABO, banc_mod(g["banc"]).ID, "tour2", f"cma_{group}{tag}.log"), "a", encoding="utf-8")
    best = (None, 1e9)
    t0 = time.time()
    with Pool(workers, initializer=_init_worker, initargs=(group, d2)) as pool:
        while not es.stop():
            X = es.ask()
            F = pool.map(_cost_worker, X)
            es.tell(X, F)
            i = int(np.argmin(F))
            if F[i] < best[1]:
                best = (np.array(X[i]), F[i])
                with open(best_file, "w", encoding="utf-8") as bf:
                    json.dump({"cost": float(F[i]), "d2": theta_to_d2(best[0], group, d2)}, bf, indent=1)
            log.write(f"{time.strftime('%H:%M:%S')} it {es.countiter} best {best[1]:.3f} gen_min {min(F):.3f} ({time.time() - t0:.0f}s)\n")
            log.flush()
    log.close()
    return best


def report(group, roles=("fit", "val")):
    g = GROUPS[group]
    prof = import_prof(g["prof"])
    fit = prof.load_fit()
    banc = banc_mod(g["banc"])
    real = load_real(group, roles)
    steps = load_steps(group)
    c, det = evaluate(fit, real, steps, banc, prof, harm=load_harm(group))
    print(group, "coût", round(c, 3))
    for d in det:
        print("  ", d)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("group")
    ap.add_argument("--gens", type=int, default=120)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--sigma", type=float, default=0.6)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--sq", type=int, default=None)
    ap.add_argument("--reinit", action="store_true")
    ap.add_argument("--tag", default="")
    ap.add_argument("--fb", type=int, default=None)
    ap.add_argument("--apply", default=None, help="étiquette du meilleur calage à écrire dans le profil")
    a = ap.parse_args()
    if a.apply is not None:
        g = GROUPS[a.group]
        prof = import_prof(g["prof"])
        b = json.load(open(os.path.join(LABO, banc_mod(g["banc"]).ID, "tour2", f"best_{a.group}{a.apply}.json"), encoding="utf-8"))
        fit = prof.load_fit()
        set_d2(fit, g["key"], b["d2"])
        prof.save_fit(fit)
        print("appliqué", a.group, a.apply, b["cost"])
        report(a.group)
    elif a.report:
        report(a.group)
    else:
        best = run_cma(a.group, a.gens, a.workers, a.sigma, sq=a.sq, reinit=a.reinit, tag=a.tag, fb=a.fb)
        print("meilleur coût", best[1])
