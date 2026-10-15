"""« ❓ Comment faire ? » : parcours pas à pas (utils/guides), mode « Montre-moi » et chat.

100 % hors production : Supabase simulé (qa_hors_prod via qalib), nova-billing simulé (cas « gratuit »
de qa/tarifs.py) et l'API de chat SIMULÉE comme dans qa/chat_inge.py (aucun appel à Groq ni à Gemini).

Au bureau (1600 × 900, thème sombre) et au téléphone (390 × 844, au doigt, thème clair) :
  0. le bouton « ❓ Comment faire ? » est là en mode simple (barre du haut ; menu ☰ au téléphone),
     la liste s'ouvre, la recherche trouve, le détail montre étapes / prérequis / pièges ;
     aucun débordement horizontal, cibles d'au moins 44 px ; capture dans l'autre thème aussi ;
  1. « Enregistrer ta voix » en Montre-moi : instru et piste voix déjà là → on démarre au REC (anneau
     autour de REC), vraie prise (micro simulé), arrêt → « C'est fait » ;
  2. « Mixer ta voix » en Montre-moi : anneau sur Mix auto, clic, choix d'un style dans la fenêtre →
     l'étape avance seule, « Fais-le pour moi » lance la lecture, fin ;
  3. « Exporter » en Montre-moi : anneau sur Exporter (☰ au téléphone), fenêtre d'export ouverte →
     l'étape avance, offre payante affichée, fin ; puis Échap ferme un guide en cours ;
  4. chat, question sans l'IA : « comment je fais pour mettre de l'autotune ? » → carte d'étapes
     numérotées (aucune requête), « Fais-le pour moi » pose le style Trap autotune ;
  5. chat, question floue → l'IA (simulée) reçoit un résumé COURT des parcours et renvoie GUIDE ;
     la carte s'affiche, « Montre-moi » démarre le guide sur le studio.

  NOVA_URL=http://127.0.0.1:3466/ python qa/guides.py [--vp pc|tel390]
Sorties : D:\\1 WORK\\CONTENU\\nova-guides\\captures (captures + resultats_guides.json)
Au plus UN navigateur headless à la fois.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-guides\captures")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402,F401  (Supabase simulé, production bloquée)
from qalib import launch, new_page, Log, save_log  # noqa: E402
from tarifs import Billing, route_billing, open_studio  # noqa: E402
from scenarios import bottom_nav  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)
INPUT = "input[placeholder*='rends ma voix plus pro']"
THEMES = {"pc": "dark", "tel390": "light"}


class ChatSim:
    """API de chat simulée : pour une question floue, renvoie l'outil GUIDE du parcours voulu."""

    def __init__(self):
        self.calls = []

    def reply(self, body):
        msg = (body.get("message") or "").lower()
        guides = body.get("guides") or ""
        self.calls.append({"message": body.get("message"), "guides": guides, "octets": len(json.dumps(body, ensure_ascii=False))})
        if "claque" in msg and "mixer-voix" in guides:
            return {"text": "Pour que ça claque, on commence par le mix de ta voix : je te montre.",
                    "actions": [{"action": "GUIDE", "payload": {"id": "mixer-voix"}, "description": "Parcours mixer ta voix"}]}
        return {"text": "Je t'écoute.", "actions": []}


def route_chat(page, sim):
    def handler(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*"})
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(sim.reply(body), ensure_ascii=False))
    page.route(re.compile(r"/api/chat(\?|$)"), handler)


BOX_JS = """(sel) => { const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, display: getComputedStyle(e).display }; }"""

SMALL_TARGETS_JS = """(sel) => [...document.querySelectorAll(sel + ' button, ' + sel + ' input')]
  .filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; })
  .filter(b => b.h < 44 || b.w < 44)"""


