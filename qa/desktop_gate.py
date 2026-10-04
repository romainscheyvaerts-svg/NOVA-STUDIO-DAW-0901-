"""Appli Windows (window.__novaDesktop simulé) : porte de connexion + export payant.

Usage :
  NOVA_URL=http://127.0.0.1:3800/ QA_OUT=D:\\...\\nova-desktop-acces python qa/desktop_gate.py

Aucune écriture réelle : Supabase Auth (connexion) et la fonction nova-billing sont
simulées (route.fulfill) ; les lectures du catalogue partent avec la clé anon ;
tout le reste en écriture est bloqué par qalib.new_page. Aucun vrai compte, aucun paiement.
"""
import sys, json, time, re, os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from qalib import *  # noqa
from scenarios import step, btn, visible, close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa

PROJECT = "mxdrxpzxbgybchzzvpkf"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6"
        "ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40")
FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.qa"  # jamais accepté par le vrai serveur
DESKTOP_JS = "window.__novaDesktop = { version: '1.1.3', platform: 'windows', ui: 'qa', bridges: { asio: 8766, vst: 8765 } };"
OPEN_SPY_JS = "window.__opened = []; window.open = function (u) { window.__opened.push(String(u || '')); return null; };"

USERS = {
    "artiste": {"id": "11111111-1111-4111-8111-111111111111", "email": "artiste.test@example.com"},
    "romain": {"id": "22222222-2222-4222-8222-222222222222", "email": "superadmin.test@example.com"},
}


def session_json(u):
    now = int(time.time())
    return json.dumps({
        "access_token": FAKE_TOKEN, "refresh_token": "qa-refresh", "token_type": "bearer",
        "expires_in": 3600, "expires_at": now + 3600,
        "user": {"id": u["id"], "aud": "authenticated", "role": "authenticated", "email": u["email"]},
    })


def install_mocks(page, who, billing, state):
    """who : None (pas connecté) ou clé de USERS. billing : réponses nova-billing par action."""
    user = USERS.get(who) if who else None

    def auth(route, request):
        url = request.url
        if "/auth/v1/user" in url:
            if state.get("user"):
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps({**state["user"], "aud": "authenticated", "role": "authenticated"}))
            return route.fulfill(status=401, content_type="application/json", body='{"message":"invalid JWT"}')
        if "/auth/v1/token" in url and request.method == "POST":
            # Connexion simulée (identifiants de test uniquement).
            data = request.post_data_json or {}
            if data.get("password") == "motdepasse-qa":
                u = USERS["artiste"]; state["user"] = u
                return route.fulfill(status=200, content_type="application/json", body=session_json(u))
            return route.fulfill(status=400, content_type="application/json",
                                 body='{"error":"invalid_grant","error_description":"Invalid login credentials"}')
        if "/auth/v1/logout" in url:
            state["user"] = None
            return route.fulfill(status=204, body="")
        return route.abort()

    def billing_route(route, request):
        body = request.post_data_json or {}
        action = body.get("action")
        state.setdefault("billing_calls", []).append(action)
        r = billing.get(action, {"error": "non simulé"})
        if callable(r): r = r(body)
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(r),
                             headers={"Access-Control-Allow-Origin": "*"})

    def rest(route, request):
        # Lectures du catalogue : clé anon (le faux jeton serait refusé). Écritures : bloquées.
        if request.method in ("GET", "HEAD"):
            h = {**request.headers, "authorization": f"Bearer {ANON}"}
            return route.continue_(headers=h)
        if "/rpc/" in request.url:
            return route.fulfill(status=200, content_type="application/json",
                                 body="true" if who == "romain" else "false")
        return route.abort()

    page.route(f"https://{PROJECT}.supabase.co/auth/v1/**", auth)
    page.route(f"https://{PROJECT}.supabase.co/functions/v1/nova-billing", billing_route)
    page.route(f"https://{PROJECT}.supabase.co/rest/v1/**", rest)
    page.route(f"https://{PROJECT}.supabase.co/storage/v1/**",
               lambda route, req: route.continue_(headers={**req.headers, "authorization": f"Bearer {ANON}"}) if req.method == "GET" else route.abort())
    page.add_init_script(DESKTOP_JS)
    page.add_init_script(OPEN_SPY_JS)
    if user:
        state["user"] = user
        page.add_init_script(f"try {{ localStorage.setItem('sb-{PROJECT}-auth-token', {json.dumps(session_json(user))}); }} catch (e) {{}}")


NON_ABONNE = {
    "status": {"plans": [], "admin": False},
    "export_unlocked": {"unlocked": False},
    "use_export_credit": {"unlocked": False, "remaining": 0, "reason": "not_pro"},
    "checkout": {"url": "https://checkout.stripe.com/c/pay/cs_test_qa", "session_id": "cs_test_qa"},
    "verify": {"paid": True, "kind": "export_voices", "project_key": "x"},
}
SUPERADMIN = {
    "status": {"plans": [], "admin": True, "free_exports_left": 999, "free_exports_total": 10},
    "export_unlocked": {"unlocked": True, "admin": True},
    "use_export_credit": {"unlocked": True, "remaining": 999, "admin": True},
}


