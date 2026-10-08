"""Calage du de-esser NOVA (cœur sous Node) sur les vraies voix + salves synthétiques.
Usage : python deess/tune.py '<{tag: réglages}>'"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import mesures as M  # noqa: E402
import salves  # noqa: E402
from bancs import deess as banc  # noqa: E402
from procs_deess import NodeDeess  # noqa: E402

SIB = ["voix_micro", "lead_avant", "stem_voix", "voix_extrait", "vraie_voix", "voix_douce"]
CTRL = ["micro_sec", "strip_1306"]


def summary(p, V, settings):
    p.configure(settings)
    rows = {}
    for k, x in V.items():
        rows[k] = M.voice_metrics(x[0], p.run(x)[0])
    sib = [rows[k] for k in SIB if k in rows]
    s = {
        "s_red": round(float(np.mean([r["reduction_s_db"] for r in sib])), 2),
        "s_p90": round(float(np.mean([r["reduction_s_p90_db"] for r in sib])), 2),
        "aigus_hors_s": round(float(np.mean([r["aigus_hors_s_db"] for r in sib])), 2),
        "null_hors_s": round(float(np.mean([r["null_hors_s_db"] for r in sib])), 1),
        "ctrl_aigus": {k: rows[k]["aigus_hors_s_db"] for k in CTRL if k in rows},
    }
    sv = salves.run(p, levels=(-30.0, -10.0), rels=(-12.0, 0.0))
    s["salves"] = {k: (v["reduction_salve_db"], v["reduction_hors_salve_db"], v["attaque_t63_ms"]) for k, v in sv.items()}
    return s, rows


if __name__ == "__main__":
    V = banc.load_voices()
    p = NodeDeess()
    for tag, st in json.loads(sys.argv[1]).items():
        s, _ = summary(p, V, st)
        print(tag, json.dumps(s, ensure_ascii=False), flush=True)
    p.close()
