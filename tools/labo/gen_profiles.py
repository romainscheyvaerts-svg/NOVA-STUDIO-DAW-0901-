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
        return float(f"{x:.6g}")
    if isinstance(x, list):
        return [r6(v) for v in x]
    if isinstance(x, dict):
        return {k: r6(v) for k, v in x.items()}
    return x


def opto_vintage():
    from modeles import cl1b_profil as prof
    fit = prof.load_fit()
    return {
        "source": "Mesures labo NOVA du Tube-Tech CL 1B mk II (Softube), 08/10/2026",
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


GENERATORS = {"OPTO_VINTAGE": opto_vintage}


def main():
    profiles = {}
    for k, g in GENERATORS.items():
        try:
            profiles[k] = r6(g())
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
