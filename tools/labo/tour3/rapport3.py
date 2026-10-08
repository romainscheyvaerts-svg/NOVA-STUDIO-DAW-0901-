"""
Tour 3 : tableaux AVANT (profil du tour 2, révision git) / APRÈS (profil actuel) des
null tests sur vraies voix et vraie batterie (calage ET validation), aux réglages
de Romain (dont la règle « 5 dB au VU » / « 2 dB » calée sur le VST), plus les
fichiers d'écoute dans <labo>/<id>/tour3/ecoute.

Portage numba (identique au cœur TS : tests vitest + tour3/d3_check) pour le calcul ;
la preuve « vrai moteur » (Chrome) est faite par compare.py chrome et tour3/chrome_nulls.py.
Usage : python -m tour3.rapport3 [révision_git_avant]   -> <labo>/tour3_nulls.json + .md
"""
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tour2.common import banc_mod, null_db, LABO, SR  # noqa: E402
from tour2.fitdyn import MonoProc, import_prof  # noqa: E402
from tour2.sets import sets, SIG  # noqa: E402
from tour3.render_real import jobs  # noqa: E402
import bench  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DEV = [("cl1b", "Opto Vintage", "modeles.cl1b_profil", "cl1b_fit.json"),
       ("fet76", "FET 76", "modeles.fet76_profil", "fet76_fit.json"),
       ("la2a", "Leveler 2A", "modeles.la2a_profil", "la2a_fit.json"),
       ("voxbox", "Vox Strip", "modeles.voxbox_profil", "voxbox_fit.json")]
SIGNOM = {"V1": "voix 1", "V2": "voix 2 (Pro Tools)", "V3": "voix 3 (lead)", "V4": "voix 4 (lead)", "D": "batterie"}
# cas « réglages de Romain » (mis en tête des tableaux)
ROMAIN = {"cl1b": ["romain_voix", "fm5", "man_romain", "man5"], "fet76": ["romain_bus", "bus5"],
          "la2a": ["romain_bus", "bus2"], "voxbox": ["romain_voix", "voix5"]}
LIB = {"romain_voix": "Romain (session)", "fm5": "Romain F/M, 5 dB au VU", "man_romain": "Romain Manuel (session)",
       "man5": "Romain Manuel, 5 dB au VU", "romain_bus": "Romain (bus)", "bus5": "Romain bus, 5 dB au VU",
       "bus2": "Romain bus, 2 dB au VU", "voix5": "Romain, 5 dB au VU"}
ECOUTE = {"cl1b": ["romain_voix", "fm5", "man5", "transitoires", "fm_batterie"], "fet76": ["romain_bus", "bus5", "transitoires"],
          "la2a": ["romain_bus", "bus2", "transitoires", "pr45_batterie"], "voxbox": ["romain_voix", "voix5", "batterie"]}


def old_fit(rev, fn):
    out = subprocess.run(["git", "-c", "safe.directory=*", "show", f"{rev}:tools/labo/modeles/{fn}"], cwd=REPO,
                         capture_output=True, text=True, encoding="utf-8")
    return json.loads(out.stdout)


def entries(bn):
    out = []
    for e in sets(bn):
        out.append(dict(e, sub="tour2"))
    for e in jobs(bn, ("fit", "val")):
        out.append(dict(e, sub="tour3"))
    return out


def main(rev):
    res = {}
    for bn, nom, pm, fn in DEV:
        prof = import_prof(pm)
        banc = banc_mod(bn)
        f_new = prof.load_fit()
        f_old = dict(prof.DEFAULT_FIT) if hasattr(prof, "DEFAULT_FIT") else {}
        f_old.update(old_fit(rev, fn))
        rows = []
        ecoute = os.path.join(LABO, banc.ID, "tour3", "ecoute")
        os.makedirs(ecoute, exist_ok=True)
        for e in entries(bn):
            vf = os.path.join(LABO, banc.ID, e["sub"], "vst", f"{e['name']}__{e['sig']}.npy")
            if not os.path.exists(vf):
                continue
            path, off, sec = SIG[e["sig"]]
            x = bench.load_audio(path, sec, off, e["rms_db"])
            yv = np.load(vf).astype(float)
            n = min(x.shape[1], yv.shape[1])
            x, yv = x[:, :n], yv[:, :n]
            out = {}
            for tag, F in (("avant", f_old), ("apres", f_new)):
                p = MonoProc(prof.builder(F, banc.to_nova))
                p.configure(e["settings"])
                y = p.run(x)[0]
                out[tag] = null_db(yv[0], y)
                out["y_" + tag] = y
            rows.append({"cas": e["name"], "signal": e["sig"], "role": e["role"], "avant": round(out["avant"], 1),
                         "apres": round(out["apres"], 1), "romain": e["name"] in ROMAIN.get(bn, [])})
            if e["sig"] in ("V1", "V2", "D") and e["name"] in ECOUTE.get(bn, []):
                base = os.path.join(ecoute, f"{e['name']}__{e['sig']}")
                pk = max(np.max(np.abs(yv[0])), 1e-9)
                g = min(1.0, 0.98 / pk)
                sf.write(base + "__0_entree.wav", (x[0] / max(np.max(np.abs(x[0])), 1e-9) * 0.98).astype(np.float32), SR)
                sf.write(base + "__1_original.wav", (yv[0] * g).astype(np.float32), SR)
                sf.write(base + "__2_nova_tour2.wav", (out["y_avant"] * g).astype(np.float32), SR)
                sf.write(base + "__3_nova_tour3.wav", (out["y_apres"] * g).astype(np.float32), SR)
                sf.write(base + "__4_difference_tour3.wav", ((yv[0] - out["y_apres"]) * g).astype(np.float32), SR)
        rows.sort(key=lambda r: (not r["romain"], r["signal"] == "D", r["cas"], r["role"] != "fit", r["signal"]))
        res[bn] = {"nom": nom, "rows": rows}
        print(nom, [(r["cas"], r["signal"], r["avant"], r["apres"]) for r in rows], flush=True)
    json.dump(res, open(os.path.join(LABO, "tour3_nulls.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    md = ["| Effet | Cas | Signal | Rôle | Null tour 2 | Null tour 3 |", "|---|---|---|---|---|---|"]
    for bn, d in res.items():
        for r in d["rows"]:
            cas = f"**{LIB.get(r['cas'], r['cas'])}**" if r["romain"] else r["cas"]
            md.append(f"| {d['nom']} | {cas} | {SIGNOM[r['signal']]} | {'calage' if r['role'] == 'fit' else '**validation**'} | "
                      f"{str(r['avant']).replace('.', ',')} dB | {str(r['apres']).replace('.', ',')} dB |")
    open(os.path.join(LABO, "tour3_nulls.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "HEAD")
