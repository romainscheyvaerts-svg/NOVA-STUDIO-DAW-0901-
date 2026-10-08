"""Usage : python deess/run_salves.py deedger|nova_avant|nova_apres '<réglages json>' tag"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import host, salves  # noqa
from voix_ref import make  # noqa
host.hide_console()
which, settings, tag = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
p = make(which); p.configure(settings)
r = salves.run(p)
fn = os.path.join(r"D:\1 WORK\CONTENU\nova-labo\deesser", f"salves_{which}.json")
allr = json.load(open(fn, encoding="utf-8")) if os.path.exists(fn) else {}
allr[tag] = {"reglages": settings, "res": r}
json.dump(allr, open(fn, "w", encoding="utf-8"), indent=1)
for k, v in r.items():
    print(tag, k, {a: b for a, b in v.items() if a != "courbe_2ms"}, flush=True)
p.close()
