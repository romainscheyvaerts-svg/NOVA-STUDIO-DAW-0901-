# -*- coding: utf-8 -*-
"""
Nova Studio pour Windows.

Un seul exécutable, trois rôles :
  NovaStudio.exe                      fenêtre WebView2 (Edge) qui charge le DAW en ligne
                                      + lance / surveille les deux ponts en processus enfants
  NovaStudio.exe --bridge asio        pont ASIO   (bridge-python/asio_bridge.py, ws://127.0.0.1:8766)
  NovaStudio.exe --bridge vst         pont VST3   (bridge-python/nova_bridge_server.py, ws://127.0.0.1:8765)
  NovaStudio.exe --probe-vst3         lecture des plugins VST3 pour le pont (bridge-python/vst_probe.py)
  NovaStudio.exe <...>asio_control_panel.py "<driver>"
                                      panneau ASIO (le pont ASIO relance sys.executable avec ce script)

Les ponts tournent dans des processus séparés : un plugin VST qui plante n'emporte
pas la fenêtre (et la session en cours) avec lui ; le superviseur le relance.

Variables d'environnement (tests / développement) :
  NOVA_DESKTOP_URL=http://localhost:5177/   page chargée à la place de la prod
  NOVA_DESKTOP_DEBUG=1                      outils de développement (F12)
  NOVA_DESKTOP_CDP_PORT=9333                port de débogage distant (tests automatisés)
  NOVA_DESKTOP_DATA_DIR=...                 dossier de données (profil WebView2, journaux)
  NOVA_DESKTOP_NO_BRIDGES=1                 ne lance pas les ponts
  NOVA_DESKTOP_EXTRA_ARGS="--flag"          arguments Chromium en plus (tests)
  NOVA_DESKTOP_CLOSE_TIMEOUT=90             délai max de sauvegarde à la fermeture (s)
"""
import ctypes
import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from ctypes import wintypes
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse

APP_NAME = "Nova Studio"
APP_VERSION = "1.0.0"
DEFAULT_URL = "https://nova-studio-daw-0901-9kzo.vercel.app/"
ASIO_PORT = 8766
VST_PORT = int(os.environ.get("NOVA_BRIDGE_PORT", "8765"))
CLOSE_TIMEOUT_S = float(os.environ.get("NOVA_DESKTOP_CLOSE_TIMEOUT", "90"))
MUTEX_NAME = "NovaStudioDesktopMutex"   # repris par l'installateur (AppMutex)
BG = (12, 13, 16)                       # #0c0d10, couleur de fond du DAW

FROZEN = getattr(sys, "frozen", False)
HERE = os.path.dirname(os.path.abspath(__file__))
RES_DIR = getattr(sys, "_MEIPASS", HERE)

log = logging.getLogger("NovaDesktop")


# ─────────────────────────────────────────────────────────────────────────────
# Chemins
# ─────────────────────────────────────────────────────────────────────────────

