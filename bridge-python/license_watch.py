#!/usr/bin/env python3
"""
Fenêtres de licence / d'activation ouvertes par les plugins (Windows).

Un plugin protégé peut ouvrir, au chargement, une fenêtre d'activation, de
licence ou d'enregistrement (parfois depuis un programme d'aide qu'il lance).
Le pont tourne en arrière-plan : sans aide, cette fenêtre s'ouvrait derrière le
navigateur et le chargement semblait bloqué.

- windows_of()      : fenêtres de premier niveau d'un ensemble de processus
                      (le pont et ses descendants : programmes d'aide de licence)
- bring_window()    : mise au premier plan (restaure, premier plan forcé,
                      « toujours au-dessus » 2 s)
- LicenseWatcher    : après chaque création d'instance de plugin, surveille
                      ~20 s (toutes les 0,5 s) l'apparition de nouvelles
                      fenêtres qui ne sont pas l'éditeur du plugin ; chacune est
                      ramenée devant et signalée (rappel on_window).

Rien ne se passe hors Windows (fonctions neutres).
"""

import ctypes
import logging
import os
import platform
import threading
import time
from typing import Callable, Dict, Iterable, List, Optional, Set

logger = logging.getLogger("NovaBridge.Licence")

IS_WINDOWS = platform.system() == "Windows"
WATCH_AFTER_S = 20.0
POLL_S = 0.5

# Fenêtres techniques qui ne sont jamais une demande de licence.
_IGNORED_CLASSES = {"ConsoleWindowClass", "tooltips_class32", "IME", "MSCTFIME UI", "#32768",
                    "PseudoConsoleWindow", "CicMarshalWndClass"}

if IS_WINDOWS:
    from ctypes import wintypes
    _user32 = ctypes.windll.user32
    _k32 = ctypes.windll.kernel32
    _EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, wintypes.UINT]
    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]


def descendants(root: int) -> Set[int]:
    """Le processus donné et tous ses descendants (Toolhelp32)."""
    out = {root}
    if not IS_WINDOWS:
        return out
    snap = _k32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        return out
    parents: Dict[int, int] = {}
    try:
        e = _PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = _k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            parents[e.th32ProcessID] = e.th32ParentProcessID
            ok = _k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        _k32.CloseHandle(snap)
    grew = True
    while grew:
        grew = False
        for pid, ppid in parents.items():
            if ppid in out and pid not in out and pid != ppid:
                out.add(pid)
                grew = True
    return out


def _text(hwnd) -> str:
    # InternalGetWindowText : n'envoie aucun message à la fenêtre. GetWindowText
    # attendait la réponse du thread propriétaire (souvent bloqué dans le
    # chargement du plugin) et figeait le pont.
    buf = ctypes.create_unicode_buffer(512)
    _user32.InternalGetWindowText(hwnd, buf, 512)
    return buf.value


def _class(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    _user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def windows_of(pids: Iterable[int], visible_only: bool = True) -> Dict[int, dict]:
    """Fenêtres de premier niveau appartenant aux processus donnés :
    {hwnd: {title, cls, pid, visible}} (petites fenêtres techniques exclues)."""
    if not IS_WINDOWS:
        return {}
    wanted = set(pids)
    found: Dict[int, dict] = {}

    def cb(hwnd, _lp):
        pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in wanted:
            return True
        visible = bool(_user32.IsWindowVisible(hwnd))
        if visible_only and not visible:
            return True
        cls = _class(hwnd)
        if cls in _IGNORED_CLASSES:
            return True
        r = wintypes.RECT()
        _user32.GetWindowRect(hwnd, ctypes.byref(r))
        title = _text(hwnd)
        if visible and (r.right - r.left < 100 or r.bottom - r.top < 50):
            return True
        if not visible and not title:
            return True
        found[int(hwnd)] = {"title": title, "cls": cls, "pid": pid.value, "visible": visible}
        return True

    try:
        _user32.EnumWindows(_EnumProc(cb), 0)
    except Exception as e:  # pragma: no cover
        logger.debug(f"EnumWindows : {e}")
    return found


def bring_window(hwnd: int, topmost_s: float = 2.0):
    """Ramène une fenêtre devant le navigateur (même d'un autre processus)."""
    if not IS_WINDOWS:
        return
    try:
        pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        _user32.AllowSetForegroundWindow(pid.value)
        _user32.AllowSetForegroundWindow(0xFFFFFFFF)  # ASFW_ANY
        # Variantes asynchrones : la fenêtre d'un autre thread (souvent bloqué dans
        # le chargement du plugin) ne doit jamais bloquer le pont.
        _user32.ShowWindowAsync(hwnd, 9)               # SW_RESTORE
        HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
        flags = 0x0001 | 0x0002 | 0x0040 | 0x4000      # NOSIZE | NOMOVE | SHOWWINDOW | ASYNCWINDOWPOS
        _user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags)
        # Windows refuse le premier plan à un processus d'arrière-plan : file de
        # messages créée pour ce thread, rattachement un instant à la fenêtre
        # active, touche Alt ; plusieurs essais (fenêtre parfois encore en création).
        msg = wintypes.MSG()
        _user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)
        me = _k32.GetCurrentThreadId()
        for _ in range(4):
            fg = _user32.GetForegroundWindow()
            if fg and int(fg) == int(hwnd):
                break
            fg_thread = _user32.GetWindowThreadProcessId(fg, None) if fg else 0
            attached = bool(fg_thread and fg_thread != me and _user32.AttachThreadInput(me, fg_thread, True))
            _user32.keybd_event(0x12, 0, 0, 0)         # Alt : autorise SetForegroundWindow
            _user32.SetForegroundWindow(hwnd)
            _user32.keybd_event(0x12, 0, 2, 0)
            if attached:
                _user32.AttachThreadInput(me, fg_thread, False)
            time.sleep(0.15)
        fg = _user32.GetForegroundWindow()
        if not fg or int(fg) != int(hwnd):
            # Windows refuse le premier plan pendant que le musicien tape ailleurs :
            # la fenêtre reste au-dessus et clignote dans la barre des tâches.
            class FLASHWINFO(ctypes.Structure):
                _fields_ = [("cbSize", wintypes.UINT), ("hwnd", wintypes.HWND), ("dwFlags", wintypes.DWORD),
                            ("uCount", wintypes.UINT), ("dwTimeout", wintypes.DWORD)]
            fi = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, 0x3 | 0xC, 0, 0)  # FLASHW_ALL | FLASHW_TIMERNOFG
            _user32.FlashWindowEx(ctypes.byref(fi))

        def untop():
            try:
                _user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x4000)  # + NOACTIVATE
            except Exception:
                pass
        threading.Timer(topmost_s, untop).start()
    except Exception as e:
        logger.debug(f"Premier plan impossible : {e}")


