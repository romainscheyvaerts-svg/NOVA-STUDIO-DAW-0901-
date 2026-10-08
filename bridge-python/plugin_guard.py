#!/usr/bin/env python3
"""
Garde du pont : un plugin qui plante ne fait plus tomber le pont.

Constaté le 08/10/2026 : RUBY2 (Acustica) fait une violation d'accès dans
pedalboard (lecture du texte d'un réglage, get_text_for_raw_value) dès son
chargement : le processus du pont mourait, avec toutes les pistes en cours.

Deux mécanismes, localisés ici (vst_host.instantiate appelle check() puis
loading() ; le serveur appelle startup() et dispatche --trial-load) :

1. Témoin de chargement. Avant chaque création d'instance DANS le pont, la clé
   du plugin est écrite dans plugin_guard.json (« en cours ») ; elle est
   effacée juste après (réussite ou erreur Python). Si le pont meurt pendant
   le chargement (plantage natif), le témoin reste : au démarrage suivant, ce
   plugin passe « à risque ».

2. Essai isolé. Un plugin à risque (témoin resté, liste de départ SEED_RISKY,
   ou NOVA_BRIDGE_TRIAL=all) est d'abord chargé dans un processus jetable (le
   pont relancé avec --trial-load, sans fenêtre), avec un délai de garde. Il y
   suit la même séquence que dans le pont : chargement, préparation (stéréo,
   ou mono pour une variante mono), lecture de tous les réglages en texte,
   état. S'il plante ou ne répond pas : « plugin instable sur le pont », noté
   (jusqu'à sa mise à jour : empreinte du binaire), refusé avec un message
   clair, et le pont continue. S'il passe : chargé normalement dans le pont,
   et noté « essai réussi » (pas de nouvel essai tant qu'il ne change pas).

Fichier : %LOCALAPPDATA%\\NovaStudio\\plugin_guard.json (NOVA_GUARD_FILE pour
les tests). NOVA_BRIDGE_TRIAL : « off » (rien), « risky » (défaut), « all ».
"""

import json
import logging
import os
import platform
import re
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger('NovaBridge.Guard')

MARK = "@@NOVA-TRIAL@@"
TRIAL_TIMEOUT_S = float(os.environ.get("NOVA_GUARD_TIMEOUT") or 90)

# Plugins connus pour faire planter pedalboard (essai isolé dès la 1re fois) ;
# le nom compact du plugin COMMENCE par l'une de ces entrées (RUBY2, RUBY2ZL).
SEED_RISKY = {"ruby2"}

# Script relancé en enfant (le serveur le renseigne ; exécutable figé : sys.executable).
MAIN_SCRIPT: Optional[str] = None


class PluginUnstable(RuntimeError):
    """Le plugin plante ou bloque le pont : refusé, le pont continue."""


def _compact(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def key_of(path: str, plugin_name: Optional[str]) -> str:
    return f"{os.path.normcase(os.path.abspath(path))}#{plugin_name or ''}"


def display_name(path: str, plugin_name: Optional[str]) -> str:
    if plugin_name:
        return plugin_name
    base = os.path.basename(path.rstrip("\\/"))
    return base[:-5] if base.lower().endswith(".vst3") else base


def _fingerprint(path: str) -> Optional[List[float]]:
    """Empreinte du binaire : un plugin mis à jour est essayé de nouveau."""
    try:
        import vst_shell
        b = vst_shell.binary_of(path) or path
        st = os.stat(b)
        return [round(st.st_mtime, 3), float(st.st_size)]
    except OSError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Fichier d'état
# ─────────────────────────────────────────────────────────────────────────────

_lock = threading.RLock()


def guard_file() -> str:
    env = os.environ.get("NOVA_GUARD_FILE")
    if env:
        return env
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "NovaStudio", "plugin_guard.json")