def data_dir() -> str:
    d = os.environ.get("NOVA_DESKTOP_DATA_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "NovaStudio")
    os.makedirs(os.path.join(d, "logs"), exist_ok=True)
    return d


def log_path(name: str) -> str:
    return os.path.join(data_dir(), "logs", name)


def resource(*parts: str) -> str:
    return os.path.join(RES_DIR, *parts)


def webview2_dir() -> str:
    return resource("webview2") if FROZEN else os.path.join(HERE, "vendor", "webview2")


def self_command(*args: str) -> list:
    return [sys.executable, *args] if FROZEN else [sys.executable, os.path.abspath(__file__), *args]


def _rotate(path: str, max_bytes: int = 2_000_000) -> None:
    try:
        if os.path.getsize(path) > max_bytes:
            os.replace(path, path + ".1")
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Rôle « pont » (processus enfant)
# ─────────────────────────────────────────────────────────────────────────────

def _redirect_output(kind: str):
    path = log_path(f"bridge-{kind}.log")
    _rotate(path)
    f = open(path, "a", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = sys.stderr = f
    try:
        import faulthandler
        faulthandler.enable(file=f)
    except Exception:
        pass
    print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} — Nova Studio {APP_VERSION}, pont {kind} (pid {os.getpid()}) =====")
    return f


def _bridge_import_path() -> None:
    if not FROZEN:
        sys.path.insert(0, os.path.join(os.path.dirname(HERE), "bridge-python"))


def run_bridge(kind: str) -> int:
    _redirect_output(kind)
    _bridge_import_path()
    if kind == "asio":
        import asyncio
        import asio_bridge
        asyncio.run(asio_bridge.main())
        return 0
    if kind == "vst":
        import nova_bridge_server
        nova_bridge_server.main()
        return 0
    print(f"pont inconnu : {kind}")
    return 2


def run_asio_control_panel(driver: str) -> int:
    _bridge_import_path()
    import asio_control_panel
    return 0 if asio_control_panel.open_asio_control_panel(driver) else 1


# ─────────────────────────────────────────────────────────────────────────────
# Superviseur des ponts
# ─────────────────────────────────────────────────────────────────────────────

class _JobObject:
    """Job Windows « tuer à la fermeture » : si Nova Studio meurt (crash, gestionnaire
    des tâches), Windows arrête aussi les ponts au lieu de laisser des orphelins."""

    def __init__(self):
        self.handle = None
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [(n, ctypes.c_ulonglong) for n in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class BASIC(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                            ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD),
                            ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t),
                            ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t),
                            ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class EXTENDED(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", BASIC),
                            ("IoInfo", IO_COUNTERS),
                            ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t),
                            ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            self._k32 = k32
            h = k32.CreateJobObjectW(None, None)
            info = EXTENDED()
            info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            self.handle = h
        except Exception as e:
            log.warning(f"Job object indisponible : {e}")

    def assign(self, proc: subprocess.Popen) -> None:
        if self.handle:
            try:
                self._k32.AssignProcessToJobObject(self.handle, int(proc._handle))
            except Exception as e:
                log.warning(f"AssignProcessToJobObject : {e}")


