#!/usr/bin/env python3
"""
Hôte VST3 natif : coût du passage par un autre processus (mémoire partagée + événements),
mesuré bloc par bloc, contre pedalboard (même plugin, même boucle, dans le processus).

Pour chaque bloc de 128 échantillons (le bloc temps réel du DAW, 2,67 ms à 48 kHz) :
  - temps total de l'appel vu du pont (Python) ;
  - temps passé dans process() du plugin (mesuré dans l'hôte) ;
  - surcoût = total − plugin (aller-retour mémoire partagée + réveil des fils + numpy).
La latence en échantillons n'augmente pas : l'appel est synchrone (le bloc revient traité
dans le même tour), seule la marge de temps du bloc est consommée.

Usage : python qa/vst_native_charge.py [--plugin cl1b] [--blocks 3000] [--out DIR]
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vst_native_parite as par  # noqa: E402


def pct(v, q):
    import numpy as np
    return round(float(np.percentile(np.asarray(v), q)), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plugin", default="cl1b")
    ap.add_argument("--blocks", type=int, default=3000)
    ap.add_argument("--out", default=os.path.join(par.OUT_DEFAULT, "charge"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    par.below_normal()
    os.environ.setdefault("NOVA_VST_HOST_PRIORITY", "below_normal")
    sys.path.insert(0, par.BRIDGE)
    import numpy as np
    import vst_native
    spec = par.PLUGINS[a.plugin]
    sig = par.test_signal(a.blocks * 128 / par.SR + 0.1)
    res = {"plugin": spec["label"], "blocks": a.blocks, "block": 128}

    # Natif
    p = vst_native.load_plugin(spec["path"], spec.get("plugin_name"))
    p.process(np.zeros((2, 128), np.float32), par.SR, 128, reset=True)
    tot, plug = [], []
    for i in range(a.blocks):
        x = sig[:, i * 128:(i + 1) * 128]
        t = time.perf_counter()
        p.process(x, par.SR, 128, reset=False)
        tot.append((time.perf_counter() - t) * 1e6)
        plug.append(p.last_process_us)
    over = [t - q for t, q in zip(tot, plug)]
    res["native"] = {"total_us": {"p50": pct(tot, 50), "p95": pct(tot, 95), "p99": pct(tot, 99), "max": round(max(tot), 1)},
                     "plugin_us_p50": pct(plug, 50), "overhead_us": {"p50": pct(over, 50), "p95": pct(over, 95), "p99": pct(over, 99)},
                     "block_budget_pct_p50": round(pct(tot, 50) / (128 / par.SR * 1e6) * 100, 2)}
    p.close()

    # pedalboard
    try:
        from pedalboard import load_plugin
        if spec.get("plugin_name"):
            q = load_plugin(spec["path"], plugin_name=spec["plugin_name"])   # shell Waves : lent sans l'hôte natif
        else:
            try:
                q = load_plugin(spec["path"])
            except ImportError:      # 1er « scan » de la session parfois refusé (comme dans vst_host) : un nouvel essai
                q = load_plugin(spec["path"])
        q.process(np.zeros((2, 128), np.float32), par.SR, buffer_size=128, reset=True)
        tq = []
        for i in range(a.blocks):
            x = sig[:, i * 128:(i + 1) * 128]
            t = time.perf_counter()
            q.process(x, par.SR, buffer_size=128, reset=False)
            tq.append((time.perf_counter() - t) * 1e6)
        res["pedalboard"] = {"total_us": {"p50": pct(tq, 50), "p95": pct(tq, 95), "p99": pct(tq, 99), "max": round(max(tq), 1)},
                             "block_budget_pct_p50": round(pct(tq, 50) / (128 / par.SR * 1e6) * 100, 2)}
    except Exception as e:  # noqa: BLE001
        res["pedalboard"] = {"error": str(e)}
    json.dump(res, open(os.path.join(a.out, f"charge_{a.plugin}.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps(res, indent=1, ensure_ascii=False), flush=True)
    os._exit(0)


if __name__ == "__main__":
    main()
