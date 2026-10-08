"""Tour 3 : réponse de l'égaliseur NOVA (cœur TS) contre l'original (tour3/eq.json déjà mesuré).
Usage : python elevate/tour3_eq_nova.py [profil.json]"""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import nova
from tour3_mesure_eq import CASES, resp, SR
T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
prof = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else None
E = json.load(open(os.path.join(T3, "eq.json")))
fq = np.array(E["freq"])
m = nova.MasterTransient()
x = np.random.default_rng(5).standard_normal((2, 6 * SR)) * 10 ** (-30 / 20)
res = {}
for name, bands in CASES.items():
    g26 = [bands.get(b, 0.0) for b in range(1, 27)]
    prm = dict(nova.transient_params(0), bandGainDb=g26, transientOn=False, limiterOn=False, clipperOn=False, protect=False)
    yn = m.run(x, prm, prof)
    f, hn = resp(x[0], yn[0])
    a = np.array(E[name]["orig"]); b = np.interp(fq, f, hn)
    res[name] = (round(float(np.max(np.abs(a - b))), 2), round(float(np.sqrt(np.mean((a - b) ** 2))), 2))
    print(f"{name:14s} écart max {res[name][0]:5.2f} dB rms {res[name][1]:5.2f}", flush=True)
m.close()
json.dump(res, open(os.path.join(T3, "eq_nova_" + ("profil" if prof else "actuel") + ".json"), "w"))
