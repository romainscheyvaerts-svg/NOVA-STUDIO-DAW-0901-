# -*- coding: utf-8 -*-
"""
Nova Studio pour Windows.

Un seul exécutable, plusieurs rôles :
  NovaStudio.exe                      fenêtre WebView2 (Edge) avec le DAW embarqué (voir ui_bundle.py)
                                      + lance / surveille les deux ponts en processus enfants
  NovaStudio.exe --bridge asio        pont ASIO   (bridge-python/asio_bridge.py, ws://127.0.0.1:8766)
  NovaStudio.exe --bridge vst         pont VST3   (bridge-python/nova_bridge_server.py, ws://127.0.0.1:8765)
  NovaStudio.exe --probe-vst3         lecture des plugins VST3 pour le pont (bridge-python/vst_probe.py)
  NovaStudio.exe <...>asio_control_panel.py "<driver>"
                                      panneau ASIO (le pont ASIO relance sys.executable avec ce script)

Le DAW (site construit) est livré avec l'application et servi en local par WebView2 sous son
adresse habituelle (https://nova-studio-daw-0901-9kzo.vercel.app/) : démarrage sans réseau,
mêmes données (connexion, sessions locales) qu'avant. Seuls /api/* (assistant Nova), Supabase
(beats, comptes) et les paiements passent par Internet. Les nouvelles versions du site sont
téléchargées en arrière-plan et prises au démarrage suivant (ui_bundle.py).

Les ponts tournent dans des processus séparés : un plugin VST qui plante n'emporte pas la
fenêtre (et la session en cours) avec lui ; le superviseur le relance.

Variables d'environnement (tests / développement) :
  NOVA_DESKTOP_URL=http://localhost:5177/   page chargée depuis le réseau (pas d'interface embarquée)
  NOVA_DESKTOP_UI_DIR=...                   interface embarquée à utiliser (défaut : _internal/ui)
  NOVA_DESKTOP_NO_UPDATE=1                  pas de recherche de mise à jour de l'interface
  NOVA_DESKTOP_DEBUG=1                      outils de développement (F12), raccourcis navigateur
  NOVA_DESKTOP_CDP_PORT=9333                port de débogage distant (tests automatisés)
  NOVA_DESKTOP_DATA_DIR=...                 dossier de données (profil WebView2, journaux, interface)
  NOVA_DESKTOP_NO_BRIDGES=1                 ne lance pas les ponts
  NOVA_DESKTOP_EXTRA_ARGS="--flag"          arguments Chromium en plus (tests)
  NOVA_DESKTOP_CLOSE_TIMEOUT=90             délai max de sauvegarde à la fermeture (s)
  NOVA_DESKTOP_WINDOW=x,y,l,h               fenêtre placée là et non activée (tests : pas de vol du focus)
  NOVA_DESKTOP_UPDATE_DELAY=25              délai avant la 1re recherche de mise à jour (s)
  NOVA_DESKTOP_BOOT_TIMEOUT=40              délai max de démarrage du DAW avant retour à la version précédente (s)
"""
import ctypes
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from ctypes import wintypes
from logging.handlers import RotatingFileHandler
from urllib.parse import unquote, urlparse

T_START = time.perf_counter()

APP_NAME = "Nova Studio"
APP_VERSION = "1.1.2"
ASIO_PORT = 8766
VST_PORT = int(os.environ.get("NOVA_BRIDGE_PORT", "8765"))
CLOSE_TIMEOUT_S = float(os.environ.get("NOVA_DESKTOP_CLOSE_TIMEOUT", "90"))
MUTEX_NAME = "NovaStudioDesktopMutex"   # repris par l'installateur (AppMutex)
BG = (12, 13, 16)                       # #0c0d10, couleur de fond du DAW
# interface téléchargée qui ne monte pas -> version précédente
BOOT_TIMEOUT_S = float(os.environ.get("NOVA_DESKTOP_BOOT_TIMEOUT", "40"))
UPDATE_FIRST_DELAY_S = float(os.environ.get("NOVA_DESKTOP_UPDATE_DELAY", "25"))
UPDATE_EVERY_S = 6 * 3600

