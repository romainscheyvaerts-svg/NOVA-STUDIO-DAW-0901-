"""🎙️ Mode simple à UNE piste REC + 👤 « Créer un compte » = compte Make Music (16/10/2026). 100 % hors production.

Décisions de Romain :
  1. mode simple : un nouveau projet n'a que BEAT (l'instru) et UNE piste REC (plus LEAD COUPLET, LEAD REFRAIN,
     BACK 1, BACK 2) ; « + Piste voix » en ajoute ; le mode avancé garde le gabarit complet ; un projet déjà
     créé garde ses pistes ;
  2. « Créer un compte » (barre, accueil, fenêtres qui demandent un compte) crée le compte MAKE MUSIC (mxdrx…),
     avec le parcours du site studiomakemusic.com : nom, e-mail, mot de passe de 12 caractères (majuscule,
     minuscule, chiffre), e-mail de confirmation (lien vers studiomakemusic.com/auth → studio /daw),
     « Renvoyer l'e-mail », connexion refusée tant que l'e-mail n'est pas confirmé (message clair).
     Compte Make Music seulement : « Sauvegarder en ligne » passe par les séances en ligne Make Music et
     « Ouvrir un projet » liste ces séances (avant : « Connecte-toi », alors qu'on l'était).

Supabase simulé (qa_hors_prod) + routes de ce scénario : l'ancien projet (sqduhf…) refuse tout et NE DOIT
recevoir AUCUNE inscription ; le projet Make Music (mxdrx…) simule l'inscription (jamais de vrai compte),
le renvoi d'e-mail, la connexion (refusée « e-mail non confirmé » la 1re fois, puis acceptée) et la liste
des séances en ligne (daw-session list_mine). nova-billing simulé (compte gratuit). Navigateur headless.

Cas :
  pistes_simple  (1366, sombre)  : nouveau projet → BEAT + REC seulement ; « + Piste voix » ajoute une voix ;
                                    gabarit sauvé en .zip pour le cas suivant ;
  pistes_avance  (1366, clair)   : mode avancé → gabarit complet (6 pistes) ; .zip ; puis retour en mode simple :
                                    le projet rouvert garde ses 6 pistes ;
  pistes_tel     (390, sombre)   : téléphone : BEAT + REC, rien de recouvert ;
  inscription    (1366, sombre)  : accueil → Connexion → Créer un compte : règles en direct, mot de passe faible
                                    refusé sans appel serveur, inscription Make Music (nom, lien de retour),
                                    « Confirme ton e-mail », renvoi, « J'ai confirmé » → connexion refusée
                                    (non confirmé, message + renvoi) puis acceptée : l'accueil montre le compte ;
  inscription_tel (390, clair)   : studio → ☰ → Se connecter → Créer un compte : e-mail déjà inscrit → message
                                    clair ; rien de recouvert ;
  palette_pro    (1366, clair)   : Ctrl+K « Créer mon compte » ouvre l'inscription ; fenêtre Nova Pro :
                                    « Crée-le ici » → formulaire Make Music dans la fenêtre → « Confirme ton e-mail » ;
  cloud_mm       (1366, clair)   : compte Make Music seulement → « Sauvegarder » propose la séance en ligne (plus
                                    « Se connecter ») ; « Ouvrir un projet » liste ses séances ; accueil idem ;
                                    sauvegarde en ligne demandée au chat / palette → « Emporter la session ».

  NOVA_URL=http://127.0.0.1:3428/ PYTHONIOENCODING=utf-8 python qa/simple_compte.py [cas ...]
Sorties : D:\\1 WORK\\CONTENU\\nova-153\\simple-compte\\qa (captures + simple_compte.json)
"""
import json
import os
import re
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-153\simple-compte\qa")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402  (Supabase simulé, production bloquée)
import qa_hors_prod  # noqa: E402
from qalib import launch, new_page, Log, save_log, balayage_chevauchement  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = qalib.BASE
OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)

