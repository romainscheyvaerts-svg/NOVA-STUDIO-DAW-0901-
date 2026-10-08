"""Évalue vite quelques cas du banc CL1B avec le modèle Python (pour les grilles)."""
import json, sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run_bench, compare
from bancs import cl1b as banc
from modeles import cl1b_profil as prof
from modeles.pyproc import ModelProc

M = json.load(open(r"D:/1 WORK/CONTENU/nova-labo/tubetech_cl1b/mesures.json", encoding="utf-8"))

def evaluate(fit, cases):
    proc = ModelProc(prof.builder(fit, None))
    out = {}
    for case in banc.CASES:
        if case["name"] not in cases: continue
        proc.configure(banc.to_nova(case["settings"]))
        for t in case["tests"]:
            name = t.get("name") or t["type"]
            if cases[case["name"]] and name not in cases[case["name"]]: continue
            t = dict(t); t["_out_dir"] = r"D:/1 WORK/CONTENU/nova-labo/tubetech_cl1b/audio_nova_py"; t["_case"] = case["name"]
            out[(case["name"], name)] = compare.diff_test(name, M[case["name"]]["tests"][name], run_bench.run_test(proc, t))
    return out
