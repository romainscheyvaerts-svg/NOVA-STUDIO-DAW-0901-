#!/usr/bin/env python3
"""
Instruments ou effets ? Lecture des classes d'un plugin VST3 sans l'instancier.

La plupart des plugins n'ont pas de moduleinfo.json (Vital, Omnisphere,
Kontakt…) : le scan les classait tous en « effet ». On charge alors la DLL du
plugin et on lit sa « factory » VST3 (IPluginFactory2::getClassInfo2 :
sous-catégories « Instrument|Synth », « Fx|EQ »…), sans créer d'instance ni
ouvrir de fenêtre : ~10 ms par plugin en général.

Une DLL peut planter ou rester bloquée au chargement (protection, service
absent…) : la lecture se fait dans un processus enfant (le pont relancé avec
--probe-vst3), avec un délai par plugin. Résultats gardés en cache
(%LOCALAPPDATA%/NovaStudio/vst3_classes.json) : seuls les plugins nouveaux ou
mis à jour sont relus au lancement suivant.
"""

import ctypes
import json
import logging
import os
import platform
import queue
import subprocess
import sys
import threading
import time
from typing import Callable, Dict, List, Optional, Tuple

logger = logging.getLogger('NovaBridge.Probe')

MARK = "@@NOVA@@"
PER_PLUGIN_TIMEOUT_S = 15.0
FIRST_TIMEOUT_S = 40.0      # démarrage de l'enfant (exécutable PyInstaller) + 1er plugin
WORKERS = 6
CACHE_VERSION = 1

# Une classe : (nom, sous-catégories), ex. ("Vital", "Instrument|Synth")
Classes = List[Tuple[str, str]]


def is_instrument_subcats(sub: str) -> bool:
    return any(s.strip().lower().startswith("instrument") for s in (sub or "").split("|"))


def dll_of(bundle: str) -> Optional[str]:
    """Binaire Windows 64 bits d'un plugin (bundle .vst3 ou ancien fichier unique)."""
    if os.path.isfile(bundle):
        return bundle
    d = os.path.join(bundle, "Contents", "x86_64-win")
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.lower().endswith(".vst3") and os.path.isfile(os.path.join(d, f)):
                return os.path.join(d, f)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# PROCESSUS ENFANT : lecture des factories
# ─────────────────────────────────────────────────────────────────────────────

def _uid(l1: int, l2: int, l3: int, l4: int):
    """INLINE_UID du SDK VST3 en mode COM (Windows)."""
    b = [l1 & 0xFF, (l1 >> 8) & 0xFF, (l1 >> 16) & 0xFF, (l1 >> 24) & 0xFF,
         (l2 >> 16) & 0xFF, (l2 >> 24) & 0xFF, l2 & 0xFF, (l2 >> 8) & 0xFF,
         (l3 >> 24) & 0xFF, (l3 >> 16) & 0xFF, (l3 >> 8) & 0xFF, l3 & 0xFF,
         (l4 >> 24) & 0xFF, (l4 >> 16) & 0xFF, (l4 >> 8) & 0xFF, l4 & 0xFF]
    return (ctypes.c_ubyte * 16)(*b)


class _PClassInfo(ctypes.Structure):
    _fields_ = [("cid", ctypes.c_ubyte * 16), ("cardinality", ctypes.c_int32),
                ("category", ctypes.c_char * 32), ("name", ctypes.c_char * 64)]


class _PClassInfo2(ctypes.Structure):
    _fields_ = [("cid", ctypes.c_ubyte * 16), ("cardinality", ctypes.c_int32),
                ("category", ctypes.c_char * 32), ("name", ctypes.c_char * 64),
                ("classFlags", ctypes.c_uint32), ("subCategories", ctypes.c_char * 128),
                ("vendor", ctypes.c_char * 64), ("version", ctypes.c_char * 64),
                ("sdkVersion", ctypes.c_char * 64)]


def _vcall(obj: int, idx: int, restype, argtypes, *args):
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vtbl[idx])(obj, *args)


def _txt(b: bytes) -> str:
    return b.decode("utf-8", "replace").strip()


