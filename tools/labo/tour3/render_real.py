"""
Tour 3 : rendus de VRAIS signaux par le VST d'origine (hors ligne, sans fenêtre)
aux réglages de Romain, y compris « réduction cible » (règle maison : 5 dB au
VU sur les pistes, 2 dB pour le Leveler de bus) calée par dichotomie comme le
pont (bridge-python/gr_calibration).

Sortie : <labo>/<id>/tour3/vst/<nom>__<signal>.npy + jobs.json (réglages résolus).
Usage : python -m tour3.render_real <banc>
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "..", "..", "bridge-python"))
from tour3 import lowprio  # noqa: E402
import bench  # noqa: E402
import host  # noqa: E402
import gr_calibration as gc  # noqa: E402
from tour2.common import banc_mod, LABO  # noqa: E402
from tour2.sets import SIG  # noqa: E402

SR = 48000
FIT, VAL = ("V1", "V4"), ("V2", "V3")

# nom, réglages, niveau RMS, calage (paramètre, bas, haut, sens, cible dB) ou None
JOBS = {
    "cl1b": [
        ("fm5", {"ratio": "4:1", "attack": 3.0, "release": 3.0, "select_attack_release": "F/M"}, -20,
         ("threshold_db", -41.0, 2.0, -1, 5.0)),
        ("man_romain", {"threshold_db": -27.0, "ratio": "4:1", "attack": 3.0, "release": 3.0, "select_attack_release": "Man",
                        "output_volume_db": 6.0}, -20, None),
        ("man5", {"ratio": "4:1", "attack": 3.0, "release": 3.0, "select_attack_release": "Man"}, -20,
         ("threshold_db", -41.0, 2.0, -1, 5.0)),
    ],
    "fet76": [
        ("bus5", {"ratio": "4:1", "attack": 4.0, "release": 4.0, "output": -15.0}, -16, ("input", -60.0, 0.0, 1, 5.0)),
    ],
    "voxbox": [
        ("voix5", {"comp_byp": "In", "comp_attack": "Medium", "comp_rel": "Medium"}, -20, ("comp_thresh", 0.0, 10.0, 1, 5.0)),
    ],
    "la2a": [
        ("bus2", {"gain": "25", "comp_limit": "Comp"}, -14, ("peak_reduct", 0.0, 100.0, 1, 2.0)),
    ],
}


def main(bn):
    host.hide_console()
    banc = banc_mod(bn)
    out = os.path.join(LABO, banc.ID, "tour3", "vst")
    os.makedirs(out, exist_ok=True)
    jf = os.path.join(out, "jobs.json")
    done = json.load(open(jf, encoding="utf-8")) if os.path.exists(jf) else {}
    pl = host.open_plugin(banc.PLUGIN)
    for name, st, rms, cal in JOBS[bn]:
        settings = dict(banc.BASE)
        settings.update(st)
        host.set_params(pl, settings)
        if cal and name not in done:
            p, lo, hi, sense, target = cal
            x = bench.load_audio(SIG["V1"][0], SIG["V1"][2], SIG["V1"][1], rms).astype(np.float32)
            r = gc.calibrate_plugin(pl, lambda v: host.set_param(pl, p, float(v)), x, SR, lo, hi, sense, target)
            st = dict(st)
            st[p] = str(getattr(pl, p))
            try:
                st[p] = float(st[p])
            except ValueError:
                pass
            done[name] = {"settings": st, "rms_db": rms, "vu_gr_db": r["gr_db"], "reached": r["reached"]}
        elif name not in done:
            done[name] = {"settings": st, "rms_db": rms}
        st = done[name]["settings"]
        settings = dict(banc.BASE)
        settings.update(st)
        host.set_params(pl, settings)
        for sig in FIT + VAL:
            fn = os.path.join(out, f"{name}__{sig}.npy")
            if os.path.exists(fn):
                continue
            path, off, sec = SIG[sig]
            x = bench.load_audio(path, sec, off, rms)
            pre = int(0.05 * SR)
            xx = np.concatenate([np.zeros((2, pre)), x], axis=1)
            y = host.process(pl, xx, SR, block=512, reset=True)[:, pre:pre + x.shape[1]]
            np.save(fn, y.astype(np.float32))
        with open(jf, "w", encoding="utf-8") as f:
            json.dump(done, f, indent=1, ensure_ascii=False)
        print(name, done[name], flush=True)


def jobs(bn, roles=("fit",)):
    """Entrées « real_extra » pour tour3.fit3 (réglages résolus)."""
    banc = banc_mod(bn)
    jf = os.path.join(LABO, banc.ID, "tour3", "vst", "jobs.json")
    done = json.load(open(jf, encoding="utf-8")) if os.path.exists(jf) else {}
    out = []
    for name, d in done.items():
        for sig in FIT + VAL:
            role = "fit" if sig in FIT else "val"
            out.append({"name": name, "sig": sig, "settings": d["settings"], "rms_db": d["rms_db"], "role": role})
    return out


if __name__ == "__main__":
    lowprio()
    main(sys.argv[1])
