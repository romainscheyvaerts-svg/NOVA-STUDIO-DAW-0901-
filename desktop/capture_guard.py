# -*- coding: utf-8 -*-
"""
Anti-enregistrement d'écran de l'appli Windows Nova Studio (protège les instrus et mélodies
du catalogue NON achetées ; règle de Romain : pas de tag audio).

 1. La fenêtre est exclue des captures : SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
    (Windows 10 2004 et plus : invisible dans OBS, les captures, les partages d'écran ;
    plus ancien : WDA_MONITOR, la fenêtre apparaît noire).
 2. Un logiciel d'enregistrement ouvert (OBS, Bandicam, ShareX, Barre de jeu Xbox en
    enregistrement…) est signalé au DAW (window.__novaCaptureGuard), qui coupe la lecture
    des instrus non achetées et le dit à l'utilisateur. Les admins du studio sont exemptés
    (le DAW envoie « nova-desktop:capture-protect:off »).

Module séparé de nova_desktop.py pour être testé seul (desktop/test/test_capture_guard.py),
sans lancer l'appli ni toucher aux ports des ponts.
"""
import ctypes
import sys

WDA_NONE, WDA_MONITOR, WDA_EXCLUDEFROMCAPTURE = 0x0, 0x1, 0x11

# Nom de l'exécutable (minuscules) → nom affiché à l'utilisateur.
RECORDERS = {
    "obs64.exe": "OBS Studio", "obs32.exe": "OBS Studio", "obs.exe": "OBS Studio",
    "streamlabs obs.exe": "Streamlabs", "streamlabs desktop.exe": "Streamlabs",
    "bdcam.exe": "Bandicam", "bandicam.exe": "Bandicam",
    "camtasiastudio.exe": "Camtasia", "camrecorder.exe": "Camtasia",
    "sharex.exe": "ShareX", "fraps.exe": "Fraps", "action_x64.exe": "Mirillis Action",
    "xsplit.core.exe": "XSplit", "screenrec.exe": "ScreenRec", "apowerrec.exe": "ApowerREC",
    "fbrecorder.exe": "FlashBack", "debut.exe": "Debut", "icecreamscreenrecorder.exe": "Icecream Recorder",
    "screenpresso.exe": "Screenpresso", "loom.exe": "Loom", "medal.exe": "Medal",
    "snagitcapture.exe": "Snagit", "screencast-o-matic.exe": "Screencast-O-Matic",
    "vokoscreenng.exe": "vokoscreen", "kazam.exe": "Kazam", "movavi screen recorder.exe": "Movavi",
    # Barre de jeu Xbox : le service d'enregistrement (bcastdvr) ne tourne que pendant une
    # capture vidéo ou quand « Enregistrer ce qui s'est passé » est activé.
    "bcastdvr.exe": "Barre de jeu Xbox (enregistrement)",
}


def match_recorders(exe_names) -> list:
    """Noms affichés des logiciels d'enregistrement parmi des noms d'exécutables (triés, sans doublon)."""
    found = set()
    for n in exe_names or []:
        name = RECORDERS.get(str(n).strip().lower())
        if name:
            found.add(name)
    return sorted(found)


def running_exe_names() -> list:
    """Noms des exécutables en cours (instantané des processus, sans psutil). Hors Windows : []."""
    if sys.platform != "win32":
        return []
    from ctypes import wintypes
    TH32CS_SNAPPROCESS = 0x2

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return []
    names = []
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            names.append(e.szExeFile)
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return names


def running_recorders() -> list:
    """Logiciels d'enregistrement ouverts en ce moment."""
    return match_recorders(running_exe_names())


def set_exclude_from_capture(hwnd: int, on: bool) -> str:
    """
    Fenêtre exclue des captures (on) ou capturable (off). Renvoie le mode appliqué :
    « exclue », « noire » (Windows trop ancien), « normale » ou « erreur:<code> ».
    """
    if sys.platform != "win32":
        return "erreur:hors-windows"
    from ctypes import wintypes
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    u32.SetWindowDisplayAffinity.argtypes = [wintypes.HWND, wintypes.DWORD]
    u32.SetWindowDisplayAffinity.restype = wintypes.BOOL
    h = wintypes.HWND(int(hwnd))
    if not on:
        return "normale" if u32.SetWindowDisplayAffinity(h, WDA_NONE) else f"erreur:{ctypes.get_last_error()}"
    if u32.SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE):
        return "exclue"
    if u32.SetWindowDisplayAffinity(h, WDA_MONITOR):
        return "noire"
    return f"erreur:{ctypes.get_last_error()}"


def display_affinity(hwnd: int) -> int:
    """Mode actuel de la fenêtre (WDA_*), -1 si illisible."""
    if sys.platform != "win32":
        return -1
    from ctypes import wintypes
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    u32.GetWindowDisplayAffinity.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    v = wintypes.DWORD(0)
    return int(v.value) if u32.GetWindowDisplayAffinity(wintypes.HWND(int(hwnd)), ctypes.byref(v)) else -1


def guard_script(recorders) -> str:
    """Script envoyé au DAW (ExecuteScriptAsync) : la liste des logiciels détectés."""
    import json
    return f"window.__novaCaptureGuard && window.__novaCaptureGuard({json.dumps(list(recorders or []), ensure_ascii=False)})"
