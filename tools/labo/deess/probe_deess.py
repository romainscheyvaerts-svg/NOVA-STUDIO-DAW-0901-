"""Sonde des de-essers de référence (chargement SANS fenêtre) : paramètres et valeurs affichées."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import host  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\deesser\probe"
os.makedirs(OUT, exist_ok=True)
for name in sys.argv[1:]:
    try:
        p = host.open_plugin(name)
        d = {"name": getattr(p, "name", name), "latency": host.latency_of(p), "params": host.describe_params(p)}
    except Exception as e:  # noqa: BLE001
        d = {"error": f"{type(e).__name__}: {e}"}
    with open(os.path.join(OUT, name.replace(" ", "_") + ".json"), "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    print(name, "erreur" if "error" in d else f"{len(d['params'])} paramètres, latence {d['latency']}")
