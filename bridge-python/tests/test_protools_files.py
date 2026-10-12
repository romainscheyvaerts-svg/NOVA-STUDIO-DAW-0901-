"""Pont Pro Tools (v14) : prises BWF écrites dans le dossier de l'ingé.

protools_files (nom, dossier, en-tête, écriture atomique, fichier verrouillé) et les
actions du serveur (HELLO, PT_STATUS, trame PT_WRITE_FILE) sur la boucle asyncio réelle.

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_protools*.py"
"""
import asyncio
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import protools_files as pf  # noqa: E402


def bwf(sr=48000, tref=0, frames=10, bits=24, nch=1, chunks=True):
    """Petit BWF (même disposition que utils/bwf.ts)."""
    fmt_tag = 3 if bits == 32 else 1
    fmt = struct.pack('<HHIIHH', fmt_tag, nch, sr, sr * nch * bits // 8, nch * bits // 8, bits)
    bext = bytearray(602)
    bext[0:4] = b'NOVA'
    struct.pack_into('<II', bext, 338, tref & 0xffffffff, tref >> 32)
    struct.pack_into('<H', bext, 346, 1)
    bext += b'A=PCM,F=48000,W=24,M=mono,T=NOVA Studio\r\n'
    data = bytes(range(256)) * (frames * nch * bits // 8 // 256 + 1)
    data = data[:frames * nch * bits // 8]

    def ck(cid, body):
        return cid + struct.pack('<I', len(body)) + body + (b'\0' if len(body) & 1 else b'')
    body = b'WAVE' + ck(b'fmt ', fmt) + (ck(b'bext', bytes(bext)) if chunks else b'') + ck(b'iXML', b'<BWFXML/>') + ck(b'data', data)
    return b'RIFF' + struct.pack('<I', len(body)) + body


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / 'Séance LENNON' / 'Prises PT'

    def tearDown(self):
        self.tmp.cleanup()

    def test_ecrit_et_relit_timereference(self):
        tref = 3600 * 48000 + 592593
        path, renamed = pf.write_take(str(self.dir), 'Voix lead_Prise 3_Lina.wav', bwf(tref=tref))
        self.assertFalse(renamed)
        self.assertEqual(path, self.dir / 'Voix lead_Prise 3_Lina.wav')
        r = pf.read_bwf(path)
        self.assertEqual(r['time_reference'], tref)
        self.assertEqual(r['sample_rate'], 48000)
        self.assertEqual(r['bits'], 24)
        self.assertEqual(r['frames'], 10)
        self.assertEqual(r['ixml'], '<BWFXML/>')
        # aucun temporaire laissé
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ['Voix lead_Prise 3_Lina.wav'])

    def test_timereference_64_bits(self):
        tref = 23 * 3600 * 96000 + 7
        path, _ = pf.write_take(str(self.dir), 'a.wav', bwf(sr=96000, tref=tref))
        self.assertEqual(pf.read_bwf(path)['time_reference'], tref)

    def test_remplace_une_version_precedente(self):
        pf.write_take(str(self.dir), 'a.wav', bwf(tref=1))
        path, renamed = pf.write_take(str(self.dir), 'a.wav', bwf(tref=2))
        self.assertFalse(renamed)
        self.assertEqual(pf.read_bwf(path)['time_reference'], 2)

    def test_fichier_verrouille_ecrit_a_cote(self):
        pf.write_take(str(self.dir), 'a.wav', bwf(tref=1))
        real = os.replace
        calls = []

        def locked(src, dst):
            calls.append(Path(dst).name)
            if Path(dst).name == 'a.wav':
                raise PermissionError('ouvert dans Pro Tools')
            return real(src, dst)
        pf.os.replace = locked
        try:
            path, renamed = pf.write_take(str(self.dir), 'a.wav', bwf(tref=2))
        finally:
            pf.os.replace = real
        self.assertTrue(renamed)
        self.assertEqual(path.name, 'a (2).wav')
        self.assertEqual(pf.read_bwf(self.dir / 'a.wav')['time_reference'], 1)   # l'original intact
        self.assertEqual(pf.read_bwf(path)['time_reference'], 2)

    def test_noms_refuses(self):
        for bad in ('..\\x.wav', 'a/b.wav', 'x.exe', 'CON.wav', '.cache.wav', 'a:b.wav', '', 'x' * 200 + '.wav'):
            with self.assertRaises(pf.ProToolsFileError, msg=bad):
                pf.write_take(str(self.dir), bad, bwf())

    def test_dossiers_refuses(self):
        windir = os.environ.get('SystemRoot', r'C:\Windows')
        for bad in ('relatif\\dossier', windir, os.path.join(windir, 'Temp'), 'C:\\'):
            with self.assertRaises(pf.ProToolsFileError, msg=bad):
                pf.check_folder(bad)

    def test_pas_un_bwf(self):
        with self.assertRaises(pf.ProToolsFileError):
            pf.write_take(str(self.dir), 'a.wav', b'MZ' + b'\0' * 100)
        with self.assertRaises(pf.ProToolsFileError):
            pf.write_take(str(self.dir), 'a.wav', bwf(chunks=False))     # WAV sans bext : pas horodaté
        with self.assertRaises(pf.ProToolsFileError):
            pf.write_take(str(self.dir), 'a.wav', bwf()[:-3])            # tronqué
        self.assertFalse(self.dir.exists() and any(self.dir.iterdir()))

    def test_etat_du_dossier(self):
        os.environ['NOVA_PT_DIR'] = str(self.dir)
        try:
            st = pf.folder_status('')
        finally:
            del os.environ['NOVA_PT_DIR']
        self.assertEqual(st['default_folder'], str(self.dir))
        self.assertTrue(st['writable'])
        st = pf.folder_status(os.environ.get('SystemRoot', r'C:\Windows'))
        self.assertFalse(st['writable'])
        self.assertIn('Windows', st['error'])


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    def json(self, action):
        return [json.loads(d) for d in self.sent if isinstance(d, str) and json.loads(d).get('action') == action]


def frame(meta: dict, payload: bytes) -> bytes:
    j = json.dumps(meta).encode('utf-8')
    off = (8 + len(j) + 3) & ~3
    head = bytearray(off)
    head[0] = 2
    struct.pack_into('<I', head, 4, len(j))
    head[8:8 + len(j)] = j
    return bytes(head) + payload + b'\0' * ((-len(payload)) % 4)


class ServerTest(unittest.TestCase):
    def setUp(self):
        import nova_bridge_server as srv
        self.srv = srv
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _server(self):
        server = self.srv.NovaBridgeServer.__new__(self.srv.NovaBridgeServer)
        server.loop = asyncio.get_running_loop()
        server.clients = set()
        return server

    def test_hello_annonce_le_pont_pro_tools(self):
        async def go():
            server, ws = self._server(), FakeWS()
            await server._a_hello(ws, {'action': 'HELLO', 'req_id': 1})
            await asyncio.sleep(0)
            h = json.loads(ws.sent[0])
            self.assertGreaterEqual(h['version'], 14)
            self.assertTrue(h['protools'])
        asyncio.run(go())

    def test_trame_pt_write_file(self):
        folder = Path(self.tmp.name) / 'PT'
        data = bwf(sr=44100, tref=3600 * 44100 + 12345, frames=7)   # longueur non multiple de 4 : bourrage

        async def go():
            server, ws = self._server(), FakeWS()
            await server._on_render(ws, frame({'action': 'PT_WRITE_FILE', 'req_id': 5, 'folder': str(folder),
                                               'name': 'Voix_Prise 1_Lina.wav', 'size': len(data)}, data))
            r = ws.json('PT_WRITE_FILE')[0]
            self.assertTrue(r['success'], r)
            self.assertEqual(r['req_id'], 5)
            self.assertEqual(Path(r['path']).read_bytes(), data)        # octets identiques
            self.assertEqual(pf.read_bwf(r['path'])['time_reference'], 3600 * 44100 + 12345)
            # refus : nom dangereux
            await server._on_render(ws, frame({'action': 'PT_WRITE_FILE', 'req_id': 6, 'folder': str(folder),
                                               'name': '..\\evil.wav', 'size': len(data)}, data))
            bad = ws.json('PT_WRITE_FILE')[1]
            self.assertFalse(bad['success'])
            self.assertIn('Nom de fichier refusé', bad['error'])
            # statut du dossier
            await server._a_pt_status(ws, {'action': 'PT_STATUS', 'req_id': 7, 'folder': str(folder)})
            await asyncio.sleep(0.05)
            st = ws.json('PT_STATUS')[0]
            self.assertTrue(st['writable'])
            self.assertEqual(st['folder'], str(folder.resolve()))
        asyncio.run(go())


if __name__ == '__main__':
    unittest.main()
