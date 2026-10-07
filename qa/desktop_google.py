"""Appli Windows : connexion Google de bout en bout, SANS Google ni vrai compte.

Usage (après `npx vite build`) :
  python qa/desktop_google.py
  QA_OUT=D:\\...\\captures python qa/desktop_google.py

- L'interface construite (dist/) est servie en local et ouverte dans Chromium headless
  (aucune fenêtre), avec window.__novaDesktop et un faux window.chrome.webview reliés au
  VRAI code Python de l'appli (desktop/google_login.py : GoogleLoginBridge + serveur local).
- « Ouvrir dans le navigateur » est seulement enregistré (aucun navigateur lancé).
- Le retour de Google est simulé : un 2e onglet headless ouvre l'adresse de retour
  http://127.0.0.1:<port>/cb?nova_state=…#access_token=<faux>&refresh_token=<faux>.
- Supabase est entièrement simulé (route.fulfill) : rien ne part vers la production.
  setSession est espionné côté réseau (GET /auth/v1/user avec le faux jeton) et par la
  session enregistrée dans le stockage local.
"""
import base64
import http.server
import json
import os
import queue
import socket
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import google_login as gl  # noqa: E402

DIST = ROOT / "dist"
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\qa-nova-google-2026-10-07"))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
PROJECT = "mxdrxpzxbgybchzzvpkf"
PORTS = (48927, 48928, 48929, 0)  # pas ceux de l'appli
USER = {"id": "33333333-3333-4333-8333-333333333333", "email": "google.test@example.com"}


def b64(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


FAKE_AT = b64({"alg": "HS256", "typ": "JWT"}) + "." + b64(
    {"sub": USER["id"], "email": USER["email"], "role": "authenticated", "aud": "authenticated",
     "exp": int(time.time()) + 3600}) + ".signature-qa"
FAKE_RT = "refresh-qa-0001"

DESKTOP_JS = """
(function () {
  window.__novaDesktop = { version: '1.3.0', platform: 'windows', ui: 'qa', features: %(features)s,
                           bridges: { asio: 8766, vst: 8765 } };
  var listeners = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: function (m) { window.__novaToPython(String(m)); },
    addEventListener: function (t, h) { if (t === 'message') listeners.push(h); },
    removeEventListener: function (t, h) { listeners = listeners.filter(function (x) { return x !== h; }); }
  };
  window.__novaFromPython = function (s) { listeners.slice().forEach(function (h) { h({ data: s }); }); };
})();
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def send_head(self):
        p = self.path.split("?")[0]
        if not (DIST / p.lstrip("/")).exists() or p == "/":
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, *a):
        pass


def serve_dist():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{port}/"


def port_closed(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return False
    except OSError:
        return True


class Harness:
    """Le côté Python de l'appli, branché sur la page headless."""

    def __init__(self):
        self.to_page = queue.Queue()
        self.opened, self.focused, self.logs = [], [], []
        self.bridge = gl.GoogleLoginBridge(self.to_page.put, self.opened.append, lambda: self.focused.append(time.time()),
                                           timeout=60, ports=PORTS, log=self.logs.append)
        self.auth_calls = []

    def from_page(self, raw):
        msg = gl.parse_page_message(raw)
        if msg is not None:
            self.bridge.handle(msg)

    def pump(self, page, until=None, timeout=10.0):
        """Livre les messages Python -> page (la page Playwright ne se pilote que depuis ce fil)."""
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = self.to_page.get(timeout=0.05)
                page.evaluate("s => window.__novaFromPython(s)", json.dumps(m))
            except queue.Empty:
                page.wait_for_timeout(30)
            if until and until():
                return True
        return bool(until and until())


def install_supabase_mocks(page, h: Harness, state):
    def auth(route, request):
        url = request.url
        h.auth_calls.append(f"{request.method} {url.split('?')[0].split('/auth/v1/')[1]} "
                            f"{'jeton-faux' if FAKE_AT in (request.headers.get('authorization') or '') else 'autre'}")
        if "/auth/v1/user" in url:
            if (request.headers.get("authorization") or "") == f"Bearer {FAKE_AT}":
                state["user_checked"] = state.get("user_checked", 0) + 1
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps({**USER, "aud": "authenticated", "role": "authenticated",
                                                      "app_metadata": {"provider": "google"}}))
            return route.fulfill(status=401, content_type="application/json", body='{"message":"invalid JWT"}')
        if "/auth/v1/logout" in url:
            return route.fulfill(status=204, body="")
        return route.abort()

    # Playwright essaie les routes de la dernière à la première : le « tout couper » d'abord.
    page.route("https://*.supabase.co/**", lambda r, q: r.abort())  # tout autre projet : coupé
    page.route(f"https://{PROJECT}.supabase.co/auth/v1/**", auth)
    page.route(f"https://{PROJECT}.supabase.co/rest/v1/**",
               lambda r, q: r.fulfill(status=200, content_type="application/json", body="[]") if q.method in ("GET", "HEAD")
               else r.fulfill(status=200, content_type="application/json", body="null"))
    page.route(f"https://{PROJECT}.supabase.co/functions/v1/**",
               lambda r, q: r.fulfill(status=200, content_type="application/json", body='{"plans":[],"admin":false}'))
    page.route(f"https://{PROJECT}.supabase.co/storage/v1/**", lambda r, q: r.abort())


