"""Prises écrites par le pont (chantier C1), avec une carte SIMULÉE (tests/fake_sounddevice) :
le pilote ASIO du studio n'est jamais ouvert.

Signal connu : chaque échantillon porte son numéro (rampe codée, exacte en float32) ; une
prise relue doit redonner les numéros consécutifs, sans trou, au bit près.

    <python du pont> -m unittest discover -s tests -p "test_take_writer.py"
"""
import asyncio
import json
import logging
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import fake_sounddevice as fsd  # noqa: E402
fsd.install()
import asio_bridge  # noqa: E402
import take_writer  # noqa: E402
from asio_bridge import ASIOAudioStream, ASIOBridgeServer, ASIOConfig, FILE_HEADER, INPUT_HEADER_V2  # noqa: E402
from take_writer import CaptureRing, TakeManager, WavWriter, repair_wav  # noqa: E402

asio_bridge.logger.setLevel(logging.ERROR)

SR = 48000
MOD = 1 << 20
OFF = 1000          # décalage du numéro d'un canal à l'autre


def ramp(frame, frames, n_in, sr=SR):
    """Canal c, image i : ((i + c·1000) mod 2^20) / 2^20 − 0,5 — exact en float32."""
    idx = frame + np.arange(frames)
    return np.stack([((idx + c * OFF) % MOD) / MOD - 0.5 for c in range(n_in)], axis=1).astype(np.float32)


def decode(x, c=0):
    """Numéros d'image codés dans un canal (mod 2^20)."""
    return (np.round((np.asarray(x, np.float64) + 0.5) * MOD).astype(np.int64) - c * OFF) % MOD


class _SF:
    """Lecteur WAV indépendant (parcours des blocs RIFF, comme un lecteur standard) : le venv
    du pont n'a pas soundfile. Seule la taille annoncée par le bloc 'data' compte."""

    @staticmethod
    def read(path, dtype='float32', always_2d=True):
        b = Path(path).read_bytes()
        assert b[:4] == b'RIFF' and b[8:12] == b'WAVE'
        i, fmt, data = 12, None, None
        while i + 8 <= len(b):
            cid, size = b[i:i + 4], struct.unpack_from('<I', b, i + 4)[0]
            if cid == b'fmt ':
                fmt = struct.unpack_from('<HHIIHH', b, i + 8)
            elif cid == b'data':
                data = b[i + 8:i + 8 + size]
                break
            i += 8 + size + (size & 1)
        tag, ch, sr, _, align, bits = fmt
        assert tag == 3 and bits == 32
        n = len(data) // align
        return np.frombuffer(data[:n * align], dtype='<f4').reshape(n, ch).astype(np.float32), sr

    @staticmethod
    def info(path):
        class I:
            subtype = 'FLOAT'
        _SF.read(path)
        return I()


sf = _SF


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, m):
        self.sent.append(m)

    def json(self, action):
        return [json.loads(m) for m in self.sent if isinstance(m, str) and json.loads(m).get('action') == action]

    def binary(self, magic=None):
        return [m for m in self.sent if isinstance(m, (bytes, bytearray)) and (magic is None or m[:4] == magic)]


class Base(unittest.TestCase):
    def setUp(self):
        fsd.STATE['realtime'] = False
        fsd.STATE['generator'] = ramp
        fsd.STATE['loopback'] = {}
        fsd.STATE['opened'].clear()
        fsd.STATE['rates'] = None
        fsd.STATE['drop'] = None
        fsd.streams.clear()
        self.tmp = tempfile.TemporaryDirectory(prefix='nova-prises-')
        self.root = Path(self.tmp.name)

    def tearDown(self):
        fsd.STATE['drop'] = None
        self.tmp.cleanup()

    def open_stream(self, block_size=256, inputs=4):
        fsd.STATE['devices'] = [{'name': 'Carte simulée', 'hostapi': 0, 'max_input_channels': inputs, 'max_output_channels': 2, 'default_samplerate': float(SR)}]
        st = ASIOAudioStream(ASIOConfig(device_name=None, sample_rate=SR, block_size=block_size))
        self.assertTrue(st.start())
        return st, fsd.streams[-1]

    def run_blocks(self, card, mgr, n, pump_every=4):
        for i in range(n):
            card.step(1)
            if pump_every and i % pump_every == 0:
                mgr.pump()
        mgr.pump()


