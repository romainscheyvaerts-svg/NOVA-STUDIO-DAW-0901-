"""Banc synthétique complet d'un de-esser. Usage : python deess/run_banc.py <proc> '<réglages>' tag"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import host, mesures as M  # noqa
from voix_ref import make  # noqa
host.hide_console()
which, settings, tag = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
p = make(which); p.configure(settings)
r = {"reglages": settings, "latence": p.latency}
r["statique_8k"] = M.static_curve(p, 8000, [-70, -60, -50, -40, -30, -20, -10, -3], dur=0.8)
r["selectivite_-10"] = M.selectivity(p, [100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6500, 8000, 10000, 12000, 16000], -10, dur=0.8)
r["masquage"] = M.masking(p)
r["temps"] = M.times(p, 8000, -50, -10)
r["transparence_-50"] = M.transparency(p, -50)
r["transparence_-20"] = M.transparency(p, -20)
r["repos_-20"] = M.at_rest(p, -20)
r["repos_-6"] = M.at_rest(p, -6)
fn = os.path.join(r"D:\1 WORK\CONTENU\nova-labo\deesser", f"banc_{which}.json")
allr = json.load(open(fn, encoding="utf-8")) if os.path.exists(fn) else {}
allr[tag] = r
json.dump(allr, open(fn, "w", encoding="utf-8"), indent=1)
print(tag, "statique", r["statique_8k"]["gain_db"])
print(tag, "selectivite", r["selectivite_-10"]["gain_db"])
print(tag, "masquage", r["masquage"])
print(tag, "temps", {k: r["temps"][k] for k in ("gr_pre_db", "gr_hold_db", "attack_ms", "release_ms")})
print(tag, "transparence", r["transparence_-50"]["max_ecart_db"], r["transparence_-50"]["null_db"], r["transparence_-20"]["max_ecart_db"], r["transparence_-20"]["null_db"], "repos", r["repos_-20"]["null_db"], r["repos_-6"]["null_db"])
p.close()
