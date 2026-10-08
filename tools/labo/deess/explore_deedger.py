"""Exploration rapide de DeEdger (boîte noire) : dépend-il du niveau absolu ?
de l'équilibre bande / large bande ? de « compensate » ? de « quality » ?"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import host  # noqa: E402
import mesures as M  # noqa: E402
from procs_deess import VstDeess  # noqa: E402

host.hide_console()
OUT = r"D:\1 WORK\CONTENU\nova-labo\deesser"
p = VstDeess("DeEdger.vst3", {"active": True, "bypass_master": False, "freq_hz": 8000.0, "q": 1.0, "depth": 10.0,
                             "compensate": False, "focus_listen": False, "ch_mode": "L+R", "delta": False})
res = {"latence": p.latency}
LV = [-70, -60, -50, -40, -30, -20, -10, -3]
for comp in (False, True):
    for qual in ("Off", "Normal", "High"):
        p.configure({"compensate": comp, "quality": qual})
        res[f"stat_comp{int(comp)}_{qual}"] = M.static_curve(p, 8000, LV, dur=0.8)
        print(f"stat_comp{int(comp)}_{qual}", res[f"stat_comp{int(comp)}_{qual}"]["gain_db"], flush=True)
p.configure({"compensate": False, "quality": "Off"})
for d in (5.0, 20.0):
    p.configure({"depth": d})
    res[f"stat_depth{d}"] = M.static_curve(p, 8000, LV, dur=0.8)
    print("depth", d, res[f"stat_depth{d}"]["gain_db"], flush=True)
p.configure({"depth": 10.0})
res["selectivite_-20"] = M.selectivity(p, [200, 1000, 3000, 5000, 6500, 8000, 10000, 12000, 16000], -20, dur=0.8)
print("sel", res["selectivite_-20"]["gain_db"], flush=True)
res["masquage"] = M.masking(p)
print("masq", res["masquage"], flush=True)
res["temps"] = M.times(p, 8000, -50, -10)
print("temps", {k: res["temps"][k] for k in ("gr_pre_db", "gr_hold_db", "attack_ms", "release_ms")}, flush=True)
res["transparence"] = M.transparency(p, -50)
print("transp", res["transparence"]["max_ecart_db"], res["transparence"]["null_db"], flush=True)
json.dump(res, open(os.path.join(OUT, "explore_deedger.json"), "w", encoding="utf-8"), indent=1)
