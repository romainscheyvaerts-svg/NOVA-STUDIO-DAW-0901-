"""💳 « Gérer mon abonnement » (portail client Stripe) : un abonné Nova Pro peut gérer et résilier depuis NOVA.

100 % hors production : Supabase simulé (qa_hors_prod via qalib), compte SIMULÉ, fonction nova-billing
SIMULÉE par une route de ce scénario (statut du compte + action « portal »). Le « portail Stripe » est une
page factice servie par une route (billing.stripe.com n'est jamais appelé). Navigateur headless.

Cas :
  pc_sombre / pc_clair (1366 × 768) :
    1. abonné Nova Pro mensuel : pastille du compte → bouton 💳 « Gérer mon abonnement » visible ;
    2. portail pas encore activé dans Stripe (erreur du serveur) → message clair en français, aucun onglet vide
       laissé ouvert, rien de recouvert ;
    3. portail disponible → un nouvel onglet s'ouvre sur le portail (action « portal », adresse de retour) ;
    4. palette Ctrl+K « abonnement » → « Gérer mon abonnement Nova Pro » ;
  cadeau (1366, sombre) : Nova Pro OFFERT (pas d'abonnement Stripe) → ni bouton ni entrée de palette ;
  tel_sombre / tel_clair (390 × 844, au doigt) : menu ☰ → « Gérer mon abonnement (Nova Pro mensuel) » dans le
    compte → message clair si le portail est indisponible, rien de recouvert.

  NOVA_URL=http://127.0.0.1:3426/ PYTHONIOENCODING=utf-8 python qa/gerer_abonnement.py [cas ...]
Sorties : D:\\1 WORK\\CONTENU\\nova-152\\nettoyage\\qa (captures + gerer_abonnement.json)
"""
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-152\nettoyage\qa")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402  (Supabase simulé, production bloquée)
import qa_hors_prod  # noqa: E402
from qalib import launch, new_page, Log, save_log, balayage_chevauchement  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = qalib.BASE
OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)

USER = "3e9a7b1c-5d2f-4a60-9b71-82c3d4e5f6a7"
EMAIL = "abonne.qa@exemple.be"
PORTAIL = "https://billing.stripe.com/p/session/test_qa_portail"
STRIPE_SANS_PORTAIL = ("No configuration provided and your live mode default configuration has not been created. Provide a configuration "
                       "or create your default by saving your customer portal settings in live mode at https://dashboard.stripe.com/settings/billing/portal.")

GRILLE = {
    "version": "2026-10-14", "currency": "eur", "taxes": "TTC", "export": {"cents": 199, "par": "projet"},
    "pro": {"mois_cents": 999, "an_cents": 8900, "economie_an_cents": 3088, "economie_an_pourcent": 26, "mois_offerts_an": 3,
            "stockage_go": 20, "melodies_offertes_par_mois": 1},
    "cadeaux": {"instru_jours": 30, "melodie_jours": 7, "melodie_exclusive_jours": 30, "studio_jours": 30},
    "gratuit": {"projets_en_ligne": 1, "projet_jours": 7, "extrait_secondes": 30, "export": False},
}


def statut(kind):
    if kind == "abonne":
        pro = {"active": True, "source": "abonnement", "paid": True, "interval": "month", "until": "2026-11-16T00:00:00Z",
               "cadeau": {"active": False, "until": None, "days_left": 0, "total_days": 0, "sources": []}}
        plans = [{"plan": "nova_pro", "status": "active", "current_period_end": "2026-11-16T00:00:00Z", "interval": "month"}]
    else:  # Nova Pro offert (licence achetée) : rien à gérer chez Stripe
        pro = {"active": True, "source": "cadeau", "paid": False, "interval": None, "until": None,
               "cadeau": {"active": True, "until": None, "days_left": 20, "total_days": 30, "sources": [{"source": "instru", "days": 30, "label": DEFAULT_BEAT}]}}
        plans = []
    return {"grille": "2026-10-14", "plans": plans, "admin": False, "pro": pro,
            "features": {"exports_illimites": True, "collab_hote": True, "import_instrus": True},
            "melodie_offerte": {"droit": True, "restantes": 1, "par_mois": 1}, "free_exports_left": 0, "free_exports_total": 0}


