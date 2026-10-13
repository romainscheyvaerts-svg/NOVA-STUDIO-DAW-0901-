"""Tarifs Nova (grille du 14/10/2026), 100 % hors production : nova-billing SIMULÉ.

Le Supabase du catalogue est simulé par qa_hors_prod (via qalib) ; ce scénario simule EN PLUS
les réponses de nova-billing (grille, statut du compte, décision d'export, paiement Stripe)
pour chaque cas, au bureau (1600 × 900) et au téléphone (390 × 844, au doigt), avec captures :

  1. gratuit       : pas d'export ; bandeau « Exporter ce projet : 1,99 € ou Nova Pro 9,99 €/mois »,
                     écran Nova Pro mensuel / annuel avec l'économie ;
  2. export_199    : « Payer 1,99 € et exporter » → paiement (simulé) → projet débloqué (« payé ») ;
  3. pro           : Nova Pro → exports illimités ;
  4. instru        : instru achetée → « Licence achetée : export offert + 1 mois de Nova Pro offert » ;
  5. melodie       : mélodie achetée → 7 jours de Nova Pro offerts ;
  6. refus         : instru du catalogue non achetée → export refusé (acheter la licence), aucun paiement possible ;
  7. ancienne      : serveur pas encore à jour → ancienne grille, message clair, jamais « Produit inconnu » ;
  8. capture       : logiciel d'enregistrement signalé (appli Windows / iPhone) + instru non achetée →
                     lecture coupée et message ; l'export n'est pas ouvert dans ce cas.

  NOVA_URL=http://127.0.0.1:3447/ python qa/tarifs.py [--vp pc|tel390] [cas ...]

Au plus UN navigateur headless à la fois (la machine fait tourner d'autres tests).
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402  (Supabase simulé, production bloquée)
from qalib import launch, new_page, BASE, Log, save_log  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT, btn, visible  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-tarifs\captures"))
OUT.mkdir(parents=True, exist_ok=True)

GRILLE = {
    "version": "2026-10-14", "currency": "eur", "taxes": "TTC", "export": {"cents": 199, "par": "projet"},
    "pro": {"mois_cents": 999, "an_cents": 8900, "economie_an_cents": 3088, "economie_an_pourcent": 26, "mois_offerts_an": 3,
            "stockage_go": 20, "melodies_offertes_par_mois": 1},
    "cadeaux": {"instru_jours": 30, "melodie_jours": 7, "melodie_exclusive_jours": 30, "studio_jours": 30},
    "gratuit": {"projets_en_ligne": 1, "projet_jours": 7, "extrait_secondes": 30, "export": False},
}


def statut(pro=None):
    return {"grille": "2026-10-14", "plans": [], "admin": False, "pro": pro,
            "features": {"exports_illimites": bool(pro and pro["active"]), "collab_hote": bool(pro and pro["active"]), "import_instrus": bool(pro and pro["active"])},
            "melodie_offerte": {"droit": False, "restantes": 0, "par_mois": 1}, "free_exports_left": 0, "free_exports_total": 0}


def cadeau(days_left, total, source):
    return {"active": True, "source": "cadeau", "paid": False, "interval": None, "until": None,
            "cadeau": {"active": True, "until": None, "days_left": days_left, "total_days": total, "sources": [{"source": source, "days": total, "label": DEFAULT_BEAT}]}}


class Billing:
    """nova-billing simulé pour UN cas : grille, statut, export_access (selon le projet reçu), paiement."""

    def __init__(self, cas):
        self.cas = cas
        self.calls = []
        self.paid = False

    def access(self, body):
        ids = body.get("catalog_ids") or []
        scope = body.get("scope") or "mix"
        items = [{"id": i, "title": DEFAULT_BEAT, "kind": "melody" if self.cas == "melodie" else "beat", "owned": self.cas in ("instru", "melodie")} for i in ids]
        base = {"grille": "2026-10-14", "missing": [], "items": items, "login_required": False, "kits": bool(body.get("kits")), "offers": None, "pro": None}
        if self.cas == "refus" and ids and scope == "mix":
            return {**base, "unlocked": False, "via": None, "reason": "catalogue_non_achete",
                    "missing": [{"id": i, "title": DEFAULT_BEAT, "kind": "beat"} for i in ids]}
        if self.cas == "instru":
            return {**base, "unlocked": True, "via": "licence", "reason": None, "pro": {"active": True, "source": "cadeau", "days_left": 30, "total_days": 30, "until": None}}
        if self.cas == "melodie":
            return {**base, "unlocked": True, "via": "licence", "reason": None, "pro": {"active": True, "source": "cadeau", "days_left": 7, "total_days": 7, "until": None}}
        if self.cas == "pro":
            return {**base, "unlocked": True, "via": "pro", "reason": None, "pro": {"active": True, "source": "abonnement", "days_left": 0, "total_days": 0, "until": None}}
        if self.paid:
            return {**base, "unlocked": True, "via": "achat", "reason": None}
        return {**base, "unlocked": False, "via": None, "reason": "paiement", "offers": {"export_cents": 199, "pro_mois_cents": 999, "pro_an_cents": 8900}}

    def reply(self, body):
        a = body.get("action")
        self.calls.append(body)
        if self.cas == "ancienne":
            # Fonction en ligne avant la grille du 14/10 (2e2b234) : actions inconnues → 400.
            if a == "status":
                return 200, {"plans": [], "admin": False, "free_exports_left": 0, "free_exports_total": 10}
            if a == "export_unlocked":
                return 200, {"unlocked": False}
            if a == "use_export_credit":
                return 200, {"unlocked": False, "remaining": 0, "reason": "not_pro"}
            if a == "checkout":
                if body.get("product") in ("export_voices", "collab", "beatmaker"):
                    return 200, {"url": "about:blank#stripe-simule", "session_id": "cs_test_qaold"}
                return 400, {"error": "Produit inconnu"}
            if a == "verify":
                return 200, {"paid": False}
            return 400, {"error": "Action inconnue"}
        if a == "pricing":
            return 200, GRILLE
        if a == "status":
            pro = {"pro": {"active": True, "source": "abonnement", "paid": True, "interval": "month", "until": None,
                           "cadeau": {"active": False, "until": None, "days_left": 0, "total_days": 0, "sources": []}},
                   "instru": cadeau(30, 30, "instru"), "melodie": cadeau(7, 7, "melodie")}.get(self.cas)
            return 200, statut(pro)
        if a == "export_access":
            return 200, self.access(body)
        if a == "checkout":
            if body.get("product") not in ("export_project", "pro_month", "pro_year"):
                return 400, {"error": "Produit inconnu"}
            return 200, {"url": "about:blank#stripe-simule", "session_id": "cs_test_qa199"}
        if a == "verify":
            self.paid = True
            return 200, {"paid": True, "kind": "export_project", "project_key": "x"}
        return 400, {"error": "Action inconnue"}


def route_billing(page, sim: Billing):
    def handler(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS"})
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        st, payload = sim.reply(body)
        route.fulfill(status=st, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(payload))
    # Route de la PAGE : passe avant le simulateur générique du contexte (qa_hors_prod).
    page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/functions/v1/nova-billing"), handler)


def open_studio(page):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(1500)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 60)
    page.wait_for_timeout(800)
    close_welcome(page)


def sans_instru_du_catalogue(page):
    """Projet sur sa propre instru (aucune instru du catalogue) : même chemin que l'interface (__novaTest, serveur de dev)."""
    page.evaluate("() => window.__novaTest.update(d => { for (const t of d.tracks) { delete t.instrumentId; } })")
    page.wait_for_timeout(300)


