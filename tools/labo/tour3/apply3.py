"""Tour 3 : écrit les calages retenus dans les profils du labo (modeles/*_fit.json).
Usage : python -m tour3.apply3 <appareil>=<fichier best json> [...]
appareils : cl1b_fm, cl1b_man, fet76, voxbox, la2a"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tour2.fitdyn import import_prof, set_d2  # noqa: E402

TARGET = {"cl1b_fm": ("modeles.cl1b_profil", ("dyn2", "fm")), "cl1b_man": ("modeles.cl1b_profil", ("dyn2", "man")),
          "fet76": ("modeles.fet76_profil", ("dyn2",)), "voxbox": ("modeles.voxbox_profil", ("dyn2",)),
          "la2a": ("modeles.la2a_profil", ("dyn2",))}

if __name__ == "__main__":
    for arg in sys.argv[1:]:
        dev, fn = arg.split("=", 1)
        pm, key = TARGET[dev]
        prof = import_prof(pm)
        fit = prof.load_fit()
        if key[0] == "dyn2" and len(key) == 2 and not isinstance(fit.get("dyn2"), dict):
            fit["dyn2"] = {}
        d2 = json.load(open(fn, encoding="utf-8"))["d2"]
        set_d2(fit, key, d2)
        prof.save_fit(fit)
        print("appliqué", dev, "<-", fn)
