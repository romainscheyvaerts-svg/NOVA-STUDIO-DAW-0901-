"""👤 Un seul compte partout : la barre du haut (et l'accueil) montrent le compte connecté, quel que soit
le point de connexion. 100 % hors production.

Avant : NOVA parle à deux projets Supabase. La barre ne montrait que l'« ancien » compte principal
(fenêtre « Se connecter »), alors que les paiements, la collaboration, les séances en ligne et l'appli
Windows utilisent le compte Make Music (studiomakemusic.com). Résultat : connecté par la fenêtre
Nova Pro, le site ou l'appli Windows, on lisait toujours « Se connecter » ; et « Se connecter »
refusait les identifiants de studiomakemusic.com (compte inconnu de l'ancien projet).

Supabase simulé (qa_hors_prod) + routes de ce scénario : l'ancien projet (sqduhf…) REFUSE les
identifiants (compte Make Music seulement, le cas réel), le projet Make Music (mxdrx…) les accepte
(session simulée, jeton sans signature). nova-billing simulé (compte gratuit). Navigateur headless.

Cas (chacun part d'un point de connexion) :
  session   (1366, sombre) : session Make Music déjà ouverte (site / appli Windows) → l'accueil affiche le
            compte (« Compte Make Music »), la barre du studio aussi (plus de « Connexion ») ;
  barre     (1366, clair)  : « Connexion » de la barre → fenêtre de connexion → identifiants studiomakemusic.com
            → connecté (la fenêtre se ferme, la barre montre le compte) ; « Se déconnecter » → les DEUX comptes
            sont fermés (la barre redevient « Connexion », plus de session Make Music enregistrée) ;
  nova_pro  (1366, sombre) : import d'un son de l'ordinateur → fenêtre Nova Pro → « Se connecter » (compte
            Make Music) → la barre montre le compte sans recharger ;
  tel       (390, sombre)  : session Make Music → menu ☰ : le compte (e-mail) et « Déconnexion », pas « Se connecter ».

  NOVA_URL=http://127.0.0.1:3426/ PYTHONIOENCODING=utf-8 python qa/compte_unique.py [cas ...]
Sorties : D:\\1 WORK\\CONTENU\\nova-152\\nettoyage\\qa (captures + compte_unique.json)
"""
import io
import json
import math
import os
import re
import struct
import sys
import time
import wave
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

USER = "6f1e2d3c-4b5a-4968-8776-655443322110"
EMAIL = "artiste.compte@exemple.be"
PASSWORD = "motdepasse-qa-123"
CATALOG_KEY = "sb-mxdrxpzxbgybchzzvpkf-auth-token"

CASES = {
    "session": {"vp": "pc1366", "theme": "dark"},
    "barre": {"vp": "pc1366", "theme": "light"},
    "nova_pro": {"vp": "pc1366", "theme": "dark"},
    "tel": {"vp": "tel390", "theme": "dark"},
}
res = {"cas": {}}


def wav_bytes(seconds=2.0, sr=44100):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / sr))) for i in range(int(seconds * sr))))
    return buf.getvalue()