def hide_window(hwnd: int):
    if IS_WINDOWS:
        try:
            _user32.ShowWindowAsync(hwnd, 0)  # SW_HIDE (sans attendre la fenêtre)
        except Exception:
            pass


def close_window(hwnd: int):
    if IS_WINDOWS:
        try:
            _user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        except Exception:
            pass


def memory_load() -> int:
    """Mémoire physique utilisée (%) ; 0 si inconnu."""
    if not IS_WINDOWS:
        return 0

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    m = MEMORYSTATUSEX()
    m.dwLength = ctypes.sizeof(m)
    try:
        if _k32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return int(m.dwMemoryLoad)
    except Exception:
        pass
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# SURVEILLANCE APRÈS CHARGEMENT
# ─────────────────────────────────────────────────────────────────────────────

class Watch:
    """Une création d'instance surveillée (chargement, rendu)."""

    def __init__(self, path: str, plugin_name: Optional[str], context: Optional[dict], baseline: Set[int]):
        self.path = path
        self.plugin_name = plugin_name
        self.context = context or {}
        self.baseline = baseline
        self.started = time.time()
        self.ended: Optional[float] = None
        self.seen = False          # une fenêtre de licence est apparue
        self.titles: List[str] = []

    @property
    def label(self) -> str:
        return self.plugin_name or os.path.basename(self.path)[:-5]

    def end(self):
        if self.ended is None:
            self.ended = time.time()