USER = "7a1e2d3c-4b5a-4968-8776-655443322119"
EMAIL = "nouvelle.artiste@exemple.be"
NAME = "Lina K"
PASSWORD = "Motdepasse2026"
DEJA = "deja.inscrite@exemple.be"
CATALOG_KEY = "sb-mxdrxpzxbgybchzzvpkf-auth-token"
EXTRA = ["lead-couplet", "lead-refrain", "back-1", "back-2"]

CASES = {
    "pistes_simple": {"vp": "pc1366", "theme": "dark"},
    "pistes_avance": {"vp": "pc1366", "theme": "light"},
    "pistes_tel": {"vp": "tel390", "theme": "dark"},
    "inscription": {"vp": "pc1366", "theme": "dark"},
    "inscription_tel": {"vp": "tel390", "theme": "light"},
    "palette_pro": {"vp": "pc1366", "theme": "light"},
    "cloud_mm": {"vp": "pc1366", "theme": "light"},
}
res = {"cas": {}}
ZIPS = {}
HDR = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}

STATE_JS = """() => { const s = window.__novaEdit && window.__novaEdit.getState(); if (!s) return null;
  return s.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, inst: !!t.instrumentId, bus: /^(bus-|send-|master)/.test(t.id) || t.type === 'BUS' || t.type === 'MASTER' })); }"""