FROZEN = getattr(sys, "frozen", False)
HERE = os.path.dirname(os.path.abspath(__file__))
RES_DIR = getattr(sys, "_MEIPASS", HERE)
if not FROZEN:
    sys.path.insert(0, HERE)

import ui_bundle  # noqa: E402

DEFAULT_URL = ui_bundle.PROD_ORIGIN + "/"
log = logging.getLogger("NovaDesktop")


def since_start_ms() -> int:
    return int((time.perf_counter() - T_START) * 1000)


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


def bundled_ui_dir() -> str:
    return os.environ.get("NOVA_DESKTOP_UI_DIR") or (
        resource("ui") if FROZEN else os.path.join(HERE, "build", "ui-bundle"))


def self_command(*args: str) -> list:
    return [sys.executable, *args] if FROZEN else [sys.executable, os.path.abspath(__file__), *args]


def _rotate(path: str, max_bytes: int = 2_000_000) -> None:
    try:
        if os.path.getsize(path) > max_bytes:
            os.replace(path, path + ".1")
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Priorité et économie d'énergie (audio sans craquements sur les portables)
# ─────────────────────────────────────────────────────────────────────────────

ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000
CREATE_NO_WINDOW = 0x08000000
PROCESS_SET_INFORMATION = 0x0200
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ProcessPowerThrottling = 4
PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1
PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4


class _PowerThrottlingState(ctypes.Structure):
    _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]


_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.GetCurrentProcess.restype = wintypes.HANDLE
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_k32.GetPriorityClass.argtypes = [wintypes.HANDLE]
_k32.CloseHandle.argtypes = [wintypes.HANDLE]
try:
    _k32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
except AttributeError:  # Windows 7/8.0 : absent (non pris en charge de toute façon)
    pass


def tune_process(pid: "int | None" = None) -> str:
    """Priorité « supérieure à la normale » (jamais temps réel) et pas d'EcoQoS / de bridage
    des minuteurs par Windows quand la fenêtre est cachée ou sur batterie.
    Renvoie un petit compte rendu pour le journal."""
    own = pid is not None
    h = _k32.OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, False, pid) if own \
        else _k32.GetCurrentProcess()
    if not h:
        return f"accès refusé ({ctypes.get_last_error()})"
    try:
        prio = "prio+" if _k32.SetPriorityClass(h, ABOVE_NORMAL_PRIORITY_CLASS) else f"prio:{ctypes.get_last_error()}"
        st = _PowerThrottlingState(1, PROCESS_POWER_THROTTLING_EXECUTION_SPEED |
                                   PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, 0)
        try:
            ok = _k32.SetProcessInformation(h, ProcessPowerThrottling, ctypes.byref(st), ctypes.sizeof(st))
            eco = "sans EcoQoS" if ok else f"ecoqos:{ctypes.get_last_error()}"
        except AttributeError:
            eco = "ecoqos:n/a"
        return f"{prio}, {eco}"
    finally:
        if own:
            _k32.CloseHandle(h)


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
    print(f"processus : {tune_process()}")
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
            # aucune console visible ; priorité « supérieure à la normale » dès le départ
            creationflags=CREATE_NO_WINDOW | ABOVE_NORMAL_PRIORITY_CLASS,
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


