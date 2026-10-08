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

Fenêtres de licence : certains plugins (Slate, Harrison…) ouvrent une fenêtre
« Software Activation » dès le chargement de la DLL. Dans l'enfant, elle est
cachée aussitôt et le plugin est noté « activation » (jamais relu tout seul) :
c'est un chargement explicite depuis Nova qui l'ouvre, au premier plan.
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
from typing import Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger('NovaBridge.Probe')

MARK = "@@NOVA@@"
PER_PLUGIN_TIMEOUT_S = 15.0
FIRST_TIMEOUT_S = 40.0      # démarrage de l'enfant (exécutable PyInstaller) + 1er plugin
WORKERS = 6
CACHE_VERSION = 2

# Une classe : (nom, sous-catégories[, éditeur]), ex. ("Vital", "Instrument|Synth", "Matt Tytel")
Classes = List[Tuple[str, ...]]
# Un shell Waves contient 725 plugins (WaveShell1-VST3 17.1) : l'ancienne
# limite (512) coupait la liste ; un cache à 512 classes pile est relu.
MAX_CLASSES = 4096
OLD_CLASS_CAP = 512


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
    vendor = ""
    try:
        class _PFactoryInfo(ctypes.Structure):
            _fields_ = [("vendor", ctypes.c_char * 64), ("url", ctypes.c_char * 256),
                        ("email", ctypes.c_char * 128), ("flags", ctypes.c_int32)]
        fi = _PFactoryInfo()
        if _vcall(fac, 3, ctypes.c_int32, [ctypes.POINTER(_PFactoryInfo)], ctypes.byref(fi)) == 0:
            vendor = _txt(fi.vendor)
    except Exception:
        pass
    for i in range(max(0, min(int(count), MAX_CLASSES))):
        if has2:
            ci = _PClassInfo2()
            if _vcall(f2.value, 7, ctypes.c_int32, [ctypes.c_int32, ctypes.POINTER(_PClassInfo2)], i, ctypes.byref(ci)) != 0:
                continue
            sub = _txt(ci.subCategories)
            cls_vendor = _txt(ci.vendor) or vendor
        else:
            ci = _PClassInfo()
            if _vcall(fac, 5, ctypes.c_int32, [ctypes.c_int32, ctypes.POINTER(_PClassInfo)], i, ctypes.byref(ci)) != 0:
                continue
            sub = ""
            cls_vendor = vendor
        if _txt(ci.category) == "Audio Module Class":
            out.append((_txt(ci.name), sub, cls_vendor))
    # Pas de FreeLibrary : certains plugins plantent en se déchargeant ; l'enfant
    # est de toute façon fermé à la fin (os._exit).
    return out


def _dialog_watch(state: dict, emit: Callable[[dict], None]):
    """(Enfant) Une fenêtre (activation, licence, enregistrement…) apparaît
    pendant la lecture d'un plugin : elle est cachée tout de suite (personne ne
    peut s'en servir dans ce processus jetable) et signalée au pont."""
    import license_watch as lw
    me = os.getpid()
    base = set(lw.windows_of(lw.descendants(me)))
    while True:
        time.sleep(0.2)
        i = state.get("i")
        if i is None:
            continue
        try:
            wins = lw.windows_of(lw.descendants(me))
        except Exception:
            continue
        for h, info in wins.items():
            if h in base or h in state["seen"]:
                continue
            state["seen"].add(h)
            lw.hide_window(h)
            emit({"i": i, "dialog": info["title"] or info["cls"]})


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
    lock = threading.Lock()

    def emit(obj):
        with lock:
            out.write("\n" + MARK + json.dumps(obj) + "\n")
            out.flush()

    paths = [line.strip() for line in inp.read().splitlines() if line.strip()]
    state: dict = {"i": None, "seen": set()}
    threading.Thread(target=_dialog_watch, args=(state, emit), daemon=True).start()
    for i, p in enumerate(paths):
        state["i"] = i
        emit({"i": i, "start": True})
        try:
            emit({"i": i, "classes": read_classes(p)})
        except BaseException as e:  # noqa: BLE001
            emit({"i": i, "error": str(e)[:200]})
    state["i"] = None
    emit({"end": True})
    os._exit(0)


# ─────────────────────────────────────────────────────────────────────────────
# PONT : lancement de l'enfant, cache
# ─────────────────────────────────────────────────────────────────────────────
#
# Résultat d'une lecture : {"c": classes | None, "st": statut, "t": titre}
#   ok          classes lues
#   error       binaire illisible (pas de factory, chargement refusé…)
#   activation  le plugin a ouvert une fenêtre (activation de licence,
#               enregistrement…) : fenêtre cachée, plugin pas relu
#               automatiquement ; un chargement explicite depuis Nova l'ouvre
#               au premier plan (voir license_watch)
#   hang        ne répond pas, sans fenêtre visible
#   crash       l'enfant s'est arrêté sur ce plugin
# Seuls « ok » et « error » sont définitifs ; les autres sont relus au
# « Chercher à nouveau » (rescan) ou quand le plugin est mis à jour.

