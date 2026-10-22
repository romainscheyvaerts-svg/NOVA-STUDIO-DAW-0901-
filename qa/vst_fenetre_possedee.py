#!/usr/bin/env python3
"""
Preuve « fenêtres de plugins comme dans un DAW » (hôte natif NovaVSTHost), sans rien afficher à
l'écran : une fausse fenêtre de Nova Studio (son propre fil + boucle de messages, posée hors écran)
et la vraie fenêtre d'un plugin (Pro-C 3), possédée par elle, posée hors écran sans activation.

Vérifie :
  1. propriétaire = fenêtre de Nova (GetWindow GW_OWNER), pas de WS_EX_APPWINDOW (=> aucun bouton
     dans la barre des tâches ni dans Alt+Tab), pas de WS_EX_TOPMOST (pas au-dessus des autres
     applications) ;
  2. au-dessus de Nova dans l'ordre Z, et encore au-dessus après que Nova est remontée ;
  3. cachée quand Nova est réduite, de retour quand Nova est rétablie ;
  4. sans propriétaire (site + pont dans un navigateur) : fenêtre indépendante comme avant ;
  5. blocage : l'interface du plugin se fige 4 s (debug_hang). On mesure, sur le fil de « Nova »,
     la durée de gestes qui touchent la fenêtre possédée (remontée dans l'ordre Z, réduction +
     rétablissement) et la plus longue absence de réponse de sa boucle de messages :
       a) sans chien de garde (NOVA_EDITOR_HANG_MS=0) ; b) avec (défaut 400 ms) ;
  6. pire cas (geste de Nova avant le détachement + gel de 15 s, ou processus du plugin suspendu) :
     le pont (show_editor du NativePlugin) arrête l'hôte dès que Nova « ne répond pas ».

Usage : python qa/vst_fenetre_possedee.py [--json sortie.json]
"""

import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bridge-python"))

PLUGIN = r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-C 3.vst3"

u32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
u32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u32.DefWindowProcW.restype = LRESULT
u32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU,
                                wintypes.HINSTANCE, wintypes.LPVOID]
u32.CreateWindowExW.restype = wintypes.HWND
u32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
u32.GetWindow.restype = wintypes.HWND
u32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
u32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
u32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             wintypes.UINT]
u32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
u32.IsWindowVisible.argtypes = [wintypes.HWND]
u32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT,
                                    wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
u32.SendMessageTimeoutW.restype = LRESULT
u32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u32.DestroyWindow.argtypes = [wintypes.HWND]

GW_OWNER, GW_HWNDNEXT, GW_HWNDFIRST = 4, 2, 0
GWL_EXSTYLE = -20
WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST = 0x40000, 0x80, 0x8
WS_OVERLAPPEDWINDOW = 0x00CF0000
SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE = 0x2, 0x1, 0x10
SW_SHOWNOACTIVATE, SW_SHOWMINNOACTIVE = 4, 7
WM_APP, WM_NULL, WM_CLOSE = 0x8000, 0x0000, 0x0010
POS = -24000


