# -*- coding: utf-8 -*-
"""
Connexion Google de Nova Studio pour Windows.

Google refuse de s'authentifier dans une WebView (« disallowed_useragent ») : la page Google
s'ouvre donc dans le NAVIGATEUR PAR DÉFAUT, et le retour se fait sur un petit serveur local
temporaire (RFC 8252, « loopback redirect ») :

  1. la page (DesktopAccessGate) demande « nova-google:prepare » ;
  2. on ouvre un serveur sur 127.0.0.1 (port fixe, avec repli) et on renvoie l'adresse de retour
     http://127.0.0.1:<port>/cb?nova_state=<state aléatoire à usage unique> ;
  3. la page appelle supabase.auth.signInWithOAuth({ redirectTo, skipBrowserRedirect: true }) et
     nous demande d'ouvrir l'URL obtenue (« nova-google:open ») dans le navigateur par défaut ;
  4. après Google, Supabase renvoie le navigateur sur /cb avec les jetons dans le fragment (#) ;
     la page /cb (servie ici) les POSTe en même origine sur /done avec le state ;
  5. on vérifie le state, on transmet les jetons à la fenêtre (« nova-google:result »), qui appelle
     supabase.auth.setSession ; le serveur se ferme aussitôt (ou au bout de 5 minutes).

Supabase (GoTrue) accepte d'office les adresses de retour en IP de bouclage (127.0.0.1, [::1]),
quel que soit le port : aucune « Redirect URL » à ajouter. « localhost » n'est PAS accepté.

Sécurité : écoute sur 127.0.0.1 seulement ; en-tête Host et Origin contrôlés (pas de rebinding
DNS ni de POST depuis un autre site) ; state de 256 bits comparé en temps constant, à usage
unique ; jetons jamais journalisés ni écrits sur disque ; serveur fermé après usage.
"""
import base64
import hashlib
import hmac
import http.server
import json
import secrets
import socketserver
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlparse

# Port fixe (avec repli) : 48817 à 48821, puis un port libre choisi par Windows.
PORTS = (48817, 48818, 48819, 48820, 48821, 0)
TIMEOUT_S = 300.0
CALLBACK_PATH = "/cb"
DONE_PATH = "/done"
STATE_PARAM = "nova_state"
MAX_BODY = 32 * 1024
# Seule URL que l'on accepte d'ouvrir dans le navigateur pour la connexion Google.
AUTH_PREFIX = "https://mxdrxpzxbgybchzzvpkf.supabase.co/auth/v1/authorize?"

MSG_PREPARE = "nova-google:prepare"
MSG_READY = "nova-google:ready"
MSG_OPEN = "nova-google:open"
MSG_CANCEL = "nova-google:cancel"
MSG_RESULT = "nova-google:result"

# Messages affichés dans le navigateur (page /cb) selon le code d'erreur.
BROWSER_MESSAGES = {
    "access_denied": "Connexion Google annulée. Reviens sur Nova Studio pour réessayer, ou connecte-toi avec ton e-mail.",
    "oauth_error": "Google ou Make Music a refusé la connexion. Reviens sur Nova Studio pour réessayer.",
    "missing_tokens": "La réponse de connexion est incomplète. Reviens sur Nova Studio et relance « Continuer avec Google ».",
    "state": "Ce lien de connexion n'est plus valable (déjà utilisé ou trop ancien). Reviens sur Nova Studio et relance « Continuer avec Google ».",
}

# ─────────────────────────────────────────────────────────────────────────────
# Page /cb (aux couleurs de NOVA)
# ─────────────────────────────────────────────────────────────────────────────

