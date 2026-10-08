"""Pont ASIO multicanal (R15), avec une carte SIMULÉE (tests/fake_sounddevice) :
le pilote ASIO du studio n'est jamais ouvert.

    <python du pont> -m unittest discover -s tests -p "test_asio_multichannel.py"
"""
import asyncio
import json
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import fake_sounddevice as fsd  # noqa: E402
fsd.install()
import asio_bridge  # noqa: E402
from asio_bridge import (ASIOAudioStream, ASIOBridgeServer, ASIOConfig, INPUT_HEADER_V2,  # noqa: E402
                         decode_output_message, encode_input_block_v2, find_impulse_delays)
import logging  # noqa: E402
asio_bridge.logger.setLevel(logging.WARNING)

SR = 44100
FREQS = [220.0, 330.0, 440.0, 550.0, 660.0, 770.0, 880.0, 990.0]


def sines(frame, frames, n_in, sr):
    t = (frame + np.arange(frames)) / sr
    return np.stack([0.25 * np.sin(2 * np.pi * FREQS[c] * t) for c in range(n_in)], axis=1).astype(np.float32)


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, m):
        self.sent.append(m)

    def json(self, action):
        return [json.loads(m) for m in self.sent if isinstance(m, str) and json.loads(m).get('action') == action]

    def binary(self):
        return [m for m in self.sent if isinstance(m, (bytes, bytearray))]


def dominant(x, sr=SR):
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    return np.fft.rfftfreq(len(x), 1 / sr)[int(np.argmax(spec))]


class Base(unittest.TestCase):
    def setUp(self):
        fsd.STATE['realtime'] = False
        fsd.STATE['generator'] = sines
        fsd.STATE['loopback'] = {}
        fsd.STATE['opened'].clear()
        fsd.streams.clear()

    def open_stream(self, **kw):
        cfg = ASIOConfig(device_name=None, sample_rate=SR, block_size=kw.pop('block_size', 256), **kw)
        st = ASIOAudioStream(cfg)
        self.assertTrue(st.start())
        return st, fsd.streams[-1]


class TestProtocol(unittest.TestCase):
    def test_input_header_v2_roundtrip(self):
        blk = np.arange(12, dtype=np.float32).reshape(3, 4)
        msg = encode_input_block_v2(blk, 123456789012, 48000, 1.25)
        magic, frames, ch, sr, idx, adc = INPUT_HEADER_V2.unpack_from(msg, 0)
        self.assertEqual((magic, frames, ch, sr, idx, adc), (b'NVI2', 3, 4, 48000, 123456789012, 1.25))
        self.assertEqual(INPUT_HEADER_V2.size, 32)
        data = np.frombuffer(msg, dtype=np.float32, offset=32).reshape(3, 4)
        np.testing.assert_array_equal(data, blk)

    def test_output_v1_and_v2(self):
        a = np.arange(8, dtype=np.float32).reshape(4, 2)
        v1 = struct.pack('<II', 4, 2) + a.tobytes()
        out, dests = decode_output_message(v1)
        self.assertIsNone(dests)
        np.testing.assert_array_equal(out, a)
        b = np.arange(24, dtype=np.float32).reshape(4, 6)
        v2 = b'NVO2' + struct.pack('<II', 4, 6) + struct.pack('<6i', 0, 1, 2, 3, -1, 5) + b.tobytes()
        out, dests = decode_output_message(v2)
        self.assertEqual(dests, [0, 1, 2, 3, -1, 5])
        np.testing.assert_array_equal(out, b)

    def test_find_impulse_delays(self):
        rec = np.zeros((1000, 3), dtype=np.float32)
        rec[300, 0] = 0.5
        rec[324, 1] = -0.4
        self.assertEqual(find_impulse_delays(rec, 100), [200, 224, None])