Probe = Dict[str, object]
_live_procs: Set[int] = set()


def probe_pids() -> Set[int]:
    """Processus de lecture en cours (et leurs descendants) : leurs fenêtres ne
    sont pas celles d'un chargement explicite."""
    import license_watch as lw
    out: Set[int] = set()
    for pid in list(_live_procs):
        out |= lw.descendants(pid)
    return out


def _kill_tree(proc: "subprocess.Popen"):
    """L'enfant ET les programmes qu'un plugin a lancés (aide de licence) :
    sinon leur fenêtre restait ouverte après l'arrêt de l'enfant."""
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
    # Laisse au programme d'aide de licence le temps de disparaître : un enfant
    # suivant qui s'y connectait encore s'arrêtait net.
    time.sleep(0.3)
    _live_procs.discard(proc.pid)


def _cache_path() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "NovaStudio", "vst3_classes.json")


def _load_cache() -> Dict[str, dict]:
    try:
        with open(_cache_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("items")
        if not isinstance(items, dict):
            return {}
        if data.get("v") == CACHE_VERSION:
            return items
        if data.get("v") == 1:
            # v1 : les plugins sans réponse étaient en fait souvent des fenêtres
            # d'activation : on les relit, le reste est gardé.
            return {k: {**v, "st": "ok"} for k, v in items.items() if isinstance(v.get("c"), list)}
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


_cache_lock = threading.Lock()


def record_loaded(path: str, plugin_name: Optional[str], is_instrument: bool):
    """Plugin chargé sans souci par le pont (licence active) : le cache ne le
    garde plus comme « activation ». Sa catégorie vient de pedalboard."""
    fp = _fingerprint(path)
    if fp is None:
        return
    with _cache_lock:
        cache = _load_cache()
        hit = cache.get(path)
        if hit and (hit.get("st") == "ok" or (isinstance(hit.get("c"), list) and len(hit["c"]) > 1)):
            return  # déjà lu (un shell garde sa liste complète)
        name = plugin_name or os.path.basename(path)[:-5]
        cache[path] = {"m": fp[0], "s": fp[1], "st": "ok",
                       "c": [[name, "Instrument" if is_instrument else "Fx"]]}
        _save_cache(cache)


def forget_unsettled():
    """« Chercher à nouveau » : plugins en attente d'activation / sans réponse relus."""
    with _cache_lock:
        cache = _load_cache()
        kept = {k: v for k, v in cache.items() if v.get("st") in ("ok", "error")}
        if len(kept) != len(cache):
            _save_cache(kept)


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


def _run_child(cmd: List[str], paths: List[str], results: Dict[str, Probe],
               on_done: Callable[[], None]):
    """Lit les plugins dans des enfants successifs (relancés après un plantage,
    un blocage ou une fenêtre d'activation)."""
    import license_watch as lw
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
        _live_procs.add(proc.pid)
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
        dialog: Optional[str] = None
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
            if "dialog" in msg:
                # Fenêtre d'activation : pas un blocage, on arrête ce plugin là.
                cur, dialog = i, str(msg.get("dialog") or "")
                break
            if msg.get("start"):
                cur = i
            else:
                ok = "classes" in msg
                results[remaining[i]] = {"c": [tuple(c) for c in msg["classes"]] if ok else None,
                                         "st": "ok" if ok else "error"}
                cur = None
                done = i + 1
                on_done()
            deadline = time.time() + PER_PLUGIN_TIMEOUT_S
        if cur is not None and dialog is None and not finished:
            # Sans réponse : une fenêtre (même cachée) du plugin ou de son aide ?
            try:
                wins = lw.windows_of(lw.descendants(proc.pid), visible_only=False)
                titled = [w["title"] for w in wins.values() if w["title"]]
                if titled:
                    dialog = titled[0]
            except Exception:
                pass
        _kill_tree(proc)
        if finished:
            return
        if cur is not None:
            name = os.path.basename(remaining[cur])
            if dialog is not None:
                logger.info(f"   🔑 {name} demande une activation (« {dialog} ») : à charger une fois depuis Nova")
                results[remaining[cur]] = {"c": None, "st": "activation", "t": dialog[:200]}
            elif q.empty() and proc.poll() is not None and time.time() < deadline:
                results[remaining[cur]] = {"c": None, "st": "crash"}
            else:
                logger.info(f"   (plugin ignoré : {name} ne répond pas à la lecture)")
                results[remaining[cur]] = {"c": None, "st": "hang"}
            on_done()
            remaining = remaining[cur + 1:]
            stalls = 0
        else:
            remaining = remaining[done:]
            stalls = 0 if done else stalls + 1
            if stalls >= 2 and remaining:
                results[remaining[0]] = {"c": None, "st": "crash"}
                on_done()
                remaining = remaining[1:]
                stalls = 0


def apply_classes(plugins: List[dict], results: Dict[str, Probe]) -> List[dict]:
    """Inventaire complété : is_instrument / category des plugins lus, et
    scan_status / license (activation demandée) des autres. Un fichier à
    plusieurs plugins (« shell » : WaveShell de Waves, 725 plugins) est
    remplacé par une entrée par plugin (plugin_name = nom de la classe,
    chargé par vst_shell), effets ET instruments : « C6 Stereo », « C6 Mono »…
    Chaque entrée porte `shell` (nom du fichier), `family` (« C6 ») et
    `channels` (mono / stereo / mono/stereo, d'après le nom)."""
    import vst_shell
    out: List[dict] = []
    seen = {(p["name"].lower(), (p.get("vendor") or "").lower()) for p in plugins}
    for e in plugins:
        r = results.get(e["path"]) if e.get("is_instrument") is None else None
        if not r:
            out.append(e)
            continue
        classes = r.get("c")
        st = r.get("st")
        e = {**e, "scan_status": st}
        if st == "activation":
            e["license"] = "activation"
            e["license_title"] = r.get("t")
        if not classes:
            out.append(e)
            continue
        if len(classes) == 1:
            instr = is_instrument_subcats(classes[0][1])
            out.append({**e, "is_instrument": instr, "category": "Instrument" if instr else "Effect",
                        "sub_categories": [s for s in classes[0][1].split("|") if s]})
            continue
        shell = os.path.basename(e["path"])
        if shell.lower().endswith(".vst3"):
            shell = shell[:-5]
        for c in classes:
            name, sub = c[0], c[1]
            vendor = (c[2] if len(c) > 2 else "") or e.get("vendor") or ""
            key = (name.lower(), vendor.lower())
            if not name or key in seen:
                continue  # même plugin dans un autre shell (versions Waves) : le premier gagne
            seen.add(key)
            instr = is_instrument_subcats(sub)
            item = {**e, "name": name, "vendor": vendor, "uid": "", "id": f"path:{e['path']}#{name}",
                    "category": "Instrument" if instr else "Effect", "is_instrument": instr,
                    "sub_categories": [s for s in sub.split("|") if s], "plugin_name": name,
                    "shell": shell, "family": vst_shell.family_of(name)}
            ch = vst_shell.channels_of(name)
            if ch:
                item["channels"] = ch
            out.append(item)
    out.sort(key=lambda p: (p["category"] != "Effect", p["name"].lower()))
    return out


def probe_bundles(bundles: List[str], main_script: Optional[str] = None,
                  on_progress: Optional[Callable[[int, int], None]] = None) -> Dict[str, Probe]:
    """Lecture des plugins donnés (cache d'abord, puis processus enfants)."""
    if platform.system() != "Windows":
        return {}
    with _cache_lock:
        cache = _load_cache()
    results: Dict[str, Probe] = {}
    todo: List[str] = []
    prints: Dict[str, Tuple[float, int]] = {}
    for b in bundles:
        fp = _fingerprint(b)
        if fp is None:
            continue
        prints[b] = fp
        hit = cache.get(b)
        if hit and isinstance(hit.get("c"), list) and len(hit["c"]) == OLD_CLASS_CAP:
            hit = None  # liste coupée par l'ancienne limite : relue
        if hit and hit.get("m") == fp[0] and hit.get("s") == fp[1]:
            c = hit.get("c")
            results[b] = {"c": [tuple(x) for x in c] if isinstance(c, list) else None,
                          "st": hit.get("st") or ("ok" if isinstance(c, list) else "hang"), "t": hit.get("t")}
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
        fresh: Dict[str, Probe] = {}
        lock = threading.Lock()

        def flush():
            with _cache_lock:
                disk = _load_cache()
                for b, r in list(fresh.items()):
                    fp = prints[b]
                    c = r.get("c")
                    disk[b] = {"m": fp[0], "s": fp[1], "st": r.get("st"), "t": r.get("t"),
                               "c": [list(x) for x in c] if c is not None else None}
                _save_cache(disk)

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
        # Arrêts / blocages : relus un par un. En parallèle, un même programme
        # d'aide de licence (partagé par les plugins d'un éditeur) pouvait
        # appartenir à un autre enfant : la fenêtre n'était pas vue, ou l'enfant
        # s'arrêtait quand l'autre était fermé.
        for _ in range(2 if workers > 1 else 0):
            again = [b for b in todo if (fresh.get(b) or {}).get("st") in ("crash", "hang")]
            if not again:
                break
            second: Dict[str, Probe] = {}
            _run_child(_child_command(main_script), again, second, lambda: None)
            fresh.update(second)
        results.update(fresh)
        with lock:
            flush()
        n_act = sum(1 for r in fresh.values() if r.get("st") == "activation")
        logger.info(f"🔎 Lecture terminée ({len(fresh)}/{total} en {time.time() - t:.0f} s"
                    + (f", {n_act} demandent une activation" if n_act else "") + ")")
    return results