def run_case(p, case, vp, theme):
    log = Log(f"compte_{case}")
    tel = vp.startswith("tel")
    r = {"vp": vp, "theme": theme, "ok": True, "checks": [], "captures": []}
    res["cas"][case] = r
    sess = qa_hors_prod.compte_simule(USER, EMAIL)
    seen = {"main_token": 0, "mm_token": 0, "mm_logout": 0}

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:400]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{case}] {label}" + ("" if cond else f"  → {str(extra)[:300]}"), flush=True)

    def snap(tag):
        path = OUT / f"compte_{case}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def visible(sel):
        return page.locator(sel).locator("visible=true").count() > 0

    def bar_connected():
        return visible("[data-testid=bar-account]") and visible("[aria-label='Se déconnecter']") and not visible("[aria-label='Connexion']")

    def wait(fn, timeout_s=10):
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            if fn():
                return True
            page.wait_for_timeout(250)
        return fn()

    def mm_stored():
        return page.evaluate(f"() => !!localStorage.getItem('{CATALOG_KEY}')")

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    init = f"localStorage.setItem('nova_theme', '{theme}');"
    if case in ("session", "tel"):
        init += f" localStorage.setItem('{CATALOG_KEY}', {json.dumps(json.dumps(sess))});"
    ctx.add_init_script(f"try {{ {init} }} catch (e) {{}}")

    hdr = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}

    def main_auth(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=hdr)
        if "/token" in request.url:
            seen["main_token"] += 1
            # Compte Make Music seulement : inconnu de l'ancien projet (le cas réel).
            return route.fulfill(status=400, headers=hdr, content_type="application/json",
                                 body=json.dumps({"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}))
        if "/logout" in request.url:
            return route.fulfill(status=204, headers=hdr)
        return route.fulfill(status=401, headers=hdr, content_type="application/json", body=json.dumps({"msg": "no session"}))

    def mm_auth(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=hdr)
        if "/token" in request.url:
            seen["mm_token"] += 1
            try:
                body = json.loads(request.post_data or "{}")
            except Exception:
                body = {}
            if body.get("email") == EMAIL and body.get("password") == PASSWORD:
                return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps(sess))
            return route.fulfill(status=400, headers=hdr, content_type="application/json",
                                 body=json.dumps({"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}))
        if "/logout" in request.url:
            seen["mm_logout"] += 1
            return route.fulfill(status=204, headers=hdr)
        return route.fallback()

    def billing(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=hdr)
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        if body.get("action") == "status":
            payload = {"grille": "2026-10-14", "plans": [], "admin": False, "pro": None,
                       "features": {"exports_illimites": False, "collab_hote": False, "import_instrus": False}}
        else:
            payload = {"plans": [], "admin": False}
        return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps(payload))

    page.route(re.compile(r"^https://sqduhfckgvyezdiubeei\.supabase\.co/auth/v1/"), main_auth)
    page.route(re.compile(r"^https://mxdrxpzxbgybchzzvpkf\.supabase\.co/auth/v1/"), mm_auth)
    page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/functions/v1/nova-billing"), billing)
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)
        if case == "session":
            ok = wait(lambda: visible("[data-testid=landing-account]"), 10)
            txt = page.locator("[data-testid=landing-account]").locator("visible=true").first.inner_text() if ok else ""
            check("accueil : le compte Make Music est affiché (plus « Connexion »)", ok and "artiste.compte" in txt and "Compte Make Music" in txt, txt)
            snap("1_accueil")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
        page.wait_for_timeout(1500)
        close_welcome(page)
        wait_text_gone(page, "Chargement", 60)
        close_welcome(page)
        page.wait_for_timeout(1500)

        if case == "session":
            check("studio : la barre montre le compte connecté", wait(bar_connected, 8))
            title = page.locator("[data-testid=bar-account]").first.get_attribute("title") or ""
            check("studio : l'infobulle du compte donne l'e-mail", EMAIL in title, title)
            snap("2_studio")

        elif case == "tel":
            page.get_by_test_id("transport-menu").locator("visible=true").first.tap()
            page.wait_for_timeout(700)
            body = page.locator("body").inner_text()
            check("téléphone : le menu montre le compte (e-mail)", EMAIL in body, body[-400:])
            check("téléphone : « Déconnexion » proposé, pas « Se connecter »", "Déconnexion" in body and "Se connecter" not in body, body[-400:])
            bal = balayage_chevauchement(page)
            check("téléphone : aucun bouton recouvert", not bal.get("recouverts") and not bal.get("erreur"), bal)
            snap("1_menu")

        elif case == "barre":
            check("au départ : la barre propose « Connexion »", visible("[aria-label='Connexion']"))
            page.locator("[aria-label='Connexion']").locator("visible=true").first.click()
            dlg = page.locator("[role=dialog][aria-label='Connexion']").first
            dlg.wait_for(timeout=8000)
            dlg.locator("input[type=email]").first.fill(EMAIL)
            dlg.locator("input[type=password]").first.fill(PASSWORD)
            snap("1_fenetre")
            dlg.locator("button[type=submit]").first.click()
            ok = wait(bar_connected, 10)
            check("identifiants studiomakemusic.com : connecté, la barre montre le compte", ok)
            check("la fenêtre de connexion s'est fermée", page.locator("[role=dialog][aria-label='Connexion']").count() == 0)
            check("les deux projets ont reçu la connexion (ancien refusé, Make Music accepté)", seen["main_token"] >= 1 and seen["mm_token"] >= 1, seen)
            check("session Make Music enregistrée", mm_stored())
            snap("2_connecte")
            page.locator("[aria-label='Se déconnecter']").locator("visible=true").first.click()
            ok = wait(lambda: visible("[aria-label='Connexion']") and not visible("[data-testid=bar-account]"), 10)
            check("« Se déconnecter » : la barre redevient « Connexion »", ok)
            check("« Se déconnecter » : le compte Make Music est fermé aussi", wait(lambda: not mm_stored(), 5), seen)
            snap("3_deconnecte")

        elif case == "nova_pro":
            check("au départ : la barre propose « Connexion »", visible("[aria-label='Connexion']"))
            f = OUT / "son_qa_compte.wav"
            f.write_bytes(wav_bytes())
            page.keyboard.press("Control+k")
            page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
            page.keyboard.type("importer un fichier audio", delay=10)
            page.wait_for_timeout(400)
            with page.expect_file_chooser(timeout=8000) as fc:
                page.locator("[data-testid=command-palette] [role=option][data-palette-id='pal.importAudio']").first.click()
            fc.value.set_files(str(f))
            gate = page.locator("[data-testid=pro-gate]").first
            gate.wait_for(timeout=10000)
            gate.locator("input[type=email]").first.fill(EMAIL)
            gate.locator("input[type=password]").first.fill(PASSWORD)
            snap("1_fenetre_pro")
            gate.get_by_role("button", name="Se connecter").first.click()
            ok = wait(bar_connected, 10)
            check("connexion par la fenêtre Nova Pro : la barre montre le compte, sans recharger", ok)
            snap("2_connecte")
            page.keyboard.press("Escape")
    except Exception as e:  # noqa: BLE001
        check("scénario sans exception", False, repr(e))
        try:
            snap("exception")
        except Exception:
            pass
    finally:
        r["erreurs_console"] = [e["text"] for e in log.errors()][:10]
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
    (OUT / "compte_unique.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(("TOUT VERT" if ok else "ÉCHECS") + f" : {sum(len(c['checks']) for c in res['cas'].values())} vérifications, {res['duree_s']} s", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
