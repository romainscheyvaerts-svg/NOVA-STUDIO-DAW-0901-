"""
Preuve du calage « réduction cible » (règle de Romain) sur une vraie voix :
  - VST réels (hors ligne, sans fenêtre) : même code que le pont
    (bridge-python/gr_calibration.calibrate_plugin) ;
  - effets NOVA (portage identique du cœur) : même dichotomie ;
la réduction est mesurée PAREIL pour les deux (gain court terme sortie / entrée,
balistique VU), puis on croise : le réglage trouvé sur le VST, traduit en
réglage NOVA, donne-t-il la même réduction ?
Sortie : D:/1 WORK/CONTENU/nova-labo/calage.json
"""
import importlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "bridge-python"))
import bench  # noqa: E402
import gr_calibration as gc  # noqa: E402
import host  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402

VOIX = r"D:\1 WORK\CONTENU\nova-autotune\micro_sec_12s.wav"
SR = 48000

CASES = [
    # banc, profil, réglages VST de départ, réglage calé (VST), bornes, sens, cible, réglage NOVA calé, bornes NOVA
    ("cl1b", "modeles.cl1b_profil", {"ratio": "2:1", "attack": 3.0, "release": 3.0, "select_attack_release": "F/M"},
     "threshold_db", -41.0, 2.0, -1, 5.0, "threshold", -60.0, 20.0),
    ("fet76", "modeles.fet76_profil", {"ratio": "4:1", "attack": 5.0, "release": 6.0, "output": -15.0},
     "input", -60.0, 0.0, 1, 5.0, "input", -60.0, 0.0),
    ("la2a", "modeles.la2a_profil", {"gain": "25", "comp_limit": "Comp"},
     "peak_reduct", 0.0, 100.0, 1, 2.0, "peakReduction", 0.0, 100.0),
    ("voxbox", "modeles.voxbox_profil", {"comp_byp": "In", "comp_attack": "Medium", "comp_rel": "Medium"},
     "comp_thresh", 0.0, 10.0, 1, 5.0, "compThresh", 0.0, 10.0),
]


def vu_of(x, y):
    tr, st = gc.gr_trace_from_io(x, y, SR)
    return gc.vu_max_gr(tr, st)


def main():
    host.hide_console()
    x = bench.load_audio(VOIX, 12, 0.0, -18.0).astype(np.float32)
    out = {"voix": VOIX, "niveau_rms_dbfs": -18.0, "cas": []}
    for banc_name, prof_name, start, vp, lo, hi, sense, target, np_, nlo, nhi in CASES:
        banc = importlib.import_module(f"bancs.{banc_name}")
        prof = importlib.import_module(prof_name)
        res = {"appareil": banc.PLUGIN, "nova": banc.NOVA_KIND, "cible_db": target}
        try:
            pl = host.open_plugin(banc.PLUGIN)
            settings = dict(banc.BASE)
            settings.update(start)
            host.set_params(pl, settings)

            def apply(v):
                host.set_param(pl, vp, float(v))
            r = gc.calibrate_plugin(pl, apply, x, SR, lo, hi, sense, target)
            res["vst"] = {"reglage": vp, "valeur": r["value"], "texte": str(getattr(pl, vp)), "vu_gr_db": r["gr_db"],
                          "atteint": r["reached"], "rendus": len(r["steps"])}
            settings[vp] = str(getattr(pl, vp))
            yv = host.process(pl, x, SR)
            res["vst"]["vu_gr_db_verif"] = vu_of(x, yv)
            del pl
        except Exception as e:  # noqa: BLE001
            res["vst"] = {"erreur": str(e)}
            settings = None
        fit = prof.load_fit()
        p0 = banc.to_nova(dict(banc.BASE, **start))

        def nova_run(v):
            q = dict(p0)
            q[np_] = v
            P, l0, dl, tab = prof.nova_to_internal(q, fit)
            y, A = ac.process(x.astype(np.float64), P, float(l0), float(dl), tab)
            return y, A

        def nova_vu(v):
            # réduction lue dans la cellule (comme le VU de NOVA et utils/grCalibration.ts)
            _, A = nova_run(v)
            g = 20 * np.log10(np.maximum(A, 1.0))
            blk = 128
            tr = g[: len(g) // blk * blk].reshape(-1, blk).max(axis=1)
            return gc.vu_max_gr(tr, blk / SR)
        rn = gc.bisect_for_target(nova_vu, nlo, nhi, sense, target)
        y_n, _ = nova_run(rn["value"])
        res["nova"] = {"reglage": np_, "valeur": rn["value"], "vu_gr_db": rn["gr_db"], "atteint": rn["reached"],
                       "vu_gr_db_estime_entree_sortie": vu_of(x, y_n)}
        if settings is not None:
            qn = banc.to_nova(settings)
            y2, _ = nova_run(qn[np_])
            res["croise"] = {"reglage_nova_du_vst": qn.get(np_), "vu_gr_db_nova_au_reglage_du_vst": nova_vu(qn[np_]),
                             "vu_gr_db_nova_estime_entree_sortie": vu_of(x, y2)}
        out["cas"].append(res)
        with open(r"D:\1 WORK\CONTENU\nova-labo\calage.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