CB_SCRIPT = r"""
(function () {
  var frag = location.hash ? location.hash.slice(1) : '';
  var query = location.search ? location.search.slice(1) : '';
  var st = '';
  try { st = new URLSearchParams(query).get('nova_state') || ''; } catch (e) {}
  // Les jetons ne restent ni dans la barre d'adresse ni dans l'historique.
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var t = document.getElementById('t'), m = document.getElementById('m'), i = document.getElementById('i');
  function show(r) {
    var ok = !!(r && r.ok);
    i.className = ok ? 'ico ok' : 'ico ko';
    i.textContent = ok ? '✓' : '!';
    t.textContent = ok ? "C'est bon, tu peux revenir sur Nova Studio" : 'Connexion non terminée';
    m.textContent = ok ? 'Tu es connecté. Tu peux fermer cet onglet : Nova Studio s’ouvre tout seul.'
                       : ((r && r.message) || 'Reviens sur Nova Studio et réessaie.');
    document.title = ok ? 'Connecté — Nova Studio' : 'Connexion non terminée — Nova Studio';
  }
  fetch('/done', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'omit',
    body: JSON.stringify({ state: st, fragment: frag, query: query })
  }).then(function (r) { return r.json(); }).then(show).catch(function () {
    show({ ok: false, message: "Nova Studio ne répond plus (fenêtre fermée ou délai de 5 minutes dépassé). Rouvre Nova Studio et relance « Continuer avec Google »." });
  });
})();
"""
CB_SCRIPT_HASH = base64.b64encode(hashlib.sha256(CB_SCRIPT.encode("utf-8")).digest()).decode()

CB_HTML = """<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Connexion — Nova Studio</title>
<style>
  html,body{margin:0;height:100%%;background:#0b0c10;color:#e2e8f0;font-family:Inter,"Segoe UI",system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;
    background:radial-gradient(600px 400px at 10%% 0%%,rgba(34,211,238,.14),transparent),
               radial-gradient(600px 400px at 90%% 100%%,rgba(139,92,246,.18),transparent),#0b0c10}
  .card{max-width:440px;width:100%%;padding:36px 32px;border-radius:24px;border:1px solid rgba(255,255,255,.1);
    background:rgba(17,19,24,.92);box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center}
  .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:26px}
  .logo{width:40px;height:40px;border-radius:14px;background:linear-gradient(135deg,#22d3ee,#8b5cf6);
    color:#000;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:18px}
  .name{font-weight:900;letter-spacing:.06em;color:#fff}
  .ico{width:56px;height:56px;margin:0 auto 18px;border-radius:999px;display:flex;align-items:center;justify-content:center;
    font-size:26px;font-weight:900}
  .wait{border:3px solid #22d3ee;border-top-color:transparent;animation:s 1s linear infinite}
  .ok{background:linear-gradient(135deg,#22d3ee,#8b5cf6);color:#000}
  .ko{background:rgba(239,68,68,.15);color:#fca5a5;border:1px solid rgba(248,113,113,.4)}
  h1{font-size:21px;line-height:1.3;margin:0 0 10px;color:#fff}
  p{font-size:14px;line-height:1.5;margin:0;color:#94a3b8}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><main class="card" role="status" aria-live="polite">
  <div class="brand"><div class="logo">N</div><span class="name">NOVA STUDIO</span></div>
  <div id="i" class="ico wait"></div>
  <h1 id="t">Connexion à Nova Studio…</h1>
  <p id="m">Un instant, on transmet ta connexion à l'appli.</p>
</main>
<script>%(script)s</script>
</body></html>
"""


def cb_page() -> bytes:
    return (CB_HTML % {"script": CB_SCRIPT}).encode("utf-8")


def parse_return(fragment: str, query: str) -> dict:
    """Lit le retour de Supabase (flux implicit : jetons dans le fragment ; erreurs dans le
    fragment ou la requête). Renvoie {"ok": True, jetons…} ou {"ok": False, "error", "message"}."""
    f = {k: v[0] for k, v in parse_qs(fragment or "", keep_blank_values=False).items()}
    q = {k: v[0] for k, v in parse_qs(query or "", keep_blank_values=False).items()}
    access, refresh = f.get("access_token", ""), f.get("refresh_token", "")
    if access and refresh:
        out = {"ok": True, "access_token": access, "refresh_token": refresh}
        if f.get("expires_in", "").isdigit():
            out["expires_in"] = int(f["expires_in"])
        if f.get("token_type"):
            out["token_type"] = f["token_type"]
        return out
    err = f.get("error") or q.get("error")
    desc = (f.get("error_description") or q.get("error_description") or "")[:300]
    if err:
        code = "access_denied" if err == "access_denied" else "oauth_error"
        return {"ok": False, "error": code, "message": desc}
    return {"ok": False, "error": "missing_tokens", "message": ""}