def gate_visible(page):
    return visible(page.get_by_test_id("desktop-gate"))


def enter_studio(page, res):
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=25000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(1200)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 45)
    page.wait_for_timeout(800)


def open_export(page):
    b = btn(page, re.compile(r"^\W*Exporter( le mix)?\s*$"))
    if not visible(b):
        page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(500)
        b = btn(page, re.compile(r"^\W*Exporter( le mix)?\s*$"))
    b.click(); page.wait_for_timeout(2500)


def d_non_connecte(page, log, res, vp):
    state = {}
    install_mocks(page, None, NON_ABONNE, state)
    with step(res, "porte affichée, studio non monté"):
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text("Connecte-toi pour démarrer Nova Studio").wait_for(timeout=20000)
        assert gate_visible(page)
        assert page.get_by_text(DEFAULT_BEAT, exact=True).count() == 0, "l'accueil du DAW est monté derrière la porte"
        page.wait_for_timeout(800)  # fin du fondu de l'écran de chargement
        shot(page, "1_non_connecte_porte")
    with step(res, "mauvais mot de passe : message clair"):
        page.get_by_label("E-mail").fill("artiste.test@example.com")
        page.get_by_label("Mot de passe").fill("faux")
        page.get_by_role("button", name="Se connecter").click()
        page.get_by_text("E-mail ou mot de passe incorrect.").wait_for(timeout=10000)
        shot(page, "1b_mauvais_mot_de_passe")
    with step(res, "création de compte : formulaire"):
        page.get_by_role("button", name="Créer un compte gratuit").click()
        page.get_by_text("Crée ton compte gratuit").wait_for()
        shot(page, "1c_creer_compte")
        page.get_by_role("button", name="Se connecter").click()
    with step(res, "bonne connexion : le studio s'ouvre"):
        page.get_by_label("Mot de passe").fill("motdepasse-qa")
        page.get_by_role("button", name="Se connecter").click()
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=25000)
        assert not gate_visible(page)


def d_connecte_studio(page, log, res, vp):
    state = {}
    install_mocks(page, "artiste", NON_ABONNE, state)
    with step(res, "connecté non abonné : studio libre"):
        page.goto(BASE, wait_until="domcontentloaded")
        enter_studio(page, res)
        assert not gate_visible(page)
        shot(page, "2_connecte_non_abonne_studio")
    with step(res, "export : paiement 2 € proposé"):
        open_export(page)
        page.get_by_text(re.compile("PAYER 2 € ET EXPORTER", re.I)).first.wait_for(timeout=15000)
        shot(page, "3_export_non_abonne_paiement")
    with step(res, "clic Payer : Stripe ouvert dans le navigateur, export débloqué après vérification"):
        page.get_by_role("button", name=re.compile("PAYER 2 € ET EXPORTER", re.I)).first.click()
        page.get_by_text(re.compile("Paiement reçu")).first.wait_for(timeout=20000)
        opened = page.evaluate("window.__opened")
        res["fenetres_ouvertes"] = opened
        assert opened == ["https://checkout.stripe.com/c/pay/cs_test_qa"], opened
        shot(page, "3b_export_apres_paiement")
    res["billing_calls"] = state.get("billing_calls")


def d_superadmin(page, log, res, vp):
    state = {}
    install_mocks(page, "romain", SUPERADMIN, state)
    with step(res, "super-admin : export libre"):
        page.goto(BASE, wait_until="domcontentloaded")
        enter_studio(page, res)
        open_export(page)
        page.get_by_text("Admin : export gratuit").first.wait_for(timeout=15000)
        txt = page.inner_text("body")
        assert "PAYER 2 €" not in txt.upper()
        shot(page, "4_export_superadmin_libre")
    res["billing_calls"] = state.get("billing_calls")


def d_deconnexion(page, log, res, vp):
    state = {}
    install_mocks(page, "artiste", NON_ABONNE, state)
    with step(res, "déconnexion depuis le studio : la porte revient"):
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=25000)
        # Session effacée (comme après « Déconnexion ») : au redémarrage, la porte revient.
        page.evaluate(f"localStorage.removeItem('sb-{PROJECT}-auth-token')")
        state["user"] = None
        page.reload(wait_until="domcontentloaded")
        page.get_by_text("Connecte-toi pour démarrer Nova Studio").wait_for(timeout=20000)


def d_web_inchange(page, log, res, vp):
    with step(res, "site web : aucune porte"):
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=25000)
        assert not gate_visible(page)
        assert "Compte gratuit requis pour démarrer" in page.inner_text("body")
        shot(page, "5_web_accueil_sans_porte")


ALL = [d_non_connecte, d_connecte_studio, d_superadmin, d_deconnexion, d_web_inchange]

if __name__ == "__main__":
    filt = sys.argv[1:]
    results = []
    for fn in ALL:
        if filt and not any(f in fn.__name__ for f in filt):
            continue
        r = run_one(fn, "pc")
        results.append(r)
        print(json.dumps(r, ensure_ascii=False)[:2500], flush=True)
    (OUT / "resume_desktop.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.exit(0 if all(r["ok"] for r in results) else 1)
