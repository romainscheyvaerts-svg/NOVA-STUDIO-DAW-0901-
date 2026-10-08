"""
Passe un banc complet sur un processeur et écrit mesures.json + graphiques.

Usage (toujours caché : pythonw) :
    pythonw run_bench.py <banc> vst            -> D:/1 WORK/CONTENU/nova-labo/<id>/mesures.json
    pythonw run_bench.py <banc> nova           -> .../<id>/mesures_nova.json
    options : --only cas1,cas2   --out dossier
<banc> : nom d'un module de tools/labo/bancs (ex. cl1b).
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
import traceback

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench  # noqa: E402
import host  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo"


def run_test(proc, t):
    k = t["type"]
    if k == "freq_response":
        return bench.freq_response(proc, t["level_db"], T=t.get("T", 3.0))
    if k == "noise_response":
        return bench.noise_response(proc, t["rms_db"], kind=t.get("kind", "pink"))
    if k == "tone_levels":
        r = bench.tone_levels(proc, t["freq"], t["levels"], dur=t.get("dur", 2.5))
        r["static"] = bench.static_summary(r)
        return r
    if k == "step_response":
        return bench.step_response(proc, t.get("freq", 1000), t["base_db"], t["step_db"], t["hold"], t["rel_obs"])
    if k == "bursts":
        return bench.bursts(proc, t.get("freq", 1000), t["base_db"], t["burst_db"], t["burst_ms"], t["period_ms"])
    if k == "stereo_link":
        return bench.stereo_link(proc, t["loud_db"], t["quiet_db"])
    if k == "real_signal":
        x = bench.load_audio(t["path"], t.get("seconds"), t.get("offset", 0.0), t.get("rms_db"))
        y = proc.run(x)
        out_dir = t["_out_dir"]
        os.makedirs(out_dir, exist_ok=True)
        fn = os.path.join(out_dir, f"{t['_case']}__{t['name']}.npy")
        np.save(fn, y.astype(np.float32))
        return {"file": fn, "in_rms_db": float(20 * np.log10(np.sqrt(np.mean(x ** 2)))),
                "out_rms_db": float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)),
                "in_peak_db": float(20 * np.log10(np.max(np.abs(x)))),
                "out_peak_db": float(20 * np.log10(np.max(np.abs(y)) + 1e-12))}
    raise ValueError(k)


def make_proc(banc, which):
    import procs
    if which == "vst":
        return procs.VstProc(banc.PLUGIN, banc.BASE)
    return procs.NodeCoreProc(banc.NOVA_KIND, banc.NOVA_BASE)


def main():
    host.hide_console()
    ap = argparse.ArgumentParser()
    ap.add_argument("banc")
    ap.add_argument("which", choices=["vst", "nova"])
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--carto", action="store_true", help="banc de cartographie (CARTO) au lieu de CASES")
    a = ap.parse_args()
    banc = importlib.import_module(f"bancs.{a.banc}")
    out_dir = a.out or os.path.join(LABO, banc.ID)
    os.makedirs(out_dir, exist_ok=True)
    tag = ("mesures" if a.which == "vst" else "mesures_nova") + ("_carto" if a.carto else "")
    dest = os.path.join(out_dir, f"{tag}.json")
    only = set(x for x in a.only.split(",") if x)
    result = {}
    if only and os.path.exists(dest):
        with open(dest, encoding="utf-8") as f:
            result = json.load(f)
    log = open(os.path.join(out_dir, f"{tag}.log"), "a", encoding="utf-8")
    proc = make_proc(banc, a.which)
    result["_meta"] = {"plugin": getattr(proc, "name", banc.NOVA_KIND if a.which == "nova" else banc.PLUGIN),
                       "latency_reported": proc.latency, "sr": bench.SR, "date": time.strftime("%Y-%m-%d %H:%M")}
    for case in (banc.CARTO if a.carto else banc.CASES):
        if only and case["name"] not in only:
            continue
        t0 = time.time()
        settings = case["settings"] if a.which == "vst" else banc.to_nova(case["settings"])
        applied = proc.configure(settings)
        cres = {"settings": case["settings"], "applied": applied, "tests": {}}
        for t in case["tests"]:
            t = dict(t)
            t["_out_dir"] = os.path.join(out_dir, "audio_" + a.which)
            t["_case"] = case["name"]
            name = t.get("name") or t["type"]
            try:
                cres["tests"][name] = run_test(proc, t)
            except Exception as e:  # noqa: BLE001
                cres["tests"][name] = {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1200:]}
        result[case["name"]] = cres
        log.write(f"{time.strftime('%H:%M:%S')} {case['name']} {time.time() - t0:.1f}s\n")
        log.flush()
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
    proc.close()
    log.write("FIN\n")
    log.close()


if __name__ == "__main__":
    main()
