"""
Garde des fenêtres pendant une mesure boîte noire (à lancer DANS bureau_cache.py).

Liste les fenêtres de premier niveau du bureau invisible courant. Une fenêtre dont le titre ou
le texte évoque une licence / activation / essai déclenche l'arrêt : le processus hôte du
plugin est tué (équivalent de « Quitter ») — aucune licence n'est jamais acceptée.
"""
import ctypes
import re
import threading
import time
from ctypes import wintypes

u32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

LICENCE = re.compile(r"licen|activat|trial|essai|expir|register|ilok|authori|serial|subscription|abonnement", re.I)
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _text(hwnd) -> str:
    n = u32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    u32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _cls(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _children_text(hwnd) -> str:
    out = []

    def cb(h, _):
        t = _text(h)
        if t:
            out.append(t)
        return True
    u32.EnumChildWindows(hwnd, EnumProc(cb), 0)
    return " | ".join(out)[:400]


def windows():
    desk = u32.GetThreadDesktop(k32.GetCurrentThreadId())
    out = []

    def cb(h, _):
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        out.append({"hwnd": int(h), "pid": int(pid.value), "title": _text(h), "class": _cls(h),
                    "visible": bool(u32.IsWindowVisible(h))})
        return True
    u32.EnumDesktopWindows(desk, EnumProc(cb), 0)
    return out


class Garde:
    """Surveille les fenêtres visibles (sur le bureau invisible) appartenant au processus hôte."""

    def __init__(self, on_licence):
        self.on_licence = on_licence
        self.vues = []
        self.stop = threading.Event()
        self.pids = set()
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self):
        seen = set()
        while not self.stop.is_set():
            for w in windows():
                if not w["visible"] or w["hwnd"] in seen:
                    continue
                if self.pids and w["pid"] not in self.pids:
                    continue
                seen.add(w["hwnd"])
                txt = w["title"] + " | " + _children_text(w["hwnd"])
                w["texte"] = txt
                self.vues.append(w)
                if LICENCE.search(txt):
                    self.on_licence(w)
            time.sleep(0.2)