class TestRingAndWav(Base):
    def test_ring_roundtrip_and_overrun(self):
        r = CaptureRing(2, SR, seconds=1.0)
        for k in range(10):
            r.write(ramp(k * 256, 256, 2))
        x, bad = r.read(0, 2560)
        self.assertEqual(bad, 0)
        np.testing.assert_array_equal(decode(x[:, 0]), np.arange(2560))
        np.testing.assert_array_equal(decode(x[:, 1], 1), np.arange(2560))
        # Le producteur fait plus d'un tour : les images trop anciennes ne sont plus lisibles.
        for k in range(10, 10 + r.size // 256 + 4):
            r.write(ramp(k * 256, 256, 2))
        self.assertGreater(r.oldest(), 0)
        x, bad = r.read(0, 512)
        self.assertEqual(bad, 512)
        self.assertTrue(np.all(x == 0))

    def test_wav_float32_readable_and_repaired_after_crash(self):
        p = self.root / 'a.wav'
        w = WavWriter(p, 2, SR)
        data = ramp(0, 10000, 2)
        w.write(data[:4000])
        w.update_header()
        w.write(data[4000:])          # écrit, mais en-tête pas encore à jour (plantage ici)
        w.f.flush()
        y, sr = sf.read(str(p), dtype='float32', always_2d=True)
        self.assertEqual((sr, len(y)), (SR, 4000))       # lisible tel quel (jusqu'au dernier en-tête)
        w.f.close()
        self.assertEqual(repair_wav(p), 10000)
        y, sr = sf.read(str(p), dtype='float32', always_2d=True)
        np.testing.assert_array_equal(y, data)            # tout, au bit près
        info = sf.info(str(p))
        self.assertEqual(info.subtype, 'FLOAT')


class TestTakes(Base):
    def make(self, st, tracks, **kw):
        mgr = TakeManager(self.root, threaded=False)
        s = mgr.start(st.capture, kw.pop('take_id', 'tk-test'), {'id': 'p1', 'name': kw.pop('project', 'Séance: test/1')}, tracks, st.block_size, **kw)
        return mgr, s

    def read(self, path):
        y, sr = sf.read(str(path), dtype='float32', always_2d=True)
        self.assertEqual(sr, SR)
        return y

    def test_take_is_complete_bit_exact_with_preroll(self):
        st, card = self.open_stream()
        card.step(200)                                  # 1,07 s de flux avant la prise
        mgr, s = self.make(st, [{'track_id': 't1', 'name': 'Voix', 'inputs': [0], 'mode': 'mono'}])
        self.assertEqual(s.start_frame, st.frames_in - SR)   # 1 s de pré-capture
        self.run_blocks(card, mgr, 400)
        res = mgr.stop('tk-test')
        self.assertEqual(res['status'], 'terminée')
        self.assertEqual(res['lost_blocks'], 0)
        y = self.read(res['files'][0]['path'])
        self.assertEqual(len(y), res['end_frame'] - res['start_frame'])
        np.testing.assert_array_equal(decode(y[:, 0]), (res['start_frame'] + np.arange(len(y))) % MOD)
        # Dossier du projet (nom nettoyé), métadonnées à côté.
        self.assertEqual(Path(res['dir']).name, 'Séance test 1')
        meta = json.loads(Path(res['meta']).read_text(encoding='utf-8'))
        self.assertEqual((meta['status'], meta['start_frame'], meta['sample_rate']), ('terminée', res['start_frame'], SR))

    def test_multitrack_files_are_sample_synchronous(self):
        st, card = self.open_stream()
        card.step(20)
        mgr, s = self.make(st, [{'track_id': 'a', 'inputs': [0]}, {'track_id': 'b', 'inputs': [1]},
                                {'track_id': 'st', 'inputs': [2, 3], 'mode': 'stereo'},
                                {'track_id': 'sum', 'inputs': [0, 1], 'mode': 'sum'}])
        self.run_blocks(card, mgr, 300)
        res = mgr.stop('tk-test')
        f = {x['track_id']: self.read(x['path']) for x in res['files']}
        n = res['end_frame'] - res['start_frame']
        want = (res['start_frame'] + np.arange(n)) % MOD
        self.assertTrue(all(len(v) == n for v in f.values()))
        np.testing.assert_array_equal(decode(f['a'][:, 0], 0), want)
        np.testing.assert_array_equal(decode(f['b'][:, 0], 1), want)
        self.assertEqual(f['st'].shape[1], 2)
        np.testing.assert_array_equal(decode(f['st'][:, 0], 2), want)
        np.testing.assert_array_equal(decode(f['st'][:, 1], 3), want)
        g = ramp(res['start_frame'], n, 2)
        np.testing.assert_array_equal(f['sum'][:, 0], g[:, 0] + g[:, 1])    # somme float32, comme le graphe audio

    def test_writer_late_ring_overwritten_zeros_in_place(self):
        st, card = self.open_stream()
        mgr, s = self.make(st, [{'track_id': 'a', 'inputs': [0]}], preroll=0)
        mgr.pump()
        size = st.capture.size
        # Le fil d'écriture ne passe pas pendant plus d'un tour d'anneau.
        blocks = size // 256 + 40
        card.step(blocks)
        res = mgr.stop('tk-test')
        y = self.read(res['files'][0]['path'])[:, 0]
        n = res['end_frame'] - res['start_frame']
        self.assertEqual(len(y), n)                    # même longueur : la suite reste à sa place
        lost = res['lost_frames']
        self.assertGreater(lost, 0)
        self.assertTrue(all(l['kind'] == 'tampon' for l in res['losses']))
        self.assertTrue(np.all(y[:lost] == 0))
        np.testing.assert_array_equal(decode(y[lost:]), (res['start_frame'] + lost + np.arange(n - lost)) % MOD)
        self.assertGreaterEqual(res['lost_blocks'], 1)

    def test_asio_lost_blocks_filled_counted_and_aligned(self):
        st, card = self.open_stream()
        card.step(10)
        mgr, s = self.make(st, [{'track_id': 'a', 'inputs': [0]}, {'track_id': 'b', 'inputs': [1]}], preroll=0)
        start = s.start_frame
        lost_at = card.frame + 50 * 256
        fsd.STATE['drop'] = lambda f: lost_at <= f < lost_at + 2 * 256     # 2 blocs perdus par le pilote
        self.run_blocks(card, mgr, 120)
        res = mgr.stop('tk-test')
        self.assertEqual(res['lost_blocks'], 2)
        self.assertEqual(res['lost_frames'], 512)
        l = res['losses'][0]
        self.assertEqual((l['kind'], l['frame'], l['frames'], l['filled']), ('asio', lost_at, 512, True))
        self.assertAlmostEqual(l['at'], (lost_at - start) / SR, places=4)
        for k, c in (('a', 0), ('b', 1)):
            y = self.read(next(x['path'] for x in res['files'] if x['track_id'] == k))[:, 0]
            i0 = lost_at - start
            self.assertTrue(np.all(y[i0:i0 + 512] == 0))
            # Avant et APRÈS le trou : chaque échantillon à sa vraie place sur l'horloge de la carte.
            np.testing.assert_array_equal(decode(y[:i0], c), (start + np.arange(i0)) % MOD)
            np.testing.assert_array_equal(decode(y[i0 + 512:], c), (lost_at + 512 + np.arange(len(y) - i0 - 512)) % MOD)
        self.assertEqual(st.input_losses, 1)
        self.assertEqual(st.input_lost_frames, 512)

    def test_header_kept_up_to_date_during_take(self):
        old = take_writer.HEADER_EVERY
        take_writer.HEADER_EVERY = 0.0
        try:
            st, card = self.open_stream()
            mgr, s = self.make(st, [{'track_id': 'a', 'inputs': [0]}], preroll=0)
            self.run_blocks(card, mgr, 100)
            # Prise en cours, page ou pont qui plante maintenant : le fichier se lit déjà.
            y = self.read(s.tracks[0].wav.path)
            self.assertEqual(len(y), s.next - s.start_frame)
            np.testing.assert_array_equal(decode(y[:, 0]), (s.start_frame + np.arange(len(y))) % MOD)
            mgr.stop('tk-test')
        finally:
            take_writer.HEADER_EVERY = old

    def test_names_and_root_follow_project_store(self):
        """Prises à côté des projets sur le disque, noms sûrs comme les projets (CON, NUL…)."""
        old = os.environ.pop('NOVA_TAKES_DIR', None)
        try:
            self.assertEqual(take_writer.takes_root(), take_writer.project_store.default_root().parent / 'Prises')
        finally:
            if old is not None:
                os.environ['NOVA_TAKES_DIR'] = old
        st, card = self.open_stream()
        mgr, s = self.make(st, [{'track_id': 'a', 'name': 'NUL', 'inputs': [0]}], take_id='tk-con', project='CON')
        self.assertNotEqual(s.folder.name.lower(), 'con')
        mgr.stop('tk-con')
        self.assertFalse(list(s.folder.glob('*.tmp')))          # écriture atomique : aucun reste

    def test_refuses_bad_ids_and_files_outside(self):
        st, card = self.open_stream()
        mgr = TakeManager(self.root, threaded=False)
        with self.assertRaises(ValueError):
            mgr.start(st.capture, '../x', {}, [{'track_id': 'a', 'inputs': [0]}], 256)
        with self.assertRaises(ValueError):
            mgr.start(st.capture, 'ok', {}, [], 256)
        self.assertIsNone(mgr.file_for('..', 'a'))
        self.assertIsNone(mgr.file_for('inconnue', 'a'))
        s = mgr.start(st.capture, 'tk-1', {'name': 'P'}, [{'track_id': 'a', 'inputs': [0]}], 256)
        self.assertIsNone(mgr.file_for('tk-1', 'a'))            # en cours d'écriture : pas encore
        mgr.stop('tk-1')
        self.assertIsNotNone(mgr.file_for('tk-1', 'a'))
        self.assertIsNone(mgr.file_for('tk-1', 'b'))
        # Métadonnées modifiées pour viser un fichier hors du dossier des prises : refusé.
        meta = json.loads(s.meta_path.read_text(encoding='utf-8'))
        meta['files'][0]['file'] = '../../evil.wav'
        s.meta_path.write_text(json.dumps(meta), encoding='utf-8')
        mgr.finished.clear()
        self.assertIsNone(mgr.file_for('tk-1', 'a'))


class TestServer(Base):
    def make_server(self):
        os.environ['NOVA_TAKES_DIR'] = str(self.root)
        try:
            srv = ASIOBridgeServer(port=0)
        finally:
            os.environ.pop('NOVA_TAKES_DIR', None)
        srv.config.sample_rate = SR
        srv.config.block_size = 256
        ws = FakeWS()
        srv.clients['c1'] = ws
        return srv, ws

    def test_hello_announces_take_writer(self):
        srv, ws = self.make_server()
        asyncio.run(srv._handle_message('c1', {'action': 'HELLO', 'protocol': 2}))
        self.assertIn('take_writer', ws.json('HELLO_OK')[0]['features'])

    def test_rec_start_anchor_stop_fetch(self):
        srv, ws = self.make_server()
        fsd.STATE['devices'] = [{'name': 'Carte simulée', 'hostapi': 0, 'max_input_channels': 4, 'max_output_channels': 2, 'default_samplerate': float(SR)}]

        async def go():
            await srv._handle_message('c1', {'action': 'START_STREAM'})
            card = fsd.streams[-1]
            card.step(100)
            await srv._handle_message('c1', {'action': 'REC_START', 'take_id': 'tk-srv', 'project_id': 'p', 'project_name': 'Projet',
                                             'position': 2.5, 'tracks': [{'track_id': 'v1', 'name': 'Voix 1', 'inputs': [0]},
                                                                         {'track_id': 'v2', 'name': 'Voix 2', 'inputs': [1]},
                                                                         {'track_id': 'bad', 'inputs': [99]}]})
            await srv._handle_message('c1', {'action': 'REC_ANCHOR', 'take_id': 'tk-srv', 'frame': 12345, 'pos0': 2.5, 'latency': 0.01, 'offsets': {'v1': 0}})
            for _ in range(200):
                card.step(1)
                srv.takes.pump()
            await srv._handle_message('c1', {'action': 'REC_STOP', 'take_id': 'tk-srv'})
            await srv._handle_message('c1', {'action': 'REC_FETCH', 'take_id': 'tk-srv', 'track_id': 'v2', 'req': 7})
            await srv._handle_message('c1', {'action': 'REC_IMPORTED', 'take_id': 'tk-srv'})
            await srv._handle_message('c1', {'action': 'STOP_STREAM'})
        asyncio.run(go())
        started = ws.json('REC_STARTED')[0]
        self.assertTrue(started['success'])
        self.assertEqual([f['track_id'] for f in started['files']], ['v1', 'v2'])     # entrée 99 inexistante : ignorée
        stopped = ws.json('REC_STOPPED')[0]
        self.assertTrue(stopped['success'])
        self.assertEqual(stopped['start_frame'], started['start_frame'])
        chunks = ws.binary(b'NVF1')
        self.assertTrue(chunks)
        parts = sorted((FILE_HEADER.unpack_from(c, 0), c[FILE_HEADER.size:]) for c in chunks)
        self.assertTrue(all(h[1] == 7 and h[3] == len(parts) for h, _ in parts))
        data = b''.join(p for _, p in parts)
        fetched = ws.json('REC_FETCHED')[0]
        self.assertTrue(fetched['success'])
        self.assertEqual(len(data), fetched['bytes'])
        self.assertEqual(fetched['meta']['anchor']['frame'], 12345)
        with open(next(f['path'] for f in stopped['files'] if f['track_id'] == 'v2'), 'rb') as f:
            self.assertEqual(data, f.read())
        meta = json.loads(Path(stopped['meta']).read_text(encoding='utf-8'))
        self.assertTrue(meta['imported'])
        self.assertEqual(meta['position'], 2.5)

    def test_disconnect_closes_take_as_interrupted(self):
        srv, ws = self.make_server()
        fsd.STATE['devices'] = [{'name': 'Carte simulée', 'hostapi': 0, 'max_input_channels': 2, 'max_output_channels': 2, 'default_samplerate': float(SR)}]

        async def go():
            await srv._handle_message('c1', {'action': 'START_STREAM'})
            card = fsd.streams[-1]
            card.step(50)
            await srv._handle_message('c1', {'action': 'REC_START', 'take_id': 'tk-crash', 'tracks': [{'track_id': 'v', 'inputs': [0]}]})
            for _ in range(80):
                card.step(1)
                srv.takes.pump()
            # La page meurt : sa connexion se ferme ; le pont ferme la prise proprement.
            # (même chemin que la fin de _handle_connection pour ce client)
            await srv._stop_takes('interrompue', 'c1')
            await srv._handle_message('c1', {'action': 'STOP_STREAM'})
        asyncio.run(go())
        meta = srv.takes.read_meta('tk-crash')
        self.assertEqual(meta['status'], 'interrompue')
        p = srv.takes.file_for('tk-crash', 'v')
        y, _ = sf.read(str(p), dtype='float32', always_2d=True)
        self.assertEqual(len(y), meta['end_frame'] - meta['start_frame'])
        np.testing.assert_array_equal(decode(y[:, 0]), (meta['start_frame'] + np.arange(len(y))) % MOD)

    def test_v2_blocks_jump_over_lost_asio_blocks(self):
        """La page reçoit le même calage : après 2 blocs perdus, le n° d'image saute de 512."""
        st, card = self.open_stream()
        card.step(5)
        at = card.frame
        fsd.STATE['drop'] = lambda f: at <= f < at + 512
        card.step(4)
        idx = []
        while True:
            b = st.read_input_block()
            if not b:
                break
            idx.append(b[0])
        self.assertIn(at + 512, idx)
        self.assertNotIn(at, idx)


if __name__ == '__main__':
    unittest.main()