class FakeNova:
    """Fausse fenêtre principale de Nova Studio : fil dédié + boucle de messages, hors écran."""

    def __init__(self):
        self.jobs: "queue.Queue" = queue.Queue()
        self.posted: dict = {}
        self.worst_post = 0.0
        self.hwnd = None
        self.ready = threading.Event()
        self._proc = WNDPROC(self._wndproc)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.ready.wait(5)

    def _wndproc(self, h, m, w, l):
        if m == WM_APP + 1:
            # Message « posté » (comme un clic, une touche, un minuteur) : retardé tant que le fil de
            # Nova est bloqué, même dans un SendMessage (contrairement aux messages « envoyés »).
            sent = self.posted.pop(int(w), None)
            if sent is not None:
                self.worst_post = max(self.worst_post, (time.perf_counter() - sent) * 1000.0)
            return 0
        if m == WM_APP:
            while True:
                try:
                    fn, box, ev = self.jobs.get_nowait()
                except queue.Empty:
                    break
                t0 = time.perf_counter()
                try:
                    box["result"] = fn()
                finally:
                    box["ms"] = (time.perf_counter() - t0) * 1000.0
                    ev.set()
            return 0
        return u32.DefWindowProcW(h, m, w, l)

    def _run(self):
        class WNDCLASSW(ctypes.Structure):
            _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                        ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                        ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]
        wc = WNDCLASSW()
        wc.lpfnWndProc = self._proc
        wc.lpszClassName = "NovaTestOwner"
        u32.RegisterClassW(ctypes.byref(wc))
        # WS_EX_TOOLWINDOW : la fausse Nova elle-même n'a pas de bouton (rien ne bouge dans la barre).
        self.hwnd = u32.CreateWindowExW(WS_EX_TOOLWINDOW, "NovaTestOwner", "Nova Studio (test)", WS_OVERLAPPEDWINDOW,
                                        POS, POS, 500, 400, None, None, None, None)
        u32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
        self.ready.set()
        msg = wintypes.MSG()
        while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            u32.TranslateMessage(ctypes.byref(msg))
            u32.DispatchMessageW(ctypes.byref(msg))

    def run(self, fn, timeout=30.0):
        """Exécute fn sur le fil de Nova ; rend (résultat, durée en ms sur ce fil)."""
        box, ev = {}, threading.Event()
        self.jobs.put((fn, box, ev))
        u32.PostMessageW(self.hwnd, WM_APP, 0, 0)
        ev.wait(timeout)
        return box.get("result"), box.get("ms", float("inf"))

    def close(self):
        u32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)


class Probe(threading.Thread):
    """Plus long gel de la boucle de messages de Nova : un message posté toutes les 20 ms (comme un
    clic ou une touche), retard de traitement mesuré dans la fenêtre de Nova."""

    def __init__(self, nova: "FakeNova"):
        super().__init__(daemon=True)
        self.nova, self.stop = nova, threading.Event()
        nova.worst_post = 0.0
        nova.posted.clear()

    @property
    def worst(self) -> float:
        pending = [time.perf_counter() - t for t in list(self.nova.posted.values())]
        return max([self.nova.worst_post] + [p * 1000.0 for p in pending])

    def run(self):
        n = 0
        while not self.stop.is_set():
            n += 1
            self.nova.posted[n] = time.perf_counter()
            u32.PostMessageW(self.nova.hwnd, WM_APP + 1, n, 0)
            time.sleep(0.02)
        time.sleep(0.1)


def above(a, b) -> bool:
    """a est au-dessus de b dans l'ordre Z."""
    h = u32.GetWindow(a, GW_HWNDNEXT)
    n = 0
    while h and n < 100000:
        if h == b:
            return True
        h = u32.GetWindow(h, GW_HWNDNEXT)
        n += 1
    return False


def open_plugin(env: dict):
    os.environ.update(env)
    import vst_native
    vst_native.POOL.close()     # pas d'hôte de réserve : chaque hôte hérite de l'environnement ci-dessus
    return vst_native.NativePlugin(PLUGIN)


def show(p, owner):
    kw = {"offscreen": False, "title": "Pro-C 3 (test)", "debug_pos": [POS + 40, POS + 40]}
    if owner:
        kw["owner"] = int(owner)
    return p._host.request("show_editor", timeout=60, **kw)


def checks(nova: FakeNova, res: dict) -> dict:
    ed = int(res["hwnd"])
    ex = u32.GetWindowLongPtrW(ed, GWL_EXSTYLE)
    out = {
        "propriétaire = Nova": u32.GetWindow(ed, GW_OWNER) == nova.hwnd,
        "pas de WS_EX_APPWINDOW (pas de bouton de barre des tâches)": not ex & WS_EX_APPWINDOW,
        "pas « toujours au-dessus »": not ex & WS_EX_TOPMOST,
        "au-dessus de Nova": above(ed, nova.hwnd),
    }
    nova.run(lambda: u32.SetWindowPos(nova.hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE))
    out["encore au-dessus après remontée de Nova"] = above(ed, nova.hwnd)
    nova.run(lambda: u32.ShowWindow(nova.hwnd, SW_SHOWMINNOACTIVE))
    time.sleep(0.3)
    out["cachée quand Nova est réduite"] = not u32.IsWindowVisible(ed)
    nova.run(lambda: u32.ShowWindow(nova.hwnd, SW_SHOWNOACTIVATE))
    time.sleep(0.3)
    out["de retour quand Nova est rétablie"] = bool(u32.IsWindowVisible(ed))
    return out


