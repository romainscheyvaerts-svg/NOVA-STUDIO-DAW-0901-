"""Loi statique du limiteur (sinus 1 kHz, +8 dB, sans adaptatif) : NOVA contre l'original -> statique_limiteur.json"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, nova
V = json.load(open(r"D:\1 WORK\CONTENU\nova-labo\elevate\mesures_limiteur.json"))
m = nova.MasterTransient()
prm = dict(nova.transient_params(0), limiterOn=True, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0,
           ceilingDb=-0.1, truePeak=True, transientOn=False, protect=True)
rows = []
for L, vo in V["statique_g8"]:
    t = np.arange(48000) / 48000
    x = 10 ** (L / 20) * np.sin(2 * np.pi * 1000 * t)
    y = m.run(np.vstack([x, x]), prm)
    no = 20 * np.log10(np.max(np.abs(y[0, 24000:])))
    rows.append([L, round(vo, 2), round(float(no), 2), round(float(no - vo), 2)])
print(rows)
json.dump(rows, open(r"D:\1 WORK\CONTENU\nova-labo\elevate\statique_limiteur.json", "w"))
m.close()
