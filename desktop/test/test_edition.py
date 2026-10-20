# -*- coding: utf-8 -*-
r"""
Édition de l'appli (nova_desktop.read_edition / page_features) : « standard », ou « hors-ligne »
posée par l'installateur de la clé USB (HKCU\Software\Make Music\Nova Studio, valeur Edition).

  python test\test_edition.py

La clé de registre réelle n'est jamais touchée : le test écrit sous une clé « … QA » à lui,
supprimée à la fin.
"""
import os
import sys
import unittest
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.pop("NOVA_DESKTOP_EDITION", None)

import nova_desktop  # noqa: E402

QA_KEY = r"Software\Make Music\Nova Studio QA"


class EditionTests(unittest.TestCase):
    def setUp(self):
        self._key = nova_desktop.EDITION_KEY
        nova_desktop.EDITION_KEY = QA_KEY
        os.environ.pop("NOVA_DESKTOP_EDITION", None)

    def tearDown(self):
        nova_desktop.EDITION_KEY = self._key
        os.environ.pop("NOVA_DESKTOP_EDITION", None)
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, QA_KEY)
        except OSError:
            pass

    def _write(self, value):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, QA_KEY) as k:
            winreg.SetValueEx(k, "Edition", 0, winreg.REG_SZ, value)

    def test_sans_cle_standard(self):
        self.assertEqual(nova_desktop.read_edition(), "standard")

    def test_cle_hors_ligne(self):
        self._write("hors-ligne")
        self.assertEqual(nova_desktop.read_edition(), "hors-ligne")
        self._write("  Hors-Ligne ")
        self.assertEqual(nova_desktop.read_edition(), "hors-ligne")

    def test_valeur_inconnue_standard(self):
        self._write("pirate")
        self.assertEqual(nova_desktop.read_edition(), "standard")

    def test_variable_de_test(self):
        os.environ["NOVA_DESKTOP_EDITION"] = "hors-ligne"
        self.assertEqual(nova_desktop.read_edition(), "hors-ligne")

    def test_fonctions_page(self):
        self.assertIn("google-login", nova_desktop.page_features("standard"))
        hl = nova_desktop.page_features("hors-ligne")
        self.assertNotIn("google-login", hl)
        self.assertIn("app-update", hl)

    def test_marqueur_page(self):
        js = nova_desktop.MARKER_JS % {"version": '"1.5.4"', "ui": '"ui-x"', "edition": '"hors-ligne"',
                                       "features": '["stems"]', "asio": 8766, "vst": 8765, "hwnd": 0}
        self.assertIn('edition: "hors-ligne"', js)
        self.assertIn('features: Object.freeze(["stems"])', js)


if __name__ == "__main__":
    unittest.main(verbosity=2)