def read_classes(bundle: str) -> Classes:
    """(Enfant) Classes audio d'un plugin. Lève une exception si illisible."""
    from ctypes import wintypes
    dll = dll_of(bundle)
    if not dll:
        raise FileNotFoundError("binaire introuvable")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.LoadLibraryExW.restype = ctypes.c_void_p
    k32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD]
    k32.GetProcAddress.restype = ctypes.c_void_p
    k32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    h = k32.LoadLibraryExW(dll, None, 0x00000008)  # LOAD_WITH_ALTERED_SEARCH_PATH
    if not h:
        raise OSError(f"chargement impossible ({ctypes.get_last_error()})")
    init = k32.GetProcAddress(h, b"InitDll")
    if init:
        ctypes.WINFUNCTYPE(ctypes.c_bool)(init)()
    gpf = k32.GetProcAddress(h, b"GetPluginFactory")
    if not gpf:
        raise OSError("pas de GetPluginFactory")
    fac = ctypes.WINFUNCTYPE(ctypes.c_void_p)(gpf)()
    if not fac:
        raise OSError("factory vide")
    count = _vcall(fac, 4, ctypes.c_int32, [])
    f2 = ctypes.c_void_p()
    iid = _uid(0x0007B650, 0xF24B4C0B, 0xA464EDB9, 0xF00B2ABB)  # IPluginFactory2
    has2 = _vcall(fac, 0, ctypes.c_int32, [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                  ctypes.addressof(iid), ctypes.byref(f2)) == 0 and bool(f2.value)
    out: Classes = []
    for i in range(max(0, min(int(count), 512))):
        if has2:
            ci = _PClassInfo2()
            if _vcall(f2.value, 7, ctypes.c_int32, [ctypes.c_int32, ctypes.POINTER(_PClassInfo2)], i, ctypes.byref(ci)) != 0:
                continue
            sub = _txt(ci.subCategories)
        else:
            ci = _PClassInfo()
            if _vcall(fac, 5, ctypes.c_int32, [ctypes.c_int32, ctypes.POINTER(_PClassInfo)], i, ctypes.byref(ci)) != 0:
                continue
            sub = ""
        if _txt(ci.category) == "Audio Module Class":
            out.append((_txt(ci.name), sub))
    # Pas de FreeLibrary : certains plugins plantent en se déchargeant ; l'enfant
    # est de toute façon fermé à la fin (os._exit).
    return out


def child_main():
    """Point d'entrée de l'enfant : chemins lus sur stdin, une ligne JSON par
    résultat sur stdout (préfixée : les plugins écrivent aussi sur stdout)."""
    try:
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)  # pas de boîte « DLL manquante »
    except Exception:
        pass
    out, inp = sys.stdout, sys.stdin
    if out is None or inp is None:
        # Exécutable sans console (Nova Studio pour Windows) : sys.stdout / stdin
        # valent None, mais les tubes du parent sont bien là (handles Win32).
        import msvcrt
        k32 = ctypes.windll.kernel32
        k32.GetStdHandle.restype = ctypes.c_void_p
        if out is None:
            out = os.fdopen(msvcrt.open_osfhandle(k32.GetStdHandle(-11), os.O_WRONLY), "w", encoding="utf-8")
        if inp is None:
            inp = os.fdopen(msvcrt.open_osfhandle(k32.GetStdHandle(-10), os.O_RDONLY), "r", encoding="utf-8")

    def emit(obj):
        out.write("\n" + MARK + json.dumps(obj) + "\n")
        out.flush()

    paths = [line.strip() for line in inp.read().splitlines() if line.strip()]
    for i, p in enumerate(paths):
        emit({"i": i, "start": True})
        try:
            emit({"i": i, "classes": read_classes(p)})
        except BaseException as e:  # noqa: BLE001
            emit({"i": i, "error": str(e)[:200]})
    emit({"end": True})
    os._exit(0)


# ─────────────────────────────────────────────────────────────────────────────
# PONT : lancement de l'enfant, cache
# ─────────────────────────────────────────────────────────────────────────────

def _cache_path() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "NovaStudio", "vst3_classes.json")


