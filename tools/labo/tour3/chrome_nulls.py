"""
Tour 3 : null tests des réglages de Romain dans le VRAI moteur NOVA (AudioWorklet dans
Chrome headless, OfflineAudioContext — le chemin de l'export), avec le profil GÉNÉRÉ
(engine/analogProfiles.ts) : preuve que le cœur livré donne les chiffres du labo.

Il faut le serveur : npx vite --port 3474 --strictPort ; NOVA_URL=http://127.0.0.1:3474/
Usage : python -m tour3.chrome_nulls  -> <labo>/tour3_chrome_nulls.json
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tour3 import lowprio  # noqa: E402
from tour2.common import banc_mod, null_db, LABO  # noqa: E402
from tour2.fitdyn import MonoProc, import_prof  # noqa: E402
from tour2.sets import SIG  # noqa: E402
from tour3.rapport3 import entries, ROMAIN  # noqa: E402
import bench  # noqa: E402
import chrome_proc  # noqa: E402

DEV = [("cl1b", "modeles.cl1b_profil"), ("fet76", "modeles.fet76_profil"), ("la2a", "modeles.la2a_profil"), ("voxbox", "modeles.voxbox_profil")]
DRUMS = {"cl1b": ["transitoires", "fm_batterie"], "fet76": ["transitoires"], "la2a": ["transitoires", "pr45_batterie"], "voxbox": ["batterie"]}


def main():
    lowprio()
    out = {}
    for bn, pm in DEV:
        banc = banc_mod(bn)
        prof = import_prof(pm)
        cp = chrome_proc.ChromeProc(banc.NOVA_KIND, banc.NOVA_BASE)
        py = MonoProc(prof.builder(prof.load_fit(), banc.to_nova))
        rows = []
        for e in entries(bn):
            if e["name"] not in ROMAIN[bn] + DRUMS[bn]:
                continue
            vf = os.path.join(LABO, banc.ID, e["sub"], "vst", f"{e['name']}__{e['sig']}.npy")
            if not os.path.exists(vf):
                continue
            path, off, sec = SIG[e["sig"]]
            x = bench.load_audio(path, sec, off, e["rms_db"])
            yv = np.load(vf).astype(float)
            n = min(x.shape[1], yv.shape[1])
            x, yv = x[:, :n], yv[:, :n]
            cp.configure(banc.to_nova(e["settings"]))
            yc = cp.run(x)[0]
            py.configure(e["settings"])
            yp = py.run(x)[0]
            rows.append({"cas": e["name"], "signal": e["sig"], "role": e["role"], "null_chrome": round(null_db(yv[0], yc), 2),
                         "null_portage": round(null_db(yv[0], yp), 2), "chrome_vs_portage_db": round(null_db(yp, yc), 1)})
            print(bn, rows[-1], flush=True)
        cp.close()
        out[bn] = rows
    json.dump(out, open(os.path.join(LABO, "tour3_chrome_nulls.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
