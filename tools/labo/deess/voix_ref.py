"""Passe les vraies voix dans un de-esser et mesure (réduction des « s », hors « s »).
Usage : python deess/voix_ref.py deedger|nova_avant|nova_apres [réglages json par rendu]
Sorties : D:/1 WORK/CONTENU/nova-labo/deesser/voix_<proc>.json, audio/<proc>__<voix>__<tag>.npy"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import host  # noqa: E402
import mesures as M  # noqa: E402
from bancs import deess as banc  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\deesser"
AUD = os.path.join(OUT, "audio")
os.makedirs(AUD, exist_ok=True)


def make(which):
    from procs_deess import NodeDeess, NovaDeessChrome, VstDeess
    if which == "nova_node":
        return NodeDeess()
    if which == "deedger":
        return VstDeess(banc.DEEDGER, banc.DEEDGER_BASE)
    if which == "nova_avant":
        return NovaDeessChrome("/plugins/DeEsserPlugin.tsx", "DeEsserNode", name="nova_avant")
    if which == "nova_apres":
        return NovaDeessChrome("/plugins/DeEsserPlugin.tsx", "DeEsserNode", name="nova_apres")
    raise ValueError(which)


def run(which, variants):
    host.hide_console()
    V = banc.load_voices()
    p = make(which)
    fn = os.path.join(OUT, f"voix_{which}.json")
    res = json.load(open(fn, encoding="utf-8")) if os.path.exists(fn) else {}
    for tag, settings in variants.items():
        p.configure(settings)
        for k, x in V.items():
            y = p.run(x)
            np.save(os.path.join(AUD, f"{which}__{k}__{tag}.npy"), y.astype(np.float32))
            m = M.voice_metrics(x[0], y[0])
            res.setdefault(tag, {"reglages": settings})[k] = m
            print(which, tag, k, m, flush=True)
        json.dump(res, open(fn, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    p.close()


if __name__ == "__main__":
    which = sys.argv[1]
    variants = json.loads(sys.argv[2])
    run(which, variants)
