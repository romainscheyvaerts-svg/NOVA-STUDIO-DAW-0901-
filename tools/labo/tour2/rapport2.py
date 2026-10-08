"""
Tour 2 : tableau AVANT / APRÈS des null tests sur vraies voix et vraie batterie
(calage ET validation), plus les fichiers d'écoute.

AVANT = profil du tour 1 (fichiers *_fit.json de la révision git indiquée), APRÈS =
profil actuel. Le portage numba (identique au cœur TS, vérifié par vitest) sert au
calcul ; la preuve « vrai moteur » (Chrome) est faite par compare.py chrome.

Usage : python -m tour2.rapport2 [révision_git_avant]   -> <labo>/tour2_nulls.json + .md
"""
import json, os, subprocess, sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tour2.common import banc_mod, null_db, LABO, SR  # noqa: E402
from tour2.fitdyn import MonoProc, import_prof  # noqa: E402
from tour2.sets import sets, SIG  # noqa: E402
import bench  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DEV = [("cl1b", "Opto Vintage", "modeles.cl1b_profil", "cl1b_fit.json"),
       ("fet76", "FET 76", "modeles.fet76_profil", "fet76_fit.json"),
       ("la2a", "Leveler 2A", "modeles.la2a_profil", "la2a_fit.json"),
       ("voxbox", "Vox Strip", "modeles.voxbox_profil", "voxbox_fit.json")]
SIGNOM = {"V1": "voix 1 (micro sec)", "V2": "voix 2 (session Pro Tools)", "V3": "voix 3 (lead)", "V4": "voix 4 (lead, autre passage)", "D": "batterie"}


def old_fit(rev, fn):
    out = subprocess.run(["git", "-c", "safe.directory=*", "show", f"{rev}:tools/labo/modeles/{fn}"], cwd=REPO,
                         capture_output=True, text=True, encoding="utf-8")
    return json.loads(out.stdout)


def main(rev):
    res = {}
    for bn, nom, pm, fn in DEV:
        prof = import_prof(pm)
        banc = banc_mod(bn)
        f_new = prof.load_fit()
        f_old = dict(prof.DEFAULT_FIT) if hasattr(prof, "DEFAULT_FIT") else {}
        f_old.update(old_fit(rev, fn))
        rows = []
        ecoute = os.path.join(LABO, banc.ID, "tour2", "ecoute")
        os.makedirs(ecoute, exist_ok=True)
        for e in sets(bn):
            vf = os.path.join(LABO, banc.ID, "tour2", "vst", f"{e['name']}__{e['sig']}.npy")
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
                         "apres": round(out["apres"], 1)})
            # écoute : original / NOVA avant / NOVA après / différence après (cas principaux)
            if e["sig"] in ("V1", "V2", "D") and e["name"] in ("romain_voix", "voix_man", "romain_bus", "voix_r8", "voix_pr55", "transitoires", "batterie"):
                base = os.path.join(ecoute, f"{e['name']}__{e['sig']}")
                pk = max(np.max(np.abs(yv[0])), 1e-9)
                g = min(1.0, 0.98 / pk)
                sf.write(base + "__1_original.wav", (yv[0] * g).astype(np.float32), SR)
                sf.write(base + "__2_nova_avant.wav", (out["y_avant"] * g).astype(np.float32), SR)
                sf.write(base + "__3_nova_apres.wav", (out["y_apres"] * g).astype(np.float32), SR)
                sf.write(base + "__4_difference_apres.wav", ((yv[0] - out["y_apres"]) * g).astype(np.float32), SR)
        res[bn] = {"nom": nom, "rows": rows}
        print(nom, [(r["cas"], r["signal"], r["avant"], r["apres"]) for r in rows], flush=True)
    json.dump(res, open(os.path.join(LABO, "tour2_nulls.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    md = ["| Effet | Cas | Signal | Rôle | Null AVANT (tour 1) | Null APRÈS (tour 2) |", "|---|---|---|---|---|---|"]
    for bn, d in res.items():
        for r in d["rows"]:
            md.append(f"| {d['nom']} | {r['cas']} | {SIGNOM[r['signal']]} | {'calage' if r['role'] == 'fit' else '**validation**'} | "
                      f"{str(r['avant']).replace('.', ',')} dB | {str(r['apres']).replace('.', ',')} dB |")
    open(os.path.join(LABO, "tour2_nulls.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "HEAD")