def hang_test(nova: FakeNova, p, hang_ms=4000, gesture_at=1.0) -> dict:
    """L'interface du plugin se fige hang_ms ; Nova remonte sa fenêtre (comme un clic dans Nova)
    gesture_at secondes après le début du gel."""
    events = []
    p._host.listeners.append(lambda ev, msg: events.append((round(time.perf_counter(), 3), ev, msg.get("ms")))
                             if ev.startswith("editor_") else None)
    probe = Probe(nova)
    probe.start()
    time.sleep(0.2)
    t0 = time.perf_counter()
    p._host.request("debug_hang", ms=hang_ms)
    time.sleep(gesture_at)
    _, z_ms = nova.run(lambda: u32.SetWindowPos(nova.hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE))
    _, min_ms = nova.run(lambda: (u32.ShowWindow(nova.hwnd, SW_SHOWMINNOACTIVE),
                                  u32.ShowWindow(nova.hwnd, SW_SHOWNOACTIVATE)))
    while time.perf_counter() - t0 < hang_ms / 1000.0 + 1.5:
        time.sleep(0.1)
    probe.stop.set()
    probe.join(25)
    owned_after = u32.GetWindow(int(p._host.request("show_editor", offscreen=False, owner=int(nova.hwnd),
                                                      debug_pos=[POS + 40, POS + 40])["hwnd"]), GW_OWNER) == nova.hwnd
    return {"gel du plugin (ms)": hang_ms, "geste de Nova après (ms)": round(gesture_at * 1000),
            "Nova : remontée dans l'ordre Z (ms)": round(z_ms),
            "Nova : réduction + rétablissement (ms)": round(min_ms),
            "Nova : plus long gel de sa boucle de messages (ms)": round(probe.worst),
            "événements": [(round((t - t0) * 1000), ev, round(ms or 0)) for t, ev, ms in events],
            "rattachée après le gel": owned_after}


def suspend(pid: int, on: bool):
    ntdll = ctypes.WinDLL("ntdll")
    h = k32.OpenProcess(0x0800, False, pid)   # PROCESS_SUSPEND_RESUME
    try:
        (ntdll.NtSuspendProcess if on else ntdll.NtResumeProcess)(wintypes.HANDLE(h))
    finally:
        k32.CloseHandle(h)