class Billing:
    def __init__(self, kind):
        self.kind = kind
        self.portal = "indisponible"  # ou "ok"
        self.portal_calls = []

    def install(self, page):
        hdr = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS"}

        def handler(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=hdr)
            try:
                body = json.loads(request.post_data or "{}")
            except Exception:
                body = {}
            a = body.get("action")
            if a == "status":
                return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps(statut(self.kind)))
            if a == "pricing":
                return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps(GRILLE))
            if a == "portal":
                self.portal_calls.append(body)
                if self.portal == "ok":
                    return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps({"url": PORTAIL}))
                return route.fulfill(status=500, headers=hdr, content_type="application/json", body=json.dumps({"error": STRIPE_SANS_PORTAIL}))
            return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps({"plans": [], "admin": False}))
        page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/functions/v1/nova-billing"), handler)


CASES = {
    "pc_sombre": {"vp": "pc1366", "theme": "dark", "kind": "abonne"},
    "pc_clair": {"vp": "pc1366", "theme": "light", "kind": "abonne"},
    "cadeau": {"vp": "pc1366", "theme": "dark", "kind": "cadeau"},
    "tel_sombre": {"vp": "tel390", "theme": "dark", "kind": "abonne"},
    "tel_clair": {"vp": "tel390", "theme": "light", "kind": "abonne"},
}
res = {"cas": {}}