def run_case(p, case, vp, theme):
    log = Log(f"simple_compte_{case}")
    tel = vp.startswith("tel")
    r = {"vp": vp, "theme": theme, "ok": True, "checks": [], "captures": []}
    res["cas"][case] = r
    sess = qa_hors_prod.compte_simule(USER, EMAIL)
    seen = {"main_signup": 0, "mm_signup": [], "mm_resend": 0, "mm_token": 0, "list_mine": 0}

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:500]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{case}] {label}" + ("" if cond else f"  → {str(extra)[:300]}"), flush=True)

    def snap(tag):
        path = OUT / f"sc_{case}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def visible(sel):
        return page.locator(sel).locator("visible=true").count() > 0

    def wait(fn, timeout_s=10):
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            try:
                if fn():
                    return True
            except Exception:
                pass
            page.wait_for_timeout(250)
        return fn()

    def press(loc):
        loc = loc.locator("visible=true").first
        loc.tap() if tel else loc.click()

    def voices():
        st = page.evaluate(STATE_JS) or []
        return [t for t in st if t["type"] == "AUDIO" and not t["bus"] and not t["inst"]]

    def bal(label):
        b_ = balayage_chevauchement(page)
        check(f"{label} : aucun bouton recouvert", not b_.get("recouverts") and not b_.get("erreur"), b_)

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    init = f"localStorage.setItem('nova_theme', '{theme}');"
    if case == "pistes_avance":
        init += " if (!sessionStorage.getItem('qa_sc_simple')) localStorage.setItem('nova_simple_mode', '0');"
    if case == "cloud_mm":
        init += f" localStorage.setItem('{CATALOG_KEY}', {json.dumps(json.dumps(sess))});"
    ctx.add_init_script(f"try {{ {init} }} catch (e) {{}}")

    def main_auth(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=HDR)
        if "/signup" in request.url:
            seen["main_signup"] += 1
            return route.fulfill(status=400, headers=HDR, content_type="application/json", body=json.dumps({"msg": "ancien projet : inscription interdite ici"}))
        if "/token" in request.url:
            return route.fulfill(status=400, headers=HDR, content_type="application/json",
                                 body=json.dumps({"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}))
        if "/logout" in request.url:
            return route.fulfill(status=204, headers=HDR)
        if "/recover" in request.url:
            return route.fulfill(status=200, headers=HDR, content_type="application/json", body="{}")
        return route.fulfill(status=401, headers=HDR, content_type="application/json", body=json.dumps({"msg": "no session"}))

    def mm_auth(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=HDR)
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        if "/signup" in request.url:
            q = parse_qs(urlsplit(request.url).query)
            seen["mm_signup"].append({"email": body.get("email"), "data": body.get("data"), "redirect_to": (q.get("redirect_to") or [None])[0],
                                      "pw_ok": body.get("password") == PASSWORD})
            ident = [] if body.get("email") == DEJA else [{"id": "i1", "provider": "email"}]
            user = {"id": USER, "aud": "authenticated", "role": "authenticated", "email": body.get("email"), "identities": ident,
                    "user_metadata": body.get("data") or {}, "app_metadata": {}, "created_at": "2026-10-16T10:00:00Z"}
            return route.fulfill(status=200, headers=HDR, content_type="application/json", body=json.dumps(user))
        if "/resend" in request.url:
            seen["mm_resend"] += 1
            return route.fulfill(status=200, headers=HDR, content_type="application/json", body="{}")
        if "/token" in request.url:
            seen["mm_token"] += 1
            if body.get("email") == EMAIL and body.get("password") == PASSWORD:
                if seen["mm_token"] == 1:
                    return route.fulfill(status=400, headers=HDR, content_type="application/json",
                                         body=json.dumps({"code": 400, "error_code": "email_not_confirmed", "msg": "Email not confirmed"}))
                return route.fulfill(status=200, headers=HDR, content_type="application/json", body=json.dumps(sess))
            return route.fulfill(status=400, headers=HDR, content_type="application/json",
                                 body=json.dumps({"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}))
        if "/logout" in request.url:
            return route.fulfill(status=204, headers=HDR)
        return route.fallback()

    def billing(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=HDR)
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        payload = {"grille": "2026-10-14", "plans": [], "admin": False, "pro": None,
                   "features": {"exports_illimites": False, "collab_hote": False, "import_instrus": False}} if body.get("action") == "status" else {"plans": [], "admin": False}
        return route.fulfill(status=200, headers=HDR, content_type="application/json", body=json.dumps(payload))

    def daw_session(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=HDR)
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        if body.get("action") == "list_mine":
            seen["list_mine"] += 1
            rows = [
                {"id": "a1b2c3d4-0000-4000-8000-000000000001", "link": "a1b2c3d4-0000-4000-8000-000000000001." + "k" * 32, "name": "Mon son du mardi",
                 "version": 3, "updated_at": "2026-10-15T18:00:00Z", "updated_from": "iPad", "expires_at": "2026-10-20T18:00:00Z", "days_left": 4,
                 "unlimited": False, "expired": False},
                {"id": "a1b2c3d4-0000-4000-8000-000000000002", "link": None, "name": "Ancienne (effacée)", "expired": True},
            ]
            return route.fulfill(status=200, headers=HDR, content_type="application/json", body=json.dumps({"sessions": rows}))
        return route.fallback()

    page.route(re.compile(r"^https://sqduhfckgvyezdiubeei\.supabase\.co/auth/v1/"), main_auth)
    page.route(re.compile(r"^https://mxdrxpzxbgybchzzvpkf\.supabase\.co/auth/v1/"), mm_auth)
    page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/functions/v1/nova-billing"), billing)
    page.route(re.compile(r"^https://mxdrxpzxbgybchzzvpkf\.supabase\.co/functions/v1/daw-session"), daw_session)

    def landing():
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)

    def studio():
        landing()
        press(page.get_by_text(DEFAULT_BEAT, exact=True))
        page.wait_for_timeout(1500)
        close_welcome(page)
        wait_text_gone(page, "Chargement", 60)
        close_welcome(page)
        page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
        page.wait_for_timeout(1200)

    def save_zip(name):
        dest = OUT / f"sc_{name}.zip"
        page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(900)
        loc = page.get_by_role("button", name=re.compile("cet appareil", re.I)).first
        with page.expect_download(timeout=90000) as dl:
            loc.click()
        dl.value.save_as(str(dest))
        page.wait_for_timeout(500)
        with zipfile.ZipFile(dest) as z:
            pj = json.loads(z.read("project.json"))
        return dest, [t["id"] for t in pj["tracks"]]

    def open_zip(f):
        page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
        page.get_by_text("Charger Projet").first.click()
        page.wait_for_timeout(700)
        with page.expect_file_chooser(timeout=8000) as fc:
            page.get_by_text("Charger depuis l'ordinateur").first.click()
        fc.value.set_files(str(f))
        page.wait_for_timeout(4000)
        close_welcome(page)
        page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
        page.wait_for_timeout(1500)

    def signup_form():
        return page.locator("[data-mm-signup=form]").locator("visible=true").first

    try:
        if case == "pistes_simple":
            studio()
            v = voices()
            check("mode simple : le nouveau projet a BEAT + UNE piste REC", [t["id"] for t in v] == ["track-rec-main"], v)
            check("mode simple : plus de LEAD COUPLET, LEAD REFRAIN, BACK 1, BACK 2 à l'écran",
                  all(page.locator(f"[data-track-header='{i}']").count() == 0 for i in EXTRA) and visible("[data-track-header='track-rec-main']"))

            snap("1_studio_rec_seule")
            bal("bureau sombre")
            press(page.locator("[aria-label='Ajouter une piste voix']"))
            ok = wait(lambda: len(voices()) == 2, 6)
            check("« + Piste voix » ajoute une 2e voix", ok, voices())
            snap("2_piste_voix_ajoutee")
            f, ids = save_zip("simple")
            ZIPS["simple"] = f
            check("le .zip du projet simple contient BEAT, REC et la voix ajoutée (pas les 4 du gabarit avancé)",
                  "track-rec-main" in ids and "instrumental" in ids and not any(i in ids for i in EXTRA), ids)

        elif case == "pistes_avance":
            studio()
            v = voices()
            names = [t["name"] for t in v]
            check("mode avancé : gabarit complet (REC, LEAD COUPLET, LEAD REFRAIN, BACK 1, BACK 2)",
                  names == ["REC", "LEAD COUPLET", "LEAD REFRAIN", "BACK 1", "BACK 2"], names)
            snap("1_studio_avance")
            f, ids = save_zip("avance")
            check("le .zip du projet avancé garde ses 5 voix", all(i in ids for i in EXTRA), ids)
            # Retour en mode simple, rechargement : le projet DÉJÀ créé garde toutes ses pistes.
            page.evaluate("() => { sessionStorage.setItem('qa_sc_simple', '1'); localStorage.setItem('nova_simple_mode', '1'); }")
            page.goto(BASE, wait_until="domcontentloaded")
            open_zip(f)
            simple_now = page.evaluate("() => localStorage.getItem('nova_simple_mode')")
            v2 = [t["id"] for t in voices()]
            check("mode simple + projet existant rouvert : ses 5 voix sont toutes là", simple_now == "1" and all(i in v2 for i in EXTRA) and "track-rec-main" in v2, {"simple": simple_now, "voix": v2})
            snap("2_projet_existant_en_mode_simple")

        elif case == "pistes_tel":
            studio()
            v = voices()
            check("téléphone, mode simple : BEAT + une piste REC", [t["id"] for t in v] == ["track-rec-main"], v)
            snap("1_tel_rec_seule")
            bal("téléphone sombre")

        elif case == "inscription":
            landing()
            snap("0_accueil")
            press(page.locator("button", has_text=re.compile(r"^\s*Connexion\s*$")))
            dlg = page.locator("[role=dialog][aria-label='Connexion']").locator("visible=true").first
            dlg.wait_for(timeout=8000)
            check("la fenêtre dit que c'est le compte Make Music (celui de studiomakemusic.com)", "studiomakemusic.com" in dlg.inner_text())
            press(page.get_by_test_id("auth-signup-open"))
            form = signup_form()
            form.wait_for(timeout=5000)
            check("« Créer un compte » : formulaire Make Music (nom, e-mail, mot de passe)",
                  all(form.locator(f"[data-testid=auth-signup-{k}]").count() == 1 for k in ("name", "email", "password")))
            form.locator("[data-testid=auth-signup-name]").fill(NAME)
            form.locator("[data-testid=auth-signup-email]").fill(EMAIL)
            form.locator("[data-testid=auth-signup-password]").fill("court")
            rules = form.locator("li[data-ok]").evaluate_all("els => els.map(e => [e.textContent.trim(), e.dataset.ok])")
            check("règles du site en direct : 12 caractères, majuscule, minuscule, chiffre", [x[0].lstrip("✓ ") for x in rules] == ["12 caractères", "une majuscule", "une minuscule", "un chiffre"] and [x[1] for x in rules] == ["0", "0", "1", "0"], rules)
            press(form.locator("[data-testid=auth-signup-submit]"))
            page.wait_for_timeout(500)
            err = form.locator("[data-testid=auth-signup-error]").text_content() if form.locator("[data-testid=auth-signup-error]").count() else ""
            check("mot de passe faible : refusé avec ce qui manque, AUCUN appel au serveur", "trop faible" in err and not seen["mm_signup"], err)
            snap("1_mot_de_passe_faible")
            form.locator("[data-testid=auth-signup-password]").fill(PASSWORD)
            check("mot de passe valable : les 4 règles cochées", form.locator("li[data-ok='1']").count() == 4)
            bal("formulaire d'inscription (bureau sombre)")
            press(form.locator("[data-testid=auth-signup-submit]"))
            sent = page.locator("[data-mm-signup=sent]").locator("visible=true").first
            ok = wait(lambda: sent.count() > 0 and sent.is_visible(), 8)
            check("après l'envoi : « Confirme ton e-mail » avec l'adresse", ok and EMAIL in sent.inner_text(), sent.inner_text() if ok else "")
            s0 = seen["mm_signup"][0] if seen["mm_signup"] else {}
            check("compte créé dans le projet MAKE MUSIC (mxdrx), pas dans l'ancien", len(seen["mm_signup"]) == 1 and seen["main_signup"] == 0, seen)
            check("comme le site : nom enregistré dans full_name, bon mot de passe", s0.get("data") == {"full_name": NAME} and s0.get("pw_ok"), s0)
            check("lien de confirmation : studiomakemusic.com/auth → studio /daw", s0.get("redirect_to") == "https://www.studiomakemusic.com/auth?redirect=%2Fdaw", s0)
            snap("2_confirme_ton_email")
            press(page.get_by_test_id("auth-signup-resend"))
            check("« Renvoyer l'e-mail » : renvoi demandé au projet Make Music", wait(lambda: seen["mm_resend"] == 1, 5), seen)
            press(page.get_by_test_id("auth-signup-confirmed"))
            dlg.locator("input[type=email]").wait_for(timeout=5000)
            check("« J'ai confirmé, me connecter » : retour à la connexion, e-mail déjà rempli", dlg.locator("input[type=email]").input_value() == EMAIL)
            dlg.locator("input[type=password]").fill(PASSWORD)
            press(dlg.locator("button[type=submit]"))
            ok = wait(lambda: visible("[data-testid=auth-resend-confirm]"), 8)
            msg = (dlg.text_content() or "")
            check("connexion avant d'avoir cliqué le lien : « pas encore confirmé » + bouton Renvoyer (plus d'anglais)", ok and "pas encore confirmé" in msg and "Invalid" not in msg, msg[-300:])
            snap("3_email_non_confirme")
            press(dlg.locator("button[type=submit]"))
            ok = wait(lambda: visible("[data-testid=landing-account]"), 10)
            txt = page.locator("[data-testid=landing-account]").locator("visible=true").first.inner_text() if ok else ""
            check("e-mail confirmé : connecté, la fenêtre se ferme, l'accueil montre le compte Make Music", ok and "nouvelle.artiste" in txt and "Compte Make Music" in txt, txt)
            check("la session Make Music est enregistrée", page.evaluate(f"() => !!localStorage.getItem('{CATALOG_KEY}')"))
            snap("4_connecte")

        elif case == "inscription_tel":
            studio()
            page.get_by_test_id("transport-menu").locator("visible=true").first.tap()
            page.wait_for_timeout(700)
            page.get_by_role("button", name=re.compile("Se connecter")).locator("visible=true").first.tap()
            dlg = page.locator("[role=dialog][aria-label='Connexion']").locator("visible=true").first
            dlg.wait_for(timeout=8000)
            page.get_by_test_id("auth-signup-open").locator("visible=true").first.tap()
            form = signup_form()
            form.wait_for(timeout=5000)
            form.locator("[data-testid=auth-signup-name]").fill(NAME)
            form.locator("[data-testid=auth-signup-email]").fill(DEJA)
            form.locator("[data-testid=auth-signup-password]").fill(PASSWORD)
            snap("1_formulaire_tel")
            bal("formulaire d'inscription (téléphone clair)")
            form.locator("[data-testid=auth-signup-submit]").tap()
            ok = wait(lambda: form.locator("[data-testid=auth-signup-error]").count() > 0, 8)
            err = form.locator("[data-testid=auth-signup-error]").text_content() if ok else ""
            check("e-mail déjà inscrit : « déjà un compte Make Music : connecte-toi » (pas d'attente d'un mail fantôme)", "déjà un compte Make Music" in err, err)
            check("téléphone : inscription envoyée au projet Make Music seulement", len(seen["mm_signup"]) == 1 and seen["main_signup"] == 0, seen)
            box = form.bounding_box() or {}
            check("téléphone : le formulaire tient dans la largeur (390 px)", box.get("width", 999) <= 390 and box.get("x", -1) >= 0, box)
            snap("2_deja_inscrit_tel")

        elif case == "palette_pro":
            studio()
            page.keyboard.press("Control+k")
            page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
            page.keyboard.type("créer mon compte", delay=10)
            page.wait_for_timeout(400)
            page.locator("[data-testid=command-palette] [role=option][data-palette-id='pal.signup']").first.click()
            ok = wait(lambda: visible("[data-mm-signup=form]"), 6)
            check("palette Ctrl+K « Créer mon compte Make Music » : l'inscription s'ouvre directement", ok)
            snap("1_palette_inscription")
            page.keyboard.press("Escape")
            check("Échap ferme la fenêtre", wait(lambda: page.locator("[role=dialog][aria-label='Connexion']").count() == 0, 4))
            # Fenêtre Nova Pro (import d'un son) : « Crée-le ici » au lieu d'un lien vers le site.
            f = OUT / "sc_son.wav"
            if not f.exists():
                import io, wave, struct, math
                buf = io.BytesIO()
                with wave.open(buf, "wb") as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
                    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / 44100))) for i in range(44100)))
                f.write_bytes(buf.getvalue())
            page.keyboard.press("Control+k")
            page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
            page.keyboard.type("importer un fichier audio", delay=10)
            page.wait_for_timeout(400)
            with page.expect_file_chooser(timeout=8000) as fc:
                page.locator("[data-testid=command-palette] [role=option][data-palette-id='pal.importAudio']").first.click()
            fc.value.set_files(str(f))
            gate = page.locator("[data-testid=pro-gate]").first
            gate.wait_for(timeout=10000)
            check("fenêtre Nova Pro : plus de lien « Créer un compte sur studiomakemusic.com »", "Créer un compte sur studiomakemusic.com" not in gate.inner_text())
            gate.get_by_test_id("pro-signup-open").click()
            pf = gate.locator("[data-mm-signup=form]").first
            pf.wait_for(timeout=5000)
            pf.locator("[data-testid=pro-signup-name]").fill(NAME)
            pf.locator("[data-testid=pro-signup-email]").fill(EMAIL)
            pf.locator("[data-testid=pro-signup-password]").fill(PASSWORD)
            snap("2_nova_pro_inscription")
            pf.locator("[data-testid=pro-signup-submit]").click()
            ok = wait(lambda: gate.locator("[data-mm-signup=sent]").count() > 0, 8)
            check("fenêtre Nova Pro : compte Make Music créé dans la fenêtre → « Confirme ton e-mail »", ok and len(seen["mm_signup"]) == 1 and seen["main_signup"] == 0, seen)
            snap("3_nova_pro_confirme")
            bal("fenêtre Nova Pro (bureau clair)")

        elif case == "cloud_mm":
            landing()
            ok = wait(lambda: visible("[data-testid=landing-account]"), 10)
            check("compte Make Music seulement : l'accueil le montre", ok)
            press(page.get_by_text("Charger Projet"))
            ok = wait(lambda: visible("[data-testid=landing-online-sessions-item]"), 8)
            items = page.locator("[data-testid=landing-online-sessions-item]").locator("visible=true")
            check("accueil « Charger Projet » : ses projets en ligne Make Music (plus « Connectez-vous »)",
                  ok and items.count() == 1 and "Mon son du mardi" in items.first.inner_text() and "Connectez-vous" not in page.locator("body").inner_text(),
                  items.count())
            check("projet en ligne gratuit : la date de fin est dite", ok and "gardée jusqu'au 20 octobre" in items.first.inner_text(), items.first.inner_text() if ok else "")
            snap("1_accueil_projets_en_ligne")
            page.keyboard.press("Escape")
            page.goto(BASE, wait_until="domcontentloaded")
            page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)
            press(page.get_by_text(DEFAULT_BEAT, exact=True))
            page.wait_for_timeout(1500); close_welcome(page); wait_text_gone(page, "Chargement", 60); close_welcome(page)
            page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
            page.wait_for_timeout(1000)
            page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(900)
            body = page.locator("body").inner_text()
            check("« Sauvegarder » : la séance en ligne Make Music est proposée, plus « Se connecter / Créer un compte »",
                  visible("[data-testid=save-takehome]") and "Se connecter / Créer un compte" not in body)
            snap("2_sauvegarder")
            page.locator("[data-testid=save-takehome]").locator("xpath=ancestor::div[contains(@class,'max-w-lg')]").locator("button[aria-label='Fermer']").first.dispatch_event("click"); page.wait_for_timeout(400)
            page.keyboard.press("Control+k")
            page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
            page.keyboard.type("ouvrir un projet", delay=10)
            page.wait_for_timeout(400)
            page.locator("[data-testid=command-palette] [role=option][data-palette-id='pal.open']").first.click()
            ok = wait(lambda: visible("[data-testid=load-online-sessions-item]"), 8)
            txt = page.locator("[data-testid=load-online-sessions]").first.inner_text() if ok else ""
            check("« Ouvrir un projet » → « Mon compte (en ligne) » : les séances du compte Make Music (la séance effacée est masquée)",
                  ok and "Mon son du mardi" in txt and "Ancienne" not in txt and EMAIL in txt, txt)
            check("liste lue par daw-session list_mine (compte connecté)", seen["list_mine"] >= 2, seen)
            snap("3_ouvrir_un_projet")
            bal("Ouvrir un projet (bureau clair)")
    except Exception as e:  # noqa: BLE001
        check("scénario sans exception", False, repr(e))
        try:
            snap("exception")
        except Exception:
            pass
    finally:
        r["requetes"] = seen
        errs = [e["text"] for e in log.errors()]
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
    (OUT / "simple_compte.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(("TOUT VERT" if ok else "ÉCHECS") + f" : {sum(len(c['checks']) for c in res['cas'].values())} vérifications, {res['duree_s']} s", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
