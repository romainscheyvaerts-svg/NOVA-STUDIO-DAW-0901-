"""Charge Elevate (VST3) SANS fenêtre et liste ses paramètres."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import host
host.hide_console()
PLUGIN = r"Newfangled Audio\Newfangled Elevate.vst3"
p = host.open_plugin(PLUGIN)
d = host.describe_params(p)
out = {"name": getattr(p, "name", "?"), "latency": host.latency_of(p), "params": d}
json.dump(out, open(r"D:\1 WORK\CONTENU\nova-labo\elevate\probe.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out["name"], out["latency"], len(d))
for k, v in d.items():
    print(k, "|", v.get("text"), "|", v.get("n_valid"), "|", v.get("valid_sample"))
