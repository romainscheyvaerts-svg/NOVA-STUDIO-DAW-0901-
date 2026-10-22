# -*- coding: utf-8 -*-
r"""
Intégration à Windows de l'appli (fonctions pures de nova_desktop.py, sans fenêtre) :

  - place de la fenêtre retrouvée (écran présent, 2e écran, écran débranché, fenêtre trop grande) ;
  - navigation : un fichier lâché hors d'une zone d'import n'ouvre plus le fichier À LA PLACE du DAW ;
  - verrou d'instance à part pour un dossier de données de test (la vraie Nova n'est jamais ramenée) ;
  - service worker effacé une seule fois (le Cache Storage du DAW n'est plus vidé à chaque démarrage) ;
  - ponts : numpy chargé avec un seul fil de calcul OpenBLAS (mémoire engagée et fils mesurés).

  venv\Scripts\python.exe test\test_systeme.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
sys.path.insert(0, DESKTOP)
_TMP = tempfile.mkdtemp(prefix="nova-test-systeme-")
os.environ["NOVA_DESKTOP_DATA_DIR"] = _TMP

import nova_desktop as nd  # noqa: E402

HOST = "nova-studio-daw-0901-9kzo.vercel.app"
SCREEN = (0, 0, 2560, 1550)            # zone de travail de l'écran principal (barre des tâches en bas)
SCREEN2 = (2560, 0, 1920, 1040)        # 2e écran à droite


class PlacementTests(unittest.TestCase):
    def test_sans_fichier(self):
        self.assertIsNone(nd.choose_placement(None, [SCREEN]))

    def test_meme_place(self):
        self.assertEqual(nd.choose_placement({"x": 100, "y": 80, "w": 1600, "h": 1000, "max": False}, [SCREEN]),
                         (100, 80, 1600, 1000, False))

    def test_agrandie_sur_le_2e_ecran(self):
        pl = nd.choose_placement({"x": 2700, "y": 60, "w": 1400, "h": 900, "max": True}, [SCREEN, SCREEN2])
        self.assertEqual(pl, (2700, 60, 1400, 900, True))

    def test_ecran_debranche(self):
        # fenêtre laissée sur le 2e écran, débranché depuis : place par défaut (agrandie sur l'écran principal)
        self.assertIsNone(nd.choose_placement({"x": 2700, "y": 60, "w": 1400, "h": 900, "max": True}, [SCREEN]))

    def test_barre_de_titre_hors_ecran(self):
        self.assertIsNone(nd.choose_placement({"x": 100, "y": -500, "w": 1400, "h": 520, "max": False}, [SCREEN]))

    def test_trop_grande_ramenee(self):
        x, y, w, h, mx = nd.choose_placement({"x": 1500, "y": 900, "w": 3000, "h": 2000, "max": False}, [SCREEN])
        self.assertEqual((w, h), (2560, 1550))
        self.assertEqual((x, y), (0, 0))

    def test_debordement_ramene_dans_l_ecran(self):
        x, y, w, h, _ = nd.choose_placement({"x": 2000, "y": 700, "w": 1400, "h": 900, "max": False}, [SCREEN])
        self.assertTrue(0 <= x and x + w <= 2560 and 0 <= y and y + h <= 1550)

    def test_taille_minimale(self):
        _, _, w, h, _ = nd.choose_placement({"x": 10, "y": 10, "w": 200, "h": 100, "max": False}, [SCREEN])
        self.assertEqual((w, h), (960, 600))

    def test_aller_retour_fichier(self):
        nd.save_placement({"x": 12, "y": 34, "w": 1500, "h": 950, "max": True})
        self.assertEqual(nd.load_placement(), {"x": 12, "y": 34, "w": 1500, "h": 950, "max": True})
        nd.save_popout_placement("nova-console", {"x": 2600, "y": 40, "w": 1280, "h": 760, "max": False})
        self.assertEqual(nd.load_popout_placements()["nova-console"]["x"], 2600)

    def test_fichier_abime(self):
        with open(os.path.join(_TMP, "fenetre.json"), "w", encoding="utf-8") as f:
            f.write("{pas du json")
        self.assertIsNone(nd.load_placement())


class NavigationTests(unittest.TestCase):
    def test_fichier_bloque(self):
        for uri in ("file:///C:/Users/x/Desktop/voix.wav", "file:///C:/x/beat.mid", "file:///D:/projet.novaproj.zip"):
            self.assertEqual(nd.navigation_policy(uri, HOST), "block", uri)

    def test_daw_et_supabase_restent(self):
        self.assertEqual(nd.navigation_policy(f"https://{HOST}/", HOST), "app")
        self.assertEqual(nd.navigation_policy("https://abc.supabase.co/auth/v1/callback", HOST), "app")
        self.assertEqual(nd.navigation_policy("about:blank", HOST), "app")
        self.assertEqual(nd.navigation_policy("data:text/html,x", HOST), "app")

    def test_externe_dans_le_navigateur(self):
        self.assertEqual(nd.navigation_policy("https://checkout.stripe.com/x", HOST), "browser")
        self.assertEqual(nd.navigation_policy("mailto:contact@studiomakemusic.com", HOST), "browser")

    def test_schemas_inconnus_bloques(self):
        self.assertEqual(nd.navigation_policy("ms-settings:sound", HOST), "block")


class InstanceTests(unittest.TestCase):
    def test_verrou_a_part_pour_un_profil_de_test(self):
        self.assertNotEqual(nd.mutex_name(), nd.MUTEX_NAME)
        self.assertTrue(nd.mutex_name().startswith(nd.MUTEX_NAME + "-"))

    def test_verrou_normal_sans_profil(self):
        saved = os.environ.pop("NOVA_DESKTOP_DATA_DIR")
        try:
            self.assertEqual(nd.mutex_name(), "NovaStudioDesktopMutex")   # = AppMutex de l'installateur
        finally:
            os.environ["NOVA_DESKTOP_DATA_DIR"] = saved

    def test_fenetre_notee_ignoree_si_processus_different(self):
        with open(os.path.join(_TMP, "window.hwnd"), "w", encoding="ascii") as f:
            f.write("123456 999999")
        self.assertEqual(nd._published_window(), 0)


class ServiceWorkerTests(unittest.TestCase):
    def test_temoin(self):
        nd.mark_sw_profile(False)
        self.assertFalse(nd.sw_profile_clean())
        nd.mark_sw_profile(True)
        self.assertTrue(nd.sw_profile_clean())
        nd.mark_sw_profile(False)
        self.assertFalse(nd.sw_profile_clean())

    def test_cache_storage_plus_vide_au_demarrage(self):
        with open(os.path.join(DESKTOP, "nova_desktop.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("CoreWebView2BrowsingDataKinds.CacheStorage", src)


PROBE = r"""
import os, sys, subprocess, json
sys.path.insert(0, %(desktop)r)
os.environ["NOVA_DESKTOP_DATA_DIR"] = %(tmp)r
import nova_desktop
if %(lean)r:
    nova_desktop.lean_numpy()
