"""Catalogue restreint (quota Supabase dépassé, réponses 402) : message clair, pas de plantage,
pas de boucle de requêtes, et ce qui reste utilisable (projet vierge, projets et fichiers locaux).

Tout passe par le catalogue simulé (qa_hors_prod.simulate_quota) : rien ne sort vers la production.

  NOVA_URL=http://127.0.0.1:3485/ PYTHONIOENCODING=utf-8 python qa/catalogue_indisponible.py
Sortie : D:\\1 WORK\\CONTENU\\nova-qa-hors-prod\\service-indisponible\\
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\service-indisponible")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, Log, launch, new_page, shot, OUT, save_log  # noqa: E402
import qa_hors_prod as hp  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RES = {"name": "catalogue_indisponible", "etapes": {}}


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:400], flush=True)


def catalog_requests():
    with hp._LOCK:
        return sum(v for k, v in hp.STATS["simulees"].items() if k in ("catalogue_liste", "audio_beats", "pochettes"))


def body(pg):
    return pg.inner_text("body")


def run():
    with sync_playwright() as p:
        b = launch(p)
        for vp in ("pc", "tel"):
            log = Log(f"catalogue_indisponible_{vp}")
            # 1. Première visite, catalogue restreint : aucune copie locale.
            hp.simulate_quota(True)
            ctx, pg = new_page(b, vp, log)
            n0 = catalog_requests()
            pg.goto(BASE, wait_until="domcontentloaded")
            pg.get_by_text("Le catalogue est momentanément indisponible.").first.wait_for(timeout=30000)
            pg.wait_for_timeout(800)
            shot(pg, f"{vp}_01_premiere_visite_quota")
            t = body(pg)
            ok(f"{vp} : message clair (au lieu de « Catalogue injoignable »)",
               "Tu peux travailler avec tes propres fichiers" in t and "Catalogue injoignable" not in t)
            ok(f"{vp} : ce qui reste utilisable est proposé",
               all(s in t for s in ("Nouveau projet vierge", "Ouvrir un projet de cet appareil", "Importer ton instru")))
            ok(f"{vp} : nouvel essai automatique annoncé (délai croissant)", re.search(r"Nouvel essai automatique dans \d", t) is not None,
               re.search(r"Nouvel essai automatique dans [^\n]+", t).group(0) if re.search(r"Nouvel essai automatique dans [^\n]+", t) else None)
            # Pas de boucle : 20 s d'attente → aucune nouvelle requête (le 1er nouvel essai est à 60 s).
            n1 = catalog_requests()
            pg.wait_for_timeout(20000)
            n2 = catalog_requests()
            ok(f"{vp} : aucune rafale de requêtes pendant l'attente", n2 == n1, {"requetes_au_chargement": n1 - n0, "requetes_en_20_s": n2 - n1})
            # Recharger la page pendant le délai : toujours aucune requête vers le catalogue.
            pg.reload(wait_until="domcontentloaded")
            pg.get_by_text("Le catalogue est momentanément indisponible.").first.wait_for(timeout=30000)
            pg.wait_for_timeout(1500)
            n3 = catalog_requests()
            ok(f"{vp} : recharger la page ne relance pas de requête (délai mémorisé)", n3 == n2, {"requetes": n3 - n2})
            # Connexion par e-mail sur le site pendant la restriction : message clair, pas de JSON.
            if vp == "pc":
                pg.get_by_role("button", name="Connexion").first.click(); pg.wait_for_timeout(800)
                pg.locator("input[type=email]").first.fill("artiste@example.com")
                pg.locator("input[type=password]").first.fill("motdepasse123")
                pg.locator("button[type=submit]").first.click()
                pg.get_by_text("Le service de connexion est momentanément indisponible").first.wait_for(timeout=15000)
                shot(pg, f"{vp}_01b_connexion_email_quota")
                t = body(pg).lower()   # message affiché en capitales (CSS)
                ok(f"{vp} : connexion e-mail pendant la restriction → message clair, aucun JSON",
                   "projets locaux restent accessibles" in t and "exceed_egress_quota" not in t and "restricted" not in t)
                pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
                if pg.get_by_role("button", name="Nouveau projet vierge").count() == 0 or not pg.get_by_role("button", name="Nouveau projet vierge").first.is_visible():
                    close = pg.get_by_role("button", name=re.compile("^Fermer")).locator("visible=true")
                    if close.count(): close.first.click(); pg.wait_for_timeout(400)
            # Le studio reste utilisable : projet vierge.
            pg.get_by_role("button", name="Nouveau projet vierge").first.click()
            pg.wait_for_timeout(2500)
            for name in ("C'est parti", "Plus tard"):
                bt = pg.get_by_role("button", name=name, exact=True).locator("visible=true").first
                try:
                    if bt.is_visible(): bt.click(); pg.wait_for_timeout(300)
                except Exception:
                    pass
            shot(pg, f"{vp}_02_studio_sans_catalogue")
            errs = [e for e in log.errors() if "Failed to load resource" not in e["text"]]   # le 402 lui-même, noté par Chrome
            ok(f"{vp} : projet vierge ouvert sans le catalogue, aucun plantage",
               not errs and ("BPM" in body(pg) or "Morceau" in body(pg)), [e["text"][:160] for e in errs][:5])
            ctx.close()

            # 2. Catalogue déjà vu (copie locale), puis restreint : la dernière liste reste affichée.
            hp.simulate_quota(False)
            ctx, pg = new_page(b, vp, log)
            pg.goto(BASE, wait_until="domcontentloaded")
            pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=30000)
            pg.evaluate("() => { const m = JSON.parse(localStorage.getItem('nova_catalog_copy_meta')); m.savedAt = 0; localStorage.setItem('nova_catalog_copy_meta', JSON.stringify(m)); }")
            hp.simulate_quota(True)
            pg.reload(wait_until="domcontentloaded")
            pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=30000)
            pg.get_by_test_id("catalogue-indisponible-bandeau").first.wait_for(timeout=15000)
            pg.wait_for_timeout(800)
            shot(pg, f"{vp}_03_derniere_liste_connue")
            ok(f"{vp} : dernière liste connue affichée + bandeau", "dernière liste connue" in body(pg))
            # Écoute d'un beat jamais écouté pendant la restriction : message clair, pas d'erreur.
            pg.get_by_role("button", name=re.compile("Écouter.{0,3}MIDNIGHT")).first.click()
            pg.wait_for_timeout(1500)
            shot(pg, f"{vp}_04_ecoute_indisponible")
            ok(f"{vp} : écoute pendant la restriction → message clair",
               "Écoute momentanément indisponible" in body(pg) or "momentanément indisponible" in body(pg))
            # 3. Restriction levée : le nouvel essai (fin du délai) rétablit le catalogue.
            hp.simulate_quota(False)
            pg.evaluate("() => { const o = JSON.parse(localStorage.getItem('nova_catalog_outage')); if (o) { o.retryAt = Date.now(); localStorage.setItem('nova_catalog_outage', JSON.stringify(o)); } }")
            pg.reload(wait_until="domcontentloaded")
            pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=30000)
            pg.wait_for_timeout(2500)
            shot(pg, f"{vp}_05_catalogue_revenu")
            ok(f"{vp} : catalogue revenu, bandeau disparu", pg.get_by_test_id("catalogue-indisponible-bandeau").count() == 0)
            errs = [e for e in log.errors() if "Failed to load resource" not in e["text"]]
            ok(f"{vp} : aucune erreur de page (ni exception, ni erreur console hors le 402 lui-même)", not errs,
               [e["text"][:160] for e in errs][:5])
            save_log(log, {"result": RES})
            ctx.close()
        b.close()
    RES["ok"] = all(v["ok"] for v in RES["etapes"].values())
    (OUT / "resultats.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print("TOUT OK" if RES["ok"] else "ÉCHECS", flush=True)
    return RES["ok"]


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
