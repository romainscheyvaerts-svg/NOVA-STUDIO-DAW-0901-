# -*- coding: utf-8 -*-
"""
Tests de la connexion Google de l'appli Windows (google_login.py), sans Internet ni Google :
serveur local temporaire (state, fermeture, délai) et pont page <-> Python.

  venv\\Scripts\\python.exe test\\test_google_login.py
"""
import http.client
import json
import os
import socket
import sys
import threading
import time
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import google_login as gl  # noqa: E402

results = []
TEST_PORTS = (48917, 48918, 48919, 0)  # pas les ports de l'appli : un Nova Studio ouvert ne gêne pas


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'OK' if ok else 'ÉCHEC'}] {name} {detail}")


def request(port, method, path, body=None, headers=None, host=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Host": host or f"127.0.0.1:{port}"}
    h.update(headers or {})
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    c.request(method, path, body=data, headers=h)
    r = c.getresponse()
    out = (r.status, dict(r.getheaders()), r.read())
    c.close()
    return out


def post_done(login, body, origin=None):
    return request(login.port, "POST", "/done", body,
                   {"Content-Type": "application/json", "Origin": origin or login.origin})


def port_closed(port) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return False
    except OSError:
        return True


def new_login(timeout=30.0, ports=TEST_PORTS):
    got = []
    ev = threading.Event()

    def on_result(r):
        got.append(r)
        ev.set()

    login = gl.LoopbackLogin(on_result, timeout=timeout, ports=ports)
    login.start()
    return login, got, ev


FRAG = "access_token=AT.fake.jwt&expires_in=3600&refresh_token=RT-fake&token_type=bearer&type=signup"


def t_parse():
    print("lecture du retour Supabase")
    r = gl.parse_return(FRAG, "nova_state=x")
    check("jetons lus dans le fragment", r == {"ok": True, "access_token": "AT.fake.jwt", "refresh_token": "RT-fake",
                                                "expires_in": 3600, "token_type": "bearer"}, r)
    r = gl.parse_return("error=access_denied&error_description=The+user+denied", "")
    check("annulation Google -> access_denied", r["error"] == "access_denied" and not r["ok"], r)
    r = gl.parse_return("", "nova_state=x&error=server_error&error_description=Unable+to+exchange")
    check("erreur dans la requête -> oauth_error", r["error"] == "oauth_error" and "exchange" in r["message"], r)
    check("rien du tout -> missing_tokens", gl.parse_return("", "")["error"] == "missing_tokens")
    check("jeton d'accès seul -> missing_tokens", gl.parse_return("access_token=x", "")["error"] == "missing_tokens")


def t_server_success():
    print("serveur local : retour réussi")
    login, got, ev = new_login()
    try:
        red = login.redirect_to
        check("adresse de retour en 127.0.0.1 avec state", red.startswith(f"http://127.0.0.1:{login.port}/cb?nova_state=")
              and len(login.state) >= 43, red)
        st, h, body = request(login.port, "GET", f"/cb?nova_state={login.state}")
        csp = h.get("Content-Security-Policy", "")
        check("page /cb servie, sans cache, CSP stricte",
              st == 200 and b"Nova Studio" in body and h.get("Cache-Control") == "no-store"
              and f"sha256-{gl.CB_SCRIPT_HASH}" in csp and "default-src 'none'" in csp, st)
        check("la page affiche le message de réussite prévu", "C'est bon, tu peux revenir sur Nova Studio" in gl.CB_SCRIPT)
        st, _, _ = request(login.port, "GET", "/cb", host="evil.example:80")
        check("Host étranger (rebinding DNS) refusé", st == 400, st)
        st, _, _ = request(login.port, "GET", "/autre")
        check("autre chemin : 404", st == 404, st)

        st, _, _ = post_done(login, {"state": login.state, "fragment": FRAG}, origin="https://evil.example")
        check("POST depuis un autre site refusé", st == 403 and not got, st)
        st, _, body = post_done(login, {"state": "mauvais-state", "fragment": FRAG})
        check("state invalide refusé (403), rien transmis", st == 403 and not got and json.loads(body)["error"] == "state", st)
        st, _, _ = post_done(login, {"state": login.state[:-1] + ("A" if login.state[-1] != "A" else "B"), "fragment": FRAG})
        check("state presque juste refusé", st == 403 and not got, st)
        check("serveur toujours ouvert après les refus", not port_closed(login.port))
        st, _, _ = request(login.port, "POST", "/done", b"x" * (gl.MAX_BODY + 1),
                           {"Content-Type": "application/json", "Origin": login.origin})
        check("corps trop gros refusé", st == 413 and not got, st)

        st, _, body = post_done(login, {"state": login.state, "fragment": FRAG, "query": f"nova_state={login.state}"})
        check("bon state : 200 et réponse SANS les jetons", st == 200 and json.loads(body) == {"ok": True}
              and b"AT.fake" not in body, body)
        check("jetons transmis à l'appli (une seule fois)", ev.wait(2) and len(got) == 1 and got[0]["ok"]
              and got[0]["access_token"] == "AT.fake.jwt" and got[0]["refresh_token"] == "RT-fake", got)
        check("serveur fermé après usage", login.wait_closed(3) and _wait(lambda: port_closed(login.port)))
        check("aucun 2e résultat", len(got) == 1)
    finally:
        login.close()


def _wait(pred, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


def t_server_replay():
    print("serveur local : rejeu / erreur Google")
    login, got, ev = new_login()
    try:
        st, _, body = post_done(login, {"state": login.state, "fragment": "error=access_denied&error_description=denied"})
        b = json.loads(body)
        check("annulation Google : message clair dans le navigateur", st == 200 and not b["ok"] and "annulée" in b["message"], b)
        check("erreur transmise à l'appli", ev.wait(2) and got[0] == {"ok": False, "error": "access_denied", "message": "denied"}, got)
        check("serveur fermé", login.wait_closed(3) and _wait(lambda: port_closed(login.port)))
    finally:
        login.close()


def t_timeout_cancel():
    print("délai dépassé / annulation")
    login, got, ev = new_login(timeout=0.6)
    port = login.port
    check("délai dépassé -> résultat « timeout »", ev.wait(3) and got == [{"ok": False, "error": "timeout", "message": ""}], got)
    check("port fermé après le délai", login.wait_closed(3) and _wait(lambda: port_closed(port)))
    try:
        post_done(login, {"state": login.state, "fragment": FRAG})
        late = "répond encore"
    except OSError:
        late = "refusé"
    check("retour tardif refusé (port fermé)", late == "refusé" and len(got) == 1, late)

    login, got, ev = new_login()
    port = login.port
    login.cancel()
    check("annulation -> résultat « cancelled »", ev.wait(2) and got[0]["error"] == "cancelled", got)
    check("port fermé après annulation", login.wait_closed(3) and _wait(lambda: port_closed(port)))


def t_port_fallback():
    print("port fixe occupé : repli")
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", TEST_PORTS[0]))
    blocker.listen(1)
    try:
        login, got, ev = new_login()
        check("port suivant utilisé", login.port == TEST_PORTS[1], login.port)
        login.cancel()
        login.wait_closed(3)
    finally:
        blocker.close()
    a = socket.socket(); a.bind(("127.0.0.1", 0)); a.listen(1)
    try:
        login, got, ev = new_login(ports=(a.getsockname()[1], 0))
        check("tous les ports fixes pris : port libre de Windows", login.port not in (0, a.getsockname()[1]), login.port)
        login.cancel()
        login.wait_closed(3)
    finally:
        a.close()


def t_bridge():
    print("pont page <-> Python")
    posted, opened, focused, logs = [], [], [], []
    ev = threading.Event()

    def post(m):
        posted.append(m)
        ev.set()

    prefix = gl.AUTH_PREFIX
    br = gl.GoogleLoginBridge(post, opened.append, lambda: focused.append(1), timeout=30, ports=TEST_PORTS,
                              log=logs.append)
    check("message étranger ignoré", gl.parse_page_message("nova-desktop:apply-update") is None
          and gl.parse_page_message('{"type":"autre"}') is None)
    msg = gl.parse_page_message(json.dumps({"type": gl.MSG_PREPARE, "attempt": "e1"}))
    check("message prepare reconnu", msg == {"type": gl.MSG_PREPARE, "attempt": "e1"})
    br.handle(msg)
    ready = posted[-1]
    check("ready renvoyé avec l'adresse de retour", ready["type"] == gl.MSG_READY and ready["attempt"] == "e1"
          and ready["redirectTo"] == br.login.redirect_to and ready["timeoutS"] == 30, ready)
    login = br.login

    bad = "https://evil.example/auth/v1/authorize?provider=google&redirect_to=" + quote(ready["redirectTo"], safe="")
    check("URL étrangère : refusée", not gl.is_expected_auth_url(bad, ready["redirectTo"]))
    other_redirect = prefix + "provider=google&redirect_to=" + quote("http://127.0.0.1:1/cb?nova_state=x", safe="")
    check("URL Supabase mais autre adresse de retour : refusée", not gl.is_expected_auth_url(other_redirect, ready["redirectTo"]))
    good = prefix + "provider=google&redirect_to=" + quote(ready["redirectTo"], safe="")
    check("URL attendue : acceptée", gl.is_expected_auth_url(good, ready["redirectTo"]))

    br.handle({"type": gl.MSG_OPEN, "attempt": "autre", "url": good})
    check("open d'un autre essai : rien ouvert", opened == [] and posted[-1]["error"] == "expired", posted[-1])
    br.handle({"type": gl.MSG_OPEN, "attempt": "e1", "url": good})
    check("open : navigateur par défaut", opened == [good])
    br.handle({"type": gl.MSG_OPEN, "attempt": "e1", "url": good})
    check("Rouvrir la page Google : rouverte", opened == [good, good])

    ev.clear()
    post_done(login, {"state": login.state, "fragment": FRAG})
    check("résultat posté à la page avec l'essai et les jetons", ev.wait(2) and posted[-1]["type"] == gl.MSG_RESULT
          and posted[-1]["attempt"] == "e1" and posted[-1]["access_token"] == "AT.fake.jwt", posted[-1])
    check("fenêtre ramenée au premier plan", focused == [1])
    check("serveur fermé", br.wait_idle(3) and _wait(lambda: port_closed(login.port)))
    check("aucun jeton dans le journal", not any("AT.fake" in l or "RT-fake" in l or login.state in l for l in logs), logs)

    # URL inattendue : arrêt par sécurité
    br.handle({"type": gl.MSG_PREPARE, "attempt": "e2"})
    login2 = br.login
    br.handle({"type": gl.MSG_OPEN, "attempt": "e2", "url": bad})
    check("URL inattendue : rien ouvert, erreur bad_url, serveur fermé",
          len(opened) == 2 and posted[-1].get("error") == "bad_url" and login2.wait_closed(3), posted[-1])

    # Annuler : le serveur se ferme, pas de message (la page a déjà rendu la main)
    br.handle({"type": gl.MSG_PREPARE, "attempt": "e3"})
    login3, n = br.login, len(posted)
    br.handle({"type": gl.MSG_CANCEL, "attempt": "e3"})
    check("Annuler : serveur fermé, rien posté", login3.wait_closed(3) and _wait(lambda: port_closed(login3.port))
          and len(posted) == n)

    # Nouvel essai : l'ancien serveur se ferme ; fermeture de l'appli : tout se ferme
    br.handle({"type": gl.MSG_PREPARE, "attempt": "e4"})
    l4 = br.login
    br.handle({"type": gl.MSG_PREPARE, "attempt": "e5"})
    l5 = br.login
    check("nouvel essai : l'ancien serveur est fermé", l4.wait_closed(3) and l5.active)
    br.shutdown()
    check("fermeture de l'appli : aucun port ouvert", l5.wait_closed(3) and _wait(lambda: port_closed(l5.port)))


def main():
    for t in (t_parse, t_server_success, t_server_replay, t_timeout_cancel, t_port_fallback, t_bridge):
        t()
    ko = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(ko)}/{len(results)} vérifications OK")
    if ko:
        print("ÉCHECS : " + " ; ".join(ko))
    return 1 if ko else 0


if __name__ == "__main__":
    sys.exit(main())
