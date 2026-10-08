"""Insert ARA (Melodyne / VocAlign en insert, comme Pro Tools) : protocole du pont, sans plugin.

  - trame temps réel avec la position du morceau (drapeau TIMELINE) : lue, et les réglages
    d'automation qui suivent restent lisibles ;
  - état de l'insert = archive ARA + état VST3 en une chaîne ASCII (et ancienne archive nue) ;
  - document : sons pas encore reçus signalés (missing) avant tout appel à l'hôte ;
  - transport arrêté / trame sans position : silence, sans toucher au tube de l'hôte.

Lancer : venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_ara_insert*.py"
"""
import os
import struct
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ara_insert  # noqa: E402
import nova_bridge_server as srv  # noqa: E402
import vst_automation  # noqa: E402


def frame(slot: str, seq: int, block: np.ndarray, flags: int, timeline=None, params=None) -> bytes:
    sid = slot.encode()
    h = (2 + len(sid) + 3) & ~3
    head = bytearray(h + 8)
    head[0] = 1
    head[1] = len(sid)
    head[2:2 + len(sid)] = sid
    n = block.shape[1]
    struct.pack_into("<IHBB", head, h, seq, n, block.shape[0], flags)
    body = np.ascontiguousarray(block.T, "<f4").tobytes()
    if timeline is not None:
        body += struct.pack("<d", float(timeline))
    if params:
        body += struct.pack("<HH", len(params), 0)
        for i, o, v in params:
            body += struct.pack("<HHf", i, o, v)
    return bytes(head) + body


class TimelineFrames(unittest.TestCase):
    def test_position_lue(self):
        b = np.zeros((2, 128), np.float32)
        buf = frame("ara-1", 7, b, ara_insert.FLAG_TIMELINE, timeline=96000)
        sid, seq, n, nch, flags, data = srv.parse_audio_frame(buf)
        self.assertEqual((sid, seq, n, nch), ("ara-1", 7, 128, 2))
        self.assertEqual(ara_insert.parse_timeline(buf, n, nch, flags), 96000.0)

    def test_arret(self):
        b = np.zeros((2, 128), np.float32)
        buf = frame("ara-1", 1, b, ara_insert.FLAG_TIMELINE, timeline=-1)
        _sid, _seq, n, nch, flags, _d = srv.parse_audio_frame(buf)
        self.assertEqual(ara_insert.parse_timeline(buf, n, nch, flags), -1.0)

    def test_sans_drapeau(self):
        b = np.zeros((2, 128), np.float32)
        buf = frame("vst-1", 1, b, 0)
        _sid, _seq, n, nch, flags, _d = srv.parse_audio_frame(buf)
        self.assertIsNone(ara_insert.parse_timeline(buf, n, nch, flags))

    def test_automation_apres_la_position(self):
        b = np.zeros((2, 128), np.float32)
        flags = ara_insert.FLAG_TIMELINE | vst_automation.FLAG_PARAMS
        buf = frame("ara-1", 3, b, flags, timeline=4800, params=[(2, 64, 0.25)])
        _sid, _seq, n, nch, fl, _d = srv.parse_audio_frame(buf)
        self.assertEqual(ara_insert.parse_timeline(buf, n, nch, fl), 4800.0)
        changes = srv.parse_audio_extras(buf, n, nch, fl)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0][0], 2)
        self.assertEqual(changes[0][1], 64)
        self.assertAlmostEqual(changes[0][2], 0.25, places=6)


class EtatInsert(unittest.TestCase):
    def test_aller_retour(self):
        s = ara_insert.pack_state("QVJB", "VlNU")
        self.assertTrue(s.startswith(ara_insert.STATE_PREFIX))
        s.encode("ascii")  # GET_STATE calcule un SHA-1 de la chaîne ASCII
        self.assertEqual(ara_insert.unpack_state(s), ("QVJB", "VlNU"))

    def test_ancienne_archive_nue(self):
        self.assertEqual(ara_insert.unpack_state("QVJBYXJjaGl2ZQ=="), ("QVJBYXJjaGl2ZQ==", None))

    def test_vide(self):
        self.assertIsNone(ara_insert.pack_state(None, None))
        self.assertEqual(ara_insert.unpack_state(None), (None, None))
        self.assertEqual(ara_insert.unpack_state(ara_insert.STATE_PREFIX + "%%%"), (None, None))


class FauxHote:
    def __init__(self):
        self.calls = []

    def call(self, cmd, timeout=0, **kw):
        self.calls.append((cmd, kw))
        if cmd == "doc":
            return {"id": 1, "ok": True, "version": len(self.calls), "added": len(kw.get("regions") or []), "restored": bool(kw.get("archive_b64")),
                    "latency_samples": 0}
        return {"id": 1, "ok": True}


class Document(unittest.TestCase):
    def setUp(self):
        self.slot = ara_insert.AraInsertSlot("ara-x", "melodyne", "C:\\x\\Melodyne.vst3", 48000)
        self.slot.host = FauxHote()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.slot.dir, ignore_errors=True)

    def test_son_manquant(self):
        r = self.slot.sync_doc({"sources": [{"id": "b1"}], "regions": [{"id": "c1", "source": "b1", "start": 0, "duration": 1}]})
        self.assertEqual(r, {"success": False, "missing": ["b1"]})
        self.assertEqual(self.slot.host.calls, [])

    def test_son_envoye_une_fois_et_archive_restauree(self):
        self.slot.add_source("b1", np.zeros((1, 4800), np.float32), 48000)
        self.slot.pending_archive = "QVJB"
        req = {"sources": [{"id": "b1", "name": "Voix"}], "regions": [{"id": "c1", "source": "b1", "offset": 0, "start": 1, "duration": 0.1}],
               "track": {"name": "Voix"}, "bpm": 95}
        r1 = self.slot.sync_doc(req)
        self.assertTrue(r1["success"])
        cmd, kw = self.slot.host.calls[-1]
        self.assertEqual(cmd, "doc")
        self.assertIn("path", kw["sources"][0])
        self.assertEqual(kw["archive_b64"], "QVJB")
        self.assertIsNone(self.slot.pending_archive)
        self.slot.sync_doc(req)
        _cmd, kw2 = self.slot.host.calls[-1]
        self.assertNotIn("path", kw2["sources"][0])
        self.assertNotIn("archive_b64", kw2)

    def test_silence_a_l_arret(self):
        b = np.ones((2, 128), np.float32)
        self.assertEqual(float(np.abs(self.slot.process_block(b, None, None, -1.0)).max()), 0.0)
        self.assertEqual(float(np.abs(self.slot.process_block(b)).max()), 0.0)

    def test_en_panne_le_son_de_nova_passe(self):
        b = np.full((1, 64), 0.5, np.float32)
        out = self.slot.dry_block(b)
        self.assertEqual(out.shape, (2, 64))
        self.assertAlmostEqual(float(out[1, 3]), 0.5)


if __name__ == "__main__":
    unittest.main()
