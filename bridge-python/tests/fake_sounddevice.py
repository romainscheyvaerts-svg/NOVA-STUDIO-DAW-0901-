"""Faux module `sounddevice` (PortAudio simulé) pour tester le pont ASIO SANS carte son.

Le vrai pilote ASIO du studio n'est jamais chargé : ce module remplace `sounddevice`
dans sys.modules AVANT l'import de asio_bridge.

- Une carte « Carte simulée 8x8 » : 8 entrées, 8 sorties.
- `generator(frame_index, frames, n_in)` fabrique les entrées de chaque bloc (sinus
  différents par canal, impulsions communes…).
- `loopback` : {sortie: [(entrée, retard en échantillons), …]} — ce qui sort sur une
  sortie revient sur ces entrées (câble de boucle, mesure de latence par canal).
- `captured` : tout ce que le flux a écrit sur les sorties (images × canaux).
- Deux modes : temps réel (fil qui cadence les blocs, scénario navigateur) ou pas à pas
  (`stream.step(n)` dans les tests unitaires).
"""
import threading
import time

import numpy as np

__version__ = "fake-0.1"

STATE = {
    'devices': [
        {'name': 'Carte simulée 8x8', 'hostapi': 0, 'max_input_channels': 8, 'max_output_channels': 8, 'default_samplerate': 44100.0},
    ],
    'latency': (0.0029, 0.0058),        # (entrée, sortie) annoncées par le « pilote »
    'generator': None,
    'loopback': {},
    'capture_seconds': 30.0,
    'opened': [],                       # paramètres de chaque flux ouvert (tests)
    'realtime': True,
    'block_jitter': 0.0,
}

streams = []


class CallbackFlags:
    def __init__(self):
        self.input_overflow = False
        self.output_underflow = False

    def __bool__(self):
        return self.input_overflow or self.output_underflow


class _TimeInfo:
    def __init__(self, adc):
        self.inputBufferAdcTime = adc
        self.outputBufferDacTime = adc
        self.currentTime = adc


class PortAudioError(Exception):
    pass


def query_hostapis(index=None):
    apis = [{'name': 'ASIO', 'devices': [0]}]
    return apis if index is None else apis[index]


def query_devices(device=None, kind=None):
    devs = STATE['devices']
    if device is None and kind is None:
        return list(devs)
    if isinstance(device, int):
        return dict(devs[device])
    return dict(devs[0])


class Stream:
    def __init__(self, device=None, samplerate=44100, blocksize=256, dtype=None, channels=(2, 2), callback=None, latency='low', **_):
        self.device = device
        self.samplerate = float(samplerate)
        self.blocksize = int(blocksize)
        self.channels = channels
        self.callback = callback
        self.latency = STATE['latency']
        self.active = False
        self.closed = False
        self.frame = 0
        n_in, n_out = channels
        self.n_in, self.n_out = int(n_in), int(n_out)
        cap = int(STATE['capture_seconds'] * self.samplerate)
        self.capture = np.zeros((cap, self.n_out), dtype=np.float32)
        self.cap_pos = 0
        # Historique des sorties pour la boucle (retards jusqu'à 1 s)
        self.hist = np.zeros((int(self.samplerate) + self.blocksize, self.n_out), dtype=np.float32)
        self._thread = None
        self._stop = threading.Event()
        self.lock = threading.Lock()
        STATE['opened'].append({'samplerate': self.samplerate, 'blocksize': self.blocksize, 'channels': (self.n_in, self.n_out)})
        streams.append(self)

    # ── un bloc ──────────────────────────────────────────────────────────────
    def step(self, n=1):
        for _ in range(n):
            f = self.blocksize
            gen = STATE['generator']
            indata = gen(self.frame, f, self.n_in, self.samplerate) if gen else np.zeros((f, self.n_in), dtype=np.float32)
            indata = np.array(indata, dtype=np.float32).reshape(f, self.n_in)
            # Boucle : sorties passées → entrées
            for out_ch, targets in STATE['loopback'].items():
                if out_ch >= self.n_out:
                    continue
                for (in_ch, delay) in targets:
                    if in_ch >= self.n_in:
                        continue
                    k = self.frame + np.arange(f) - int(delay)
                    ok = k >= 0
                    indata[ok, in_ch] += self.hist[k[ok] % self.hist.shape[0], out_ch]
            outdata = np.zeros((f, self.n_out), dtype=np.float32)
            if self.callback:
                self.callback(indata, outdata, f, _TimeInfo(self.frame / self.samplerate), CallbackFlags())
            with self.lock:
                self.hist[(self.frame + np.arange(f)) % self.hist.shape[0]] = outdata
                n = min(f, self.capture.shape[0] - self.cap_pos)
                if n > 0:
                    self.capture[self.cap_pos:self.cap_pos + n] = outdata[:n]
                    self.cap_pos += n
                else:
                    # Capture pleine : on garde les dernières secondes
                    self.capture = np.roll(self.capture, -f, axis=0)
                    self.capture[-f:] = outdata
            self.frame += f

    def _run(self):
        period = self.blocksize / self.samplerate
        t0 = time.perf_counter()
        k = 0
        while not self._stop.is_set():
            self.step(1)
            k += 1
            target = t0 + k * period
            d = target - time.perf_counter()
            if d > 0:
                time.sleep(d)
            elif d < -0.5:
                t0 = time.perf_counter() - k * period    # retard énorme (machine chargée) : on recale

    def start(self):
        self.active = True
        if STATE['realtime']:
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def stop(self):
        self.active = False
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    def close(self):
        self.closed = True

    def captured(self):
        with self.lock:
            return self.capture[:self.cap_pos].copy()


def install():
    """Remplace `sounddevice` par ce module (à appeler AVANT `import asio_bridge`)."""
    import sys
    sys.modules['sounddevice'] = sys.modules[__name__]
