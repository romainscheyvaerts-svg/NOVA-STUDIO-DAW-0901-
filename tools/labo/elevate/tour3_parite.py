"""Tour 3 : le cœur TypeScript (Node) et le modèle Python du labo (modele.py) donnent-ils le même
module Transient ? (limiteur, clipper et égaliseur au repos ; batterie et mix ; réglage de Romain et 100 %)."""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import modele, nova
from bancs import elevate as banc
AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"
fit = dict(modele.DEFAULT); fit.update(json.load(open(os.path.join(HERE, "transient_fit.json"))))
m = nova.MasterTransient()
rb = banc.romain_band_transient()
out = {}
for nm in ("batterie", "mix"):
    x = np.load(os.path.join(AUD, f"in_{nm}.npy")).astype(np.float64)
    for tag, em, ad, bands in (("romain", 27.0, 50.0, rb), ("t100", 100.0, 0.0, None)):
        yp = modele.process(x, fit, em=em, bands=bands, adaptive=ad)
        yt = m.run(x, nova.transient_params(em, ad, bands))
        d = float(10 * np.log10(np.sum((yp - yt) ** 2) / np.sum(yp ** 2)))
        out[f"{tag}_{nm}"] = round(d, 1)
print(out)
m.close()