def new_app_page(browser, base, h, features="['google-login']"):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="fr-BE")
    page = ctx.new_page()
    page.set_default_timeout(15000)
    page.expose_function("__novaToPython", h.from_page)
    page.add_init_script(DESKTOP_JS % {"features": features})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:300]))
    return ctx, page, errors


def shot(page, name):
    page.screenshot(path=str(OUT / f"{name}.png"))


def step(res, name, fn):
    try:
        fn()
        res.append((name, True, ""))
        print(f"  [OK] {name}", flush=True)
    except Exception as e:  # noqa
        res.append((name, False, f"{type(e).__name__}: {str(e)[:300]}"))
        print(f"  [ÉCHEC] {name} : {type(e).__name__}: {str(e)[:300]}", flush=True)
        raise


def scenario_succes(browser, base, res):
    print("Scénario 1 : connexion Google réussie (retour simulé)")
    h, state = Harness(), {}
    ctx, page, errors = new_app_page(browser, base, h)
    install_supabase_mocks(page, h, state)
    ctx_cb = browser.new_context(viewport={"width": 900, "height": 700})  # « le navigateur par défaut »
    cb = ctx_cb.new_page()
    try:
        def porte():
            page.goto(base, wait_until="domcontentloaded")
            page.get_by_text("Connecte-toi pour démarrer Nova Studio").wait_for(timeout=30000)
            page.get_by_role("button", name="Continuer avec Google").wait_for()
            # au-dessus de l'e-mail
            gy = page.get_by_role("button", name="Continuer avec Google").bounding_box()["y"]
            ey = page.get_by_label("E-mail").bounding_box()["y"]
            assert gy < ey, (gy, ey)
            page.wait_for_timeout(600)
            shot(page, "g1_porte_bouton_google")
        step(res, "porte : « Continuer avec Google » au-dessus de l'e-mail", porte)

        def clic():
            page.get_by_role("button", name="Continuer avec Google").click()
            assert h.pump(page, until=lambda: len(h.opened) == 1), "aucune URL ouverte"
            url = h.opened[0]
            assert url.startswith(gl.AUTH_PREFIX) and "provider=google" in url, url
            assert gl.is_expected_auth_url(url, h.bridge.login.redirect_to), url
            page.get_by_text("Termine la connexion dans ton navigateur…").wait_for()
            shot(page, "g2_attente_navigateur")
        step(res, "clic : URL Supabase/Google ouverte dans le navigateur par défaut (pas dans la WebView)", clic)

        def rouvrir():
            page.get_by_role("button", name="Rouvrir la page Google").click()
            assert h.pump(page, until=lambda: len(h.opened) == 2) and h.opened[1] == h.opened[0]
        step(res, "« Rouvrir la page Google » rouvre la même page", rouvrir)

        login = h.bridge.login
        redirect = login.redirect_to

        def retour():
            cb.goto(f"{redirect}#access_token={FAKE_AT}&expires_at={int(time.time()) + 3600}&expires_in=3600"
                    f"&provider_token=ya29.faux&refresh_token={FAKE_RT}&token_type=bearer")
            cb.get_by_text("C'est bon, tu peux revenir sur Nova Studio").wait_for(timeout=10000)
            assert "#" not in cb.url and "nova_state" not in cb.url, cb.url
            shot(cb, "g3_navigateur_c_est_bon")
        step(res, "navigateur : « C'est bon, tu peux revenir sur Nova Studio », jetons effacés de l'adresse", retour)

        def ouverte():
            ok = h.pump(page, until=lambda: page.get_by_test_id("desktop-gate").count() == 0, timeout=20)
            assert ok, f"la porte ne s est pas ouverte : appels={h.auth_calls} state={state} texte={page.inner_text('body')[:400]!r}"
            assert state.get("user_checked"), f"setSession non appelé avec le faux jeton ({h.auth_calls})"
            stored = page.evaluate(f"localStorage.getItem('sb-{PROJECT}-auth-token') || ''")
            assert FAKE_AT in stored and FAKE_RT in stored, "session non enregistrée"
            assert h.focused, "fenêtre non ramenée au premier plan"
            page.wait_for_timeout(1500)
            shot(page, "g4_studio_ouvert")
        step(res, "appli : setSession(jetons) puis porte ouverte, fenêtre ramenée devant", ouverte)

        step(res, "serveur local fermé après usage", lambda: (_ for _ in ()).throw(AssertionError("port ouvert"))
             if not (login.wait_closed(3) and port_closed(login.port)) else None)
        step(res, "aucun jeton dans le journal de l'appli",
             lambda: (_ for _ in ()).throw(AssertionError(h.logs)) if any(FAKE_AT in l or FAKE_RT in l for l in h.logs) else None)
        print(f"    appels Auth simulés : {h.auth_calls}")
        if errors:
            print(f"    erreurs de page : {errors[:5]}")
    finally:
        h.bridge.shutdown()
        ctx.close(); ctx_cb.close()