import numpy
ps = "$p=Get-Process -Id %%d; '{0}|{1}' -f [int]($p.PrivateMemorySize64/1MB),$p.Threads.Count" %% os.getpid()
o = subprocess.check_output(["powershell", "-NoProfile", "-Command", ps], creationflags=0x08000000).decode().strip().split("|")
print(json.dumps({"prive": int(o[0]), "fils": int(o[1]), "env": os.environ.get("OPENBLAS_NUM_THREADS")}))
"""


class PontsNumpyTests(unittest.TestCase):
    def probe(self, lean):
        env = dict(os.environ)
        env.pop("OPENBLAS_NUM_THREADS", None)
        out = subprocess.run([sys.executable, "-c", PROBE % {"desktop": DESKTOP, "tmp": _TMP, "lean": lean}],
                             capture_output=True, text=True, env=env, timeout=120, creationflags=0x08000000)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_numpy_leger_dans_les_ponts(self):
        avant, apres = self.probe(False), self.probe(True)
        print(f"\n  numpy chargé : avant {avant['prive']} Mo engagés / {avant['fils']} fils ; "
              f"pont corrigé : {apres['prive']} Mo / {apres['fils']} fils")
        self.assertIsNone(apres["env"])                      # pas transmis aux modules stems / voix
        self.assertLess(apres["fils"], 10)
        if (os.cpu_count() or 1) >= 8:
            self.assertLess(apres["prive"], avant["prive"] - 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