def guarded_freeze_test(nova: FakeNova, mode: str) -> dict:
    """Le pire cas : Nova touche la fenêtre possédée AVANT que le chien de garde de l'hôte la détache
    (mode « hang » : gel de 15 s de l'interface du plugin), ou l'hôte entier est suspendu (mode
    « suspend » : son chien de garde ne tourne plus). Nova attend le plugin ; quand Windows la dit
    « ne répond pas » (5 s), le pont (NativePlugin.show_editor) arrête l'hôte et Nova repart."""
    import vst_native
    vst_native.POOL.close()
    p = vst_native.NativePlugin(PLUGIN)
    stop = threading.Event()
    th = threading.Thread(target=lambda: p.show_editor(stop, owner=int(nova.hwnd), debug_pos=[POS + 40, POS + 40]),
                          daemon=True)
    th.start()
    t_wait = time.perf_counter()
    while not p._editor_hwnd and time.perf_counter() - t_wait < 30:
        time.sleep(0.05)
    probe = Probe(nova)
    probe.start()
    time.sleep(0.2)
    t0 = time.perf_counter()
    if mode == "suspend":
        suspend(p.host_pid, True)
    else:
        p._host.request("debug_hang", ms=15000)
    time.sleep(0.15)
    _, z_ms = nova.run(lambda: u32.SetWindowPos(nova.hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE))
    _, min_ms = nova.run(lambda: (u32.ShowWindow(nova.hwnd, SW_SHOWMINNOACTIVE),
                                  u32.ShowWindow(nova.hwnd, SW_SHOWNOACTIVATE)), timeout=60)
    deadline = time.perf_counter() + 20
    while p.alive() and time.perf_counter() < deadline:
        time.sleep(0.05)
    killed_after = (time.perf_counter() - t0) * 1000.0
    time.sleep(0.5)
    probe.stop.set()
    probe.join(25)
    alive = p.alive()
    if alive and mode == "suspend":
        suspend(p.host_pid, False)
    stop.set()
    th.join(10)
    p.close()
    return {"hôte arrêté par le pont": not alive, "arrêt après (ms)": round(killed_after),
            "Nova : remontée dans l'ordre Z (ms)": round(z_ms),
            "Nova : réduction + rétablissement (ms)": round(min_ms),
            "Nova : plus long gel de sa boucle de messages (ms)": round(probe.worst)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--skip-suspend", action="store_true")
    a = ap.parse_args()
    os.environ["NOVA_HOST_DEBUG"] = "1"
    report = {}
    nova = FakeNova()
    print(f"Fausse Nova : {nova.hwnd:#x}")

    # 4. sans propriétaire (navigateur) : comme avant
    p = open_plugin({"NOVA_EDITOR_HANG_MS": "400"})
    r = show(p, None)
    ex = u32.GetWindowLongPtrW(int(r["hwnd"]), GWL_EXSTYLE)
    report["sans propriétaire (navigateur)"] = {"indépendante (WS_EX_APPWINDOW, sans propriétaire)":
                                                bool(ex & WS_EX_APPWINDOW) and not u32.GetWindow(int(r["hwnd"]), GW_OWNER)}
    p.close()

    # 1-3 + 5b : propriétaire + chien de garde
    p = open_plugin({"NOVA_EDITOR_HANG_MS": "400"})
    r = show(p, nova.hwnd)
    report["possédée par Nova"] = checks(nova, r)
    report["gel 4 s, geste de Nova à 1 s, AVEC chien de garde"] = hang_test(nova, p)
    report["gel 4 s, geste de Nova à 0,15 s, AVEC chien de garde"] = hang_test(nova, p, gesture_at=0.15)
    p.close()

    # 5a : sans chien de garde
    p = open_plugin({"NOVA_EDITOR_HANG_MS": "0"})
    show(p, nova.hwnd)
    report["gel 4 s, geste de Nova à 1 s, SANS chien de garde"] = hang_test(nova, p)
    p.close()

    if not a.skip_suspend:
        os.environ["NOVA_EDITOR_HANG_MS"] = "400"
        report["gel 15 s, geste de Nova dans les 400 premières ms (pont)"] = guarded_freeze_test(nova, "hang")
        report["hôte suspendu (pont)"] = guarded_freeze_test(nova, "suspend")

    nova.close()
    print(json.dumps(report, ensure_ascii=False, indent=1))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
    ok = all(v for k in ("possédée par Nova", "sans propriétaire (navigateur)") for v in report[k].values())
    z = "Nova : remontée dans l'ordre Z (ms)"
    ok = ok and report["gel 4 s, geste de Nova à 1 s, AVEC chien de garde"][z] < 100
    ok = ok and report["gel 4 s, geste de Nova à 1 s, AVEC chien de garde"]["rattachée après le gel"]
    for k in ("gel 15 s, geste de Nova dans les 400 premières ms (pont)", "hôte suspendu (pont)"):
        if k in report:
            ok = ok and report[k]["hôte arrêté par le pont"] and report[k]["Nova : plus long gel de sa boucle de messages (ms)"] < 8000
    print("RÉSULTAT :", "OK" if ok else "ÉCHEC")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