class TestStream(Base):
    def test_opens_all_card_channels(self):
        st, fake = self.open_stream(input_channels=0, output_channels=0)
        self.assertEqual((st.in_channels, st.out_channels), (8, 8))
        self.assertEqual(fake.channels, (8, 8))
        st.stop()
        st2, fake2 = self.open_stream(input_channels=2, output_channels=2)
        self.assertEqual(fake2.channels, (2, 2))
        st2.stop()

    def test_input_blocks_are_timestamped_and_distinct_per_channel(self):
        st, fake = self.open_stream(input_channels=0, output_channels=0)
        fake.step(40)
        blocks = []
        while True:
            b = st.read_input_block()
            if b is None:
                break
            blocks.append(b)
        self.assertEqual(len(blocks), 40)
        idx = [b[0] for b in blocks]
        self.assertEqual(idx, [k * 256 for k in range(40)])           # aucun trou, à l'échantillon
        x = np.concatenate([b[2] for b in blocks])
        self.assertEqual(x.shape[1], 8)
        for c in range(4):
            self.assertAlmostEqual(dominant(x[:, c]), FREQS[c], delta=6)
        st.stop()

    def test_multi_output_routing(self):
        st, fake = self.open_stream(input_channels=0, output_channels=0)
        n = 256 * 8
        t = np.arange(n) / SR
        main = np.stack([np.sin(2 * np.pi * 1000 * t)] * 2, 1) * 0.3
        cue1 = np.stack([np.sin(2 * np.pi * 2000 * t)] * 2, 1) * 0.2
        cue2 = np.stack([np.sin(2 * np.pi * 3000 * t), np.zeros(n)], 1) * 0.1
        msg = np.concatenate([main, cue1, cue2], 1).astype(np.float32)
        for k in range(8):          # comme le DAW : un message par bloc
            st.write_output(msg[k * 256:(k + 1) * 256], [0, 1, 2, 3, 4, 5])
            fake.step(1)
        fake.step(3)
        out = fake.captured()
        live = out[out.any(axis=1)]
        self.assertGreater(len(live), 1000)
        self.assertAlmostEqual(dominant(live[:, 0]), 1000, delta=15)
        self.assertAlmostEqual(dominant(live[:, 2]), 2000, delta=15)
        self.assertAlmostEqual(dominant(live[:, 4]), 3000, delta=15)
        self.assertLess(np.max(np.abs(live[:, 5])), 1e-6)            # canal droit du mix 2 : silence
        self.assertLess(np.max(np.abs(live[:, 6:])), 1e-6)           # sorties 7-8 : rien
        st.stop()

    def test_direct_monitor_routes(self):
        st, fake = self.open_stream(input_channels=0, output_channels=0)
        st.config.direct_monitor = True
        st.config.monitor_routes = [(2, 4, 0.5), (2, 5, 0.5), (0, 0, 1.0)]
        fake.step(20)
        out = fake.captured()
        self.assertAlmostEqual(dominant(out[:, 4]), FREQS[2], delta=6)
        self.assertAlmostEqual(float(np.max(np.abs(out[:, 4]))), 0.125, delta=0.01)
        self.assertAlmostEqual(dominant(out[:, 0]), FREQS[0], delta=6)
        self.assertLess(np.max(np.abs(out[:, 2])), 1e-6)
        st.stop()

    def test_latency_probe_per_channel(self):
        fsd.STATE['generator'] = None
        # Boucle : la sortie 1 revient sur les entrées 1-4 ; l'entrée 3 a 24 échantillons
        # de plus (convertisseur ADAT, par exemple).
        fsd.STATE['loopback'] = {0: [(0, 600), (1, 600), (2, 624), (3, 600)]}
        st, fake = self.open_stream(input_channels=0, output_channels=0)
        fake.step(4)
        p = st.start_latency_probe([0], 0.3)
        for _ in range(200):
            if p['done']:
                break
            fake.step(1)
        res = st.finish_latency_probe(p)
        self.assertTrue(res['complete'])
        self.assertEqual(res['delays'][:4], [600, 600, 624, 600])
        self.assertEqual(res['delays'][4:], [None] * 4)
        st.stop()


