#!/usr/bin/env python3
"""
Script autonome pour ouvrir le panneau de configuration ASIO

Exécuté dans un processus séparé pour isoler le contexte COM et
fournir un message pump Windows nécessaire au dialogue ASIO.

Usage:
    python asio_control_panel.py "FL Studio ASIO"
"""

import sys
import ctypes
from ctypes import wintypes
import time
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger('ASIOPanel')

# Windows API constants
WS_OVERLAPPED = 0x00000000
WS_POPUP = 0x80000000
CW_USEDEFAULT = 0x80000000
WM_QUIT = 0x0012
PM_REMOVE = 0x0001
SW_HIDE = 0
CLSCTX_INPROC_SERVER = 1

# Windows API structures
class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HICON),
    ]

class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", wintypes.POINT),
    ]

class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8)
    ]


def parse_guid(clsid_str: str) -> GUID:
    """Parser une chaîne CLSID en structure GUID"""
    clsid_clean = clsid_str.strip('{}')
    parts = clsid_clean.split('-')
    guid = GUID()
    guid.Data1 = int(parts[0], 16)
    guid.Data2 = int(parts[1], 16)
    guid.Data3 = int(parts[2], 16)
    data4_hex = parts[3] + parts[4]
    for i in range(8):
        guid.Data4[i] = int(data4_hex[i*2:i*2+2], 16)
    return guid


def find_driver_clsid(driver_name: str) -> str:
    """Trouver le CLSID d'un driver ASIO dans le registre"""
    import winreg
    
    for reg_path in [r"SOFTWARE\ASIO", r"SOFTWARE\WOW6432Node\ASIO"]:
        try:
            asio_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, reg_path, 0, winreg.KEY_READ)
            try:
                driver_key = winreg.OpenKey(asio_key, driver_name)
                clsid, _ = winreg.QueryValueEx(driver_key, "CLSID")
                winreg.CloseKey(driver_key)
                winreg.CloseKey(asio_key)
                return clsid
            except:
                pass
            winreg.CloseKey(asio_key)
        except:
            continue
    return None


def create_hidden_window() -> int:
    """Créer une fenêtre cachée pour servir de parent HWND au driver ASIO"""
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    
    # Window procedure (défaut)
    WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    
    def wnd_proc(hwnd, msg, wparam, lparam):
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
    
    # Garder une référence pour éviter le garbage collection
    global _wnd_proc_ref
    _wnd_proc_ref = WNDPROC(wnd_proc)
    
    class_name = "NovaASIOHiddenWindow"
    h_instance = kernel32.GetModuleHandleW(None)
    
    wc = WNDCLASSEXW()
    wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
    wc.lpfnWndProc = ctypes.cast(_wnd_proc_ref, ctypes.c_void_p)
    wc.hInstance = h_instance
    wc.lpszClassName = class_name
    
    atom = user32.RegisterClassExW(ctypes.byref(wc))
    if not atom:
        logger.warning("RegisterClassExW failed, using desktop window")
        return user32.GetDesktopWindow()
    
    hwnd = user32.CreateWindowExW(
        0,                    # dwExStyle
        class_name,           # lpClassName
        "Nova ASIO Host",     # lpWindowName
        WS_POPUP,             # dwStyle (popup = pas de barre de titre)
        0, 0, 1, 1,          # x, y, width, height
        None,                 # hWndParent
        None,                 # hMenu
        h_instance,           # hInstance
        None                  # lpParam
    )
    
    if not hwnd:
        logger.warning("CreateWindowExW failed, using desktop window")
        return user32.GetDesktopWindow()
    
    # Cacher la fenêtre
    user32.ShowWindow(hwnd, SW_HIDE)
    
    logger.info(f"   Fenêtre cachée créée: HWND={hwnd}")
    return hwnd


def run_message_pump(timeout_seconds: float = 30.0):
    """Exécuter un message pump Windows pendant un certain temps"""
    user32 = ctypes.windll.user32
    msg = MSG()
    start_time = time.time()
    
    logger.info(f"   Message pump démarré (timeout: {timeout_seconds}s)")
    
    while (time.time() - start_time) < timeout_seconds:
        # PeekMessage au lieu de GetMessage pour ne pas bloquer
        if user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
            if msg.message == WM_QUIT:
                logger.info("   WM_QUIT reçu, arrêt du message pump")
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        else:
            # Pas de message, dormir un peu pour ne pas consommer le CPU
            time.sleep(0.01)
    
    logger.info("   Message pump terminé")


