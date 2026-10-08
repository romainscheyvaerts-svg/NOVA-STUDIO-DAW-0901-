"""Vérifie le chargement et la transparence en réglage neutre, mesure le retard résiduel."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vst import Elevate, banc, SR, host
host.hide_console()
e = Elevate()
print("latence annoncée", e.latency)
rng = np.random.default_rng(0)
x = rng.standard_normal((2, SR * 2)) * 0.05
for name, s in (("neutre", banc.NEUTRE), ("romain", banc.romain_settings())):
    ap = e.configure(s)
    y = e.run(x)
    c = np.correlate(y[0, 20000:60000], x[0, 20000:60000], "full")
    lag = int(np.argmax(np.abs(c))) - (40000 - 1)
    d = y[0, 30000:] - x[0, 30000 - 0:len(y[0])][:len(y[0]) - 30000]
    nd = 10 * np.log10(np.sum(d ** 2) / np.sum(x[0, 30000:] ** 2))
    print(name, "retard résiduel", lag, "null vs entrée", round(nd, 2), "rms out", round(20*np.log10(np.std(y[0,30000:])),2), "in", round(20*np.log10(np.std(x[0])),2))
    bad = {k: v for k, v in ap.items() if k in s and str(s[k]) not in (v, str(float(s[k])) if isinstance(s[k], (int, float)) and not isinstance(s[k], bool) else v)}
    print(" réglages appliqués différents :", list(bad.items())[:20])
