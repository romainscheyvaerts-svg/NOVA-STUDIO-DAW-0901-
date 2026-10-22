# -*- coding: utf-8 -*-
"""Outils pour piloter la VRAIE appli Windows (desktop/nova_desktop.py, fenêtre WebView2) en test,
sans rien montrer à l'écran ni voler le focus : fenêtre posée hors écran et non activée
(NOVA_DESKTOP_WINDOW), profil jetable (NOVA_DESKTOP_DATA_DIR : verrou d'instance à part, la
vraie Nova Studio ouverte n'est jamais touchée), sans les ponts (ports 8765/8766 jamais
utilisés), réseau de la page coupé (proxy vers un port fermé, sauf 127.0.0.1) : aucune requête
vers la production. Lecture de la page par le port de débogage (CDP).
"""
import ctypes
import json
import os
import subprocess
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = Path(os.environ.get("NOVA_DESKTOP_SRC") or ROOT / "desktop")
VENV_PY = Path(os.environ.get("NOVA_DESKTOP_PY", r"D:\1 WORK\CODE\NOVA-153-wt\desktop\venv\Scripts\python.exe"))
UI_DIR = os.environ.get("NOVA_DESKTOP_UI_DIR_TEST", r"D:\1 WORK\CODE\NOVA-153-wt\desktop\build\ui-bundle")
OFFSCREEN = "-24000,-24000,1400,900"

u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.c_void_p]
u32.GetWindowThreadProcessId.restype = wintypes.DWORD
u32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u32.IsWindowVisible.argtypes = [wintypes.HWND]
u32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
u32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
u32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
u32.GetWindow.restype = wintypes.HWND
u32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]


def windows_of(pids) -> list:
    """Fenêtres de premier niveau visibles des processus donnés : [(hwnd, titre, exstyle, propriétaire)]."""
    pids = set(pids)
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in pids and u32.IsWindowVisible(h):
            buf = ctypes.create_unicode_buffer(256)
            u32.GetWindowTextW(h, buf, 256)
            out.append((int(h or 0), buf.value, u32.GetWindowLongPtrW(h, -20), int(u32.GetWindow(h, 4) or 0)))
        return True

    u32.EnumWindows(cb, 0)
    return out


def rect(hwnd) -> tuple:
    r = wintypes.RECT()
    u32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def process_table() -> dict:
    """{pid: (ppid, nom, ligne de commande, création en FILETIME)} via WMI (PowerShell caché)."""
    ps = ("Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId,$_.ParentProcessId,"
          "$_.Name,$_.CreationDate.ToFileTimeUtc(),($_.CommandLine -replace '[\\r\\n|]',' ') }")
    raw = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", creationflags=0x08000000).stdout
    t = {}
    for line in raw.splitlines():
        parts = line.split("|", 4)
        if len(parts) == 5 and parts[0].isdigit():
            try:
                created = int(parts[3])
            except ValueError:
                created = 0
            t[int(parts[0])] = (int(parts[1] or 0), parts[2], parts[4], created)
    return t


def filetime_now() -> int:
    return int((time.time() + 11644473600) * 10_000_000)


def descendants(root: int, table: "dict | None" = None, since: int = 0) -> set:
    """Processus nés de root. Garde-fou contre la réutilisation des numéros de processus par
    Windows : un enfant est forcément né APRÈS son parent (et après `since`, l'heure de lancement
    du test) ; sinon c'est un processus étranger dont le parent d'origine portait le même numéro
    (le 22/10, sans ce garde-fou, la vraie Nova Studio de Romain a été prise pour un enfant d'un
    test arrêté et fermée par lui)."""
    table = table or process_table()
    born = {root: table[root][3] if root in table else since}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _n, _c, created) in table.items():
            if ppid in born and pid not in born and created >= max(born[ppid], since) - 10_000_000:
                born[pid] = created
                changed = True
    return set(born)


def alive(pids, since: int = 0) -> list:
    t = process_table()
    return [(p, t[p][1]) for p in pids if p in t and t[p][3] >= since]


