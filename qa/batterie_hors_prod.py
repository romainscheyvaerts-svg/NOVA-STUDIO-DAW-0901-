"""Batterie de non-régression NOVA, 100 % hors production (catalogue Supabase simulé).

Lance chaque scénario dans son propre processus (navigateurs headless, aucune
fenêtre), avec le compteur de qa_hors_prod, puis écrit un tableau :
résultat, durée, requêtes Supabase simulées, octets servis, requêtes bloquées,
requêtes parties vers la production (0 attendu).

  NOVA_URL=http://127.0.0.1:3485/ python qa/batterie_hors_prod.py [--jobs 3] [--phase nom] [scénario ...]
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

QA = Path(__file__).resolve().parent
BASE_OUT = Path(os.environ.get("QA_HORS_PROD_DIR", r"D:\1 WORK\CONTENU\nova-qa-hors-prod"))

BATTERIE = [
    ("barre_debordement", []), ("barre_bas_debordement", []), ("gestes_tactiles", []), ("fenetres_echap", []),
    ("palette_commandes", []), ("menu_clip", []), ("casque_rec", []), ("seances_doigt", []),
    ("session_voix", []), ("session_mix", []), ("session_beat", []),
    ("collab_bout_en_bout", []), ("feat_distance", []),
    ("r16_midi", []), ("r21_session_pro", []), ("r14_r15_multipiste", []), ("r18_beatmaker", []),
    ("r23_beat_repunch", []), ("r7_sidechain", []), ("r8_automation", []), ("inserts_visibles", []),
    ("pdc_preuve", []), ("pdc_audio_lecture", []),
    ("protools_utiles", []), ("r17_raccourcis_scrub", []), ("catalogue_indisponible", []),
]


def run_one(name, args, phase, url, timeout):
    out = BASE_OUT / "batterie" / phase
    cnt = out / "compteurs" / f"{name}.json"
    logf = out / "sorties" / f"{name}.txt"
    cnt.parent.mkdir(parents=True, exist_ok=True); logf.parent.mkdir(parents=True, exist_ok=True)
    try: cnt.unlink()
    except OSError: pass
    env = dict(os.environ, NOVA_URL=url, QA_OUT=str(out / "captures" / name), QA_PHASE=phase, QA_TAG=phase,
               PYTHONIOENCODING="utf-8", QA_HORS_PROD_COMPTEUR=str(cnt))
    env.pop("QA_ALLOW_PROD", None)
    t0 = time.time()
    with open(logf, "w", encoding="utf-8") as fh:
        try:
            p = subprocess.run([sys.executable, str(QA / f"{name}.py"), *args], cwd=str(QA.parent), env=env,
                               stdout=fh, stderr=subprocess.STDOUT, timeout=timeout,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            code = p.returncode
        except subprocess.TimeoutExpired:
            code = "délai"
    secs = round(time.time() - t0)
    c = {}
    try: c = json.loads(cnt.read_text(encoding="utf-8"))
    except Exception: pass
    tail = logf.read_text(encoding="utf-8", errors="replace").splitlines()[-12:]
    ko = [l for l in logf.read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith(("KO", "ÉCHEC", "FAIL"))]
    r = {"scenario": name, "code": code,
         "ok": code == 0 and bool(c) and not c.get("requetes_bloquees") and not c.get("requetes_prod") and not c.get("filet_dns"),
         "secs": secs, "simulees": c.get("requetes_simulees"), "simulees_scenario": c.get("simulees_par_le_scenario"),
         "octets": c.get("octets_total"), "par_type": c.get("par_type"), "octets_par_type": c.get("octets_par_type"),
         "bloquees": c.get("requetes_bloquees"), "bloquees_detail": c.get("bloquees"),
         "filet_dns": c.get("filet_dns"), "prod": c.get("requetes_prod"), "prod_detail": c.get("requetes_prod_detail"),
         "ko": ko[:10], "fin": tail}
    print(f"{'OK ' if r['ok'] else 'KO '} {name:24s} code={code} {secs:4d}s  simulées={r['simulees']}  "
          f"(+{r['simulees_scenario']} par le scénario)  bloquées={r['bloquees']}  filet DNS={r['filet_dns']}  prod={r['prod']}", flush=True)
    return r


def table(rows, phase, url):
    L = [f"# Batterie de non-régression hors production ({phase})", "",
         f"Serveur : {url} · {time.strftime('%Y-%m-%d %H:%M')} · Supabase simulé (qa/qa_hors_prod.py)", "",
         "| Scénario | Résultat | Durée | Requêtes Supabase simulées (qa_hors_prod) | + servies hors simulateur central (simulateurs du scénario, pré-vols CORS) | Octets servis | Bloquées | Filet DNS | Vers la prod |",
         "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r['scenario']} | {'✅' if r['ok'] else '❌ (code ' + str(r['code']) + ')'} | {r['secs']} s | "
                 f"{r['simulees'] if r['simulees'] is not None else '—'} | {r.get('simulees_scenario', '—')} | "
                 f"{(r['octets'] or 0) / 1e6:.1f} Mo | {r['bloquees'] if r['bloquees'] is not None else '—'} | "
                 f"{r.get('filet_dns', '—')} | {r['prod'] if r['prod'] is not None else '—'} |")
    tot_req = sum(r["simulees"] or 0 for r in rows)
    L += ["", f"**Total : {sum(r['ok'] for r in rows)}/{len(rows)} scénarios verts · {tot_req} requêtes Supabase simulées · "
              f"{sum(r.get('simulees_scenario') or 0 for r in rows)} servies par les simulateurs des scénarios ou pré-vols CORS · "
              f"{sum(r['bloquees'] or 0 for r in rows)} bloquées · {sum(r.get('filet_dns') or 0 for r in rows)} arrêtées par le filet DNS · "
              f"{sum(r['prod'] or 0 for r in rows)} vers la production.**"]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("noms", nargs="*")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--phase", default="hors_prod")
    ap.add_argument("--timeout", type=int, default=45 * 60)
    a = ap.parse_args()
    url = os.environ.get("NOVA_URL", "http://127.0.0.1:3485/")
    todo = [(n, args) for n, args in BATTERIE if not a.noms or n in a.noms]
    with ThreadPoolExecutor(a.jobs) as ex:
        rows = list(ex.map(lambda t: run_one(t[0], t[1], a.phase, url, a.timeout), todo))
    out = BASE_OUT / "batterie" / a.phase
    prev = {}
    try: prev = {r["scenario"]: r for r in json.loads((out / "resultats.json").read_text(encoding="utf-8"))}
    except Exception: pass
    prev.update({r["scenario"]: r for r in rows})
    allrows = [prev[n] for n, _ in BATTERIE if n in prev]
    (out / "resultats.json").write_text(json.dumps(allrows, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "tableau.md").write_text(table(allrows, a.phase, url), encoding="utf-8")
    print(table(allrows, a.phase, url))
    sys.exit(0 if all(r["ok"] for r in rows) else 1)


if __name__ == "__main__":
    main()