class LicenseWatcher:
    """Un seul thread, actif seulement pendant / juste après un chargement."""

    def __init__(self, on_window: Callable[[Watch, dict], None],
                 ignore_title: Optional[Callable[[str], bool]] = None,
                 excluded_pids: Optional[Callable[[], Set[int]]] = None,
                 on_clean: Optional[Callable[[Watch], None]] = None):
        self.on_window = on_window
        self.on_clean = on_clean or (lambda w: None)
        self.ignore_title = ignore_title or (lambda t: False)
        self.excluded_pids = excluded_pids or (lambda: set())
        self.watches: List[Watch] = []
        self.reported: Set[int] = set()
        self.open_windows: Dict[int, tuple] = {}   # hwnd -> (Watch, info)
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.thread: Optional[threading.Thread] = None

    def _pids(self) -> Set[int]:
        return descendants(os.getpid()) - self.excluded_pids()

    def begin(self, path: str, plugin_name: Optional[str] = None, context: Optional[dict] = None) -> Watch:
        w = Watch(path, plugin_name, context, set(windows_of(self._pids())) if IS_WINDOWS else set())
        # Fenêtre de ce plugin encore ouverte (chargement précédent en attente) :
        # signalée de nouveau à ce chargement-ci et ramenée devant.
        for hwnd, (prev, info) in list(self.open_windows.items()):
            if not (IS_WINDOWS and _user32.IsWindow(hwnd)):
                self.open_windows.pop(hwnd, None)
                continue
            if prev.path == path:
                w.seen = True
                w.titles.append(info["title"])
                try:
                    self.on_window(w, {"hwnd": hwnd, **info})
                except Exception:
                    pass
                self._present(w, hwnd)
        with self.lock:
            self.watches.append(w)
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._run, name="licence", daemon=True)
                self.thread.start()
        self.wake.set()
        return w

    def _present(self, w: Watch, hwnd: int):
        """Fenêtre de licence vue : ramenée devant (chargement demandé par le
        musicien), ou cachée puis fermée (v7, chargement « discret » : autotune
        ou mix posés automatiquement par NOVA ; aucune fenêtre ne doit surgir,
        le plugin est alors noté indisponible par le serveur)."""
        if w.context.get("quiet"):
            w.context["license_seen"] = True
            hide_window(hwnd)
            close_window(hwnd)
            return
        threading.Thread(target=bring_window, args=(hwnd,), daemon=True).start()

    def _owner(self, title: str) -> Optional[Watch]:
        live = [w for w in self.watches if w.ended is None] or self.watches
        low = title.lower()
        for w in reversed(live):
            if w.label and w.label.lower() in low:
                return w
        return live[-1] if live else None

    def _run(self):
        while True:
            now = time.time()
            with self.lock:
                expired = [w for w in self.watches if w.ended is not None and now - w.ended >= WATCH_AFTER_S]
                self.watches = [w for w in self.watches if w not in expired]
            for w in expired:
                if not w.seen:
                    try:
                        self.on_clean(w)  # chargé sans fenêtre : licence en ordre
                    except Exception:
                        pass
            with self.lock:
                if not self.watches:
                    self.thread = None
                    return
                baseline = set().union(*(w.baseline for w in self.watches))
            try:
                current = windows_of(self._pids())
            except Exception:
                current = {}
            for hwnd, info in current.items():
                if hwnd in baseline or hwnd in self.reported or self.ignore_title(info["title"]):
                    continue
                with self.lock:
                    w = self._owner(info["title"])
                if w is None:
                    continue
                self.reported.add(hwnd)
                self.open_windows[hwnd] = (w, info)
                w.seen = True
                w.titles.append(info["title"])
                quiet = bool(w.context.get("quiet"))
                logger.info(f"🔑 {w.label} ouvre une fenêtre : « {info['title'] or info['cls']} » "
                            f"({'fermée : chargement discret' if quiet else 'ramenée au premier plan'})")
                try:
                    self.on_window(w, {"hwnd": hwnd, **info})
                except Exception as e:
                    logger.debug(f"Signalement de fenêtre : {e}")
                self._present(w, hwnd)
            self.wake.wait(POLL_S)
            self.wake.clear()


# ─────────────────────────────────────────────────────────────────────────────
# MÉMOIRE DES FENÊTRES DE LICENCE (entre deux lancements du pont)
# ─────────────────────────────────────────────────────────────────────────────

class LicenseLog:
    """Plugins qui ont ouvert une fenêtre de licence au chargement.

    - 1re fois : « activation » (le musicien active, l'éditeur du plugin garde
      la licence : la fenêtre ne revient plus) ;
    - fenêtre revue lors d'un autre lancement du pont : « nag » (démo, rappel
      d'enregistrement…) : le pont ne charge plus ce plugin de lui-même ;
    - chargé sans fenêtre : licence en ordre, l'entrée est effacée.
    Fichier : %LOCALAPPDATA%/NovaStudio/license_windows.json."""

    def __init__(self):
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        self.path = os.path.join(base, "NovaStudio", "license_windows.json")
        self.lock = threading.Lock()
        self.session: Set[str] = set()
        try:
            import json
            with open(self.path, "r", encoding="utf-8") as f:
                self.data: Dict[str, dict] = json.load(f).get("items", {})
        except Exception:
            self.data = {}

    @staticmethod
    def key(path: str, plugin_name: Optional[str]) -> str:
        return f"{path}#{plugin_name or ''}"

    def _save(self):
        try:
            import json
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"v": 1, "items": self.data}, f)
            os.replace(tmp, self.path)
        except Exception as e:
            logger.debug(f"journal de licences non écrit : {e}")

    def window(self, path: str, plugin_name: Optional[str], name: str, title: str) -> str:
        """Fenêtre vue au chargement : renvoie le statut (« activation » / « nag »)."""
        k = self.key(path, plugin_name)
        with self.lock:
            e = self.data.setdefault(k, {"name": name, "path": path, "plugin_name": plugin_name, "sessions": 0})
            if k not in self.session:
                self.session.add(k)
                e["sessions"] = int(e.get("sessions", 0)) + 1
            e["title"] = title[:200]
            e["last"] = time.time()
            e["status"] = "nag" if e["sessions"] >= 2 else "activation"
            self._save()
            return e["status"]

    def clean(self, path: str, plugin_name: Optional[str]) -> bool:
        """Chargé sans fenêtre : licence en ordre. True si une entrée a été effacée."""
        k = self.key(path, plugin_name)
        with self.lock:
            if k not in self.data or k in self.session:
                return False   # fenêtre vue pendant cette session : on ne conclut pas
            del self.data[k]
            self._save()
            return True

    def status(self, path: str, plugin_name: Optional[str] = None) -> Optional[str]:
        e = self.data.get(self.key(path, plugin_name)) or self.data.get(self.key(path, None))
        return e.get("status") if e else None
