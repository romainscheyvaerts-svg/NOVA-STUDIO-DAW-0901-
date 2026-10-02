# -*- coding: utf-8 -*-
"""
Tests automatiques de l'application Windows (sans intervention).

  venv\\Scripts\\python.exe test\\run_tests.py                       # version source
  venv\\Scripts\\python.exe test\\run_tests.py dist\\NovaStudio\\NovaStudio.exe

Vérifie : marqueur window.__novaDesktop + user-agent, micro accordé sans invite,
AudioContext démarré sans geste, ponts ASIO (8766) et VST (8765) lancés puis arrêtés,
fermeture qui attend window.__novaBeforeClose (succès, exception, promesse rejetée,
promesse jamais résolue -> délai max), absence de fonction, page hors ligne,
instance unique.
"""
import ctypes
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
PORT = 5199
CDP = 9333
reports = []


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/report":
            q = urllib.parse.parse_qs(u.query)
            reports.append((time.time(), q.get("k", [""])[0], q.get("v", [""])[0]))
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass


def got(k, since):
    return [v for t, kk, v in reports if kk == k and t >= since]


def wait_for(pred, timeout, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        r = pred()
        if r:
            return r
        time.sleep(step)
    return pred()


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


u32 = ctypes.WinDLL("user32")


def find_window(pid):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        p = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(hwnd, buf, 256)
        # (le python.exe d'un venv est un lanceur : la fenêtre appartient à un processus enfant,
        # d'où la comparaison sur le titre seul ; l'instance unique garantit qu'il n'y en a qu'une)
        if u32.IsWindowVisible(hwnd) and buf.value.startswith("Nova Studio") and p.value != os.getpid():
            found.append(hwnd)
        return True

    u32.EnumWindows(cb, 0)
    return found[0] if found else None


def close_window(pid):
    hwnd = find_window(pid)
    if hwnd:
        u32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    return bool(hwnd)


def launch(cmd, url, data_dir, bridges=False, extra_env=None):
    env = dict(os.environ)
    env.update({
        "NOVA_DESKTOP_URL": url,
        "NOVA_DESKTOP_DATA_DIR": data_dir,
        "NOVA_DESKTOP_CDP_PORT": str(CDP),
        "NOVA_DESKTOP_EXTRA_ARGS": "--use-fake-device-for-media-stream",
    })
    if not bridges:
        env["NOVA_DESKTOP_NO_BRIDGES"] = "1"
    env.update(extra_env or {})
    return subprocess.Popen(cmd, env=env)


results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'OK' if ok else 'ÉCHEC'}] {name} {detail}")


def close_case(cmd, data_dir, mode, expect_min, expect_max, extra_env=None, bridges=False):
    print(f"\n== fermeture, mode « {mode} »{' + ponts' if bridges else ''}")
    t0 = time.time()
    p = launch(cmd, f"http://127.0.0.1:{PORT}/test_page.html?mode={mode}", data_dir, bridges, extra_env)
    ready = wait_for(lambda: got("ready", t0), 60)
    check("page chargée", ready)
    if not ready:
        p.kill()
        return
    if bridges:
        ports = wait_for(lambda: listening(8766) and listening(8765), 40)
        check("ponts ASIO (8766) et VST (8765) à l'écoute", ports)
    wait_for(lambda: find_window(p.pid), 10)
    tc = time.time()
    check("WM_CLOSE envoyé", close_window(p.pid))
    try:
        p.wait(expect_max + 20)
    except subprocess.TimeoutExpired:
        p.kill()
    dt = time.time() - tc
    check(f"fermeture en {dt:.1f} s (attendu {expect_min}–{expect_max} s)", expect_min <= dt <= expect_max)
    if mode == "slow":
        check("__novaBeforeClose appelée puis attendue (sauvegarde reçue)", got("close", t0) and got("saved", t0))
    if bridges:
        freed = wait_for(lambda: not listening(8766) and not listening(8765), 10)
        check("ponts arrêtés à la fermeture", freed)
    return t0


def main():
    cmd = [os.path.abspath(sys.argv[1])] if len(sys.argv) > 1 else [sys.executable, os.path.join(DESKTOP, "nova_desktop.py")]
    print("commande :", cmd)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    data_dir = tempfile.mkdtemp(prefix="nova-desktop-test-")

    pre_busy = listening(8766) or listening(8765)
    if pre_busy:
        print("ATTENTION : un pont tourne déjà (8765/8766) ; le test des ponts sera faussé")

    t0 = close_case(cmd, data_dir, "slow", 3, 15, bridges=not pre_busy)
    if t0:
        marker = (got("marker", t0) or ["null"])[0]
        ua = (got("ua", t0) or [""])[0]
        check("window.__novaDesktop visible", json.loads(marker) and "version" in json.loads(marker), marker)
        check("user-agent NovaStudioDesktop/<version>", "NovaStudioDesktop/" in ua, ua[-40:])
        check("micro accordé sans invite", (got("mic", t0) or [""])[0].startswith("OK"), str(got("mic", t0)))
        check("permission micro mémorisée", got("perm", t0) == ["granted"], str(got("perm", t0)))
        check("AudioContext démarré sans geste (autoplay)", got("audioctx", t0) == ["running"], str(got("audioctx", t0)))

    close_case(cmd, data_dir, "none", 0, 4)
    close_case(cmd, data_dir, "throw", 0, 4)
    close_case(cmd, data_dir, "reject", 0, 4)
    close_case(cmd, data_dir, "hang", 5, 12, extra_env={"NOVA_DESKTOP_CLOSE_TIMEOUT": "6"})

    print("\n== hors ligne")
    p = launch(cmd, "http://127.0.0.1:5198/", data_dir)

    def offline_title():
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{CDP}/json", timeout=1) as r:
                return [t["title"] for t in json.load(r) if "hors ligne" in t.get("title", "")]
        except Exception:
            return None

    check("page « hors ligne » affichée", wait_for(offline_title, 30))
    print("\n== instance unique")
    t1 = time.time()
    p2 = launch(cmd, "http://127.0.0.1:5198/", data_dir)
    try:
        code = p2.wait(20)
    except subprocess.TimeoutExpired:
        p2.kill()
        code = None
    check(f"2e lancement rendu immédiatement (code {code}, {time.time() - t1:.1f} s)", code == 0)
    check("1re instance toujours ouverte", p.poll() is None)
    close_window(p.pid)
    try:
        p.wait(10)
        check("fermeture depuis la page hors ligne", True)
    except subprocess.TimeoutExpired:
        p.kill()
        check("fermeture depuis la page hors ligne", False)

    srv.shutdown()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} vérifications OK")
    for n in failed:
        print("  ÉCHEC :", n)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
