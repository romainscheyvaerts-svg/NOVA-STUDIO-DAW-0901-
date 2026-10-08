#!/usr/bin/env python3
"""
Plugins rangés dans un fichier VST3 « shell » (Waves : WaveShell1-VST3 17.1
contient 725 plugins : C6 Stereo, C6 Mono, SSL EV2 Channel Stereo…).

Le problème : pedalboard (JUCE 7) ne charge un plugin d'un fichier qu'après
avoir dressé la liste de TOUS ceux qu'il contient, en créant une instance de
chacun (findDescriptionsSlow). Pour WaveShell 17.1, plus de 10 minutes, à
chaque chargement : les plugins Waves étaient inutilisables sur le pont.

La solution : le temps d'un chargement, la « factory » VST3 du shell ne montre
QUE la classe voulue. Ses quatre fonctions d'inventaire (countClasses,
getClassInfo, getClassInfo2, getClassInfoUnicode) sont remplacées, dans sa
table virtuelle, par des relais Python qui laissent tout passer hors
chargement. JUCE voit alors un fichier à un seul plugin : ~1 s au lieu de
10 min. La création de l'instance (par CID) n'est pas touchée.

Limites :
  - Windows seulement (table virtuelle COM du SDK VST3) ;
  - un relais par fichier, posé une fois pour toute la vie du processus (le
    fichier reste chargé, comme JUCE le garde de toute façon) ;
  - les chargements passent tous par le thread JUCE (un à la fois) : la
    classe choisie est globale au fichier, protégée par un verrou.

Liste des plugins d'un shell : vst_probe.read_classes (lecture de la factory
dans un processus enfant, sans créer d'instance).
"""

import ctypes
import logging
import os
import platform
import re
import threading
from contextlib import contextmanager
from typing import Callable, Dict, List, Optional, Tuple

logger = logging.getLogger('NovaBridge.Shell')

IS_WINDOWS = platform.system() == "Windows"

# Index dans la table virtuelle (FUnknown 0-2, IPluginFactory 3-6,
# IPluginFactory2 7, IPluginFactory3 8-9).
COUNT_CLASSES = 4
GET_CLASS_INFO = 5
GET_CLASS_INFO2 = 7
GET_CLASS_INFO_UNICODE = 8

K_RESULT_OK = 0
K_INVALID_ARGUMENT = 2
PAGE_READWRITE = 0x04

_COUNT_T = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p) if IS_WINDOWS else None
_GET_T = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_void_p) if IS_WINDOWS else None
_QI_T = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)) if IS_WINDOWS else None


class _PClassInfo(ctypes.Structure):
    _fields_ = [("cid", ctypes.c_ubyte * 16), ("cardinality", ctypes.c_int32),
                ("category", ctypes.c_char * 32), ("name", ctypes.c_char * 64)]


def _iid(l1: int, l2: int, l3: int, l4: int):
    """INLINE_UID du SDK VST3 en mode COM (Windows)."""
    b = [l1 & 0xFF, (l1 >> 8) & 0xFF, (l1 >> 16) & 0xFF, (l1 >> 24) & 0xFF,
         (l2 >> 16) & 0xFF, (l2 >> 24) & 0xFF, l2 & 0xFF, (l2 >> 8) & 0xFF,
         (l3 >> 24) & 0xFF, (l3 >> 16) & 0xFF, (l3 >> 8) & 0xFF, l3 & 0xFF,
         (l4 >> 24) & 0xFF, (l4 >> 16) & 0xFF, (l4 >> 8) & 0xFF, l4 & 0xFF]
    return (ctypes.c_ubyte * 16)(*b)


IID_FACTORY2 = (0x0007B650, 0xF24B4C0B, 0xA464EDB9, 0xF00B2ABB)
IID_FACTORY3 = (0x4555A2AB, 0xC1234E57, 0x9B122910, 0x36878931)