def run_case(p, case, vp, theme, kind):
    log = Log(f"abonnement_{case}")
    tel = vp.startswith("tel")
    r = {"vp": vp, "theme": theme, "ok": True, "checks": [], "captures": []}
    res["cas"][case] = r
    sess = qa_hors_prod.compte_simule(USER, EMAIL)
    sim = Billing(kind)

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:400]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{case}] {label}" + ("" if cond else f"  → {str(extra)[:300]}"), flush=True)

    def snap(tag):
        path = OUT / f"abonnement_{case}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def no_overlap(where):
        bal = balayage_chevauchement(page)
        check(f"{where} : aucun bouton recouvert", not bal.get("recouverts") and not bal.get("erreur"), bal)

    def palette_ids(query):
        if tel:
            page.get_by_test_id("transport-menu").locator("visible=true").first.tap()
            page.wait_for_timeout(300)
            page.get_by_test_id("menu-palette").locator("visible=true").first.tap()
        else:
            page.keyboard.press("Control+k")
        page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
        page.keyboard.type(query, delay=10)
        page.wait_for_timeout(400)
        ids = page.evaluate("() => [...document.querySelectorAll('[data-testid=command-palette] [role=option]')].map(o => o.getAttribute('data-palette-id'))")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        return ids

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); "
                        f"localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', {json.dumps(json.dumps(sess))}); }} catch (e) {{}}")
    # Le « portail Stripe » : une page factice (jamais le vrai billing.stripe.com).
    ctx.route(re.compile(r"^https://billing\.stripe\.com/"), lambda route, req: route.fulfill(
        status=200, content_type="text/html; charset=utf-8", body="<!doctype html><title>Portail Stripe (simulé)</title><h1>Portail client Stripe (simulé)</h1>"))
    sim.install(page)
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)
        page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
        page.wait_for_timeout(1500)
        close_welcome(page)
        wait_text_gone(page, "Chargement", 60)
        close_welcome(page)
        page.wait_for_timeout(2500)

        if tel:
            page.get_by_test_id("transport-menu").locator("visible=true").first.tap()
            page.wait_for_timeout(600)
        btn = page.locator("[data-testid=manage-subscription]").locator("visible=true")
        if kind == "cadeau":
            check("Nova Pro offert : pas de bouton « Gérer mon abonnement »", btn.count() == 0)
            ids = palette_ids("abonnement")
            check("Nova Pro offert : pas d'entrée de palette", "pal.manageSubscription" not in ids, ids)
            snap("cadeau")
            return

        try:
            btn.first.wait_for(timeout=8000)
        except Exception:
            pass
        check("abonné : bouton « Gérer mon abonnement » visible" + (" dans le menu du compte" if tel else " dans la pastille du compte"), btn.count() > 0)
        if not btn.count():
            snap("pas_de_bouton")
            return
        label = (btn.first.get_attribute("aria-label") or "") + " " + btn.first.inner_text()
        check("libellé clair", "Gérer mon abonnement" in label, label)
        if tel:
            check("menu : la formule est rappelée (Nova Pro mensuel)", "Nova Pro mensuel" in btn.first.inner_text(), btn.first.inner_text())
        snap("1_bouton")

        # 2. Portail pas activé dans Stripe → message clair, pas d'onglet vide laissé ouvert.
        pages_avant = len(ctx.pages)
        (btn.first.tap if tel else btn.first.click)()
        err = page.locator("[data-testid=billing-portal-error]").locator("visible=true")
        try:
            err.first.wait_for(timeout=8000)
        except Exception:
            pass
        txt = err.first.inner_text() if err.count() else ""
        check("portail indisponible : message clair en français", "pas encore ouverte" in txt and "continue normalement" in txt, txt)
        check("portail indisponible : aucun mot technique de Stripe à l'écran", "configuration" not in txt.lower() and "dashboard" not in txt.lower(), txt)
        page.wait_for_timeout(500)
        check("portail indisponible : aucun onglet vide laissé ouvert", len(ctx.pages) == pages_avant, len(ctx.pages))
        check("action « portal » demandée avec une adresse de retour", bool(sim.portal_calls) and str(sim.portal_calls[-1].get("return_url", "")).startswith("http"), sim.portal_calls)
        no_overlap("message d'erreur")
        snap("2_portail_indisponible")

        # 3. Portail disponible → nouvel onglet sur le portail.
        sim.portal = "ok"
        if not tel:
            fermer = page.locator("[data-testid=billing-portal-error] button").locator("visible=true")
            if fermer.count():
                fermer.first.click()
        with ctx.expect_page(timeout=10000) as nouvelle:
            (btn.first.tap if tel else btn.first.click)()
        onglet = nouvelle.value
        try:
            onglet.wait_for_url(re.compile(r"billing\.stripe\.com"), timeout=10000)
        except Exception:
            pass
        check("portail disponible : nouvel onglet ouvert sur le portail Stripe", onglet.url.startswith(PORTAIL), onglet.url)
        check("le studio reste ouvert (pas quitté)", page.url.startswith(BASE.rstrip("/")), page.url)
        onglet.close()

        # 4. Palette.
        if tel:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        ids = palette_ids("abonnement")
        check("palette Ctrl+K : « Gérer mon abonnement Nova Pro »", "pal.manageSubscription" in ids, ids)
        snap("3_fin")
    except Exception as e:  # noqa: BLE001
        check("scénario sans exception", False, repr(e))
        try:
            snap("exception")
        except Exception:
            pass
    finally:
        errs = [e["text"] for e in log.errors() if "billing" not in e["text"].lower() and "non-2xx" not in e["text"].lower()]
        r["erreurs_console"] = errs[:10]
        save_log(log)
        ctx.close()
        b.close()


def main():
    names = [a for a in sys.argv[1:] if a in CASES] or list(CASES)
    t0 = time.time()
    with sync_playwright() as p:
        for n in names:
            run_case(p, n, **CASES[n])
    ok = all(c["ok"] for c in res["cas"].values())
    res["ok"] = ok
    res["duree_s"] = round(time.time() - t0, 1)
    (OUT / "gerer_abonnement.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(("TOUT VERT" if ok else "ÉCHECS") + f" : {sum(len(c['checks']) for c in res['cas'].values())} vérifications, {res['duree_s']} s", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
