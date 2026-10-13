# -*- coding: utf-8 -*-
"""
Tests de capture_guard.py (anti-enregistrement d'écran de l'appli Windows), SANS lancer
l'appli ni toucher aux ports des ponts (8765/8766) :

  python desktop/test/test_capture_guard.py

- reconnaissance des logiciels d'enregistrement (noms d'exécutables) ;
- instantané des processus (le Python du test y figure) ;
- WDA_EXCLUDEFROMCAPTURE posé puis retiré sur une fenêtre de test INVISIBLE (jamais affichée) ;
- script envoyé au DAW ;
- nova_desktop.py : protection branchée, messages du DAW acceptés seulement depuis le DAW.
"""
import ctypes
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
sys.path.insert(0, DESKTOP)

import capture_guard as cg  # noqa: E402


class Reconnaissance(unittest.TestCase):
    def test_logiciels_connus(self):
        self.assertEqual(cg.match_recorders(["explorer.exe", "OBS64.EXE", "bdcam.exe", "obs64.exe"]), ["Bandicam", "OBS Studio"])
        self.assertEqual(cg.match_recorders(["ShareX.exe"]), ["ShareX"])
        self.assertEqual(cg.match_recorders(["bcastdvr.exe"]), ["Barre de jeu Xbox (enregistrement)"])

    def test_rien_de_suspect(self):
        self.assertEqual(cg.match_recorders(["chrome.exe", "Pro Tools.exe", "python.exe", "GameBar.exe"]), [])
        self.assertEqual(cg.match_recorders(None), [])


@unittest.skipUnless(sys.platform == "win32", "Windows seulement")
class Windows(unittest.TestCase):
    def test_instantane_des_processus(self):
        names = [n.lower() for n in cg.running_exe_names()]
        self.assertGreater(len(names), 5)
        self.assertIn(os.path.basename(sys.executable).lower(), names)
        self.assertIsInstance(cg.running_recorders(), list)

    def test_fenetre_exclue_des_captures(self):
        from ctypes import wintypes
        u32 = ctypes.WinDLL("user32", use_last_error=True)
        u32.CreateWindowExW.restype = wintypes.HWND
        u32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        u32.DestroyWindow.argtypes = [wintypes.HWND]
        u32.IsWindowVisible.argtypes = [wintypes.HWND]
        WS_POPUP = 0x80000000
        WS_EX_TOOLWINDOW = 0x00000080
        # Fenêtre de premier niveau INVISIBLE (pas de WS_VISIBLE, jamais ShowWindow) : rien n'apparaît.
        hwnd = u32.CreateWindowExW(WS_EX_TOOLWINDOW, "STATIC", "nova-test-capture", WS_POPUP, 0, 0, 10, 10, None, None, None, None)
        self.assertTrue(hwnd, f"CreateWindowExW : {ctypes.get_last_error()}")
        try:
            self.assertFalse(u32.IsWindowVisible(hwnd))
            mode = cg.set_exclude_from_capture(hwnd, True)
            self.assertIn(mode, ("exclue", "noire"))
            self.assertIn(cg.display_affinity(hwnd), (cg.WDA_EXCLUDEFROMCAPTURE, cg.WDA_MONITOR))
            self.assertEqual(cg.set_exclude_from_capture(hwnd, False), "normale")
            self.assertEqual(cg.display_affinity(hwnd), cg.WDA_NONE)
        finally:
            u32.DestroyWindow(hwnd)


class ScriptEtBranchement(unittest.TestCase):
    def test_script_pour_le_daw(self):
        js = cg.guard_script(["OBS Studio", "Barre de jeu Xbox (enregistrement)"])
        self.assertTrue(js.startswith("window.__novaCaptureGuard && window.__novaCaptureGuard("))
        payload = js[js.index("(", js.index("&&")) + 1:-1]
        self.assertEqual(json.loads(payload), ["OBS Studio", "Barre de jeu Xbox (enregistrement)"])
        self.assertTrue(cg.guard_script([]).endswith("([])"))

    def test_nova_desktop_branche_la_protection(self):
        with open(os.path.join(DESKTOP, "nova_desktop.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("import capture_guard", src)
        self.assertIn("self.capture_protect(True)", src)
        self.assertIn("self.start_recorder_watch()", src)
        # Le message qui COUPE la protection n'est accepté que depuis le DAW.
        i = src.index('"nova-desktop:capture-protect:off"')
        bloc = src[i:i + 400]
        self.assertIn("== app_host", bloc)
        # Ports des ponts inchangés.
        self.assertIn("ASIO_PORT = 8766", src)
        self.assertIn('"NOVA_BRIDGE_PORT", "8765"', src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
