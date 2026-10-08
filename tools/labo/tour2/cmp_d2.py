"""Compare plusieurs calages dyn2 (fichiers best_*.json) sur les signaux de calage ET de validation."""
import sys, os, json, copy
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour2.fitdyn import *  # noqa

group = sys.argv[1]
tags = sys.argv[2:]
g = GROUPS[group]
prof = import_prof(g["prof"])
banc = banc_mod(g["banc"])
real = load_real(group, ("fit", "val"))
steps = load_steps(group)
for tag in tags:
    fit = prof.load_fit()
    if tag != "actuel":
        b = json.load(open(os.path.join(LABO, banc.ID, "tour2", f"best_{group}{tag}.json"), encoding="utf-8"))
        set_d2(fit, g["key"], b["d2"])
    c, det = evaluate(fit, real, steps, banc, prof, harm=load_harm(group))
    rr = [d for d in det if len(d) == 5]
    vo = [d[2] for d in rr if d[1] != "D"]
    dr = [d[2] for d in rr if d[1] == "D"]
    st = [d[2] for d in det if len(d) == 3 and d[0] != "harm"]
    hm = [d[2] for d in det if d[0] == "harm"]
    print(f"{tag:10s} coût {c:7.2f} | null brut voix moy {np.mean(vo):6.2f} pire {max(vo):6.2f} | batterie {np.mean(dr) if dr else float('nan'):6.2f} | sauts {np.mean(st) if st else 0:5.3f} | harm {np.mean(hm) if hm else 0:5.2f}")
    for d in rr:
        print("     ", d)