def acquire_single_instance(wait_s: float = 0.0) -> bool:
    """Prend le verrou « une seule fenêtre ». wait_s > 0 : attend que l'instance précédente
    se ferme (relance après un arrêt du moteur d'affichage) au lieu de la ramener devant."""
    global _mutex
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.restype = wintypes.HANDLE
    end = time.time() + wait_s
    while True:
        _mutex = k32.CreateMutexW(None, False, MUTEX_NAME)
        if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
            return True
        if time.time() >= end:
            break
        k32.CloseHandle(wintypes.HANDLE(_mutex))
        time.sleep(0.25)
    # Déjà ouverte : on ramène la fenêtre existante au premier plan.
    u32 = ctypes.WinDLL("user32")
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
        ui: %(ui)s,
        bridges: Object.freeze({ asio: %(asio)d, vst: %(vst)d })
      }),
      configurable: false, enumerable: false, writable: false
    });
  } catch (e) {}
})();
"""

# Interface embarquée : pas de service worker (WebView2 sert déjà tout en local ; un ancien
# service worker resservirait sinon une vieille version du site en ligne).
NO_SW_JS = """
(function () {
  try {
    if (window.ServiceWorkerContainer) {
      ServiceWorkerContainer.prototype.register = function () {
        return Promise.reject(new DOMException('Service worker inutile dans Nova Studio pour Windows', 'NotSupportedError'));
      };
    }
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

BOOT_PROBE_JS = ("(function(){var r=document.getElementById('root');"
                 "return location.host + '|' + (r && r.children.length ? 'up' : 'down');})()")

# Bandeau discret : nouvelle version de l'interface prête (appliquée au prochain démarrage,
# ou tout de suite après sauvegarde de la session).
UPDATE_TOAST_JS = r"""
(function () {
  if (document.getElementById('nova-desktop-update')) return;
  var d = document.createElement('div');
  d.id = 'nova-desktop-update';
  d.setAttribute('role', 'status');
  d.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;max-width:340px;' +
    'background:rgba(12,13,16,.95);color:#e2e8f0;border:1px solid rgba(34,211,238,.5);border-radius:12px;' +
    'padding:12px 14px;font:500 13px/1.4 Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)';
  d.innerHTML = '<div style="margin-bottom:8px">Mise à jour de Nova Studio prête. Elle s’appliquera au prochain démarrage.</div>' +
    '<button type="button" data-a="now" style="margin-right:8px;padding:6px 12px;border:0;border-radius:8px;background:#22d3ee;color:#021014;font-weight:700;cursor:pointer">Redémarrer maintenant</button>' +
    '<button type="button" data-a="later" style="padding:6px 12px;border:1px solid #475569;border-radius:8px;background:transparent;color:#e2e8f0;cursor:pointer">Plus tard</button>';
  d.addEventListener('click', function (e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
    if (a === 'later') { d.remove(); }
    if (a === 'now') {
      d.firstChild.textContent = 'Sauvegarde de la session…';
      Array.prototype.forEach.call(d.querySelectorAll('button'), function (b) { b.disabled = true; });
      var f = window.__novaBeforeClose;
      Promise.resolve(typeof f === 'function' ? f() : null).catch(function () {}).then(function () {
        try { window.chrome.webview.postMessage('nova-desktop:apply-update'); } catch (err) {}
      });
    }
  });
  (document.body || document.documentElement).appendChild(d);
})();
"""

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


# Arguments Chromium : pas de ralentissement quand la fenêtre est cachée, en arrière-plan
# ou recouverte (timers, rendu, EcoQoS de Windows), lecture audio sans geste, fil de
# l'AudioWorklet en priorité temps réel audio. Rien qui fragilise (pas de --no-sandbox,
# --single-process, --disable-gpu, taille de tampon audio forcée…).
BROWSER_ARGS = [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ElasticOverscroll,"
    "UseEcoQoSForBackgroundProcess",
    "--enable-features=AudioWorkletThreadRealtimePriority",
]


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


class UiState:
    """Version de l'interface embarquée servie à la fenêtre (None = site en ligne)."""

    def __init__(self, url_mode: bool):
        self.active = self.bundled = None
        self.downloaded = []
        self.pending = None
        self.cache = ui_bundle.cache_root(data_dir())
        if url_mode:
            return
        t0 = time.perf_counter()
        self.active, self.bundled, self.downloaded = ui_bundle.choose(bundled_ui_dir(), self.cache, log.warning)
        if self.active is None:
            log.warning("aucune interface embarquée utilisable : chargement du site en ligne")
        else:
            log.info(f"interface {self.active} (livrée : {self.bundled}, téléchargées : {self.downloaded}) "
                     f"choisie en {(time.perf_counter() - t0) * 1000:.0f} ms")
            online = ui_bundle.read_state(self.cache).get("online")
            keep = {v.id for v in self.downloaded
                    if v is self.active or v.stamp >= self.active.stamp or v.id == online}
            threading.Thread(target=ui_bundle.prune, args=(self.cache, keep, log.info),
                             name="prune", daemon=True).start()


def run_window(url: str, url_mode: bool) -> None:
    wv2 = webview2_dir()
    os.environ["PATH"] = wv2 + os.pathsep + os.environ.get("PATH", "")
    import clr  # pythonnet (.NET Framework 4.x, présent sur tout Windows 10/11)
    clr.AddReference("System.Windows.Forms")
    clr.AddReference("System.Drawing")
    clr.AddReference(os.path.join(wv2, "Microsoft.Web.WebView2.Core.dll"))
    clr.AddReference(os.path.join(wv2, "Microsoft.Web.WebView2.WinForms.dll"))

    import System.Windows.Forms as WinForms
    from System import Action, String
    from System.Drawing import Color, Icon, Point, Size
    from System.IO import File, MemoryStream
    from System.Threading import ApartmentState, Thread, ThreadStart
    from System.Threading.Tasks import Task
    from Microsoft.Web.WebView2.Core import (
        CoreWebView2BrowsingDataKinds, CoreWebView2PermissionState, CoreWebView2ProcessFailedKind,
        CoreWebView2WebErrorStatus, CoreWebView2WebResourceContext, CoreWebView2WebResourceRequestSourceKinds)
    from Microsoft.Web.WebView2.WinForms import CoreWebView2CreationProperties, WebView2

    log.info(f"[{since_start_ms()} ms] .NET + SDK WebView2 chargés")
    debug = os.environ.get("NOVA_DESKTOP_DEBUG") == "1"
    no_update = os.environ.get("NOVA_DESKTOP_NO_UPDATE") == "1"
    app_host = (urlparse(url).hostname or "").lower()
    app_origin = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
    ui = UiState(url_mode)

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

    browser_args = " ".join(BROWSER_ARGS)
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
            self.boot_checked = False
            self.updater_started = False
            self.crashes = []
            self.tuned = set()
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
                    "Réinstalle Nova Studio (l'installateur l'ajoute tout seul, connexion Internet requise), "
                    "ou clique sur OK pour ouvrir la page Microsoft et installer « Evergreen Bootstrapper ».",
                    APP_NAME, WinForms.MessageBoxButtons.OKCancel, WinForms.MessageBoxIcon.Error)
                if r == WinForms.DialogResult.OK:
                    webbrowser.open("https://developer.microsoft.com/microsoft-edge/webview2/")
                self.allow_close = True
                self.form.Close()
                return
            core = self.core = self.web.CoreWebView2
            log.info(f"[{since_start_ms()} ms] WebView2 {core.Environment.BrowserVersionString} prêt")
            s = core.Settings
            s.UserAgent = f"{s.UserAgent} NovaStudioDesktop/{APP_VERSION}"
            s.AreDevToolsEnabled = debug
            # F5 / Ctrl+R / Alt+← / Ctrl+P… : un rechargement ou un « retour » par erreur
            # en pleine prise ferait perdre l'enregistrement en cours.
            s.AreBrowserAcceleratorKeysEnabled = debug
            s.IsStatusBarEnabled = False
            s.IsSwipeNavigationEnabled = False
            s.AreDefaultScriptDialogsEnabled = True
            core.PermissionRequested += self.on_permission
            core.NewWindowRequested += self.on_new_window
            core.NavigationStarting += self.on_navigation_starting
            core.NavigationCompleted += self.on_navigation_completed
            core.ProcessFailed += self.on_process_failed
            core.ContextMenuRequested += self.on_context_menu
            core.WebMessageReceived += self.on_web_message
            core.AddScriptToExecuteOnDocumentCreatedAsync(MARKER_JS % {
                "version": json.dumps(APP_VERSION), "asio": ASIO_PORT, "vst": VST_PORT,
                "ui": json.dumps(ui.active.id if ui.active else "online")})
            try:
                core.Environment.ProcessInfosChanged += lambda s_, e_: self.tune_webview_processes()
            except Exception:
                pass
            self.tune_webview_processes()
            if ui.active is None:
                log.info(f"chargement de {url} (en ligne)")
                core.Navigate(url)
                return
            core.AddScriptToExecuteOnDocumentCreatedAsync(NO_SW_JS)
            for pattern in [f"{app_origin}/*"] + [f"https://{h}/*" for h in ui_bundle.EXTERNAL_CSS_HOSTS]:
                try:  # page + workers (worklets, worker du pont VST)
                    core.AddWebResourceRequestedFilter(pattern, CoreWebView2WebResourceContext.All,
                                                       CoreWebView2WebResourceRequestSourceKinds.All)
                except Exception:  # runtime WebView2 ancien : page seulement
                    core.AddWebResourceRequestedFilter(pattern, CoreWebView2WebResourceContext.All)
            core.WebResourceRequested += self.on_resource

            # Un service worker installé par la version 1.0 (site en ligne) passerait avant
            # l'interface locale : on l'efface (sans toucher aux sessions ni à la connexion).
            def go(_task=None):
                self.form.BeginInvoke(Action(lambda: self.navigate_app("démarrage")))

            try:
                core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.ServiceWorkers).ContinueWith(
                    Action[Task](go))
                core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.CacheStorage)
            except Exception:
                log.exception("effacement du service worker")
                go()

        def navigate_app(self, why: str):
            log.info(f"[{since_start_ms()} ms] chargement de l'interface {ui.active.id if ui.active else 'en ligne'} ({why})")
            self.core.Navigate(url)

        def tune_webview_processes(self):
            try:
                infos = self.core.Environment.GetProcessInfos()
            except Exception:
                return
            done = []
            for i in range(infos.Count):
                info = infos[i]
                pid = int(info.ProcessId)
                if pid in self.tuned:
                    continue
                self.tuned.add(pid)
                done.append(f"{info.Kind}:{pid} {tune_process(pid)}")
            if done:
                log.info("processus WebView2 : " + " ; ".join(done))

        # ── interface embarquée : réponses servies depuis le disque ─────
        def on_resource(self, sender, args):
            try:
                v = ui.active
                if v is None:
                    return
                req = args.Request
                method = str(req.Method).upper()
                if method not in ("GET", "HEAD"):
                    return
                p = urlparse(str(req.Uri))
                host = (p.hostname or "").lower()
                if host == app_host:
                    rel = unquote(p.path).lstrip("/")
                    if rel.startswith("api/"):
                        return  # assistant Nova, etc. : Vercel, comme avant
                    if rel == "" or rel.endswith("/"):
                        rel += "index.html"
                    path = v.resolve(rel)
                    if path is None:
                        last = rel.rsplit("/", 1)[-1]
                        if "." not in last or args.ResourceContext == CoreWebView2WebResourceContext.Document:
                            rel, path = "index.html", v.resolve("index.html")  # même règle que vercel.json
                        else:
                            return  # fichier absent de cette version : réseau (site en ligne)
                elif host in ui_bundle.EXTERNAL_CSS_HOSTS:
                    rel = f"{ui_bundle.EXT_DIR}/{host}{unquote(p.path)}"
                    path = v.resolve(rel)
                    if path is None:
                        return
                else:
                    return
                if path is None:
                    return
                args.Response = self.file_response(path, rel, req, method == "HEAD")
            except Exception:
                log.exception("réponse locale")

        def file_response(self, path, rel, req, head_only):
            data = File.ReadAllBytes(path)
            total = data.Length
            headers = [f"Content-Type: {ui_bundle.mime_type(rel)}", "Cache-Control: no-cache",
                       "Access-Control-Allow-Origin: *", "Accept-Ranges: bytes",
                       f"X-Nova-Desktop-UI: {ui.active.id}"]
            status, reason, start, count = 200, "OK", 0, total
            try:
                rng = str(req.Headers.GetHeader("Range")) if req.Headers.Contains("Range") else ""
            except Exception:
                rng = ""
            m = re.match(r"^bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = min(int(m.group(2)) if m.group(2) else total - 1, total - 1)
                else:  # bytes=-N : les N derniers octets
                    start = max(0, total - int(m.group(2)))
                    end = total - 1
                if start >= total or end < start:
                    headers.append(f"Content-Range: bytes */{total}")
                    return self.core.Environment.CreateWebResourceResponse(
                        MemoryStream(), 416, "Range Not Satisfiable", "\r\n".join(headers))
                status, reason, count = 206, "Partial Content", end - start + 1
                headers.append(f"Content-Range: bytes {start}-{end}/{total}")
            headers.append(f"Content-Length: {count}")
            stream = MemoryStream() if head_only else MemoryStream(data, start, count, False)
            return self.core.Environment.CreateWebResourceResponse(stream, status, reason, "\r\n".join(headers))

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
                src = str(self.core.Source)
                if src.startswith(("http://", "https://")):
                    self.offline = False
                if not self.boot_checked and (urlparse(src).hostname or "").lower() == app_host:
                    self.boot_checked = True
                    log.info(f"[{since_start_ms()} ms] page chargée")
                    threading.Thread(target=self.watch_boot, name="boot", daemon=True).start()
                return
            status = args.WebErrorStatus
            if status == CoreWebView2WebErrorStatus.OperationCanceled:
                return
            log.warning(f"échec du chargement ({status}, HTTP {args.HttpStatusCode})")
            if ui.active is not None:
                return  # interface locale : rien à afficher de plus (erreur d'une sous-page)
            self.offline = True
            self.core.NavigateToString(offline_html(url))

        def watch_boot(self):
            """Le DAW a-t-il démarré (#root rempli) ? Sinon, on revient à la version précédente."""
            t0 = time.time()
            state = "?"
            while time.time() - t0 < BOOT_TIMEOUT_S and not self.allow_close:
                try:
                    state = self.eval_js(BOOT_PROBE_JS, 5) or "?"
                except Exception:
                    state = "?"
                if state.endswith("|up"):
                    log.info(f"[{since_start_ms()} ms] DAW démarré ({ui.active.id if ui.active else 'en ligne'})")
                    self.start_updater()
                    return
                time.sleep(0.2)
            if self.allow_close:
                return
            v = ui.active
            log.error(f"le DAW n'a pas démarré en {BOOT_TIMEOUT_S} s ({state}, interface {v.id if v else 'en ligne'})")
            if v is None or not state.startswith(app_host):
                return
            if v.kind == "downloaded":
                ui_bundle.mark_bad(v, "n'a pas démarré")
                ui.downloaded = [d for d in ui.downloaded if d is not v]
                ui.active = ui.bundled
                why = "retour à la version livrée"
            else:
                ui.active = None
                why = "retour au site en ligne"
            log.warning(why)
            self.boot_checked = False
            self.form.BeginInvoke(Action(lambda: self.navigate_app(why)))

        # ── mises à jour de l'interface ─────────────────────────────────
        def start_updater(self):
            if self.updater_started or no_update or ui.bundled is None:
                return
            self.updater_started = True
            threading.Thread(target=self.update_loop, name="ui-update", daemon=True).start()

        def update_loop(self):
            time.sleep(UPDATE_FIRST_DELAY_S)
            while not self.allow_close:
                try:
                    known = ui.downloaded + ([ui.pending] if ui.pending else [])
                    v = ui_bundle.check_for_update(ui_bundle.PROD_ORIGIN, data_dir(), ui.active, ui.bundled, known,
                                                   f"NovaStudioDesktop/{APP_VERSION}", log=log.info)
                    if v is not None and v is not ui.active and (ui.pending is None or v.id != ui.pending.id):
                        ui.pending = v
                        ui_bundle.prune(ui.cache, {v.id} | ({ui.active.id} if ui.active else set()), log.info)
                        self.form.BeginInvoke(Action(self.show_update_toast))
                except Exception as e:
                    log.warning(f"mise à jour de l'interface impossible pour l'instant : {e}")
                time.sleep(UPDATE_EVERY_S)

        def show_update_toast(self):
            try:
                self.core.ExecuteScriptAsync(UPDATE_TOAST_JS)
            except Exception:
                pass

        def on_web_message(self, sender, args):
            try:
                msg = str(args.TryGetWebMessageAsString())
            except Exception:
                return
            if msg == "nova-desktop:apply-update" and ui.pending is not None:
                log.info(f"mise à jour appliquée tout de suite : {ui.pending.id}")
                ui.active, ui.pending = ui.pending, None
                ui.downloaded.append(ui.active)
                self.boot_checked = False
                self.navigate_app("mise à jour")

        def on_process_failed(self, sender, args):
            kind = args.ProcessFailedKind
            log.error(f"processus WebView2 en échec : {kind} ({args.Reason}, code {args.ExitCode})")
            if kind == CoreWebView2ProcessFailedKind.RenderProcessExited:
                # Onglet planté : on recharge plutôt que de laisser une fenêtre vide.
                now = time.time()
                self.crashes = [t for t in self.crashes if now - t < 120] + [now]
                if len(self.crashes) >= 3 and ui.active is not None and ui.active.kind == "downloaded":
                    ui_bundle.mark_bad(ui.active, "plantages à répétition")
                    ui.active = ui.bundled
                    log.warning("plantages à répétition : retour à la version livrée")
                delay = 0 if len(self.crashes) < 3 else 5000  # pas de boucle effrénée
                self.boot_checked = False

                def reload():
                    try:
                        self.navigate_app("après plantage")
                    except Exception:
                        log.exception("rechargement")

                if delay:
                    t = WinForms.Timer()
                    t.Interval = delay

                    def tick(s, e):
                        t.Stop()
                        reload()

                    t.Tick += tick
                    t.Start()
                    self._crash_timer = t
                else:
                    reload()
            elif kind == CoreWebView2ProcessFailedKind.BrowserProcessExited:
                r = WinForms.MessageBox.Show(
                    "Le moteur d'affichage de Nova Studio s'est arrêté.\n\nRelancer Nova Studio ?",
                    APP_NAME, WinForms.MessageBoxButtons.YesNo, WinForms.MessageBoxIcon.Error)
                if r == WinForms.DialogResult.Yes:
                    try:
                        subprocess.Popen(self_command(f"--relaunch-after={os.getpid()}"), close_fds=True,
                                         creationflags=0x00000008)  # DETACHED_PROCESS
                    except Exception:
                        log.exception("relance")
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
            geom = os.environ.get("NOVA_DESKTOP_WINDOW")
            if geom:
                # tests : fenêtre posée à un endroit précis, affichée sans prendre le focus
                x, y, ww, hh = (int(n) for n in geom.split(","))
                w.form.WindowState = WinForms.FormWindowState.Normal
                w.form.StartPosition = WinForms.FormStartPosition.Manual
                w.form.Location = Point(x, y)
                w.form.Size = Size(ww, hh)
                ctx = WinForms.ApplicationContext()
                w.form.FormClosed += lambda s, e: ctx.ExitThread()
                ctypes.windll.user32.ShowWindow(wintypes.HWND(w.form.Handle.ToInt64()), 4)  # SW_SHOWNOACTIVATE
                WinForms.Application.Run(ctx)
            else:
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
    url = os.environ.get("NOVA_DESKTOP_URL") or ""
    relaunch = False
    for a in argv:
        if a.startswith("--url="):
            url = a[len("--url="):]
        if a.startswith("--relaunch-after="):
            relaunch = True
    url_mode = bool(url)
    url = url or DEFAULT_URL
    log.info(f"===== Nova Studio {APP_VERSION} (pid {os.getpid()}) — "
             f"{url if url_mode else 'interface embarquée, adresse ' + url}")
    log.info(f"processus : {tune_process()}")

    if not acquire_single_instance(wait_s=20 if relaunch else 0):
        log.info("déjà ouvert : fenêtre existante ramenée au premier plan")
        return 0

    supervisor = None
    if os.environ.get("NOVA_DESKTOP_NO_BRIDGES") != "1":
        supervisor = BridgeSupervisor()
        supervisor.start()
    try:
        run_window(url, url_mode)
    finally:
        if supervisor:
            supervisor.stop()
        log.info("Nova Studio fermé")
    return 0


if __name__ == "__main__":
    sys.exit(main())
