"""Génère engine/masterTransientProfile.ts à partir des calages du labo
(elevate/transient_fit.json et elevate/limiter_fit.json). Usage : python elevate/gen_profile.py"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
import modele  # noqa: E402


def r(x):
    return float(f"{x:.8g}")


def _r(v):
    if isinstance(v, list):
        return [_r(u) for u in v]
    if isinstance(v, bool) or isinstance(v, int):
        return v
    return r(v) if isinstance(v, float) else v


def build():
    t = dict(modele.DEFAULT)
    fn = os.path.join(HERE, "transient_fit.json")
    if os.path.exists(fn):
        t.update(json.load(open(fn)))
    lim = {"limThrDb": -3.0, "limRelK": 20.0, "limAdaptExp": 0.5, "limRelRefHz": 1000.0, "limFinRelMs": 30.0}
    fl = os.path.join(HERE, "limiter_fit.json")
    if os.path.exists(fl):
        lim.update(json.load(open(fl)))
    # tour 3 : réduction commune dans le temps (coude doux mesuré), égaliseur aux formes mesurées, clipper mesuré
    for extra in ("limiter_td.json", "eq_shapes.json", "clip_fit.json"):
        fe = os.path.join(HERE, extra)
        if os.path.exists(fe):
            lim.update(json.load(open(fe)))
    return {
        "source": "Mesures labo NOVA d'un limiteur de mastering multibande du commerce (boîte noire), 08/10/2026",
        "centers": modele.CENTERS, "emKnob": modele.EM_KNOB, "emPeakDb": modele.EM_PEAK_DB,
        "laMs": r(t["la_ms"]), "afMs": r(t["af_ms"]), "rfMs": r(t["rf_ms"]), "asMs": r(t["as_ms"]), "rsMs": r(t["rs_ms"]),
        "q": r(t["q"]), "d0": r(t["d0"]), "p": r(t["p"]), "wneg": r(t["wneg"]), "holdMs": r(t["hold_ms"]), "gsMs": r(t["gs_ms"]),
        "adK": r(t["ad_k"]), "adP": r(t["ad_p"]), "adBg": r(t["ad_bg"]), "adLtMs": r(t["ad_lt_ms"]), "adSens": r(t.get("ad_sens", 0.0)),
        **{k: _r(v) for k, v in lim.items()},
    }


if __name__ == "__main__":
    prof = build()
    src = ("/**\n * Profil mesuré de l'effet « Mastering Transient » (fichier GÉNÉRÉ par\n"
           " * tools/labo/elevate/gen_profile.py à partir des calages du labo : ne pas éditer à la main).\n"
           " * Modélisation boîte noire : uniquement des mesures acoustiques.\n */\n"
           "import type { MasterTransientProfile } from './masterTransientCore';\n\n"
           "export const MASTER_TRANSIENT_PROFILE: MasterTransientProfile & { source: string } = "
           + json.dumps(prof, ensure_ascii=False) + ";\n")
    with open(os.path.join(REPO, "engine", "masterTransientProfile.ts"), "w", encoding="utf-8") as f:
        f.write(src)
    print("ok", prof)