def port_in_use(port: int) -> bool:
    """Port local déjà pris ? On tente un bind plutôt qu'une connexion : aucun bruit
    (« connexion fermée ») dans la console d'un ancien NovaASIOBridge/NovaVSTBridge.exe."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
    except OSError:
        return True
    finally:
        s.close()
    try:  # cas rare d'un serveur à l'écoute sur 0.0.0.0 (le bind ci-dessus passe alors)
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


class Bridge:
    BACKOFF = (2, 5, 15, 30, 60)

    def __init__(self, kind: str, port: int, label: str):
        self.kind, self.port, self.label = kind, port, label
        self.proc = None
        self.started_at = 0.0
        self.failures = 0
        self.next_try = 0.0
        self.external = False


class BridgeSupervisor(threading.Thread):
    def __init__(self):
        super().__init__(name="bridges", daemon=True)
        self.bridges = [Bridge("asio", ASIO_PORT, "pont ASIO"), Bridge("vst", VST_PORT, "pont VST")]
        self.job = _JobObject()
        self._stop = threading.Event()
        self._lock = threading.Lock()

    def _spawn(self, b: Bridge) -> None:
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        b.proc = subprocess.Popen(
            self_command("--bridge", b.kind),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=0x08000000,  # CREATE_NO_WINDOW : aucune console visible
            env=env, close_fds=True,
        )
        self.job.assign(b.proc)
        b.started_at = time.time()
        log.info(f"{b.label} lancé (pid {b.proc.pid}, port {b.port})")

    def _tick(self) -> None:
        now = time.time()
        for b in self.bridges:
            if b.proc is not None:
                code = b.proc.poll()
                if code is None:
                    continue
                ran = now - b.started_at
                b.proc = None
                b.failures = 0 if ran > 60 else b.failures + 1
                delay = self.BACKOFF[min(b.failures, len(self.BACKOFF) - 1)]
                b.next_try = now + delay
                log.warning(f"{b.label} arrêté (code {code}, après {ran:.0f} s) ; relance dans {delay} s")
                continue
            if now < b.next_try:
                continue
            if port_in_use(b.port):
                if not b.external:
                    log.info(f"port {b.port} déjà occupé : {b.label} déjà lancé (ancien .exe ?), on ne le duplique pas")
                    b.external = True
                b.next_try = now + 10
                continue
            b.external = False
            try:
                self._spawn(b)
            except Exception as e:
                log.error(f"impossible de lancer le {b.label} : {e}")
                b.next_try = now + 30

    def run(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                if self._stop.is_set():
                    break
                try:
                    self._tick()
                except Exception:
                    log.exception("superviseur")
            self._stop.wait(2.0)

    def stop(self) -> None:
        with self._lock:
            self._stop.set()
            for b in self.bridges:
                p, b.proc = b.proc, None
                if p is not None and p.poll() is None:
                    log.info(f"arrêt du {b.label} (pid {p.pid})")
                    try:
                        p.kill()
                        p.wait(5)
                    except Exception:
                        pass


# ─────────────────────────────────────────────────────────────────────────────
# Instance unique
# ─────────────────────────────────────────────────────────────────────────────

_mutex = None


def acquire_single_instance() -> bool:
    global _mutex
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.restype = wintypes.HANDLE
    _mutex = k32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
        return True
    # Déjà ouverte : on ramène la fenêtre existante au premier plan.
    u32 = ctypes.WinDLL("user32")
    u32.FindWindowW.restype = wintypes.HWND
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(hwnd, buf, 256)
        if buf.value.startswith(APP_NAME) and u32.IsWindowVisible(hwnd):
            pid = wintypes.DWORD()
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value != os.getpid():
                found.append(hwnd)
                return False
        return True

    u32.EnumWindows(_enum, 0)
    if found:
        if u32.IsIconic(found[0]):
            u32.ShowWindow(found[0], 9)  # SW_RESTORE
        u32.SetForegroundWindow(found[0])
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Scripts injectés dans la page
# ─────────────────────────────────────────────────────────────────────────────

MARKER_JS = """
(function () {
  try {
    Object.defineProperty(window, '__novaDesktop', {
      value: Object.freeze({
        version: %(version)s,
        platform: 'windows',
        bridges: Object.freeze({ asio: %(asio)d, vst: %(vst)d })
      }),
      configurable: false, enumerable: false, writable: false
    });
  } catch (e) {}
})();
"""

# Lance window.__novaBeforeClose() sans bloquer et renvoie tout de suite son état.
CLOSE_START_JS = r"""
(function () {
  var st = window.__novaDesktopClose;
  if (st && st.status === 'pending') return 'pending';
  var f = window.__novaBeforeClose;
  if (typeof f !== 'function') { window.__novaDesktopClose = { status: 'none' }; return 'none'; }
  window.__novaDesktopClose = { status: 'pending', t0: Date.now() };
  try {
    var d = document.createElement('div');
    d.id = 'nova-desktop-saving';
    d.setAttribute('role', 'status');
    d.textContent = 'Sauvegarde de la session… Nova Studio se fermera tout seul.';
    d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'background:rgba(12,13,16,.92);color:#e2e8f0;border:1px solid rgba(168,85,247,.6);border-radius:10px;' +
      'padding:10px 16px;font:500 14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:none';
    (document.body || document.documentElement).appendChild(d);
  } catch (e) {}
  try {
    Promise.resolve(f()).then(
      function () { window.__novaDesktopClose = { status: 'done' }; },
      function (e) { window.__novaDesktopClose = { status: 'error', error: String(e && e.message || e) }; }
    );
  } catch (e) {
    window.__novaDesktopClose = { status: 'error', error: String(e && e.message || e) };
  }
  return window.__novaDesktopClose.status;
})()
"""

CLOSE_POLL_JS = "(window.__novaDesktopClose && window.__novaDesktopClose.status) || 'none'"

OFFLINE_HTML_FALLBACK = """<!doctype html><meta charset="utf-8"><title>Nova Studio</title>
<body style="background:#0c0d10;color:#e2e8f0;font-family:system-ui;padding:40px">
<h1>Impossible de charger Nova Studio</h1><p>Vérifie ta connexion Internet.</p>
<button onclick="location.replace('%(url)s')">Réessayer</button></body>"""


def offline_html(url: str) -> str:
    try:
        with open(resource("offline.html"), encoding="utf-8") as f:
            html = f.read()
    except OSError:
        html = OFFLINE_HTML_FALLBACK
    return html.replace("%(url)s", json.dumps(url)[1:-1])


# ─────────────────────────────────────────────────────────────────────────────
# Fenêtre (WinForms + WebView2 via pythonnet)
# ─────────────────────────────────────────────────────────────────────────────

def _set_dpi_awareness() -> None:
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass


def run_window(url: str) -> None:
    wv2 = webview2_dir()
    os.environ["PATH"] = wv2 + os.pathsep + os.environ.get("PATH", "")
    import clr  # pythonnet (.NET Framework 4.x, présent sur tout Windows 10/11)
    clr.AddReference("System.Windows.Forms")
    clr.AddReference("System.Drawing")
    clr.AddReference(os.path.join(wv2, "Microsoft.Web.WebView2.Core.dll"))
    clr.AddReference(os.path.join(wv2, "Microsoft.Web.WebView2.WinForms.dll"))

    import System.Windows.Forms as WinForms
    from System import Action, String
    from System.Drawing import Color, Icon, Size
    from System.Threading import ApartmentState, Thread, ThreadStart
    from System.Threading.Tasks import Task
    from Microsoft.Web.WebView2.Core import (
        CoreWebView2PermissionState, CoreWebView2ProcessFailedKind, CoreWebView2WebErrorStatus)
    from Microsoft.Web.WebView2.WinForms import CoreWebView2CreationProperties, WebView2

    debug = os.environ.get("NOVA_DESKTOP_DEBUG") == "1"
    app_host = (urlparse(url).hostname or "").lower()

    def trusted(uri: str) -> bool:
        h = (urlparse(uri).hostname or "").lower()
        return (h == app_host or h in ("localhost", "127.0.0.1", "[::1]")
                or h.endswith(".studiomakemusic.com") or h == "studiomakemusic.com"
                or (h.startswith("nova-studio-daw-0901") and h.endswith(".vercel.app")))

    def stays_in_app(uri: str) -> bool:
        p = urlparse(uri)
        if p.scheme not in ("http", "https"):
            return True  # about:, data:, blob: …
        h = (p.hostname or "").lower()
        return trusted(uri) or h.endswith(".supabase.co")

    browser_args = " ".join([
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ElasticOverscroll",
    ])
    if os.environ.get("NOVA_DESKTOP_EXTRA_ARGS"):
        browser_args += " " + os.environ["NOVA_DESKTOP_EXTRA_ARGS"]
    cdp = os.environ.get("NOVA_DESKTOP_CDP_PORT")
    if cdp:
        browser_args += f" --remote-debugging-port={int(cdp)}"

    class AppWindow:
        def __init__(self):
            self.core = None
            self.allow_close = False
            self.saving = False
            self.offline = False
            form = self.form = WinForms.Form()
            form.Text = APP_NAME
            try:
                form.Icon = Icon(resource("nova.ico") if FROZEN else os.path.join(HERE, "assets", "nova.ico"))
            except Exception:
                pass
            form.BackColor = Color.FromArgb(*BG)
            form.StartPosition = WinForms.FormStartPosition.CenterScreen
            form.Size = Size(1440, 900)
            form.MinimumSize = Size(960, 600)
            form.WindowState = WinForms.FormWindowState.Maximized

            web = self.web = WebView2()
            props = CoreWebView2CreationProperties()
            props.UserDataFolder = os.path.join(data_dir(), "WebView2")
            props.AdditionalBrowserArguments = browser_args
            props.Language = "fr-FR"
            web.CreationProperties = props
            web.DefaultBackgroundColor = Color.FromArgb(255, *BG)
            web.Dock = WinForms.DockStyle.Fill
            form.Controls.Add(web)
            web.CoreWebView2InitializationCompleted += self.on_ready
            form.FormClosing += self.on_closing
            web.EnsureCoreWebView2Async(None)

        # ── initialisation ──────────────────────────────────────────────
        def on_ready(self, sender, args):
            if not args.IsSuccess:
                log.error(f"WebView2 indisponible : {args.InitializationException}")
                r = WinForms.MessageBox.Show(
                    "Nova Studio a besoin du composant Microsoft Edge WebView2, introuvable sur ce PC.\n\n"
                    "Clique sur OK pour ouvrir la page de téléchargement Microsoft, installe "
                    "« Evergreen Bootstrapper », puis relance Nova Studio.",
                    APP_NAME, WinForms.MessageBoxButtons.OKCancel, WinForms.MessageBoxIcon.Error)
                if r == WinForms.DialogResult.OK:
                    webbrowser.open("https://developer.microsoft.com/microsoft-edge/webview2/")
                self.allow_close = True
                self.form.Close()
                return
            core = self.core = self.web.CoreWebView2
            s = core.Settings
            s.UserAgent = f"{s.UserAgent} NovaStudioDesktop/{APP_VERSION}"
            s.AreDevToolsEnabled = debug
            s.IsStatusBarEnabled = False
            s.IsSwipeNavigationEnabled = False
            s.AreDefaultScriptDialogsEnabled = True
            core.PermissionRequested += self.on_permission
            core.NewWindowRequested += self.on_new_window
            core.NavigationStarting += self.on_navigation_starting
            core.NavigationCompleted += self.on_navigation_completed
            core.ProcessFailed += self.on_process_failed
            core.ContextMenuRequested += self.on_context_menu
            core.AddScriptToExecuteOnDocumentCreatedAsync(MARKER_JS % {
                "version": json.dumps(APP_VERSION), "asio": ASIO_PORT, "vst": VST_PORT})
            log.info(f"WebView2 {core.Environment.BrowserVersionString} prêt, chargement de {url}")
            core.Navigate(url)

        # ── permissions : micro, MIDI, autoplay… accordés d'office au DAW ──
        def on_permission(self, sender, args):
            uri = str(args.Uri)
            if trusted(uri):
                args.State = CoreWebView2PermissionState.Allow
                try:
                    args.SavesInProfile = True
                except Exception:
                    pass
                log.info(f"permission {args.PermissionKind} accordée à {uri}")

        # ── liens externes -> navigateur par défaut ──────────────────────
        def on_new_window(self, sender, args):
            uri = str(args.Uri)
            args.Handled = True
            if uri.startswith(("http://", "https://", "mailto:")):
                webbrowser.open(uri)

        def on_navigation_starting(self, sender, args):
            uri = str(args.Uri)
            if not stays_in_app(uri):
                args.Cancel = True
                webbrowser.open(uri)

        # ── hors ligne / page en erreur ─────────────────────────────────
        def on_navigation_completed(self, sender, args):
            if args.IsSuccess:
                if str(self.core.Source).startswith(("http://", "https://")):
                    self.offline = False
                return
            status = args.WebErrorStatus
            if status == CoreWebView2WebErrorStatus.OperationCanceled:
                return
            log.warning(f"échec du chargement ({status}, HTTP {args.HttpStatusCode})")
            self.offline = True
            self.core.NavigateToString(offline_html(url))

        def on_process_failed(self, sender, args):
            kind = args.ProcessFailedKind
            log.error(f"processus WebView2 en échec : {kind}")
            if kind == CoreWebView2ProcessFailedKind.RenderProcessExited:
                # Écran noir / onglet planté : on recharge plutôt que de laisser une fenêtre vide.
                try:
                    self.core.Reload()
                except Exception:
                    log.exception("rechargement")
            elif kind == CoreWebView2ProcessFailedKind.BrowserProcessExited:
                WinForms.MessageBox.Show(
                    "Le moteur d'affichage de Nova Studio s'est arrêté.\nRelance Nova Studio.",
                    APP_NAME, WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error)
                self.allow_close = True
                self.form.Close()

        # ── menu contextuel : uniquement couper / copier / coller ───────
        KEEP_MENU = {"cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "undo", "redo",
                     "emoji", "spellCheck"}

        def on_context_menu(self, sender, args):
            if debug:
                return
            try:
                items = args.MenuItems
                for i in range(items.Count - 1, -1, -1):
                    name = str(items[i].Name)
                    if name not in self.KEEP_MENU and not name.startswith("spell"):
                        items.RemoveAt(i)
                # retire les séparateurs restés en tête / queue
                while items.Count and str(items[0].Name) == "other" and items[0].Kind.ToString() == "Separator":
                    items.RemoveAt(0)
                if items.Count == 0:
                    args.Handled = True
            except Exception:
                pass

        # ── fermeture : sauvegarde de la session avant de quitter ──────
        def eval_js(self, script: str, timeout: float):
            done = threading.Event()
            box = {}

            def cb(task):
                try:
                    box["r"] = task.Result
                except Exception as e:
                    box["e"] = e
                done.set()

            def start():
                try:
                    self.core.ExecuteScriptAsync(script).ContinueWith(Action[Task[String]](cb))
                except Exception as e:
                    box["e"] = e
                    done.set()

            self.form.BeginInvoke(Action(start))
            if not done.wait(timeout):
                raise TimeoutError("la page ne répond pas")
            if "e" in box:
                raise box["e"]
            return json.loads(str(box["r"])) if box.get("r") else None

        def _shutdown_block(self, on: bool):
            try:
                u32 = ctypes.windll.user32
                hwnd = wintypes.HWND(self.form.Handle.ToInt64())
                if on:
                    u32.ShutdownBlockReasonCreate(hwnd, ctypes.c_wchar_p("Sauvegarde de la session Nova Studio…"))
                else:
                    u32.ShutdownBlockReasonDestroy(hwnd)
            except Exception:
                pass

        def _save_then_close(self):
            t0 = time.time()
            try:
                status = self.eval_js(CLOSE_START_JS, 10)
                log.info(f"fermeture : __novaBeforeClose -> {status}")
                if status == "pending":
                    self.form.BeginInvoke(Action(lambda: setattr(self.form, "Text",
                                                                 f"{APP_NAME} — Sauvegarde de la session…")))
                    self.form.BeginInvoke(Action(lambda: self._shutdown_block(True)))
                    while time.time() - t0 < CLOSE_TIMEOUT_S:
                        time.sleep(0.25)
                        status = self.eval_js(CLOSE_POLL_JS, 10)
                        if status != "pending":
                            break
                    log.info(f"fermeture : sauvegarde terminée ({status}) en {time.time() - t0:.1f} s")
            except Exception as e:
                log.warning(f"fermeture : sauvegarde impossible ({e}), on ferme quand même")
            self.force_close()

        def force_close(self):
            self.allow_close = True
            try:
                self.form.BeginInvoke(Action(self.form.Close))
            except Exception:
                pass

        def on_closing(self, sender, args):
            if self.allow_close or self.core is None or self.offline:
                return
            args.Cancel = True
            if self.saving:
                r = WinForms.MessageBox.Show(
                    "La session est en cours de sauvegarde.\n\n"
                    "Quitter quand même ? La session risque de ne pas être entièrement sauvegardée.",
                    APP_NAME, WinForms.MessageBoxButtons.YesNo, WinForms.MessageBoxIcon.Warning,
                    WinForms.MessageBoxDefaultButton.Button2)
                if r == WinForms.DialogResult.Yes:
                    log.warning("fermeture forcée par l'utilisateur pendant la sauvegarde")
                    self.force_close()
                return
            self.saving = True
            threading.Thread(target=self._save_then_close, name="close", daemon=True).start()

    def ui_thread():
        try:
            _set_dpi_awareness()
            WinForms.Application.EnableVisualStyles()
            w = AppWindow()
            WinForms.Application.Run(w.form)
        except Exception:
            log.exception("fenêtre")

    t = Thread(ThreadStart(ui_thread))
    t.SetApartmentState(ApartmentState.STA)  # WebView2 exige un thread STA
    t.Start()
    t.Join()


# ─────────────────────────────────────────────────────────────────────────────
# Point d'entrée
# ─────────────────────────────────────────────────────────────────────────────

def _setup_app_logging() -> None:
    path = log_path("app.log")
    handler = RotatingFileHandler(path, maxBytes=2_000_000, backupCount=1, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    if sys.stderr is not None and not FROZEN:
        root.addHandler(logging.StreamHandler())


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) >= 2 and argv[0] == "--bridge":
        return run_bridge(argv[1])
    if argv and argv[0] == "--probe-vst3":
        # Pont VST : lecture des plugins (instrument ou effet ?) dans un processus enfant
        _bridge_import_path()
        import vst_probe
        vst_probe.child_main()
        return 0
    if argv and argv[0].lower().endswith("asio_control_panel.py"):
        return run_asio_control_panel(argv[1] if len(argv) > 1 else "")

    _setup_app_logging()
    url = os.environ.get("NOVA_DESKTOP_URL") or DEFAULT_URL
    for a in argv:
        if a.startswith("--url="):
            url = a[len("--url="):]
    log.info(f"===== Nova Studio {APP_VERSION} (pid {os.getpid()}) — {url}")

    if not acquire_single_instance():
        log.info("déjà ouvert : fenêtre existante ramenée au premier plan")
        return 0

    supervisor = None
    if os.environ.get("NOVA_DESKTOP_NO_BRIDGES") != "1":
        supervisor = BridgeSupervisor()
        supervisor.start()
    try:
        run_window(url)
    finally:
        if supervisor:
            supervisor.stop()
        log.info("Nova Studio fermé")
    return 0


if __name__ == "__main__":
    sys.exit(main())
