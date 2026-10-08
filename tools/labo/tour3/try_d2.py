"""Évalue rapidement un dyn2 donné (JSON en argument) sur un groupe : coût + détail court."""
import sys, json, copy
sys.path.insert(0, '.')
from tour3 import fit3
from tour2.common import banc_mod
from tour2.fitdyn import set_d2
g = sys.argv[1]; d2 = json.loads(sys.argv[2]); roles = tuple(sys.argv[3].split(",")) if len(sys.argv) > 3 else ("fit",)
G = fit3.GROUPS[g]; prof = fit3.import_prof(G["prof"]); banc = banc_mod(G["banc"])
fit = prof.load_fit(); set_d2(fit, G["key"], d2)
c, det = fit3.evaluate(fit, fit3.load_items(g, roles), prof, banc, detail=True)
print("coût", round(c, 2))
for d in det:
    print(" ", str(d)[:230])
