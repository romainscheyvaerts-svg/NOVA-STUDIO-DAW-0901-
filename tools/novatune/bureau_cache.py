#!/usr/bin/env python3
"""
Lance une commande sur un BUREAU WINDOWS INVISIBLE (CreateDesktop), puis attend sa fin.

Pourquoi : un plugin VST3 peut ouvrir une fenêtre (activation, licence, éditeur) au chargement.
Sur un bureau créé à part, aucune fenêtre ne peut apparaître à l'écran de l'utilisateur ; les
processus enfants (NovaVSTHost.exe lancé par le script) héritent de ce bureau. Le script mesuré
peut lister les fenêtres de SON bureau (EnumDesktopWindows) pour détecter un dialogue de licence
et tout arrêter (équivalent de « Quitter » : rien n'est jamais accepté).

Usage : python bureau_cache.py <journal.txt> <programme> [arguments…]
La sortie standard et d'erreur de la commande vont dans le journal.
"""
import ctypes
import os
import subprocess
import sys
from ctypes import wintypes

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
u32 = ctypes.WinDLL("user32", use_last_error=True)

DESKTOP_ALL = 0x01FF | 0x000F0000
CREATE_NO_WINDOW = 0x08000000
STARTF_USESTDHANDLES = 0x00000100
STARTF_USESHOWWINDOW = 0x00000001
HANDLE_FLAG_INHERIT = 0x1
INFINITE = 0xFFFFFFFF


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR),
                ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD), ("dwXCountChars", wintypes.DWORD),
                ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD), ("lpReserved2", ctypes.c_void_p),
                ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


u32.CreateDesktopW.restype = wintypes.HANDLE
u32.CreateDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
k32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
                               wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(STARTUPINFOW),
                               ctypes.POINTER(PROCESS_INFORMATION)]
k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    log_path, argv = sys.argv[1], sys.argv[2:]
    name = f"NovaMesure{os.getpid()}"
    desk = u32.CreateDesktopW(name, None, None, 0, DESKTOP_ALL, None)
    if not desk:
        print("CreateDesktop impossible", ctypes.get_last_error())
        return 3
    import msvcrt
    log = open(log_path, "wb")
    h = msvcrt.get_osfhandle(log.fileno())
    k32.SetHandleInformation(wintypes.HANDLE(h), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    si.lpDesktop = name
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    si.hStdInput = None
    si.hStdOutput = h
    si.hStdError = h
    pi = PROCESS_INFORMATION()
    cmd = subprocess.list2cmdline(argv)
    env = dict(os.environ)
    env["NOVA_BUREAU_CACHE"] = name
    block = "".join(f"{k}={v}\0" for k, v in env.items()) + "\0"
    CREATE_UNICODE_ENVIRONMENT = 0x00000400
    ok = k32.CreateProcessW(None, ctypes.create_unicode_buffer(cmd), None, None, True,
                            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, ctypes.create_unicode_buffer(block),
                            None, ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        print("CreateProcess impossible", ctypes.get_last_error())
        return 4
    k32.WaitForSingleObject(pi.hProcess, INFINITE)
    code = wintypes.DWORD(0)
    k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    k32.CloseHandle(pi.hProcess)
    k32.CloseHandle(pi.hThread)
    log.close()
    u32.CloseDesktop(desk)
    print(f"terminé, code {code.value}")
    return int(code.value)


if __name__ == "__main__":
    sys.exit(main())