def open_export(page):
    dlg = page.locator("[role=dialog][aria-labelledby=export-title]")
    page.keyboard.press("Control+Shift+E")
    try:
        dlg.wait_for(timeout=4000)
        return dlg
    except Exception:
        pass
    b = btn(page, re.compile(r"^\W*Exporter( le mix)?\s*$"))
    if not visible(b):
        menu = page.get_by_role("button", name=re.compile("Ouvrir le menu|Menu")).locator("visible=true").first
        menu.click(); page.wait_for_timeout(500)
        b = btn(page, re.compile(r"^\W*Exporter"))
    b.click()
    dlg.wait_for(timeout=8000)
    return dlg


def paywall(page):
    pw = page.get_by_test_id("export-paywall")
    t0 = time.time()
    while time.time() - t0 < 15:
        if pw.count() and pw.first.get_attribute("data-state") not in (None, "loading"):
            return pw.first
        page.wait_for_timeout(250)
    raise TimeoutError("bandeau d'export du serveur absent")


def run_case(p, cas, vp, res):
    name = f"tarifs_{cas}_{vp}"
    log = Log(name)
    r = {"cas": cas, "vp": vp, "ok": True, "checks": [], "captures": []}
    sim = Billing(cas)

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:200]} if extra else {})})
        if not cond:
            r["ok"] = False

    def snap(tag):
        path = OUT / f"{name}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    route_billing(page, sim)
    t0 = time.time()
    try:
        open_studio(page)
        if cas in ("gratuit", "export_199", "pro", "ancienne"):
            sans_instru_du_catalogue(page)
        if cas == "capture":
            # Ce que l'appli Windows (capture_guard.py) ou l'iPhone (SceneDelegate.swift) envoient au DAW.
            page.evaluate("() => window.__novaCaptureGuard(['OBS Studio'])")
            page.wait_for_timeout(400)
            page.keyboard.press("Space")
            page.wait_for_timeout(1500)
            playing = page.evaluate("() => window.__novaTest.getState().isPlaying")
            banner = page.get_by_test_id("capture-guard")
            check("OBS signalé + instru non achetée : lecture coupée", not playing, playing)
            check("message clair (logiciel nommé, quoi faire)", banner.count() and "OBS Studio" in banner.first.inner_text() and "achète la licence" in banner.first.inner_text(), banner.first.inner_text() if banner.count() else "")
            snap("01_lecture_coupee")
            page.evaluate("() => window.__novaCaptureGuard([])")
            page.wait_for_timeout(400)
            check("logiciel fermé : message retiré", page.get_by_test_id("capture-guard").count() == 0, "")
            raise StopIteration
        dlg = open_export(page)
        pw = paywall(page)
        state = pw.get_attribute("data-state")
        texte = pw.inner_text()
        r["paywall"] = {"state": state, "texte": texte[:300]}
        acc = [c for c in sim.calls if c.get("action") == "export_access"]
        check("le DAW demande la décision au serveur (export_access)", acc or cas == "ancienne", acc[:1])
        if acc:
            check("projet envoyé : clé, instrus du catalogue, kits, portée", all(k in acc[0] for k in ("project_key", "catalog_ids", "kits", "scope")), acc[0])
        if cas == "gratuit":
            check("bandeau « Exporter ce projet : 1,99 € ou Nova Pro 9,99 €/mois »", state == "paiement" and "Exporter ce projet : 1,99 € ou Nova Pro 9,99 €/mois" in texte, texte)
            snap("01_bandeau")
            page.get_by_test_id("export-show-pro").click(); page.wait_for_timeout(500)
            plans = page.get_by_test_id("nova-pro-plans").first
            pt = plans.inner_text()
            check("Nova Pro mensuel 9,99 € et annuel 89 € avec l'économie (30,88 €, −26 %)",
                  "9,99 €" in pt and "89 €" in pt and "30,88 €" in pt and "26 %" in pt, pt)
            plans.scroll_into_view_if_needed()
            snap("02_nova_pro_mensuel_annuel")
            check("aucun export gratuit : bouton principal = payer", "PAYER 1,99 € ET EXPORTER" in dlg.inner_text().upper() or "Payer 1,99 € et exporter" in texte, "")
        elif cas == "export_199":
            check("offre 1,99 €", state == "paiement", texte)
            page.get_by_test_id("export-pay").click()
            t1 = time.time()
            while time.time() - t1 < 20 and not any(c.get("action") == "verify" for c in sim.calls):
                page.wait_for_timeout(300)
            co = [c for c in sim.calls if c.get("action") == "checkout"]
            check("paiement Stripe « export_project » avec la clé du projet", co and co[0].get("product") == "export_project" and co[0].get("project_key"), co[:1])
            t1 = time.time()
            ok = False
            while time.time() - t1 < 25:
                pw2 = page.get_by_test_id("export-paywall")
                if pw2.count() and pw2.first.get_attribute("data-state") == "achat":
                    ok = True
                    break
                page.wait_for_timeout(300)
            check("après paiement : « Export de ce projet payé » (réexports illimités)", ok, page.get_by_test_id("export-paywall").first.inner_text() if page.get_by_test_id("export-paywall").count() else "")
            snap("01_paye")
        elif cas == "pro":
            check("Nova Pro : exports illimités", state == "pro" and "Nova Pro" in texte, texte)
            snap("01_pro")
        elif cas == "instru":
            check("« Licence achetée : export offert + 1 mois de Nova Pro offert »", state == "licence" and "Licence achetée : export offert" in texte and "1 mois de Nova Pro offert" in texte, texte)
            label = dlg.inner_text().upper()
            check("bouton d'export actif (pas de paiement)", "PAYER" not in label and "ACHETER L'INSTRU" not in label, "")
            snap("01_licence")
        elif cas == "melodie":
            check("mélodie achetée : export offert + 7 jours de Nova Pro", state == "licence" and "7 jours de Nova Pro offert" in texte, texte)
            snap("01_melodie")
        elif cas == "refus":
            check("instru non achetée : export refusé, licence à acheter (+ 1 mois de Nova Pro offert)",
                  state == "catalogue" and "pas encore achetée" in texte and "1 mois de Nova Pro" in texte, texte)
            check("aucun bouton « Payer 1,99 € » pour contourner la licence", page.get_by_test_id("export-pay").count() == 0, "")
            snap("01_refus")
        elif cas == "ancienne":
            check("ancienne grille : prix actuels (2 €, 5 €/mois) + message clair", "2 €" in texte and "5 €/mois" in texte and "pas encore actifs" in texte, texte)
            page.get_by_test_id("export-pay").click()
            page.wait_for_timeout(2500)
            co = [c for c in sim.calls if c.get("action") == "checkout"]
            check("paiement avec l'ancien produit (export_voices) : jamais « Produit inconnu »",
                  co and co[-1].get("product") == "export_voices" and "Produit inconnu" not in page.inner_text("body"), co[-1:] if co else "")
            snap("01_ancienne_grille")
        errs = [e["text"] for e in log.errors() if "Failed to load resource" not in e["text"]]
        check("aucune erreur de page", not errs, errs[:3])
    except StopIteration:
        pass
    except Exception as e:  # noqa
        r["ok"] = False
        r["checks"].append({"label": "EXCEPTION", "ok": False, "extra": f"{type(e).__name__}: {str(e)[:300]}"})
        try:
            snap("ECHEC")
        except Exception:
            pass
    finally:
        r["secs"] = round(time.time() - t0, 1)
        r["blocked_writes"] = page._blocked[:10]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    res.append(r)
    print(("OK  " if r["ok"] else "KO  ") + f"{cas} [{vp}] " + "; ".join(c["label"] for c in r["checks"] if not c["ok"]), flush=True)


CAS = ["gratuit", "export_199", "pro", "instru", "melodie", "refus", "ancienne", "capture"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp", choices=["pc", "tel390"], action="append")
    ap.add_argument("cas", nargs="*")
    a = ap.parse_args()
    vps = a.vp or ["pc", "tel390"]
    todo = a.cas or CAS
    res = []
    with sync_playwright() as p:
        for vp in vps:
            for cas in todo:
                run_case(p, cas, vp, res)  # un seul navigateur à la fois
    (OUT / "resultats_tarifs.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = all(r["ok"] for r in res)
    print(f"\n{sum(r['ok'] for r in res)}/{len(res)} cas OK — captures : {OUT}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