def _compact(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def binary_of(path: str) -> Optional[str]:
    """Fichier binaire d'un plugin (ancien format : le .vst3 est un fichier ;
    format bundle : Contents\\x86_64-win\\*.vst3)."""
    if os.path.isfile(path):
        return path
    arch = os.path.join(path, "Contents", "x86_64-win")
    named = os.path.join(arch, os.path.basename(path))
    if os.path.isfile(named):
        return named
    try:
        found = [f for f in os.listdir(arch) if f.lower().endswith(".vst3")]
    except OSError:
        return None
    return os.path.join(arch, found[0]) if len(found) == 1 else None


class ShellFactory:
    """Relais posé sur la factory VST3 d'un fichier : `select(index)` limite
    l'inventaire à une classe ; hors sélection, tout passe tel quel."""

    def __init__(self, factory_ptr: int):
        if not IS_WINDOWS:
            raise OSError("Shells VST3 : Windows seulement")
        self.ptr = int(factory_ptr)
        self.selected: Optional[int] = None
        self.lock = threading.RLock()
        self._keep: list = []          # relais ctypes gardés en vie
        self._patched: Dict[int, Dict[int, int]] = {}   # table → {index: ancienne fonction}
        vt = self._vtable(self.ptr)
        self._count = _COUNT_T(self._slot(vt, COUNT_CLASSES))
        self._get = _GET_T(self._slot(vt, GET_CLASS_INFO))
        # Interfaces 2 et 3 : souvent le même objet (même table), parfois non.
        self.f2 = self._query(IID_FACTORY2)
        self.f3 = self._query(IID_FACTORY3)
        self._get2 = _GET_T(self._slot(self._vtable(self.f2), GET_CLASS_INFO2)) if self.f2 else None
        self._getw = _GET_T(self._slot(self._vtable(self.f3), GET_CLASS_INFO_UNICODE)) if self.f3 else None
        self.classes: List[Tuple[int, str]] = self._audio_classes()
        self._install()

    # --- lecture brute ----------------------------------------------------

    @staticmethod
    def _vtable(obj: int) -> int:
        return ctypes.cast(obj, ctypes.POINTER(ctypes.c_void_p))[0]

    @staticmethod
    def _slot(vtable: int, idx: int) -> int:
        return ctypes.cast(vtable, ctypes.POINTER(ctypes.c_void_p))[idx]

    def _query(self, iid4) -> Optional[int]:
        qi = _QI_T(self._slot(self._vtable(self.ptr), 0))
        out = ctypes.c_void_p()
        iid = _iid(*iid4)
        try:
            if qi(self.ptr, ctypes.addressof(iid), ctypes.byref(out)) == K_RESULT_OK and out.value:
                return int(out.value)  # référence gardée : la factory vit autant que le processus
        except Exception:
            pass
        return None

    def _audio_classes(self) -> List[Tuple[int, str]]:
        out = []
        n = int(self._count(self.ptr))
        for i in range(max(0, min(n, 8192))):
            ci = _PClassInfo()
            if self._get(self.ptr, i, ctypes.byref(ci)) != K_RESULT_OK:
                continue
            if ci.category.decode("utf-8", "replace").strip() == "Audio Module Class":
                out.append((i, ci.name.decode("utf-8", "replace").strip()))
        return out

    # --- relais -------------------------------------------------------------

    def _map(self, i: int) -> int:
        """Index vu par l'hôte → index réel (-1 : hors liste)."""
        sel = self.selected
        if sel is None:
            return i
        return sel if i == 0 else -1

    def _install(self):
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.VirtualProtect.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
        k32.VirtualProtect.restype = ctypes.c_int

        def count(this):
            try:
                return 1 if self.selected is not None else self._count(this)
            except Exception:
                return 0

        def relay(orig):
            def fn(this, i, info):
                try:
                    j = self._map(int(i))
                    return K_INVALID_ARGUMENT if j < 0 else orig(this, j, info)
                except Exception:
                    return K_INVALID_ARGUMENT
            return fn

        plan: Dict[int, Dict[int, object]] = {}
        vt1 = self._vtable(self.ptr)
        plan.setdefault(vt1, {})[COUNT_CLASSES] = _COUNT_T(count)
        plan[vt1][GET_CLASS_INFO] = _GET_T(relay(self._get))
        if self.f2 and self._get2 is not None:
            plan.setdefault(self._vtable(self.f2), {})[GET_CLASS_INFO2] = _GET_T(relay(self._get2))
        if self.f3 and self._getw is not None:
            plan.setdefault(self._vtable(self.f3), {})[GET_CLASS_INFO_UNICODE] = _GET_T(relay(self._getw))
        for vt, slots in plan.items():
            size = (max(slots) + 1) * ctypes.sizeof(ctypes.c_void_p)
            old = ctypes.c_uint32()
            if not k32.VirtualProtect(vt, size, PAGE_READWRITE, ctypes.byref(old)):
                raise OSError(f"VirtualProtect refusé ({ctypes.get_last_error()})")
            try:
                table = ctypes.cast(vt, ctypes.POINTER(ctypes.c_void_p))
                saved = self._patched.setdefault(vt, {})
                for idx, cb in slots.items():
                    saved[idx] = table[idx]
                    table[idx] = ctypes.cast(cb, ctypes.c_void_p).value
                    self._keep.append(cb)
            finally:
                k32.VirtualProtect(vt, size, old.value, ctypes.byref(old))

    # --- sélection -------------------------------------------------------------

    def index_of(self, name: str) -> Optional[int]:
        for i, n in self.classes:
            if n == name:
                return i
        want = _compact(name)
        for i, n in self.classes:
            if _compact(n) == want:
                return i
        return None

    @contextmanager
    def only(self, name: str):
        """Le temps du bloc, l'inventaire de la factory ne montre que `name`."""
        idx = self.index_of(name)
        if idx is None:
            raise KeyError(f"« {name} » n'est pas dans ce fichier")
        with self.lock:
            self.selected = idx
            try:
                yield idx
            finally:
                self.selected = None


_shells: Dict[str, ShellFactory] = {}
_lock = threading.Lock()


def _open_factory(binary: str) -> int:
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.LoadLibraryExW.restype = ctypes.c_void_p
    k32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD]
    k32.GetProcAddress.restype = ctypes.c_void_p
    k32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    h = k32.LoadLibraryExW(binary, None, 0x00000008)  # LOAD_WITH_ALTERED_SEARCH_PATH (comme JUCE)
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
    return int(fac)