# ─────────────────────────────────────────────────────────────────────────────
# Serveur local temporaire
# ─────────────────────────────────────────────────────────────────────────────

class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # Windows : SO_REUSEADDR permettrait de partager le port


class LoopbackLogin:
    """Un essai de connexion : serveur sur 127.0.0.1, state à usage unique, délai maximal.
    on_result(dict) est appelé une seule fois (succès, erreur, annulation ou délai dépassé),
    depuis un fil du serveur."""

    def __init__(self, on_result, timeout: float = TIMEOUT_S, ports=PORTS):
        self._on_result = on_result
        self.timeout = timeout
        self.ports = tuple(ports)
        self.state = secrets.token_urlsafe(32)
        self.port = 0
        self.server = None
        self.rejected = 0
        self._lock = threading.Lock()
        self._finished = False
        self._timer = None
        self._closed = threading.Event()

    # ── cycle de vie ─────────────────────────────────────────────────
    def start(self) -> str:
        last = None
        for p in self.ports:
            try:
                self.server = _Server(("127.0.0.1", p), self._handler_class())
                break
            except OSError as e:
                last = e
        if self.server is None:
            raise OSError(f"aucun port local libre pour la connexion Google ({last})")
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.2},
                         name="google-login", daemon=True).start()
        self._timer = threading.Timer(self.timeout, self._expire)
        self._timer.daemon = True
        self._timer.start()
        return self.redirect_to

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def redirect_to(self) -> str:
        return f"{self.origin}{CALLBACK_PATH}?{STATE_PARAM}={self.state}"

    @property
    def active(self) -> bool:
        return self.server is not None and not self._closed.is_set()

    def cancel(self) -> None:
        self._finish({"ok": False, "error": "cancelled", "message": ""})

    def _expire(self) -> None:
        self._finish({"ok": False, "error": "timeout", "message": ""})

    def _finish(self, result: dict, close_delay: float = 0.0) -> bool:
        with self._lock:
            if self._finished:
                return False
            self._finished = True
        if self._timer is not None:
            self._timer.cancel()
        try:
            self._on_result(result)
        finally:
            if close_delay:
                threading.Timer(close_delay, self.close).start()
            else:
                threading.Thread(target=self.close, daemon=True).start()
        return True

    def close(self) -> None:
        """Ferme le port (idempotent ; à appeler depuis n'importe quel fil sauf celui du serveur)."""
        if self._closed.is_set():
            return
        self._closed.set()
        srv = self.server
        if srv is not None:
            try:
                srv.shutdown()
            except Exception:
                pass
            try:
                srv.server_close()
            except Exception:
                pass

    def wait_closed(self, timeout: float = 5.0) -> bool:
        return self._closed.wait(timeout)

    # ── vérifications ────────────────────────────────────────────────
    def state_ok(self, value) -> bool:
        return isinstance(value, str) and hmac.compare_digest(value.encode(), self.state.encode())

    # ── requêtes HTTP ────────────────────────────────────────────────
    def _handler_class(self):
        login = self

        class Handler(http.server.BaseHTTPRequestHandler):
            server_version = "NovaStudio"
            sys_version = ""
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # jamais de journal : l'adresse contient le state
                pass

            def _send(self, code: int, body: bytes, ctype: str, extra=()):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Connection", "close")
                for k, v in extra:
                    self.send_header(k, v)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
                self.close_connection = True

            def _json(self, code: int, obj: dict):
                self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

            def _host_ok(self) -> bool:
                return (self.headers.get("Host") or "") == f"127.0.0.1:{login.port}"

            def do_GET(self):
                if not self._host_ok():
                    return self._send(400, b"", "text/plain")
                u = urlparse(self.path)
                if u.path != CALLBACK_PATH:
                    return self._send(404, b"", "text/plain")
                csp = ("default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; "
                       f"script-src 'sha256-{CB_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; "
                       "frame-ancestors 'none'")
                self._send(200, cb_page(), "text/html; charset=utf-8", [("Content-Security-Policy", csp)])

            do_HEAD = do_GET

            def do_POST(self):
                if not self._host_ok() or urlparse(self.path).path != DONE_PATH:
                    return self._send(404, b"", "text/plain")
                if (self.headers.get("Origin") or "") != login.origin:
                    login.rejected += 1
                    return self._json(403, {"ok": False, "message": "Origine refusée."})
                if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                    return self._json(415, {"ok": False, "message": "Format refusé."})
                try:
                    n = int(self.headers.get("Content-Length") or "0")
                except ValueError:
                    n = -1
                if n < 0 or n > MAX_BODY:
                    return self._json(413, {"ok": False, "message": "Réponse trop grande."})
                try:
                    data = json.loads(self.rfile.read(n) or b"{}")
                    if not isinstance(data, dict):
                        raise ValueError
                except ValueError:
                    return self._json(400, {"ok": False, "message": BROWSER_MESSAGES["missing_tokens"]})
                if not login.state_ok(data.get("state")):
                    login.rejected += 1
                    return self._json(403, {"ok": False, "error": "state", "message": BROWSER_MESSAGES["state"]})
                result = parse_return(str(data.get("fragment") or ""), str(data.get("query") or ""))
                # Le state est consommé ici : un 2e envoi (rechargement, onglet rejoué) est refusé.
                if not login._finish(result, close_delay=0.3):
                    return self._json(410, {"ok": False, "error": "state", "message": BROWSER_MESSAGES["state"]})
                if result["ok"]:
                    return self._json(200, {"ok": True})
                return self._json(200, {"ok": False, "error": result["error"],
                                        "message": BROWSER_MESSAGES.get(result["error"], BROWSER_MESSAGES["oauth_error"])})

        return Handler


