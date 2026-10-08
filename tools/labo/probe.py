"""Sonde : quels plugins se chargent hors ligne, leurs paramètres et leur latence.
Usage : pythonw probe.py sortie.json plugin1.vst3 [plugin2.vst3 ...]"""
import json
import os
import sys
import traceback

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host  # noqa: E402

host.hide_console()
out = {}
dest = sys.argv[1]
for name in sys.argv[2:]:
    r = {}
    try:
        pl = host.open_plugin(name)
        r["name"] = getattr(pl, "name", "")
        r["vendor"] = getattr(pl, "manufacturer_name", "")
        r["latency"] = host.latency_of(pl)
        r["params"] = host.describe_params(pl)
        x = (np.random.default_rng(0).standard_normal(48000) * 0.1).astype(np.float32)
        y = host.process(pl, x, 48000)
        r["rms_in"] = float(np.sqrt(np.mean(x ** 2)))
        r["rms_out"] = float(np.sqrt(np.mean(y ** 2)))
        r["windows_after"] = host.visible_windows()
        r["ok"] = True
        del pl
    except Exception as e:  # noqa: BLE001
        r["ok"] = False
        r["error"] = f"{type(e).__name__}: {e}"
        r["trace"] = traceback.format_exc()[-1500:]
    out[name] = r
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