def shell_for(path: str) -> Optional[ShellFactory]:
    """Relais du fichier (posé au premier appel). None : pas un shell (une
    seule classe audio) ou lecture impossible."""
    if not IS_WINDOWS:
        return None
    binary = binary_of(path)
    if not binary:
        return None
    key = os.path.normcase(os.path.abspath(binary))
    with _lock:
        if key in _shells:
            return _shells[key]
        try:
            sh = ShellFactory(_open_factory(binary))
        except Exception as e:
            logger.warning(f"Shell VST3 illisible ({os.path.basename(binary)}) : {e}")
            sh = None
        if sh is not None and len(sh.classes) <= 1:
            sh = None  # fichier ordinaire : rien à restreindre (le relais reste inactif)
        if sh is not None:
            logger.info(f"🧩 Shell VST3 : {os.path.basename(binary)} ({len(sh.classes)} plugins)")
        _shells[key] = sh
        return sh


def load_from_shell(path: str, plugin_name: str, loader: Callable[[str, Optional[str]], object]):
    """Charge `plugin_name` d'un fichier shell : loader(binaire, nom) appelé
    pendant que la factory ne montre que ce plugin. None : pas un shell."""
    sh = shell_for(path)
    if sh is None:
        return None
    binary = binary_of(path)
    with sh.only(plugin_name):
        return loader(binary, plugin_name)


# ─────────────────────────────────────────────────────────────────────────────
# Liste envoyée à NOVA : une entrée par plugin d'un shell
# ─────────────────────────────────────────────────────────────────────────────

_CHANNEL_SUFFIX = re.compile(r"\s+(mono/stereo|stereo|mono|m/s)$", re.I)


def channels_of(name: str) -> Optional[str]:
    """« C6 Stereo » → stereo, « C6 Mono » → mono, « RVerb Mono/Stereo » → mono/stereo."""
    m = _CHANNEL_SUFFIX.search(name or "")
    if not m:
        return None
    v = m.group(1).lower()
    return "mono/stereo" if v in ("mono/stereo", "m/s") else v


def family_of(name: str) -> str:
    """« C6 Stereo » → « C6 » (nom sans variante mono / stéréo)."""
    return _CHANNEL_SUFFIX.sub("", name or "").strip()