# ─────────────────────────────────────────────────────────────────────────────
# Pont page <-> Python
# ─────────────────────────────────────────────────────────────────────────────

def parse_page_message(raw) -> "dict | None":
    """Message JSON de la page destiné à la connexion Google, sinon None."""
    if not isinstance(raw, str) or not raw.startswith("{") or len(raw) > 16384:
        return None
    try:
        msg = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(msg, dict) or not str(msg.get("type", "")).startswith("nova-google:"):
        return None
    return msg


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):  # la redirection vers Google suffit : on ne la suit pas
        return None


def probe_auth_service(url: str, timeout: float = 6.0) -> "str | None":
    """Sonde le service de connexion AVANT d'ouvrir le navigateur (pas de CORS côté Python).

    Le 09/10/2026, le projet Supabase restreint (quota dépassé) répondait 402 avec un JSON brut :
    le navigateur affichait une page noire « Service for this project is restricted… ».
    Renvoie None si le service répond normalement (redirection vers Google), sinon « auth_down »
    (402, erreur 5xx, nom introuvable, connexion refusée ou délai dépassé). Une seule requête GET,
    redirection non suivie (flux implicite : rien n'est créé côté serveur)."""
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "NovaStudio-sonde"})
    try:
        with opener.open(req, timeout=timeout) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            e.close()
        except Exception:
            pass
    except (urllib.error.URLError, OSError, ValueError):
        return "auth_down"
    return "auth_down" if status == 402 or status >= 500 else None


def is_expected_auth_url(url, redirect_to: str, prefix: str = AUTH_PREFIX) -> bool:
    """L'URL à ouvrir est bien l'autorisation Google de Supabase, avec NOTRE adresse de retour."""
    if not isinstance(url, str) or not url.startswith(prefix) or len(url) > 4096:
        return False
    q = parse_qs(urlparse(url).query)
    return q.get("provider") == ["google"] and q.get("redirect_to") == [redirect_to]


