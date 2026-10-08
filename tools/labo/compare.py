"""
Comparateur NOVA / original : passe le MÊME banc sur l'effet NOVA et calcule
les écarts avec les mesures du VST réel.

Usage (caché : pythonw) :
    pythonw compare.py <banc> py      # portage Python (numba) du cœur, pour caler vite
    pythonw compare.py <banc> node    # le cœur TypeScript du moteur NOVA (Node)
    pythonw compare.py <banc> chrome  # le VRAI moteur NOVA (AudioWorklet, Chrome headless) -> preuve finale
    options : --only cas1,cas2  --plots
Sorties : <labo>/<id>/ecarts_<mode>.json et .md, graphiques superposés comparaison_<mode>/*.png
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench  # noqa: E402
import host  # noqa: E402
import run_bench  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo"
FR_BAND = (30.0, 16000.0)


def make_nova_proc(banc, mode):
    if mode == "py":
        prof = importlib.import_module(banc.PY_PROFILE)
        from modeles.pyproc import ModelProc
        return ModelProc(prof.builder(None, None), banc.NOVA_KIND + "-py")
    if mode == "node":
        import procs
        return procs.NodeCoreProc(banc.NOVA_KIND, banc.NOVA_BASE)
    if mode == "chrome":
        import chrome_proc
        return chrome_proc.ChromeProc(banc.NOVA_KIND, banc.NOVA_BASE)
    raise ValueError(mode)


def _t63(d, key):
    v = d.get(key) or {}
    return v.get("t63")


def diff_test(name, vm, vn, out_dir_plots=None, tag=""):
    """Écarts entre un test mesuré (vm, VST) et le même test NOVA (vn)."""
    if "error" in vm or "error" in vn:
        return {"erreur": vm.get("error") or vn.get("error")}
    if "freqs" in vm and "channels" in vm and "mag_db" in vm["channels"][0]:
        f = np.array(vm["freqs"])
        a = np.array(vm["channels"][0]["mag_db"])
        b = np.array(vn["channels"][0]["mag_db"])
        m = (f >= FR_BAND[0]) & (f <= FR_BAND[1])
        return {"type": "fr", "max_abs_db": float(np.max(np.abs(a[m] - b[m]))),
                "rms_db": float(np.sqrt(np.mean((a[m] - b[m]) ** 2))),
                "retard_vst": vm["channels"][0]["delay_samples"], "retard_nova": vn["channels"][0]["delay_samples"]}
    if "psd_ratio_db" in json.dumps(vm)[:20000]:
        f = np.array(vm["freqs"])
        a = np.array(vm["channels"][0]["psd_ratio_db"])
        b = np.array(vn["channels"][0]["psd_ratio_db"])
        m = (f >= FR_BAND[0]) & (f <= FR_BAND[1])
        return {"type": "bruit", "max_abs_db": float(np.max(np.abs(a[m] - b[m]))),
                "rms_db": float(np.sqrt(np.mean((a[m] - b[m]) ** 2)))}
    if "rows" in vm:
        ra, rb = vm["rows"], vn["rows"]
        dout = [rb[i]["ch0"]["out_db"] - ra[i]["ch0"]["out_db"] for i in range(len(ra))]
        hd = []
        for i in range(len(ra)):
            for h in range(2):  # H2, H3
                ha = ra[i]["ch0"]["harm_rel_db"][h]
                hb = rb[i]["ch0"]["harm_rel_db"][h]
                if max(ha, hb) > -90:   # harmonique audible / mesurable
                    hd.append({"in_db": ra[i]["in_db"], "h": h + 2, "vst": ha, "nova": hb, "ecart": hb - ha})
        main = [x for x in hd if max(x["vst"], x["nova"]) > -70]
        return {"type": "statique", "max_abs_db": float(np.max(np.abs(dout))), "ecarts_sortie_db": dout,
                "harmoniques": hd,
                "harm_max_abs_db": float(max([abs(x["ecart"]) for x in main], default=0.0)),
                "in_db": [r["in_db"] for r in ra]}
    if "attack_ms" in vm:
        a = np.array(vm["gr_curve_ms"])
        b = np.array(vn["gr_curve_ms"])
        n = min(len(a), len(b))
        out = {"type": "temps", "gr_rms_db": float(np.sqrt(np.mean((a[:n] - b[:n]) ** 2))),
               "gr_fin_vst": vm["gr_hold_end_db"], "gr_fin_nova": vn["gr_hold_end_db"]}
        for ph, key in (("attaque", "attack_ms"), ("relachement", "release_ms")):
            ta, tb = vm[key].get("t63"), vn[key].get("t63")
            out[f"{ph}_t63_vst_ms"] = ta
            out[f"{ph}_t63_nova_ms"] = tb
            out[f"{ph}_ecart_pct"] = (100.0 * (tb - ta) / ta) if (ta and tb and ta > 0.3) else None
        return out
    if "overshoot_db" in vm:
        return {"type": "salves", "depassement_vst": vm["overshoot_db"][:3], "depassement_nova": vn["overshoot_db"][:3],
                "gain_moyen_ecart_db": float(np.mean(np.array(vn["burst_gain_db"]) - np.array(vm["burst_gain_db"])))}
    if "file" in vm:
        ya = np.load(vm["file"]).astype(np.float64)
        yb = np.load(vn["file"]).astype(np.float64)
        n = min(ya.shape[1], yb.shape[1])
        nd = bench.null_db(ya[:, :n], yb[:, :n])
        # écart de niveau global et null après égalisation du gain (information)
        g = float(np.sum(ya[:, :n] * yb[:, :n]) / max(np.sum(yb[:, :n] ** 2), 1e-30))
        nd_g = bench.null_db(ya[:, :n], g * yb[:, :n])
        return {"type": "null", "null_db": nd, "null_db_gain_egalise": nd_g, "ecart_gain_db": float(20 * np.log10(abs(g) + 1e-12)),
                "rms_vst": vm["out_rms_db"], "rms_nova": vn["out_rms_db"]}
    if "linked" in vm:
        return {"type": "stereo", "vst": vm, "nova": vn}
    return {"type": "autre"}


def main():
    host.hide_console()
    ap = argparse.ArgumentParser()
    ap.add_argument("banc")
    ap.add_argument("mode", choices=["py", "node", "chrome"])
    ap.add_argument("--only", default="")
    ap.add_argument("--carto", action="store_true")
    a = ap.parse_args()
    banc = importlib.import_module(f"bancs.{a.banc}")
    out_dir = os.path.join(LABO, banc.ID)
    meas = json.load(open(os.path.join(out_dir, "mesures_carto.json" if a.carto else "mesures.json"), encoding="utf-8"))
    only = set(x for x in a.only.split(",") if x)
    proc = make_nova_proc(banc, a.mode)
    nova_res = {"_meta": {"proc": proc.name, "mode": a.mode, "date": time.strftime("%Y-%m-%d %H:%M")}}
    ecarts = {}
    for case in (banc.CARTO if a.carto else banc.CASES):
        if only and case["name"] not in only:
            continue
        if case["name"] not in meas:
            continue
        proc.configure(banc.to_nova(case["settings"]))
        cres = {"settings": case["settings"], "tests": {}}
        ecarts[case["name"]] = {}
        for t in case["tests"]:
            t = dict(t)
            t["_out_dir"] = os.path.join(out_dir, "audio_nova_" + a.mode)
            t["_case"] = case["name"]
            name = t.get("name") or t["type"]
            try:
                cres["tests"][name] = run_bench.run_test(proc, t)
            except Exception as e:  # noqa: BLE001
                import traceback
                cres["tests"][name] = {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
            vm = meas[case["name"]]["tests"].get(name)
            if vm is not None:
                ecarts[case["name"]][name] = diff_test(name, vm, cres["tests"][name])
        nova_res[case["name"]] = cres
    proc.close()
    suffix = a.mode + ("_carto" if a.carto else "")
    with open(os.path.join(out_dir, f"mesures_nova_{suffix}.json"), "w", encoding="utf-8") as f:
        json.dump(nova_res, f, ensure_ascii=False)
    with open(os.path.join(out_dir, f"ecarts_{suffix}.json"), "w", encoding="utf-8") as f:
        json.dump(ecarts, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