class App:
    """Une instance de l'appli de dev, hors écran."""

    def __init__(self, data_dir, cdp_port, *, window=OFFSCREEN, url=None, extra_env=None, offline=True,
                 bridges=False, ui_dir=UI_DIR):
        self.data_dir, self.cdp = str(data_dir), int(cdp_port)
        env = dict(os.environ)
        for k in [k for k in env if k.startswith("NOVA_DESKTOP_")]:
            env.pop(k)
        env.update({"NOVA_DESKTOP_DATA_DIR": self.data_dir, "NOVA_DESKTOP_CDP_PORT": str(self.cdp),
                    "NOVA_DESKTOP_NO_UPDATE": "1", "PYTHONIOENCODING": "utf-8"})
        if window:
            env["NOVA_DESKTOP_WINDOW"] = window
        if not bridges:
            env["NOVA_DESKTOP_NO_BRIDGES"] = "1"
        if url:
            env["NOVA_DESKTOP_URL"] = url
        elif ui_dir:
            env["NOVA_DESKTOP_UI_DIR"] = ui_dir
        if offline:
            env["NOVA_DESKTOP_EXTRA_ARGS"] = "--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1;localhost"
        env.update(extra_env or {})
        self.t0 = time.perf_counter()
        self.since = filetime_now() - 20_000_000  # 2 s de marge
        self.proc = subprocess.Popen([str(VENV_PY), str(DESKTOP / "nova_desktop.py")], env=env, cwd=str(DESKTOP),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     creationflags=0x08000000)
        self.pid = self.proc.pid
        self.ws = None

    # ── CDP ──────────────────────────────────────────────────────────
    def targets(self):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.cdp}/json", timeout=0.5) as r:
                return [t for t in json.load(r) if t.get("type") == "page"]
        except Exception:
            return None

    def page_ws(self, timeout=60, match=None):
        end = time.time() + timeout
        while time.time() < end:
            for t in self.targets() or []:
                if match is None or match(t):
                    return t["webSocketDebuggerUrl"]
            time.sleep(0.05)
        raise TimeoutError("CDP injoignable")

    def ev(self, expr, timeout=30, ws=None):
        from websockets.sync.client import connect
        with connect(ws or self.ws or self.page_ws(), max_size=None, open_timeout=5) as c:
            c.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
                "expression": expr, "awaitPromise": True, "returnByValue": True}}))
            end = time.time() + timeout
            while time.time() < end:
                msg = json.loads(c.recv(timeout=timeout))
                if msg.get("id") == 1:
                    res = msg.get("result", {})
                    if "exceptionDetails" in res:
                        raise RuntimeError(json.dumps(res["exceptionDetails"])[:300])
                    return res.get("result", {}).get("value")
        raise TimeoutError(expr[:40])

    def cdp_call(self, method, params=None, timeout=30):
        from websockets.sync.client import connect
        with connect(self.ws or self.page_ws(), max_size=None, open_timeout=5) as c:
            c.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
            end = time.time() + timeout
            while time.time() < end:
                msg = json.loads(c.recv(timeout=timeout))
                if msg.get("id") == 1:
                    return msg
        raise TimeoutError(method)

    def wait_mounted(self, timeout=90) -> float:
        """Secondes depuis le lancement jusqu'au DAW monté (#root rempli)."""
        end = time.time() + timeout
        while time.time() < end:
            if self.proc.poll() is not None:
                raise RuntimeError(f"appli arrêtée (code {self.proc.returncode})")
            try:
                self.ws = self.page_ws(timeout=2)
                if self.ev("!!(document.getElementById('root') && document.getElementById('root').children.length)", 3):
                    return round(time.perf_counter() - self.t0, 2)
            except Exception:
                pass
            time.sleep(0.05)
        raise TimeoutError("DAW non monté")

    # ── fenêtres et fermeture ────────────────────────────────────────
    def pids(self) -> set:
        """Processus de l'appli (le python.exe d'un venv relance le vrai Python en enfant)."""
        return descendants(self.pid, since=self.since)

    def published_window(self) -> int:
        """Fenêtre notée par l'appli dans SON dossier de données (window.hwnd) : la seule qu'on
        ferme ; jamais une fenêtre trouvée par son titre (la vraie Nova Studio s'appelle pareil)."""
        try:
            hwnd, pid = (int(x) for x in Path(self.data_dir, "window.hwnd").read_text(encoding="ascii").split()[:2])
        except (OSError, ValueError):
            return 0
        owner = wintypes.DWORD()
        u32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(owner))
        return hwnd if owner.value == pid and pid in self.pids() else 0

    def main_window(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            h = self.published_window()
            if h:
                return h
            mine = {p for p, (_pp, _n, cmd, _c) in process_table().items()
                    if p in self.pids() and "nova_desktop.py" in cmd}
            w = [x for x in windows_of(mine) if x[1].startswith("Nova Studio")] if mine else []
            if w:  # ancienne version (pas de window.hwnd) : fenêtre d'un Python de nova_desktop.py né du test
                return w[0][0]
            time.sleep(0.05)
        return 0

    def close(self, timeout=120) -> dict:
        """Fermeture « croix » (WM_CLOSE) ; durée jusqu'à la fin du processus, processus restants."""
        if self.proc.poll() is not None:  # déjà arrêtée : rien à fermer (surtout pas une autre fenêtre)
            return {"secondes": 0.0, "arbre": 0, "restants": []}
        tree = self.pids()
        hw = self.main_window(2)
        t0 = time.perf_counter()
        if hw:
            u32.PostMessageW(wintypes.HWND(hw), 0x0010, 0, 0)
        try:
            self.proc.wait(timeout)
            secs = round(time.perf_counter() - t0, 2)
        except subprocess.TimeoutExpired:
            secs = None
            self.kill()
        time.sleep(1.5)
        return {"secondes": secs, "arbre": len(tree), "restants": alive(tree - {self.pid}, self.since)}

    def kill(self):
        """Arrêt forcé : seulement les processus nés du test ET marqués comme les siens (Python de
        nova_desktop.py, ou WebView2 avec le dossier de données jetable du test)."""
        t = process_table()
        for p in sorted(descendants(self.pid, t, self.since), reverse=True):
            cmd = t[p][2] if p in t else ""
            if p == self.pid or "nova_desktop.py" in cmd or self.data_dir.lower() in cmd.lower():
                subprocess.run(["taskkill", "/F", "/PID", str(p)], capture_output=True, creationflags=0x08000000)