def open_asio_control_panel(driver_name: str) -> bool:
    """
    Ouvrir le panneau de configuration ASIO
    
    1. Initialise COM (STA)
    2. Crée une fenêtre cachée (HWND)
    3. Crée l'instance COM du driver ASIO
    4. Appelle init(hwnd) puis controlPanel()
    5. Exécute un message pump pour le dialogue
    """
    ole32 = ctypes.windll.ole32
    
    logger.info(f"🎛️ Ouverture du panneau ASIO: {driver_name}")
    
    # 1. Trouver le CLSID
    clsid = find_driver_clsid(driver_name)
    if not clsid:
        logger.error(f"   ❌ CLSID non trouvé pour: {driver_name}")
        return False
    
    logger.info(f"   CLSID: {clsid}")
    
    # 2. Initialiser COM en mode STA (Single-Threaded Apartment)
    # COINIT_APARTMENTTHREADED = 0x2
    hr = ole32.CoInitializeEx(None, 0x2)
    if hr < 0 and hr != 1:  # S_OK=0, S_FALSE=1 (déjà initialisé)
        logger.error(f"   ❌ CoInitializeEx échoué: 0x{hr & 0xFFFFFFFF:08X}")
        return False
    
    logger.info("   COM initialisé (STA)")
    
    try:
        # 3. Créer la fenêtre cachée
        hwnd = create_hidden_window()
        
        # 4. Créer l'instance COM du driver
        guid = parse_guid(clsid)
        
        IID_IUnknown = GUID()
        IID_IUnknown.Data1 = 0x00000000
        IID_IUnknown.Data2 = 0x0000
        IID_IUnknown.Data3 = 0x0000
        IID_IUnknown.Data4[0] = 0xC0
        IID_IUnknown.Data4[1] = 0x00
        IID_IUnknown.Data4[7] = 0x46
        
        p_driver = ctypes.c_void_p()
        hr = ole32.CoCreateInstance(
            ctypes.byref(guid),
            None,
            CLSCTX_INPROC_SERVER,
            ctypes.byref(IID_IUnknown),
            ctypes.byref(p_driver)
        )
        
        if hr != 0 or not p_driver.value:
            logger.error(f"   ❌ CoCreateInstance échoué: 0x{hr & 0xFFFFFFFF:08X}")
            return False
        
        logger.info(f"   ✅ Driver COM créé: {hex(p_driver.value)}")
        
        # 5. Lire la vtable
        vtable_addr = ctypes.cast(p_driver, ctypes.POINTER(ctypes.c_void_p))[0]
        logger.info(f"   vtable addr: {hex(vtable_addr)}")
        
        # Lire 24 entrées de la vtable
        vtable = ctypes.cast(vtable_addr, ctypes.POINTER(ctypes.c_void_p * 24))[0]
        
        # Debug: afficher les entrées critiques
        logger.info(f"   vtable[3]  (init):         {hex(vtable[3]) if vtable[3] else 'NULL'}")
        logger.info(f"   vtable[21] (controlPanel): {hex(vtable[21]) if vtable[21] else 'NULL'}")
        
        # Vérifier que controlPanel n'est pas invalide
        if not vtable[21] or vtable[21] == 0xFFFFFFFFFFFFFFFF:
            logger.error(f"   ❌ vtable[21] (controlPanel) est invalide!")
            logger.info("   Essai avec d'autres index de vtable...")
            
            # Dump de la vtable pour debug
            for i in range(24):
                val = vtable[i]
                status = "❌ INVALID" if (not val or val == 0xFFFFFFFFFFFFFFFF) else "✅"
                logger.info(f"      vtable[{i:2d}]: {hex(val) if val else 'NULL'} {status}")
            
            # Chercher le bon index en tentant les index autour de 21
            # Note: Ne pas essayer, juste reporter l'erreur
            
            # Release
            RELEASE_FUNC = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
            release = RELEASE_FUNC(vtable[2])
            release(p_driver.value)
            return False
        
        # 6. Appeler init(hwnd)
        ASIO_INIT_FUNC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)
        init_func = ASIO_INIT_FUNC(vtable[3])
        
        # Passer le HWND comme sysHandle
        hwnd_ptr = ctypes.c_void_p(hwnd)
        init_result = init_func(p_driver.value, hwnd_ptr)
        logger.info(f"   init(hwnd={hwnd}) result: {init_result}")
        
        # 7. Appeler controlPanel()
        CTRL_FUNC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)
        control_panel = CTRL_FUNC(vtable[21])
        
        logger.info("   Appel controlPanel()...")
        result = control_panel(p_driver.value)
        logger.info(f"   controlPanel() result: {result}")
        
        # 8. Exécuter le message pump pour gérer le dialogue
        # Le panneau ASIO est une fenêtre modale qui a besoin d'un message pump
        run_message_pump(timeout_seconds=60.0)
        
        # 9. Release du driver
        logger.info("   Release du driver COM...")
        RELEASE_FUNC = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
        release = RELEASE_FUNC(vtable[2])
        release(p_driver.value)
        
        logger.info("   ✅ Panneau ASIO fermé proprement")
        return True
        
    except Exception as e:
        logger.error(f"   ❌ Erreur: {e}")
        import traceback
        traceback.print_exc()
        return False
        
    finally:
        ole32.CoUninitialize()
        logger.info("   COM déinitialisé")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python asio_control_panel.py <driver_name>")
        print("Example: python asio_control_panel.py \"FL Studio ASIO\"")
        sys.exit(1)
    
    driver_name = sys.argv[1]
    success = open_asio_control_panel(driver_name)
    sys.exit(0 if success else 1)