def _load_cache() -> Dict[str, dict]:
    try:
        with open(_cache_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("v") == CACHE_VERSION and isinstance(data.get("items"), dict):
            return data["items"]
    except Exception:
        pass
    return {}


def _save_cache(items: Dict[str, dict]):
    try:
        path = _cache_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": CACHE_VERSION, "items": items}, f)
        os.replace(tmp, path)
    except Exception as e:
        logger.debug(f"cache non écrit : {e}")


def _fingerprint(bundle: str) -> Optional[Tuple[float, int]]:
    dll = dll_of(bundle)
    if not dll:
        return None
    try:
        st = os.stat(dll)
        return (round(st.st_mtime, 3), st.st_size)
    except OSError:
        return None


def _child_command(main_script: Optional[str]) -> List[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--probe-vst3"]
    return [sys.executable, main_script or os.path.abspath(sys.argv[0]), "--probe-vst3"]


def _run_child(cmd: List[str], paths: List[str], results: Dict[str, Optional[Classes]],
               on_done: Callable[[], None]):
    """Lit les plugins dans des enfants successifs (relancés après un plantage
    ou un blocage). results[path] = classes, ou None si illisible."""
    remaining = list(paths)
    stalls = 0
    while remaining:
        flags = 0
        if platform.system() == "Windows":
            flags = 0x08000000 | 0x00004000  # CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, creationflags=flags)
        except Exception as e:
            logger.warning(f"Lecture des instruments impossible : {e}")
            return
        q: "queue.Queue" = queue.Queue()

        def reader(stream=proc.stdout):
            for raw in iter(stream.readline, b""):
                line = raw.decode("utf-8", "replace")
                k = line.find(MARK)
                if k >= 0:
                    try:
                        q.put(json.loads(line[k + len(MARK):]))
                    except Exception:
                        pass
            q.put(None)  # fin du flux (sortie ou plantage)

        threading.Thread(target=reader, daemon=True).start()
        try:
            proc.stdin.write(("\n".join(remaining) + "\n").encode("utf-8"))
            proc.stdin.close()
        except Exception:
            pass
        cur: Optional[int] = None
        done = 0
        finished = False
        deadline = time.time() + FIRST_TIMEOUT_S
        while True:
            try:
                msg = q.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                break  # bloqué
            if msg is None:
                break
            if msg.get("end"):
                finished = True
                break
            i = int(msg.get("i", -1))
            if not 0 <= i < len(remaining):
                continue
            if msg.get("start"):
                cur = i
            else:
                results[remaining[i]] = [tuple(c) for c in msg["classes"]] if "classes" in msg else None
                cur = None
                done = i + 1
                on_done()
            deadline = time.time() + PER_PLUGIN_TIMEOUT_S
        try:
            proc.kill()
        except Exception:
            pass
        if finished:
            return
        if cur is not None:
            logger.info(f"   (plugin ignoré : {os.path.basename(remaining[cur])} ne répond pas à la lecture)")
            results[remaining[cur]] = None
            on_done()
            remaining = remaining[cur + 1:]
            stalls = 0
        else:
            remaining = remaining[done:]
            stalls = 0 if done else stalls + 1
            if stalls >= 2 and remaining:
                results[remaining[0]] = None
                on_done()
                remaining = remaining[1:]
                stalls = 0


def apply_classes(plugins: List[dict], results: Dict[str, Optional[Classes]]) -> List[dict]:
    """Inventaire complété : is_instrument / category des plugins lus. Un bundle
    à plusieurs plugins garde son entrée (effet) et gagne une entrée par
    instrument (plugin_name)."""
    out: List[dict] = []
    seen = {(p["name"].lower(), (p.get("vendor") or "").lower()) for p in plugins}
    for e in plugins:
        classes = results.get(e["path"]) if e.get("is_instrument") is None else None
        if not classes:
            out.append(e)
            continue
        if len(classes) == 1:
            instr = is_instrument_subcats(classes[0][1])
            out.append({**e, "is_instrument": instr, "category": "Instrument" if instr else "Effect",
                        "sub_categories": [s for s in classes[0][1].split("|") if s]})
            continue
        out.append({**e, "is_instrument": False})
        for name, sub in classes:
            key = (name.lower(), (e.get("vendor") or "").lower())
            if not is_instrument_subcats(sub) or key in seen:
                continue
            seen.add(key)
            out.append({**e, "name": name, "uid": "", "id": f"path:{e['path']}#{name}", "category": "Instrument",
                        "is_instrument": True, "sub_categories": [s for s in sub.split("|") if s], "plugin_name": name})
    out.sort(key=lambda p: (p["category"] != "Effect", p["name"].lower()))
    return out


def probe_bundles(bundles: List[str], main_script: Optional[str] = None,
                  on_progress: Optional[Callable[[int, int], None]] = None) -> Dict[str, Optional[Classes]]:
    """Classes des plugins donnés (cache d'abord, puis processus enfant)."""
    if platform.system() != "Windows":
        return {}
    cache = _load_cache()
    results: Dict[str, Optional[Classes]] = {}
    todo: List[str] = []
    prints: Dict[str, Tuple[float, int]] = {}
    for b in bundles:
        fp = _fingerprint(b)
        if fp is None:
            continue
        prints[b] = fp
        hit = cache.get(b)
        if hit and hit.get("m") == fp[0] and hit.get("s") == fp[1]:
            c = hit.get("c")
            results[b] = [tuple(x) for x in c] if isinstance(c, list) else None
        else:
            todo.append(b)
    total = len(todo)
    counter = [0]

    def on_done():
        counter[0] += 1
        if on_progress:
            on_progress(counter[0], total)

    if todo:
        logger.info(f"🔎 Recherche des instruments : {total} plugins à lire (une seule fois)…")
        t = time.time()
        fresh: Dict[str, Optional[Classes]] = {}
        lock = threading.Lock()

        def flush():
            for b, c in list(fresh.items()):
                fp = prints[b]
                cache[b] = {"m": fp[0], "s": fp[1], "c": [list(x) for x in c] if c is not None else None}
            _save_cache(cache)

        def done_and_save():
            with lock:
                on_done()
                if counter[0] % 40 == 0:
                    flush()  # progression gardée si le pont est fermé pendant la lecture

        # Certains plugins bloquent au chargement (licence, service absent…) :
        # plusieurs enfants en parallèle pour que ces attentes se chevauchent.
        workers = max(1, min(WORKERS, len(todo)))
        threads = [threading.Thread(target=_run_child, args=(_child_command(main_script), todo[k::workers], fresh, done_and_save),
                                    daemon=True) for k in range(workers)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        results.update(fresh)
        with lock:
            flush()
        logger.info(f"🔎 Lecture terminée ({len(fresh)}/{total} en {time.time() - t:.0f} s)")
    return results
