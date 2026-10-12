"""Tests de la sauvegarde des projets sur le disque (project_store, Nova Studio).

    python -m unittest discover -s tests -p "test_project_store*.py"

Preuves : version + sons relus à l'identique, écriture atomique (un plantage pendant
l'écriture laisse l'ancien fichier intact, y compris processus TUÉ en pleine écriture),
versions tournantes (20 dernières + une par jour, versions nommées gardées), dossier
retrouvé après un renommage, version abîmée sautée.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import project_store  # noqa: E402
from project_store import ProjectStore, ProjectStoreError, versions_to_prune, write_atomic  # noqa: E402

DAY = 86_400_000


def record(vid, audio_ids, name="Ma séance", reason="auto", **extra):
    return {"id": vid, "savedAt": vid, "name": name, "reason": reason, "tracks": 2, "takes": 1,
            "beatTitle": None, "hasLyrics": False, "needsCatalogBeat": False,
            "json": json.dumps({"tracks": [{"id": "t1"}], "v": vid}), "audioIds": audio_ids, **extra}


class ProjectStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "Projets"
        self.store = ProjectStore(self.root)

    def tearDown(self):
        project_store._WRITE_HOOK = None
        self.tmp.cleanup()

    def test_aller_retour_identique(self):
        rng = np.random.default_rng(1)
        a = rng.standard_normal((2, 48000)).astype(np.float32)
        b = rng.standard_normal((1, 1000)).astype(np.float32)
        self.assertEqual(self.store.missing_audio("p1", "Ma séance", ["sA", "voix:1/2"]), ["sA", "voix:1/2"])
        self.store.put_audio("p1", "Ma séance", "sA", a, 48000)
        self.store.put_audio("p1", "Ma séance", "voix:1/2", b, 44100)
        self.assertEqual(self.store.missing_audio("p1", "Ma séance", ["sA", "voix:1/2"]), [])
        r = self.store.save_version("p1", "Ma séance", record(1_000, ["sA", "voix:1/2"]))
        self.assertTrue(Path(r["folder"]).name == "Ma séance")
        rec, audio, missing = self.store.load_version("p1")
        self.assertEqual(missing, [])
        self.assertEqual(rec["json"], record(1_000, [])["json"])
        got = {k: (x, sr) for k, x, sr in audio}
        np.testing.assert_array_equal(got["sA"][0], a)
        np.testing.assert_array_equal(got["voix:1/2"][0], b)
        self.assertEqual(got["voix:1/2"][1], 44100)
        # Nom de fichier sûr pour un identifiant qui contient « : » et « / ».
        self.assertTrue(all(f.name.endswith(".wav") for f in (Path(r["folder"]) / "audio").iterdir()))
        projects = self.store.list_projects()
        self.assertEqual([p["project_id"] for p in projects], ["p1"])
        self.assertEqual(projects[0]["latest"]["id"], 1_000)

    def test_version_refusee_si_un_son_manque(self):
        with self.assertRaises(ProjectStoreError):
            self.store.save_version("p1", "S", record(1, ["absent"]))
        self.assertEqual(self.store.list_versions("p1"), [])

    def test_ecriture_coupee_ancien_fichier_intact(self):
        target = self.root / "x" / "f.json"
        write_atomic(target, b'{"v": 1}')

        def boom(path, written):
            raise OSError("disque arraché")

        project_store._WRITE_HOOK = boom
        with self.assertRaises(OSError):
            write_atomic(target, b'{"v": 2, "gros": "' + b"x" * 100000 + b'"}')
        project_store._WRITE_HOOK = None
        self.assertEqual(json.loads(target.read_text()), {"v": 1})
        self.assertEqual([p.name for p in target.parent.iterdir()], ["f.json"])  # pas de temporaire laissé

    def test_processus_tue_pendant_l_ecriture(self):
        """Le pont est TUÉ (TerminateProcess) au milieu de l'écriture d'une version :
        la version précédente reste lisible, la version coupée n'existe pas."""
        a = np.ones((1, 4800), np.float32)
        self.store.put_audio("p1", "Séance", "s1", a, 48000)
        self.store.save_version("p1", "Séance", record(1_000, ["s1"]))
        projet_avant = (self.root / "Séance" / "projet.json").read_bytes()
        child = r'''
import json, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import project_store
def hang(path, written):
    Path(sys.argv[3]).write_text(str(written))   # signal : moitié écrite
    time.sleep(60)
project_store._WRITE_HOOK = hang
s = project_store.ProjectStore(Path(sys.argv[2]))
rec = {"id": 2000, "savedAt": 2000, "name": "Séance", "reason": "auto", "json": json.dumps({"big": "y" * 2_000_000}), "audioIds": ["s1"]}
s.save_version("p1", "Séance", rec)
'''
        flag = Path(self.tmp.name) / "moitie.txt"
        script = Path(self.tmp.name) / "child.py"
        script.write_text(child, encoding="utf-8")
        p = subprocess.Popen([sys.executable, str(script), str(HERE), str(self.root), str(flag)],
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            t0 = time.time()
            while not flag.exists() and time.time() - t0 < 30:
                time.sleep(0.05)
            self.assertTrue(flag.exists(), "le processus n'a pas commencé à écrire")
            p.kill()
            p.wait(10)
        finally:
            if p.poll() is None:
                p.kill()
        leftovers = [f.name for f in (self.root / "Séance" / "versions").iterdir() if f.name.endswith(".tmp")]
        self.assertEqual(len(leftovers), 1, "le temporaire à moitié écrit est bien là (preuve que la coupure a eu lieu)")
        self.assertFalse((self.root / "Séance" / "versions" / "2000.json").exists())
        self.assertEqual((self.root / "Séance" / "projet.json").read_bytes(), projet_avant)
        rec, audio, missing = ProjectStore(self.root).load_version("p1")
        self.assertEqual(rec["id"], 1_000)
        self.assertEqual(missing, [])
        # Le ménage efface le temporaire une fois vieux.
        tmpf = self.root / "Séance" / "versions" / leftovers[0]
        old = time.time() - 3600
        os.utime(tmpf, (old, old))
        self.store.prune(self.root / "Séance")
        self.assertFalse(tmpf.exists())

    def test_version_abimee_sautee(self):
        self.store.put_audio("p1", "S", "s1", np.zeros((1, 10), np.float32), 48000)
        self.store.save_version("p1", "S", record(1_000, ["s1"]))
        self.store.save_version("p1", "S", record(2_000, ["s1"]))
        (self.root / "S" / "versions" / "2000.json").write_bytes(b'{"id": 2000, "json": "tronq')
        rec, _, _ = self.store.load_version("p1")
        self.assertEqual(rec["id"], 1_000)

    def test_versions_tournantes(self):
        now = int(time.time() * 1000)
        metas = [{"id": now - i * 60_000, "savedAt": now - i * 60_000} for i in range(30)]
        metas += [{"id": now - d * DAY, "savedAt": now - d * DAY} for d in range(2, 6)]
        metas += [{"id": now - d * DAY - 3_600_000, "savedAt": now - d * DAY - 3_600_000} for d in range(2, 6)]
        metas.append({"id": now - 40 * DAY, "savedAt": now - 40 * DAY, "reason": "named", "versionNumber": 3})
        drop = set(versions_to_prune(metas))
        kept = [m for m in metas if m["id"] not in drop]
        recent = sorted((m["id"] for m in metas), reverse=True)[:20]
        self.assertTrue(set(recent) <= {m["id"] for m in kept})
        days = {time.strftime("%Y-%m-%d", time.localtime(m["id"] / 1000)) for m in metas}
        kept_days = {time.strftime("%Y-%m-%d", time.localtime(m["id"] / 1000)) for m in kept}
        self.assertEqual(days, kept_days)  # au moins une par jour
        self.assertIn(now - 40 * DAY, {m["id"] for m in kept})  # nommée : gardée
        self.assertLessEqual(len(kept), 20 + len(days) + 1)

    def test_menage_sur_disque_et_sons_orphelins(self):
        st = self.store
        for i in range(25):
            sid = f"s{i}"
            st.put_audio("p1", "S", sid, np.zeros((1, 10), np.float32), 48000)
            st.save_version("p1", "S", record(10_000 + i, [sid]))
        versions = st.list_versions("p1")
        self.assertEqual(len(versions), 20)
        # Sons des versions effacées : gardés tant qu'ils sont récents (grâce de 10 min), puis effacés.
        audio = self.root / "S" / "audio"
        self.assertEqual(len(list(audio.glob("*.wav"))), 25)
        old = time.time() - 3600
        for f in audio.glob("*.wav"):
            os.utime(f, (old, old))
        st.prune(self.root / "S")
        self.assertEqual(sorted(f.stem for f in audio.glob("*.wav")), sorted(f"s{i}" for i in range(5, 25)))

    def test_dossier_retrouve_apres_renommage_et_homonymes(self):
        st = self.store
        st.put_audio("p1", "Clip", "a", np.zeros((1, 4), np.float32), 48000)
        st.save_version("p1", "Clip", record(1, ["a"], name="Clip"))
        st.save_version("p1", "Clip renommé", record(2, ["a"], name="Clip renommé"))
        self.assertEqual([d.name for d in self.root.iterdir()], ["Clip"])
        st.put_audio("p2", "Clip", "a", np.zeros((1, 4), np.float32), 48000)
        st.save_version("p2", "Clip", record(3, ["a"], name="Clip"))
        self.assertEqual(sorted(d.name for d in self.root.iterdir()), ["Clip", "Clip (2)"])
        fresh = ProjectStore(self.root)  # nouveau lancement du pont
        self.assertEqual(fresh.load_version("p1")[0]["name"], "Clip renommé")
        self.assertEqual(project_store.safe_name("CON"), "CON (projet)")
        self.assertEqual(project_store.safe_name('a/b:c*'), "a b c")


if __name__ == "__main__":
    unittest.main()