def run_vp(p, vp, res):
    name = f"guides_{vp}"
    log = Log(name)
    theme = THEMES[vp]
    tel = vp != "pc"
    r = {"vp": vp, "theme": theme, "ok": True, "checks": [], "captures": [], "requetes": []}
    sim, billing = ChatSim(), Billing("gratuit")

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:300]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{vp}] {label}" + ("" if cond else f"  → {str(extra)[:220]}"), flush=True)

    def snap(tag):
        path = OUT / f"{name}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def tap(loc):
        loc = loc.locator("visible=true").first
        if tel:
            loc.tap()
        else:
            loc.click()

    def coach_step():
        c = page.get_by_test_id("howto-coach")
        return c.get_attribute("data-step") if c.count() else None

    def wait_step(pred, timeout=15):
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = coach_step()
            if pred(s):
                return s
            page.wait_for_timeout(200)
        return coach_step()

    def ring_on(sel):
        ring = page.evaluate(BOX_JS, "[data-testid=howto-ring]")
        tgt = page.evaluate(BOX_JS, sel)
        if not ring or not tgt or ring["display"] == "none":
            return False, {"ring": ring, "cible": tgt}
        ok = ring["x"] <= tgt["x"] + 1 and ring["y"] <= tgt["y"] + 1 and ring["x"] + ring["w"] >= tgt["x"] + tgt["w"] - 1 and ring["y"] + ring["h"] >= tgt["y"] + tgt["h"] - 1
        return ok, {"ring": ring, "cible": tgt}

    def no_overflow(where):
        sw = page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        check(f"{where} : aucun débordement horizontal", sw[0] <= sw[1] + 1, sw)

    def open_panel():
        if tel:
            tap(page.get_by_test_id("transport-menu"))
            page.wait_for_timeout(400)
            tap(page.get_by_test_id("menu-howto"))
        else:
            page.get_by_test_id("open-howto").click()
        page.get_by_test_id("howto-list").wait_for(timeout=5000)
        page.wait_for_timeout(300)

    def start_guide(gid, query):
        open_panel()
        inp = page.get_by_test_id("howto-search")
        inp.fill(query)
        page.wait_for_timeout(200)
        tap(page.get_by_test_id(f"howto-item-{gid}"))
        page.get_by_test_id("howto-detail").wait_for(timeout=4000)
        tap(page.get_by_test_id("howto-showme"))
        page.get_by_test_id("howto-coach").wait_for(timeout=4000)
        page.wait_for_timeout(500)

    def answer_headphones():
        b = page.get_by_role("button", name=re.compile("Oui, j.ai un casque"))
        if b.count() and b.first.is_visible():
            tap(b)
            page.wait_for_timeout(300)

    def chat_open():
        if tel:
            tap(bottom_nav(page).get_by_text("Nova", exact=True))
        elif not page.get_by_test_id("nova-chat").count():
            page.get_by_test_id("nova-open").click()
        page.locator(INPUT).locator("visible=true").first.wait_for(timeout=8000)
        page.wait_for_timeout(300)
        tg = page.get_by_test_id("nova-step-toggle").locator("visible=true")
        if tg.count() and "Réduire" in tg.first.inner_text():
            tg.first.click(); page.wait_for_timeout(200)

    def send(text):
        n_calls = len(sim.calls)
        n_cards = page.get_by_test_id("chat-guide").count()
        inp = page.locator(INPUT).locator("visible=true").first
        inp.fill(text)
        inp.press("Enter")
        t0 = time.time()
        while time.time() - t0 < 10 and page.get_by_test_id("chat-guide").count() <= n_cards:
            page.wait_for_timeout(200)
        page.wait_for_timeout(400)
        return {"api": len(sim.calls) > n_calls}

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    route_billing(page, billing)
    route_chat(page, sim)
    try:
        open_studio(page)
        page.wait_for_timeout(800)

        # 0. Bouton, liste, recherche, détail.
        if tel:
            check("0. « Comment faire ? » dans le menu ☰ (mode simple)", True)
        else:
            bx = page.evaluate(BOX_JS, "[data-testid=open-howto]")
            check("0. bouton « ❓ Comment faire ? » visible dans la barre du haut (mode simple)", bx is not None and bx["w"] > 0, bx)
        open_panel()
        n_items = page.locator("[data-testid^=howto-item-]").count()
        check("0. la liste montre 15 à 25 parcours", 15 <= n_items <= 25, n_items)
        snap("00_liste")
        page.get_by_test_id("howto-search").fill("autotune")
        page.wait_for_timeout(250)
        first = page.locator("[data-testid^=howto-item-]").first.get_attribute("data-testid")
        check("0. recherche « autotune » → « Mettre de l'autotune » en tête", first == "howto-item-autotune", first)
        tap(page.get_by_test_id("howto-item-autotune"))
        det = page.get_by_test_id("howto-detail")
        det.wait_for(timeout=4000)
        steps = page.locator("[data-testid=howto-steps] li").count()
        check("0. détail : étapes numérotées, résultat et pièges", steps >= 3 and page.get_by_test_id("howto-pitfalls").count() == 1, steps)
        small = page.evaluate(SMALL_TARGETS_JS, "[data-testid=howto-panel]") if tel else []
        check("0. cibles d'au moins 44 px dans la fenêtre (téléphone)", not small, small)
        no_overflow("0. liste / détail")
        snap("01_detail_autotune")
        # Même fenêtre dans l'autre thème (capture).
        other = "light" if theme == "dark" else "dark"
        page.evaluate(f"() => {{ document.documentElement.dataset.theme = '{other}'; }}")
        page.wait_for_timeout(300)
        snap(f"02_detail_theme_{other}")
        page.evaluate(f"() => {{ document.documentElement.dataset.theme = '{theme}'; }}")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        check("0. Échap : retour du détail à la liste", page.get_by_test_id("howto-list").count() == 1)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("0. Échap : fenêtre fermée", page.get_by_test_id("howto-panel").count() == 0)

        # 1. Enregistrer ta voix.
        start_guide("enregistrer-voix", "enregistrer")
        st = coach_step()
        txt = page.get_by_test_id("howto-coach-text").inner_text()
        check("1. instru et piste voix déjà là : le guide démarre au REC", "REC" in txt, (st, txt))
        ok, info = ring_on("[data-nova-target=rec]")
        check("1. anneau autour du bouton REC", ok, info)
        no_overflow("1. Montre-moi")
        snap("10_enregistrer_rec")
        tap(page.locator("[data-nova-target=rec]"))
        page.wait_for_timeout(600)
        answer_headphones()
        s2 = wait_step(lambda s: s not in (st, None), 20)
        check("1. la prise démarre → étape suivante (« Réappuie sur REC »)", s2 not in (st, None) and "Réappuie" in page.get_by_test_id("howto-coach-text").inner_text(), s2)
        snap("11_enregistrer_en_cours")
        page.wait_for_timeout(2500)
        tap(page.locator("[data-nova-target=rec]"))
        fin = wait_step(lambda s: s == "fin", 20)
        check("1. arrêt de la prise → « C'est fait »", fin == "fin", fin)
        snap("12_enregistrer_fini")
        tap(page.get_by_test_id("howto-coach-done"))
        page.wait_for_timeout(1200)
        # La carte « Et maintenant ? » peut suivre la 1re prise : elle porte les parcours suivants.
        page.wait_for_timeout(2000)
        nxt = page.get_by_test_id("howto-next")
        if nxt.count():
            check("1. « Et maintenant ? » propose la suite pas à pas (comp, mix)", page.get_by_test_id("howto-next-comp-prises").count() == 1)
            snap("13_et_maintenant")
            close = page.get_by_role("region", name="Et maintenant ?").get_by_role("button", name="Fermer")
            if close.count():
                tap(close)
        page.wait_for_timeout(400)

        # 2. Mixer ta voix (projet sans style de mix : le choix se fait pendant le guide).
        page.evaluate("() => window.__novaTest.update(d => { delete d.vocalMixStyle; })")
        page.wait_for_timeout(300)
        start_guide("mixer-voix", "mixer")
        ok, info = ring_on("[data-nova-target=mix-auto]")
        check("2. anneau autour de « Mix auto »", ok, info)
        snap("20_mix_anneau")
        tap(page.locator("[data-nova-target=mix-auto]"))
        page.locator("[aria-labelledby=vocal-tools-title]").wait_for(timeout=6000)
        s = wait_step(lambda s: s == "2", 6)
        check("2. fenêtre Mix auto ouverte → étape 2 (choisir un style)", s == "2", s)
        snap("21_mix_styles")
        style = page.locator("[aria-labelledby=vocal-tools-title] button[aria-pressed]").filter(has_text="Rap clair").first
        tap(style)
        s = wait_step(lambda s: s == "3", 8)
        check("2. style choisi → l'étape avance toute seule", s == "3", s)
        doit = page.get_by_test_id("howto-coach-doit")
        check("2. étape « lecture » : « Fais-le pour moi » proposé", s == "3" and doit.count() == 1, s)
        tap(doit)
        s = wait_step(lambda s: s == "4", 6)
        playing = page.evaluate("() => window.__novaTest.getState().isPlaying")
        check("2. « Fais-le pour moi » lance la lecture et avance", s == "4" and playing, (s, playing))
        snap("22_mix_nova")
        tap(page.get_by_test_id("howto-coach-next"))
        fin = wait_step(lambda s: s == "fin", 6)
        check("2. dernière étape passée → « C'est fait »", fin == "fin", fin)
        tap(page.get_by_test_id("howto-coach-done"))
        page.wait_for_timeout(300)
        # Le guide est fermé : Échap revient à la fenêtre Mix auto ; puis stop.
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("2. guide fermé, Échap ferme ensuite Mix auto (pas le guide)", page.locator("[aria-labelledby=vocal-tools-title]").count() == 0)
        stop = page.get_by_role("button", name="Stop").locator("visible=true")
        if stop.count():
            tap(stop)
        page.wait_for_timeout(2800)
        nud = page.get_by_test_id("howto-nudge")
        if nud.count():
            check("2. « Ton mix est posé. Et après ? » propose exporter / masteriser", page.get_by_test_id("howto-next-exporter").count() == 1)
            snap("23_et_apres")
            tap(page.get_by_test_id("howto-next-off"))
            page.wait_for_timeout(300)
            check("2. « Ne plus montrer » ferme la carte", page.get_by_test_id("howto-nudge").count() == 0)

        # 3. Exporter (fenêtre payante), puis Échap.
        start_guide("exporter", "exporter")
        sel = "[data-testid=phone-export]" if tel else "[data-bar-item=exporter]"
        ok, info = ring_on(sel)
        check(f"3. anneau autour de « Exporter » ({'bouton du haut, téléphone' if tel else 'barre du haut'})", ok, info)
        snap("30_export_anneau")
        if tel:
            tap(page.get_by_test_id("phone-export"))
        else:
            page.locator("[data-bar-item=exporter]").locator("visible=true").first.click()
        page.locator("[role=dialog][aria-labelledby=export-title]").wait_for(timeout=8000)
        s = wait_step(lambda s: s == "2", 6)
        check("3. fenêtre d'export ouverte → étape 2", s == "2", s)
        page.wait_for_timeout(1500)
        snap("32_export_fenetre")
        tap(page.get_by_test_id("howto-coach-next"))
        tap(page.get_by_test_id("howto-coach-next"))
        fin = wait_step(lambda s: s == "fin", 6)
        check("3. étapes passées → « C'est fait »", fin == "fin", fin)
        check("3. aucun paiement lancé par le guide", not any(c.get("action") == "checkout" for c in billing.calls), [c.get("action") for c in billing.calls])
        tap(page.get_by_test_id("howto-coach-done"))
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        if page.locator("[role=dialog][aria-labelledby=export-title]").count():
            cl = page.locator("[role=dialog][aria-labelledby=export-title]").get_by_role("button", name=re.compile("Fermer")).locator("visible=true")
            if cl.count():
                tap(cl); page.wait_for_timeout(300)
        start_guide("tempo", "tempo")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("3. Échap ferme le guide en cours", page.get_by_test_id("howto-coach").count() == 0)

        # 4. Chat sans l'IA : autotune.
        chat_open()
        o = send("comment je fais pour mettre de l'autotune ?")
        card = page.get_by_test_id("chat-guide").last
        check("4. « comment … autotune ? » : compris sans l'IA (aucune requête)", not o["api"], o)
        check("4. carte du parcours « autotune » avec étapes numérotées", card.get_attribute("data-guide") == "autotune" and card.locator("li").count() >= 3)
        check("4. étape déjà faite cochée (instru chargée)", card.locator("li[data-skipped='1']").count() >= 1)
        snap("40_chat_autotune")
        tap(card.get_by_test_id("chat-guide-doit"))
        page.wait_for_timeout(1500)
        style = page.evaluate("() => window.__novaTest.getState().vocalMixStyle")
        lignes = page.evaluate("() => [...document.querySelectorAll('[data-testid=chat-result]')].map(e => e.innerText)")
        check("4. « Fais-le pour moi » : style Trap autotune posé, compte rendu ✅", style == "trap-autotune" and any("Trap autotune" in x for x in lignes), (style, lignes[-2:]))
        snap("41_chat_fait")

        # 5. Chat avec l'IA (simulée) : GUIDE.
        o = send("comment je fais pour que ça claque ?")
        req = sim.calls[-1] if sim.calls else {}
        r["requetes"].append(req)
        check("5. question floue : part à l'IA avec un résumé COURT des parcours", o["api"] and 0 < len(req.get("guides", "")) <= 900, {k: (len(v) if isinstance(v, str) else v) for k, v in req.items()})
        card = page.get_by_test_id("chat-guide").last
        check("5. l'outil GUIDE affiche la carte « Mixer ta voix »", card.get_attribute("data-guide") == "mixer-voix", card.get_attribute("data-guide"))
        snap("50_chat_guide_ia")
        tap(card.get_by_test_id("chat-guide-showme"))
        page.get_by_test_id("howto-coach").wait_for(timeout=5000)
        page.wait_for_timeout(600)
        check("5. « Montre-moi » depuis le chat : le guide démarre sur le studio", page.get_by_test_id("howto-coach").get_attribute("data-guide") == "mixer-voix")
        if tel:
            check("5. téléphone : retour à l'onglet Morceau (le chat couvrait l'écran)", page.locator(INPUT).locator("visible=true").count() == 0)
        snap("51_chat_montre_moi")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        errs = [e["text"] for e in log.errors() if "Failed to load resource" not in e["text"]]
        check("aucune erreur de page", not errs, errs[:3])
    except Exception as e:  # noqa
        r["ok"] = False
        r["checks"].append({"label": "EXCEPTION", "ok": False, "extra": f"{type(e).__name__}: {str(e)[:300]}"})
        print(f"KO  [{vp}] EXCEPTION {type(e).__name__}: {str(e)[:300]}", flush=True)
        try:
            snap("ECHEC")
        except Exception:
            pass
    r["appels_api_chat_simulee"] = len(sim.calls)
    save_log(log, {"result": r})
    ctx.close(); b.close()
    res.append(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp", choices=["pc", "tel390"], action="append")
    a = ap.parse_args()
    res = []
    with sync_playwright() as p:
        for vp in a.vp or ["pc", "tel390"]:
            run_vp(p, vp, res)  # un seul navigateur à la fois
    (OUT / "resultats_guides.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    n = sum(len(r["checks"]) for r in res)
    ok = sum(c["ok"] for r in res for c in r["checks"])
    print(f"\n{ok}/{n} vérifications OK — captures : {OUT}")
    sys.exit(0 if res and n and all(r["ok"] for r in res) else 1)


if __name__ == "__main__":
    main()