class GoogleLoginBridge:
    """Traite les messages « nova-google:* » de la page.

    post(dict)    : envoie un message à la page (doit être sûr depuis n'importe quel fil) ;
    open_url(str) : ouvre une adresse dans le navigateur par défaut ;
    focus()       : ramène la fenêtre de Nova Studio au premier plan.
    probe(url)    : sonde le service de connexion avant d'ouvrir le navigateur (None = disponible,
                    « auth_down » = restreint ou injoignable : message clair dans Nova, pas de page noire) ;
    background    : sonde dans un fil à part (jamais sur le fil de l'interface)."""

    def __init__(self, post, open_url, focus=lambda: None, timeout: float = TIMEOUT_S, ports=PORTS,
                 auth_prefix: str = AUTH_PREFIX, log=lambda m: None, probe=probe_auth_service, background=True):
        self.post, self.open_url, self.focus = post, open_url, focus
        self.timeout, self.ports, self.auth_prefix, self.log = timeout, ports, auth_prefix, log
        self.probe, self.background = probe, background
        self._probed = set()
        self.login = None
        self.attempt = None
        self._lock = threading.Lock()

    def handle(self, msg: dict) -> bool:
        t = msg.get("type")
        attempt = str(msg.get("attempt") or "")[:64]
        if t == MSG_PREPARE:
            self._prepare(attempt)
        elif t == MSG_OPEN:
            self._open(attempt, msg.get("url"))
        elif t == MSG_CANCEL:
            self._cancel(attempt)
        else:
            return False
        return True

    def _prepare(self, attempt: str):
        if not attempt:
            return
        self.shutdown()  # un seul essai à la fois

        def done(result, attempt=attempt):
            with self._lock:
                if self.attempt == attempt:
                    self.attempt = None
            if result.get("error") == "cancelled":
                self.log("connexion Google annulée")
                return  # la page a déjà rendu la main
            self.log(f"connexion Google : {'réussie' if result.get('ok') else result.get('error')}")
            self.post({"type": MSG_RESULT, "attempt": attempt, **result})
            if result.get("ok"):
                try:
                    self.focus()
                except Exception:
                    pass

        login = LoopbackLogin(done, timeout=self.timeout, ports=self.ports)
        try:
            redirect = login.start()
        except OSError as e:
            self.log(f"connexion Google impossible : {e}")
            self.post({"type": MSG_RESULT, "attempt": attempt, "ok": False, "error": "port", "message": ""})
            return
        with self._lock:
            self.login, self.attempt = login, attempt
        self.log(f"connexion Google : attente du retour sur 127.0.0.1:{login.port} ({int(self.timeout)} s max)")
        self.post({"type": MSG_READY, "attempt": attempt, "redirectTo": redirect, "timeoutS": int(self.timeout)})

    def _current(self, attempt: str):
        with self._lock:
            login = self.login
            ok = login is not None and login.active and attempt and attempt == self.attempt
        return login if ok else None

    def _open(self, attempt: str, url):
        login = self._current(attempt)
        if login is None:
            self.post({"type": MSG_RESULT, "attempt": attempt, "ok": False, "error": "expired", "message": ""})
            return
        if not is_expected_auth_url(url, login.redirect_to, self.auth_prefix):
            self.log("connexion Google : adresse refusée (pas l'autorisation Supabase attendue)")
            self.post({"type": MSG_RESULT, "attempt": attempt, "ok": False, "error": "bad_url", "message": ""})
            login.cancel()
            return
        if attempt in self._probed or self.probe is None:   # « Rouvrir la page Google » : déjà sondé
            self.open_url(url)
            return

        def go():
            err = None
            try:
                err = self.probe(url)
            except Exception:
                err = "auth_down"
            if self._current(attempt) is not login:
                return  # annulé pendant la sonde
            if err:
                self.log("connexion Google : service de connexion indisponible (sonde)")
                self.post({"type": MSG_RESULT, "attempt": attempt, "ok": False, "error": err, "message": ""})
                login.cancel()
                return
            self._probed.add(attempt)
            self.open_url(url)

        if self.background:
            threading.Thread(target=go, name="google-login-sonde", daemon=True).start()
        else:
            go()

    def _cancel(self, attempt: str):
        login = self._current(attempt)
        if login is not None:
            login.cancel()

    def shutdown(self):
        with self._lock:
            login, self.login, self.attempt = self.login, None, None
        if login is not None:
            login.cancel()
            login.close()

    # tests
    def wait_idle(self, timeout: float = 5.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            with self._lock:
                login = self.login
            if login is None or login.wait_closed(0.05):
                return True
        return False
