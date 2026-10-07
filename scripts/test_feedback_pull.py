# -*- coding: utf-8 -*-
"""Tests de scripts/feedback_pull.py sur données factices (aucun réseau, aucune base).

    python -m unittest scripts/test_feedback_pull.py
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import feedback_pull as fp  # noqa: E402

FIXTURE = HERE.parent / "tests" / "fixtures" / "feedback" / "feedback_factice.json"


class FeedbackPullTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="nova_retours_"))
        shutil.copytree(FIXTURE.parent, self.tmp / "src")
        self.data = self.tmp / "src" / FIXTURE.name

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def rows(self):
        return json.loads(self.data.read_text(encoding="utf-8"))

    def test_regroupe_les_doublons_et_la_meme_erreur(self):
        open_rows = [r for r in self.rows() if r["status"] in fp.OPEN_STATUSES]
        groups = fp.group_rows(open_rows)
        by_ref = {r["ref"]: i for i, g in enumerate(groups) for r in g}
        # Même problème d'enregistrement (titres voisins + même erreur console, chiffres ignorés).
        self.assertEqual(by_ref["K7P2QX4A"], by_ref["M3N4P5Q6"])
        self.assertEqual(by_ref["K7P2QX4A"], by_ref["R8S9T2U3"])
        # Idée et amélioration sur l'accordeur : même sujet.
        self.assertEqual(by_ref["V4W5X6Y7"], by_ref["Z2A3B4C5"])
        # Sujets différents : séparés.
        self.assertNotEqual(by_ref["K7P2QX4A"], by_ref["N6P7Q8R9"])
        self.assertNotEqual(by_ref["D6E7F8G9"], by_ref["V4W5X6Y7"])
        self.assertEqual(len(groups), 4)

    def test_liste_de_travail(self):
        out = self.tmp / "out"
        self.assertEqual(fp.main(["--fichier", str(self.data), "--sortie", str(out)]), 0)
        md = (out / "a_traiter.md").read_text(encoding="utf-8")
        self.assertIn("7 signalement(s) en 4 sujet(s)", md)
        self.assertIn("## 1. P1 · Bug", md)
        self.assertIn("K7P2-QX4A", md)
        self.assertIn("captures/K7P2QX4A.jpg", md)
        self.assertTrue((out / "captures" / "K7P2QX4A.jpg").exists())
        self.assertNotIn("H2J3-K4M5", md)  # déjà corrigé : absent sans --tous
        data = json.loads((out / "a_traiter.json").read_text(encoding="utf-8"))
        self.assertEqual(data["sujets"][0]["priorite"], "P1")
        self.assertEqual(sorted(data["sujets"][0]["refs"]), ["K7P2QX4A", "M3N4P5Q6", "R8S9T2U3"])

    def test_tous_inclut_les_corriges(self):
        out = self.tmp / "out"
        fp.main(["--fichier", str(self.data), "--sortie", str(out), "--tous"])
        self.assertIn("H2J3-K4M5", (out / "a_traiter.md").read_text(encoding="utf-8"))

    def test_marquer_corrige_avec_version(self):
        code = fp.main(["--fichier", str(self.data), "--marquer-corrige", "K7P2-QX4A,00000000-0000-4000-8000-000000000002", "--version", "2026.10.08"])
        self.assertEqual(code, 0)
        rows = {r["ref"]: r for r in self.rows()}
        self.assertEqual((rows["K7P2QX4A"]["status"], rows["K7P2QX4A"]["fixed_in_version"]), ("corrige", "2026.10.08"))
        self.assertEqual(rows["M3N4P5Q6"]["status"], "corrige")
        self.assertEqual(rows["R8S9T2U3"]["status"], "en_cours")

    def test_version_obligatoire(self):
        with self.assertRaises(SystemExit):
            fp.main(["--fichier", str(self.data), "--marquer-corrige", "K7P2QX4A"])

    def test_ref_invalide_refusee(self):
        with self.assertRaises(SystemExit):
            fp.main(["--fichier", str(self.data), "--marquer-en-cours", "pas-une-ref"])

    def test_ia_locale_fusionne_mais_jamais_bug_et_idee(self):
        from unittest import mock
        rows = [r for r in self.rows() if r["status"] in fp.OPEN_STATUSES]
        groups = fp.group_rows(rows)
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)
            # L'IA propose de tout fusionner : seuls les sujets compatibles le seront.
            return mock.Mock(returncode=0, stdout="Voici : " + json.dumps([list(range(len(groups)))]), stderr="")
        with mock.patch.object(fp.subprocess, "run", side_effect=fake_run):
            merged = fp.refine_with_local_ai(groups)
        self.assertEqual(len(calls), 1)
        # Local uniquement : modèle Ollama forcé (-m), jamais un profil avec repli en ligne.
        self.assertIn("-m", calls[0])
        self.assertTrue(calls[0][calls[0].index("-m") + 1].startswith("ollama:"))
        self.assertNotIn("-p", calls[0])
        for g in merged:
            cats = {r["category"] for r in g}
            self.assertFalse("bug" in cats and cats - {"bug"}, cats)

    def test_ia_eteinte_regroupement_simple(self):
        from unittest import mock
        groups = fp.group_rows([r for r in self.rows() if r["status"] in fp.OPEN_STATUSES])
        with mock.patch.object(fp.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="", stderr="aucun fournisseur")):
            self.assertEqual(len(fp.refine_with_local_ai(groups)), len(groups))

    def test_role_de_cle_sans_l_afficher(self):
        import base64
        def jwt(role):
            p = base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=")
            return f"eyJhbGciOiJIUzI1NiJ9.{p}.signature"
        self.assertEqual(fp.key_role(jwt("service_role")), "service_role")
        self.assertEqual(fp.key_role(jwt("anon")), "anon")
        self.assertEqual(fp.key_role("sb_secret_xxx"), "service_role")
        self.assertEqual(fp.key_role("sb_publishable_xxx"), "anon")
        self.assertEqual(fp.key_role("n'importe quoi"), "")


if __name__ == "__main__":
    unittest.main()
