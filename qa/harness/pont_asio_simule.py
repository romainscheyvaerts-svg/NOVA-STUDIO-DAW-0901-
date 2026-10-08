"""Pont ASIO SIMULÉ pour les scénarios navigateur (R14 / R15) : le VRAI serveur du pont
(bridge-python/asio_bridge.py) avec une carte son simulée (bridge-python/tests/
fake_sounddevice.py). Aucun pilote ASIO n'est chargé : ni la carte du studio, ni aucune
autre (chargement de pilote et lecture du registre ASIO désactivés).

La carte simulée « Carte simulée 8x8 » (QA_INS entrées, QA_OUTS sorties, 44,1 kHz) :
  - entrées 1 à 5 : sinus 220 / 330 / 440 / 550 / 660 Hz (0,2) ;
  - une impulsion (0,7) par seconde sur les entrées 1 à 4 EN MÊME TEMPS (un clap capté par
    tous les micros) ; l'entrée 3 la reçoit 24 échantillons plus tard (convertisseur
    ADAT, préampli externe) : c'est ce que la compensation par entrée doit rattraper ;
  - mesure de latence : boucle sortie 1 → entrées 1-4 (384 échantillons, 408 pour l'entrée 3).

Actions de test en plus du protocole : QA_DUMP {path, seconds} (sorties écrites par la
carte, .npy images × canaux), QA_STATS (flux ouverts : tampon, canaux).

Usage : <python du pont> qa/harness/pont_asio_simule.py  (port : NOVA_ASIO_PORT, 8796 par défaut)
"""
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bridge-python" / "tests"))
sys.path.insert(0, str(ROOT / "bridge-python"))
import fake_sounddevice as fsd  # noqa: E402
fsd.install()
import asio_bridge as ab  # noqa: E402

SR = int(os.environ.get("QA_SR", "44100"))
INS = int(os.environ.get("QA_INS", "8"))
OUTS = int(os.environ.get("QA_OUTS", "8"))
PORT = int(os.environ.get("NOVA_ASIO_PORT", "8796"))
FREQS = [220.0, 330.0, 440.0, 550.0, 660.0, 0, 0, 0]
EXTRA = {2: 24}          # entrée 3 : 24 échantillons de retard propre
LOOP_D = 384             # aller-retour de la boucle de mesure (échantillons)

logging.getLogger('NovaASIO').setLevel(logging.WARNING)


def generator(frame, frames, n_in, sr):
    idx = frame + np.arange(frames)
    out = np.zeros((frames, n_in), dtype=np.float32)
    for c in range(min(n_in, len(FREQS))):
        if not FREQS[c]:
            continue
        k = idx - EXTRA.get(c, 0)
        out[:, c] = 0.2 * np.sin(2 * np.pi * FREQS[c] * k / sr)
        if c < 4:
            out[(k >= 0) & (k % int(sr) == 0), c] += 0.7
    return out


fsd.STATE['devices'] = [{'name': 'Carte simulée 8x8', 'hostapi': 0, 'max_input_channels': INS, 'max_output_channels': OUTS, 'default_samplerate': float(SR)}]
fsd.STATE['generator'] = generator
fsd.STATE['capture_seconds'] = 90.0
fsd.STATE['realtime'] = True

# Jamais de vrai pilote : ni chargement COM, ni registre ASIO.
ab.ASIODriverInstance.load = lambda self, name: False
ab.ASIODeviceManager._scan_asio_registry = lambda self: setattr(self, 'asio_drivers', [])

# Mesure de latence : la boucle n'existe que le temps de la mesure (sinon le mix revient dans les micros).
_start_probe = ab.ASIOAudioStream.start_latency_probe
_finish_probe = ab.ASIOAudioStream.finish_latency_probe


def start_probe(self, outs, seconds=0.6, amp=0.5):
    fsd.STATE['generator'] = None
    fsd.STATE['loopback'] = {0: [(c, LOOP_D + EXTRA.get(c, 0)) for c in range(4)]}
    return _start_probe(self, outs, seconds, amp)


def finish_probe(self, p):
    fsd.STATE['loopback'] = {}
    fsd.STATE['generator'] = generator
    return _finish_probe(self, p)


ab.ASIOAudioStream.start_latency_probe = start_probe
ab.ASIOAudioStream.finish_latency_probe = finish_probe


class QAServer(ab.ASIOBridgeServer):
    async def _handle_message(self, client_id, data):
        a = data.get("action")
        if a == "QA_DUMP":
            st = fsd.streams[-1] if fsd.streams else None
            x = st.captured() if st else np.zeros((0, OUTS), np.float32)
            n = int(float(data.get("seconds", 2)) * SR)
            np.save(data["path"], x[-n:] if n > 0 else x)
            await self._send(client_id, {"action": "QA_DUMPED", "frames": int(min(n, len(x))), "channels": int(x.shape[1]) if x.ndim == 2 else 0})
            return
        if a == "QA_STATS":
            await self._send(client_id, {"action": "QA_STATS", "opened": fsd.STATE['opened'], "frames": fsd.streams[-1].frame if fsd.streams else 0,
                                         "monitor_routes": [list(r) for r in self.config.monitor_routes], "direct": self.config.direct_monitor})
            return
        await super()._handle_message(client_id, data)


async def main():
    srv = QAServer(host="127.0.0.1", port=PORT)
    srv.config.sample_rate = SR
    await srv.start()


if __name__ == "__main__":
    asyncio.run(main())
