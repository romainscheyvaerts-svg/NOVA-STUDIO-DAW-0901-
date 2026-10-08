"""Génère engine/analogProfiles.ts (tables mesurées des compresseurs NOVA)
à partir des calages du labo (tools/labo/modeles/*_fit.json).
Usage : python gen_profiles.py"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))


def r6(x):
    if isinstance(x, float):
        return float(f"{x:.10g}")
    if isinstance(x, list):
        return [r6(v) for v in x]
    if isinstance(x, dict):
        return {k: r6(v) for k, v in x.items()}
    return x


def opto_vintage():
    from modeles import cl1b_profil as prof
    fit = prof.load_fit()
    return {
        "source": "Mesures labo NOVA (compresseur optique à tubes de référence), 08/10/2026",
        "l0": prof.L0, "dl": prof.DL,
        "thrKnob": prof.THR_KNOB, "thr1db": fit["thr_1db"],
        "ratioKnob": prof.RATIO_KNOB, "tables": fit["tables"],
        "attKnob": fit["att_knob"], "attMs": fit["att_ms"], "attSlew": fit["att_slew_k"],
        "relSlew": fit["rel_slew"],
        "rectHalf": int(fit["rect_half"]), "detRelMs": fit["det_rel_ms"],
        "fixAttMs": fit["fix_att_ms"], "fixRelSlew": fit["fix_rel_slew"], "fixDetRelMs": fit.get("fix_det_rel_ms", 0),
        "fmDelayMs": fit["fm_delay_ms"], "cellRelFollowMs": fit.get("cell_rel_follow_ms", 0.5),
        "outKnob": prof.OUT_KNOB, "outDb": prof.OUT_DB,
        "vintageGainDb": fit.get("vintage_gain_db", 0.0), "vintageEq": fit.get("vintage_eq"),
        "scFilters": fit.get("sc_filters", {}),
        "fmKnob": fit.get("fm_knob"), "fmAttMs": fit.get("fm_att_ms"),
        "fastAttMs": fit.get("fast_att_ms"), "fastRelSlew": fit.get("fast_rel_slew"),
        "fastDetRelMs": fit.get("fast_det_rel_ms"),
        # temps mesurés (t63, saut de 15 / 25 dB) : affichage seulement
        "attT63Ms": [1.0, 1.0, 1.0, 2.1, 6.4, 9.4, 10.9, 13.9, 20.4, 31.9, 48.9, 68.4, 87.4, 135.9, 191.9, 225.9],
        "relT63Ms": [23, 36, 84, 182, 351, 584, 863, 1353, 2359, 4118, 4806],
    }


def fet76():
    from modeles import fet76_profil as prof
    f = prof.load_fit()
    return {
        "source": "Mesures labo NOVA (compresseur FET de référence), 08/10/2026",
        "l0": prof.L0, "dl": prof.DL, "ratios": prof.RATIOS, "tables": f["tables"],
        "inKnob": f["in_knob"], "inGainDb": f["in_gain_db"], "outKnob": f["out_knob"], "outGainDb": f["out_gain_db"],
        "tRefDb": f["t_ref_db"], "rectHalf": int(f["rect_half"]), "detRelMs": f["det_rel_ms"],
        "attKnob": f["att_knob"], "attMs": f["att_ms"], "sloAttMs": f["slo_att_ms"],
        "relKnob": f["rel_knob"], "relMs": f["rel_ms"],
        "slowFrac": f.get("slow_frac", 0.0), "slowAttMs": f.get("slow_att_ms", 300.0), "slowRelK": f.get("slow_rel_k", 1.0),
        "outA2": f["out_a2"], "outA3": f["out_a3"], "outSat": f["out_sat"], "outBias": f["out_bias"], "outAb": f.get("out_ab", 0.0),
        "fetA2": f["fet_a2"], "finalSat": f.get("final_sat", 0.0), "eq": f.get("eq", []),
        # temps mesurés (t63, saut de 40 dB à 2 kHz / 1 kHz) : affichage seulement
        "attT63Ms": [2.54, 2.2, 1.94, 1.75, 1.52, 1.3, 1.04, 0.9, 0.69, 0.55, 0.4, 0.25, 0.12], "sloT63Ms": 10.6,
        "relT63Ms": [1061, 1030, 1002, 900, 798, 690, 587, 470, 357, 220, 95, 85, 77],
    }


def leveler2a():
    from modeles import la2a_profil as prof
    f = prof.load_fit()
    return {
        "source": "Mesures labo NOVA (nivelleur optique de référence), 08/10/2026",
        "l0": prof.L0, "dl": prof.DL,
        "prKnob": prof.PR_KNOB, "thrPr": f["thr_pr"], "tablesPr": f["tables_pr"],
        "limKnob": prof.LIM_KNOB, "thrLim": f["thr_lim"], "tablesLim": f["tables_lim"],
        "emphKnob": prof.EMPH_KNOB, "sc": f["sc"],
        "gainKnob": f["gain_knob"], "gainDb": f["gain_db"],
        "outA2": f["out_a2"], "outA3": f["out_a3"], "outSat": f["out_sat"], "outBias": f["out_bias"],
        "outAb": f.get("out_ab", 0.0), "outKnee": f.get("out_knee", 0.0), "eq": f.get("eq", []),
        "rectHalf": int(f["rect_half"]), "detRelMs": f["det_rel_ms"],
        "attMs": f["att_ms"], "relMs": f["rel_ms"], "slowFrac": f["slow_frac"], "slowAttMs": f["slow_att_ms"],
        "slowRelMs": f["slow_rel_ms"],
    }


def voxstrip():
    from modeles import voxbox_profil as prof
    f = prof.load_fit()
    return {
        "source": "Mesures labo NOVA (tranche voix à lampes de référence), 08/10/2026",
        "l0": prof.L0, "dl": prof.DL, "defaults": prof.DEFAULT_NOVA,
        "inKnob": f["in_knob"], "inGainDb": f["in_gain_db"],
        "thKnob": prof.TH_KNOB, "thrTh": f["thr_th"], "tablesTh": f["tables_th"],
        "attMs": f["att_ms"], "relMs": f["rel_ms"],
        "slowFrac": f["slow_frac"], "slowAttMs": f["slow_att_ms"], "slowRelMs": f["slow_rel_ms"],
        "outA2": f["out_a2"], "outA3": f["out_a3"], "outSat": f["out_sat"], "outBias": f["out_bias"],
        "outAb": f["out_ab"], "outKnee": f["out_knee"], "xfK": f["xf_k"], "xfFc": f["xf_fc"], "xfMode": f.get("xf_mode", 0), "eqBase": f["eq_base"],
        "lo": f["lo"], "mid": f["mid"], "hi": f["hi"], "loKind": f["lo_kind"], "midKind": f["mid_kind"], "hiKind": f["hi_kind"],
        "loF": prof.LO_F, "midF": prof.MID_F, "hiF": prof.HI_F,
        "lowcutFc": f.get("lowcut_fc") or {},
    }


GENERATORS = {"OPTO_VINTAGE": opto_vintage, "FET76": fet76, "LEVELER2A": leveler2a, "VOXSTRIP": voxstrip}


def main():
    profiles = {}
    mods = {"OPTO_VINTAGE": "cl1b_profil", "FET76": "fet76_profil", "LEVELER2A": "la2a_profil", "VOXSTRIP": "voxbox_profil"}
    import importlib
    for k, g in GENERATORS.items():
        try:
            prof = g()
            # tour 2 : cellule multi-composantes (dB) et correction linéaire mesurée (module + phase)
            fit = importlib.import_module("modeles." + mods[k]).load_fit()
            for key in ("dyn2", "dyn2_lim", "lti", "lat", "ws"):
                if fit.get(key):
                    prof[key] = fit[key]
            profiles[k] = r6(prof)
        except Exception as e:  # noqa: BLE001
            print("profil ignoré", k, e)
    lines = ["/**",
             " * Profils mesurés des compresseurs analogiques NOVA (fichier GÉNÉRÉ par",
             " * tools/labo/gen_profiles.py à partir des calages du labo : ne pas éditer à la main).",
             " * Modélisation boîte noire : uniquement des mesures acoustiques des plugins d'origine.",
             " */",
             "/* eslint-disable */",
             "export const ANALOG_PROFILES: Record<string, any> = " + json.dumps(profiles, ensure_ascii=False) + ";",
             ""]
    dest = os.path.join(REPO, "engine", "analogProfiles.ts")
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print("écrit", dest, os.path.getsize(dest), "octets")


if __name__ == "__main__":
    main()