class TestServer(Base):
    def run_async(self, coro):
        return asyncio.run(coro)

    def make_server(self):
        srv = ASIOBridgeServer(port=0)
        srv.config.sample_rate = SR
        ws = FakeWS()
        srv.clients['c1'] = ws
        return srv, ws

    def test_hello_switches_to_v2_binary(self):
        srv, ws = self.make_server()

        async def go():
            await srv._handle_message('c1', {'action': 'HELLO', 'protocol': 2})
            await srv._send_binary('c1', np.ones((4, 3), dtype=np.float32), 512, 0.5)
            srv.client_proto['c1'] = 1
            await srv._send_binary('c1', np.ones((4, 3), dtype=np.float32), 0, 0)
        self.run_async(go())
        hello = ws.json('HELLO_OK')[0]
        self.assertEqual(hello['protocol'], 2)
        self.assertIn('multichannel', hello['features'])
        v2, v1 = ws.binary()
        self.assertEqual(v2[:4], b'NVI2')
        self.assertEqual(INPUT_HEADER_V2.unpack_from(v2, 0)[4], 512)
        self.assertEqual(struct.unpack_from('<II', v1, 0), (4, 3))   # ancien client : ancien format

    def test_buffer_size_change_really_recreates_the_stream(self):
        srv, ws = self.make_server()

        async def go():
            srv.running = True
            await srv._handle_message('c1', {'action': 'START_STREAM'})
            first = srv.audio_stream
            self.assertEqual(fsd.STATE['opened'][-1]['blocksize'], 256)
            await srv._handle_message('c1', {'action': 'SET_MONITOR', 'enabled': True, 'routes': [{'in': 1, 'out': 2, 'gain': 0.7}]})
            await srv._handle_message('c1', {'action': 'SET_CONFIG', 'block_size': 1024})
            self.assertIsNot(srv.audio_stream, first)
            self.assertFalse(first.state.is_running)
            self.assertTrue(srv.audio_stream.state.is_running)
            # Même réglage renvoyé : rien n'est recréé
            again = srv.audio_stream
            await srv._handle_message('c1', {'action': 'SET_CONFIG', 'block_size': 1024})
            self.assertIs(srv.audio_stream, again)
            await srv._handle_message('c1', {'action': 'STOP_STREAM'})
        self.run_async(go())
        self.assertEqual(fsd.STATE['opened'][-1]['blocksize'], 1024)
        self.assertEqual(len(fsd.STATE['opened']), 2)
        cs = ws.json('CONFIG_SET')
        self.assertTrue(cs[0]['stream_restarted'])
        self.assertEqual(cs[0]['config']['block_size'], 1024)
        self.assertEqual(cs[0]['stream']['block_size'], 1024)
        self.assertFalse(cs[1]['stream_restarted'])
        started = ws.json('STREAM_STARTED')
        self.assertEqual([s['block_size'] for s in started], [256, 1024])
        self.assertEqual(started[0]['input_channels'], 8)
        # Le retour direct survit à la recréation du flux
        self.assertEqual(srv.config.monitor_routes, [(1, 2, 0.7)])
        self.assertIs(srv.audio_stream.config, srv.config)

    def test_measure_latency_action(self):
        fsd.STATE['generator'] = None
        fsd.STATE['loopback'] = {0: [(0, 700), (1, 731)]}
        fsd.STATE['realtime'] = True
        srv, ws = self.make_server()

        async def go():
            srv.running = True
            await srv._handle_message('c1', {'action': 'START_STREAM'})
            await srv._handle_message('c1', {'action': 'MEASURE_LATENCY', 'out_channels': [0], 'seconds': 0.3})
            await srv._handle_message('c1', {'action': 'STOP_STREAM'})
        self.run_async(go())
        m = ws.json('LATENCY_MEASURED')[0]
        self.assertTrue(m['success'], m)
        self.assertEqual(m['delays'][:2], [700, 731])

    def test_binary_output_v2_goes_to_its_outputs(self):
        srv, ws = self.make_server()

        async def go():
            srv.running = True
            await srv._handle_message('c1', {'action': 'START_STREAM'})
            n = 1024
            b = np.zeros((n, 4), dtype=np.float32)
            b[:, 0] = 0.1
            b[:, 3] = 0.4
            msg = b'NVO2' + struct.pack('<II', n, 4) + struct.pack('<4i', 0, 1, 6, 7) + b.tobytes()
            await srv._handle_binary('c1', msg)
            fsd.streams[-1].step(8)
            await srv._handle_message('c1', {'action': 'STOP_STREAM'})
        self.run_async(go())
        out = fsd.streams[-1].captured()
        self.assertAlmostEqual(float(out[:, 0].max()), 0.1, places=5)
        self.assertAlmostEqual(float(out[:, 7].max()), 0.4, places=5)
        self.assertLess(float(np.abs(out[:, 2]).max()), 1e-7)


if __name__ == '__main__':
    unittest.main()
