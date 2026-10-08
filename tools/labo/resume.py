"""Résumé texte d'un fichier de mesures (pour lire vite les chiffres)."""
import json
import sys

import numpy as np


def main(path, only=""):
    d = json.load(open(path, encoding="utf-8"))
    print(d.get("_meta"))
    for case, c in d.items():
        if case.startswith("_") or (only and only not in case):
            continue
        print(f"== {case} {c.get('applied') if 'applied' in c else ''}")
        for name, v in c["tests"].items():
            if "error" in v:
                print("  ", name, "ERREUR", v["error"])
                continue
            if "static" in v:
                s = v["static"]
                rows = v["rows"]
                print("  ", name, "in/out/gr/H2/H3/thd:")
                for i, r in enumerate(rows):
                    h = r["ch0"]["harm_rel_db"]
                    print(f"     {r['in_db']:6.1f} {r['ch0']['out_db']:7.2f} gr={s['gr_db'][i]:6.2f}  H2={h[0]:7.1f} H3={h[1]:7.1f} H4={h[2]:7.1f} H5={h[3]:7.1f} thd={r['ch0']['thd_pct']:.4f}%")
            elif name.startswith("fr") or "freqs" in v and "channels" in v and "mag_db" in v["channels"][0]:
                f = np.array(v["freqs"])
                m = np.array(v["channels"][0]["mag_db"])
                pts = [20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000]
                print("  ", name, "retard", v["channels"][0]["delay_samples"], " ".join(f"{p}:{np.interp(p, f, m):+.2f}" for p in pts))
            elif "psd_ratio_db" in str(v)[:5000]:
                f = np.array(v["freqs"])
                m = np.array(v["channels"][0]["psd_ratio_db"])
                pts = [30, 100, 1000, 5000, 10000, 16000]
                print("  ", name, "out_rms", round(v["channels"][0]["out_rms_db"], 2), " ".join(f"{p}:{np.interp(p, f, m):+.2f}" for p in pts))
            elif "attack_ms" in v:
                print(f"   {name}: GRfin={v['gr_hold_end_db']:.2f} att={v['attack_ms']} rel={v['release_ms']} GRrel_end={v['gr_rel_end_db']:.2f}")
            elif "overshoot_db" in v:
                print(f"   {name}: over={np.round(v['overshoot_db'], 2).tolist()} gain={np.round(v['burst_gain_db'], 2).tolist()}")
            else:
                print("  ", name, {k: v[k] for k in v if k not in ("file",)})


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")