def _load() -> dict:
    try:
        with open(guard_file(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            for k in ("unstable", "risky", "trusted", "pending"):
                if not isinstance(d.get(k), dict):
                    d[k] = {}
            return d
    except Exception:
        pass
    return {"v": 1, "unstable": {}, "risky": {}, "trusted": {}, "pending": {}}


def _save(d: dict):
    path = guard_file()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        for _ in range(5):  # Windows : os.replace refusé si un autre lecteur tient le fichier
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(0.05)
        os.replace(tmp, path)
    except Exception as e:
        logger.debug(f"plugin_guard.json non écrit : {e}")


def status(path: str, plugin_name: Optional[str]) -> Optional[dict]:
    """Fiche « instable » d'un plugin (None : rien à signaler)."""
    with _lock:
        hit = _load()["unstable"].get(key_of(path, plugin_name))
    if hit and hit.get("fp") not in (None, _fingerprint(path)):
        return None  # plugin mis à jour depuis : on lui redonne sa chance
    return hit


def unstable_keys() -> Dict[str, dict]:
    with _lock:
        return dict(_load()["unstable"])


def startup():
    """Au lancement du pont : un témoin resté = le pont est mort pendant ce
    chargement → plugin « à risque » (essai isolé la prochaine fois)."""
    with _lock:
        d = _load()
        pending = d.get("pending") or {}
        if not pending:
            return []
        out = []
        for k, info in pending.items():
            d["risky"][k] = {"name": info.get("name"), "reason": "le pont s'est arrêté pendant son chargement",
                             "at": info.get("at"), "fp": info.get("fp")}
            d["trusted"].pop(k, None)
            out.append(info.get("name") or k)
        d["pending"] = {}
        _save(d)
    for n in out:
        logger.warning(f"⚠️ {n} : le pont s'est arrêté pendant son chargement la dernière fois → essai isolé au prochain chargement")
    return out


def forget(path: Optional[str] = None, plugin_name: Optional[str] = None):
    """Oublie un plugin (ou tous) : il sera de nouveau chargé normalement."""
    with _lock:
        d = _load()
        if path is None:
            d["unstable"], d["risky"], d["trusted"] = {}, {}, {}
        else:
            k = key_of(path, plugin_name)
            for sec in ("unstable", "risky", "trusted"):
                d[sec].pop(k, None)
        _save(d)


def retry_unstable():
    """« Chercher à nouveau » : les plugins instables seront ré-essayés (en
    processus jetable : ils redeviennent « à risque », jamais chargés à l'aveugle)."""
    with _lock:
        d = _load()
        if not d["unstable"]:
            return
        for k, v in d["unstable"].items():
            d["risky"][k] = {**v, "reason": f"instable auparavant ({v.get('reason')})"}
        d["unstable"] = {}
        _save(d)


@contextmanager
def loading(path: str, plugin_name: Optional[str]):
    """Témoin posé pendant une création d'instance dans le pont."""
    k = key_of(path, plugin_name)
    with _lock:
        d = _load()
        d["pending"][k] = {"name": display_name(path, plugin_name), "pid": os.getpid(), "at": time.time(),
                           "fp": _fingerprint(path)}
        _save(d)
    try:
        yield
    finally:
        with _lock:
            d = _load()
            d["pending"].pop(k, None)
            _save(d)


def _mode() -> str:
    m = (os.environ.get("NOVA_BRIDGE_TRIAL") or "risky").strip().lower()
    return m if m in ("off", "risky", "all") else "risky"


def is_risky(path: str, plugin_name: Optional[str]) -> bool:
    if _mode() == "off":
        return False
    k = key_of(path, plugin_name)
    fp = _fingerprint(path)
    with _lock:
        d = _load()
    trusted = d["trusted"].get(k)
    if trusted and trusted.get("fp") == fp:
        return False
    if _mode() == "all":
        return True
    if k in d["risky"]:
        return True
    # Variantes du même plugin (RUBY2ZL, version « zéro latence » de RUBY2) : même risque.
    name = _compact(display_name(path, plugin_name))
    return any(name.startswith(seed) for seed in SEED_RISKY)


def check(path: str, plugin_name: Optional[str], timeout: Optional[float] = None):
    """Avant un chargement dans le pont. Lève PluginUnstable si le plugin est
    connu instable, ou si son essai isolé plante / bloque."""
    if _mode() == "off":
        return
    name = display_name(path, plugin_name)
    hit = status(path, plugin_name)
    if hit:
        raise PluginUnstable(f"{name} : plugin instable sur le pont ({hit.get('reason') or 'plantage'}). "
                             f"Il n'est pas chargé ; le reste continue.")
    if not is_risky(path, plugin_name):
        return
    logger.info(f"🧪 Essai isolé de {name} (plugin à risque)…")
    st, detail = run_trial(path, plugin_name, timeout or TRIAL_TIMEOUT_S)
    k = key_of(path, plugin_name)
    with _lock:
        d = _load()
        if st in ("crash", "hang"):
            reason = "il fait planter le chargement" if st == "crash" else f"il ne répond pas en {int(timeout or TRIAL_TIMEOUT_S)} s"
            d["unstable"][k] = {"name": name, "reason": reason, "detail": (detail or "")[:300], "at": time.time(),
                                "fp": _fingerprint(path)}
            d["trusted"].pop(k, None)
            _save(d)
        elif st == "ok":
            d["trusted"][k] = {"name": name, "at": time.time(), "fp": _fingerprint(path)}
            d["risky"].pop(k, None)
            _save(d)
    if st in ("crash", "hang"):
        logger.warning(f"🧯 {name} : plugin instable sur le pont ({st}) : isolé, le pont continue")
        raise PluginUnstable(f"{name} : plugin instable sur le pont ({'plantage' if st == 'crash' else 'blocage'} "
                             f"pendant son essai isolé). Il n'est pas chargé ; le reste continue.")
    logger.info(f"🧪 {name} : essai isolé {st}{f' ({detail})' if detail else ''}")


# ─────────────────────────────────────────────────────────────────────────────
# Essai dans un processus jetable
# ─────────────────────────────────────────────────────────────────────────────

def _child_command() -> List[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--trial-load"]
    return [sys.executable, MAIN_SCRIPT or os.path.abspath(sys.argv[0]), "--trial-load"]


def _kill_tree(proc: "subprocess.Popen"):
    try:
        import license_watch as lw
        pids = lw.descendants(proc.pid)
    except Exception:
        pids = {proc.pid}
    for pid in sorted(pids, key=lambda p: p == proc.pid):
        try:
            if pid == proc.pid:
                proc.kill()
            else:
                os.kill(pid, 9)
        except Exception:
            pass
    try:
        proc.wait(timeout=3)
    except Exception:
        pass


def run_trial(path: str, plugin_name: Optional[str], timeout: float = TRIAL_TIMEOUT_S,
              command: Optional[List[str]] = None) -> Tuple[str, str]:
    """Essai de chargement isolé : (« ok » | « crash » | « hang » | « error » |
    « activation », détail). Seuls « crash » et « hang » rendent un plugin instable."""
    cmd = list(command or _child_command())
    flags = 0x08000000 | 0x00004000 if platform.system() == "Windows" else 0  # sans fenêtre, priorité basse
    job = json.dumps({"path": path, "plugin_name": plugin_name})
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                creationflags=flags)
    except Exception as e:
        return "error", f"essai impossible : {e}"
    result: Dict[str, object] = {}
    err_tail: List[str] = []

    def reader():
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace")
            k = line.find(MARK)
            if k >= 0:
                try:
                    result.update(json.loads(line[k + len(MARK):]))
                except Exception:
                    pass

    def err_reader():
        for raw in iter(proc.stderr.readline, b""):
            err_tail.append(raw.decode("utf-8", "replace").rstrip())
            del err_tail[:-12]

    th = threading.Thread(target=reader, daemon=True)
    th2 = threading.Thread(target=err_reader, daemon=True)
    th.start()
    th2.start()
    try:
        proc.stdin.write(job.encode("utf-8"))
        proc.stdin.close()
    except Exception:
        pass
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        for stream in (proc.stdout, proc.stderr):
            try:
                stream.close()
            except Exception:
                pass
        if result.get("ok"):
            return "ok", f"{result.get('params', 0)} réglages"
        return ("activation", str(result.get("dialog"))) if result.get("dialog") else ("hang", "délai dépassé")
    th.join(2)
    th2.join(2)
    for stream in (proc.stdout, proc.stderr):
        try:
            stream.close()
        except Exception:
            pass
    if result.get("ok"):
        return "ok", f"{result.get('params', 0)} réglages"
    if result.get("dialog"):
        return "activation", str(result.get("dialog"))
    if result.get("error"):
        return "error", str(result.get("error"))
    tail = " | ".join(x for x in err_tail if x.strip())[-300:]
    return "crash", f"code {code}{f' : {tail}' if tail else ''}"


def _hide_dialogs(emit):
    """(Enfant) Fenêtre de licence / d'activation : cachée, signalée (personne
    ne peut s'en servir dans ce processus jetable)."""
    try:
        import license_watch as lw
    except Exception:
        return
    me = os.getpid()
    base = set(lw.windows_of(lw.descendants(me)))
    seen = set()
    while True:
        time.sleep(0.2)
        try:
            wins = lw.windows_of(lw.descendants(me))
        except Exception:
            continue
        for h, info in wins.items():
            if h in base or h in seen:
                continue
            seen.add(h)
            lw.hide_window(h)
            emit({"dialog": info.get("title") or info.get("cls")})


def trial_child_main():
    """Point d'entrée de l'enfant (--trial-load) : même séquence que le pont."""
    import ctypes
    try:
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)  # pas de boîte d'erreur système
    except Exception:
        pass
    out = sys.stdout
    lock = threading.Lock()

    def emit(obj):
        with lock:
            out.write("\n" + MARK + json.dumps(obj, ensure_ascii=False) + "\n")
            out.flush()

    try:
        job = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        emit({"error": f"demande illisible : {e}"})
        os._exit(2)
    threading.Thread(target=_hide_dialogs, args=(emit,), daemon=True).start()
    try:
        import numpy as np
        import vst_host
        plugin = vst_host._open_plugin(job["path"], job.get("plugin_name"))
        try:
            plugin.process(np.zeros((2, 128), np.float32), 48000, buffer_size=128, reset=False)
        except ValueError as e:
            if "channel" not in str(e).lower():
                raise
            plugin.process(np.zeros((1, 128), np.float32), 48000, buffer_size=128, reset=False)
        plugin.reset()
        n = 0
        for key, p in (getattr(plugin, "parameters", {}) or {}).items():
            vst_host.param_info(key, p)
            n += 1
        vst_host._get_state(plugin)
        emit({"ok": True, "params": n})
    except BaseException as e:  # noqa: BLE001 - erreur Python : pas un plantage
        emit({"error": str(e)[:300]})
    os._exit(0)