def scenario_refus_annulation(browser, base, res):
    print("Scénario 2 : mauvais state refusé, puis Annuler")
    h, state = Harness(), {}
    ctx, page, _ = new_app_page(browser, base, h)
    install_supabase_mocks(page, h, state)
    ctx_cb = browser.new_context()
    cb = ctx_cb.new_page()
    try:
        page.goto(base, wait_until="domcontentloaded")
        page.get_by_role("button", name="Continuer avec Google").click(timeout=30000)
        h.pump(page, until=lambda: len(h.opened) == 1)
        login = h.bridge.login

        def mauvais_state():
            cb.goto(f"http://127.0.0.1:{login.port}/cb?nova_state=FAUX{'x' * 40}#access_token={FAKE_AT}&refresh_token={FAKE_RT}")
            cb.get_by_text("Connexion non terminée").wait_for(timeout=10000)
            assert "plus valable" in cb.inner_text("body")
            shot(cb, "g5_navigateur_state_refuse")
            h.pump(page, timeout=1.0)
            assert not state.get("user_checked"), "setSession appelé malgré un mauvais state !"
            page.get_by_text("Termine la connexion dans ton navigateur…").wait_for()
            assert not login.wait_closed(0.2), "le serveur s'est fermé sur un mauvais state"
        step(res, "retour avec un mauvais state : refusé, aucune session, l'attente continue", mauvais_state)

        def annuler():
            page.get_by_role("button", name="Annuler").click()
            h.pump(page, timeout=0.5)
            page.get_by_text("Connexion Google annulée").wait_for()
            page.get_by_label("E-mail").wait_for()
            assert login.wait_closed(3) and port_closed(login.port), "port resté ouvert"
            shot(page, "g6_annule_email_dispo")
        step(res, "Annuler : message clair, e-mail toujours disponible, port fermé", annuler)
    finally:
        h.bridge.shutdown()
        ctx.close(); ctx_cb.close()


def scenario_ancienne_appli(browser, base, res):
    print("Scénario 3 : appli sans la fonction (ancienne version) et site web")
    h = Harness()
    ctx, page, _ = new_app_page(browser, base, h, features="[]")
    install_supabase_mocks(page, h, {})
    try:
        def ancienne():
            page.goto(base, wait_until="domcontentloaded")
            page.get_by_text("Connecte-toi pour démarrer Nova Studio").wait_for(timeout=30000)
            assert page.get_by_role("button", name="Continuer avec Google").count() == 0
        step(res, "ancienne appli : pas de bouton Google, e-mail inchangé", ancienne)
    finally:
        ctx.close()
    ctx = browser.new_context(); page = ctx.new_page()
    page.route("https://*.supabase.co/**", lambda r, q: r.abort())
    try:
        def web():
            page.goto(base, wait_until="domcontentloaded")
            page.wait_for_timeout(4000)
            assert page.get_by_test_id("desktop-gate").count() == 0
            assert page.get_by_role("button", name="Continuer avec Google").count() == 0
        step(res, "site web (hors appli) : rien ne change, pas de porte", web)
    finally:
        ctx.close()


def main():
    if not (DIST / "index.html").exists():
        print("dist/ absent : lance d'abord `npx vite build`.")
        return 2
    srv, base = serve_dist()
    res = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        try:
            for sc in (scenario_succes, scenario_refus_annulation, scenario_ancienne_appli):
                try:
                    sc(browser, base, res)
                except Exception:
                    pass
        finally:
            browser.close()
            srv.shutdown()
    ko = [n for n, ok, _ in res if not ok]
    print(f"\n{len(res) - len(ko)}/{len(res)} étapes OK — captures : {OUT}")
    (OUT / "resume_google.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if ko else 0


if __name__ == "__main__":
    sys.exit(main())
