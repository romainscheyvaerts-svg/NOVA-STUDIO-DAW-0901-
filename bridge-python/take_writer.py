"""Prises écrites par le pont ASIO lui-même (chantier C1 : zéro trou).

Avant, la prise ASIO était écrite par le navigateur, après le pont et la WebSocket : si la
page se figeait (ramasse-miettes, interface occupée), la prise avait des trous. Ici :

  callback ASIO ──copie──▶ CaptureRing (anneau, sans verrou) ──▶ fil d'écriture ──▶ WAV sur disque

- Le callback ne fait qu'une copie dans l'anneau (toutes les entrées de la carte) : aucun
  verrou, aucune entrée/sortie disque. Un seul producteur (le callback), un seul
  consommateur (le fil d'écriture) ; les positions sont ABSOLUES, en images de la carte
  (même numérotation que les blocs v2 envoyés à la page).
- L'anneau garde aussi quelques secondes d'historique : la prise commence un peu AVANT la
  demande (pré-capture), la page retire ce qui précède son premier échantillon.
- Un fil d'écriture vide l'anneau dans un WAV par piste armée (32 bits flottants : les
  échantillons de la carte au bit près). L'en-tête est mis à jour toutes les 0,5 s : après
  un plantage, le fichier reste lisible (et `repair_wav` recale l'en-tête sur la taille).
- Pertes : si le fil d'écriture prend trop de retard (anneau écrasé) ou si la carte perd
  des blocs (drapeau `input_overflow` du pilote), des zéros sont écrits À LA PLACE des
  images perdues (la suite reste calée) et la perte est notée dans les métadonnées.
- Multipiste : toutes les pistes d'un passage lisent le même anneau, aux mêmes positions :
  leurs fichiers sont synchronisés à l'échantillon.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import re
import struct
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger('NovaASIO')

TAKE_ID_RX = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# Marge de sécurité de l'anneau : un bloc en cours d'écriture par le callback (pas encore
# publié) peut recouvrir jusqu'à ce nombre d'images au-delà de write_abs.
RING_MARGIN = 8192
# Pré-capture : la prise commence ce temps avant la demande (la page coupe au bon endroit).
PREROLL_SECONDS = 1.0
HEADER_EVERY = 0.5      # s : en-tête WAV à jour (fichier lisible après un plantage)
FSYNC_EVERY = 2.0       # s : données forcées sur le disque
WAV_HEADER = 58         # RIFF + fmt (18) + fact + data, voir WavWriter


# ─────────────────────────────────────────────────────────────────────────────
# Anneau de capture (callback → fil d'écriture)
# ─────────────────────────────────────────────────────────────────────────────

class CaptureRing:
    """Anneau d'images (toutes les entrées de la carte), un producteur / un consommateur.

    `write_abs` (n° absolu de la prochaine image) n'est publié qu'APRÈS la copie : le
    lecteur ne lit jamais une zone en cours d'écriture. Une lecture qui aurait pu être
    écrasée pendant sa copie est détectée après coup (voir `read`)."""

    def __init__(self, channels: int, sample_rate: int, seconds: float = 6.0, max_bytes: int = 64 << 20):
        channels = max(1, int(channels))
        cap = int(seconds * sample_rate)
        per = channels * 4
        if cap * per > max_bytes:
            cap = max(int(2 * sample_rate), max_bytes // per)
        self.size = max(4 * RING_MARGIN, cap)
        self.channels = channels
        self.sample_rate = int(sample_rate)
        self.buf = np.zeros((self.size, channels), dtype=np.float32)
        self.write_abs = 0
        # Pertes côté carte : (n° absolu, images, nature, silence inséré ?). list.append est atomique.
        self.events: List[tuple] = []

    # ── producteur (callback ASIO) ───────────────────────────────────────────
    def write(self, block: np.ndarray) -> None:
        n = int(block.shape[0])
        if n <= 0:
            return
        w = self.write_abs
        if n > self.size - RING_MARGIN:
            block = block[-(self.size - RING_MARGIN):]
            w += n - block.shape[0]
            n = int(block.shape[0])
        p = w % self.size
        ch = min(self.channels, block.shape[1]) if block.ndim == 2 else 1
        first = min(n, self.size - p)
        if block.ndim == 1:
            block = block.reshape(-1, 1)
        self.buf[p:p + first, :ch] = block[:first, :ch]
        if n > first:
            self.buf[:n - first, :ch] = block[first:n, :ch]
        self.write_abs = w + n

    def skip(self, frames: int, kind: str = 'asio') -> int:
        """Images perdues par la carte : du silence à leur place (la suite reste calée).
        Rend le nombre d'images insérées (borné à la moitié de l'anneau)."""
        frames = int(frames)
        if frames <= 0:
            return 0
        n = min(frames, self.size // 2)
        w = self.write_abs
        p = w % self.size
        first = min(n, self.size - p)
        self.buf[p:p + first] = 0
        if n > first:
            self.buf[:n - first] = 0
        self.events.append((w, n, kind, True))
        self.write_abs = w + n
        return n

    def note_loss(self, frames: int, kind: str = 'asio') -> None:
        """Perte signalée par le pilote sans durée mesurable : comptée, rien d'inséré."""
        self.events.append((self.write_abs, int(frames), kind, False))

    # ── consommateur (fil d'écriture) ────────────────────────────────────────
    def oldest(self) -> int:
        """Plus ancienne image encore lisible sans risque."""
        return max(0, self.write_abs + RING_MARGIN - self.size)

    def read(self, start: int, n: int):
        """Copie des images [start, start+n). Rend (données, images du début écrasées
        pendant la copie : remplacées par des zéros, à compter comme perdues)."""
        out = np.empty((n, self.channels), dtype=np.float32)
        p = start % self.size
        first = min(n, self.size - p)
        out[:first] = self.buf[p:p + first]
        if n > first:
            out[first:] = self.buf[:n - first]
        bad = max(0, min(n, self.oldest() - start))
        if bad:
            out[:bad] = 0
        return out, bad


# ─────────────────────────────────────────────────────────────────────────────
# WAV 32 bits flottants, en-tête réécrit au fil de l'eau
# ─────────────────────────────────────────────────────────────────────────────

def _wav_header(channels: int, sample_rate: int, frames: int) -> bytes:
    align = 4 * channels
    data = frames * align
    return (b'RIFF' + struct.pack('<I', WAV_HEADER - 8 + data) + b'WAVE'
            + b'fmt ' + struct.pack('<IHHIIHHH', 18, 3, channels, sample_rate, sample_rate * align, align, 32, 0)
            + b'fact' + struct.pack('<II', 4, frames)
            + b'data' + struct.pack('<I', data))


class WavWriter:
    """WAV IEEE float 32 bits (format 3), écrit en continu."""

    def __init__(self, path: Path, channels: int, sample_rate: int):
        self.path = Path(path)
        self.channels = max(1, int(channels))
        self.sample_rate = int(sample_rate)
        self.frames = 0
        self.f = open(self.path, 'wb')
        self.f.write(_wav_header(self.channels, self.sample_rate, 0))
        self.f.flush()

    def write(self, x: np.ndarray) -> None:
        x = np.ascontiguousarray(x, dtype='<f4')
        self.f.write(x.tobytes())
        self.frames += int(x.shape[0])

    def update_header(self, fsync: bool = False) -> None:
        h = _wav_header(self.channels, self.sample_rate, self.frames)
        pos = self.f.tell()
        self.f.seek(0)
        self.f.write(h)
        self.f.seek(pos)
        self.f.flush()
        if fsync:
            try:
                os.fsync(self.f.fileno())
            except OSError:
                pass

    def close(self) -> None:
        try:
            self.update_header(fsync=True)
        finally:
            self.f.close()


def repair_wav(path: Path) -> int:
    """En-tête recalé sur la taille réelle du fichier (pont arrêté net pendant une prise).
    Rend le nombre d'images. Ne touche qu'aux WAV écrits par WavWriter."""
    path = Path(path)
    with open(path, 'r+b') as f:
        head = f.read(WAV_HEADER)
        if len(head) < WAV_HEADER or head[:4] != b'RIFF' or head[50:54] != b'data':
            raise ValueError('WAV inconnu')
        _, _, channels, sr, _, align, bits, _ = struct.unpack_from('<IHHIIHHH', head, 16)
        size = os.fstat(f.fileno()).st_size
        frames = max(0, (size - WAV_HEADER) // max(1, align))
        if struct.unpack_from('<I', head, 54)[0] != frames * align:
            f.seek(0)
            f.write(_wav_header(channels, sr, frames))
            f.truncate(WAV_HEADER + frames * align)
        return frames


# ─────────────────────────────────────────────────────────────────────────────
# Prise en cours
# ─────────────────────────────────────────────────────────────────────────────

def documents_dir() -> Path:
    """Dossier Documents de l'utilisateur (redirection OneDrive comprise)."""
    if sys.platform == 'win32':
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(260)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
                return Path(buf.value)
        except Exception:
            pass
    return Path.home() / 'Documents'


def takes_root() -> Path:
    """Documents\\Nova Studio\\Prises (NOVA_TAKES_DIR : autre dossier, pour les tests)."""
    env = os.environ.get('NOVA_TAKES_DIR')
    return Path(env) if env else documents_dir() / 'Nova Studio' / 'Prises'


def safe_name(s: Any, fallback: str = 'Sans titre', limit: int = 60) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', ' ', str(s or ''))
    s = re.sub(r'\s+', ' ', s).strip(' .')
    return (s[:limit].strip(' .') or fallback)


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    for _ in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:          # Windows : fichier ouvert un instant par un autre lecteur
            time.sleep(0.02)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')


class TakeTrack:
    """Une piste d'une prise : ses entrées de la carte, comment les lire, son fichier."""

    def __init__(self, spec: dict, path: Path, sample_rate: int):
        self.track_id = str(spec['track_id'])
        self.name = str(spec.get('name') or self.track_id)
        self.inputs = [int(c) for c in spec['inputs']]
        self.mode = spec.get('mode') or ('stereo' if len(self.inputs) == 2 else 'mono')
        width = 2 if self.mode == 'stereo' else 1
        self.wav = WavWriter(path, width, sample_rate)

    def columns(self, x: np.ndarray) -> np.ndarray:
        n, nch = x.shape
        col = lambda c: x[:, c] if 0 <= c < nch else np.zeros(n, np.float32)  # noqa: E731
        if self.mode == 'stereo':
            return np.stack([col(self.inputs[0]), col(self.inputs[1])], axis=1)
        if self.mode == 'sum':
            # Entrée « auto » sur la carte : entrées additionnées en float32, comme le graphe audio.
            acc = col(self.inputs[0]).astype(np.float32, copy=True)
            for c in self.inputs[1:]:
                acc = acc + col(c)
            return acc.reshape(-1, 1)
        return col(self.inputs[0]).reshape(-1, 1)


class TakeSession:
    def __init__(self, ring: CaptureRing, take_id: str, folder: Path, project: dict, tracks: List[dict],
                 start_frame: int, block_size: int, client_id: Optional[str], position: Optional[float]):
        self.ring = ring
        self.take_id = take_id
        self.folder = folder
        self.sample_rate = ring.sample_rate
        self.block_size = max(1, int(block_size))
        self.client_id = client_id
        self.start_frame = int(start_frame)
        self.next = int(start_frame)
        self.stop_at: Optional[int] = None
        self.status = 'en cours'
        self.error: Optional[str] = None
        self.losses: List[dict] = []
        self.done = threading.Event()
        self._ev_seen = len(ring.events)
        self._last_header = time.monotonic()
        self._last_sync = time.monotonic()
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime('%Y-%m-%d %Hh%Mm%S')
        self.tracks: List[TakeTrack] = []
        used = set()
        for spec in tracks:
            base = f"{stamp} - {safe_name(spec.get('name') or spec['track_id'], 'Piste', 40)} - {take_id}"
            name = base
            k = 2
            while name in used:
                name = f'{base} ({k})'
                k += 1
            used.add(name)
            self.tracks.append(TakeTrack(spec, folder / f'{name}.wav', self.sample_rate))
        self.meta_path = folder / f'{take_id}.json'
        self.meta: Dict[str, Any] = {
            'version': 1, 'take_id': take_id, 'status': self.status,
            'project_id': project.get('id'), 'project_name': project.get('name'),
            'created': datetime.datetime.now().isoformat(timespec='seconds'),
            'sample_rate': self.sample_rate, 'block_size': self.block_size,
            'start_frame': self.start_frame, 'end_frame': None, 'frames': 0,
            'position': position, 'anchor': None,
            'files': [{'track_id': t.track_id, 'name': t.name, 'file': t.wav.path.name, 'inputs': t.inputs,
                       'mode': t.mode, 'channels': t.wav.channels} for t in self.tracks],
            'losses': [], 'lost_blocks': 0, 'lost_frames': 0, 'imported': False,
        }
        self.save_meta()

    # ── métadonnées ──────────────────────────────────────────────────────────
    def lost_blocks(self) -> int:
        return sum(max(1, int(round(l['frames'] / self.block_size))) for l in self.losses)

    def save_meta(self) -> None:
        self.meta.update({'status': self.status, 'frames': self.next - self.start_frame, 'losses': self.losses,
                          'lost_blocks': self.lost_blocks(), 'lost_frames': sum(int(l['frames']) for l in self.losses),
                          **({'error': self.error} if self.error else {})})
        try:
            _write_json(self.meta_path, self.meta)
        except OSError as e:
            logger.error(f'Prise {self.take_id} : métadonnées non écrites ({e})')

    def add_loss(self, frame: int, frames: int, kind: str, inserted: bool = True) -> None:
        # Pertes contiguës de même nature : une seule entrée.
        if self.losses:
            last = self.losses[-1]
            if last['kind'] == kind and last['frame'] + last['frames'] == frame and inserted:
                last['frames'] += int(frames)
                return
        self.losses.append({'frame': int(frame), 'at': round((frame - self.start_frame) / self.sample_rate, 4),
                            'frames': int(frames), 'kind': kind, 'filled': bool(inserted)})
        logger.warning(f'Prise {self.take_id} : {frames} images perdues ({kind}) à {(frame - self.start_frame) / self.sample_rate:.2f} s')

    # ── écriture (fil d'écriture seulement) ──────────────────────────────────
    def _write(self, x: np.ndarray) -> None:
        if self.error:
            return
        try:
            for t in self.tracks:
                t.wav.write(t.columns(x))
        except OSError as e:
            self.error = f"Écriture impossible sur le disque : {e}"
            logger.error(f'Prise {self.take_id} : {self.error}')

    def _note_card_events(self) -> None:
        ev = self.ring.events
        while self._ev_seen < len(ev):
            frame, frames, kind, inserted = ev[self._ev_seen]
            self._ev_seen += 1
            if frame >= self.start_frame and (self.stop_at is None or frame < self.stop_at):
                self.add_loss(frame, frames, kind, inserted)

    def drain(self, chunk: int = 16384) -> None:
        ring = self.ring
        self._note_card_events()
        limit = ring.write_abs if self.stop_at is None else min(ring.write_abs, self.stop_at)
        while self.next < limit:
            oldest = ring.oldest()
            if self.next < oldest:
                # Fil d'écriture trop en retard : l'anneau a été réécrit. Silence à la place,
                # la suite reste à sa place.
                lost = min(oldest, limit) - self.next
                self._write(np.zeros((lost, ring.channels), np.float32))
                self.add_loss(self.next, lost, 'tampon')
                self.next += lost
                continue
            n = min(limit - self.next, chunk)
            x, bad = ring.read(self.next, n)
            if bad:
                self.add_loss(self.next, bad, 'tampon')
            self._write(x)
            self.next += n
        now = time.monotonic()
        if now - self._last_header >= HEADER_EVERY:
            self._last_header = now
            sync = now - self._last_sync >= FSYNC_EVERY
            if sync:
                self._last_sync = now
            self._headers(sync)
            self.save_meta()

    def _headers(self, fsync: bool) -> None:
        for t in self.tracks:
            try:
                t.wav.update_header(fsync)
            except OSError as e:
                self.error = self.error or f"Écriture impossible sur le disque : {e}"

    def finish(self, status: str = 'terminée') -> None:
        self._note_card_events()
        for t in self.tracks:
            try:
                t.wav.close()
            except OSError as e:
                self.error = self.error or f"Écriture impossible sur le disque : {e}"
        self.status = status
        self.meta['end_frame'] = self.next
        self.save_meta()
        self.done.set()

    def result(self) -> dict:
        return {
            'take_id': self.take_id, 'status': self.status, 'sample_rate': self.sample_rate,
            'start_frame': self.start_frame, 'end_frame': self.next, 'block_size': self.block_size,
            'dir': str(self.folder), 'meta': str(self.meta_path),
            'files': [{'track_id': t.track_id, 'path': str(t.wav.path), 'frames': t.wav.frames, 'channels': t.wav.channels,
                       'inputs': t.inputs, 'mode': t.mode} for t in self.tracks],
            'losses': self.losses, 'lost_blocks': self.lost_blocks(),
            'lost_frames': sum(int(l['frames']) for l in self.losses), 'error': self.error,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Gestionnaire (côté serveur) + fil d'écriture
# ─────────────────────────────────────────────────────────────────────────────

class TakeManager:
    def __init__(self, root: Optional[Path] = None, period: float = 0.02, threaded: bool = True):
        self.root = Path(root) if root else takes_root()
        self.period = period
        # threaded=False : pas de fil d'écriture, `pump()` appelé à la main (tests pas à pas).
        self.threaded = threaded
        self._pump_lock = threading.Lock()
        self.active: Dict[str, TakeSession] = {}
        self.finished: Dict[str, dict] = {}       # take_id → résultat (cette exécution du pont)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._quit = False

    # ── fil d'écriture ───────────────────────────────────────────────────────
    def _ensure_thread(self) -> None:
        if not self.threaded or (self._thread and self._thread.is_alive()):
            return
        self._quit = False
        self._thread = threading.Thread(target=self._run, name='nova-prises', daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._quit:
            self._wake.wait(self.period)
            self._wake.clear()
            self.pump()

    def pump(self) -> None:
        """Un passage du fil d'écriture (appelé aussi directement par les tests pas à pas).
        Jamais deux passages en même temps : un seul consommateur pour l'anneau."""
        with self._pump_lock:
            self._pump()

    def _pump(self) -> None:
        with self._lock:
            sessions = list(self.active.values())
        for s in sessions:
            try:
                s.drain()
                if s.stop_at is not None and s.next >= s.stop_at:
                    self._close(s, s.status if s.status != 'en cours' else 'terminée')
            except Exception as e:  # le fil ne doit jamais mourir
                logger.error(f'Prise {s.take_id} : {e}')
                s.error = s.error or str(e)
                self._close(s, 'interrompue')

    def _close(self, s: TakeSession, status: str) -> None:
        with self._lock:
            if self.active.get(s.take_id) is not s:
                return
            del self.active[s.take_id]
        s.finish(status)
        self.finished[s.take_id] = s.result()

    def shutdown(self) -> None:
        self._quit = True
        self._wake.set()

    # ── commandes ────────────────────────────────────────────────────────────
    def start(self, ring: CaptureRing, take_id: str, project: dict, tracks: List[dict], block_size: int,
              client_id: Optional[str] = None, position: Optional[float] = None,
              preroll: float = PREROLL_SECONDS) -> TakeSession:
        if not TAKE_ID_RX.match(take_id or ''):
            raise ValueError('identifiant de prise invalide')
        if take_id in self.active or take_id in self.finished:
            raise ValueError('prise déjà commencée')
        if not tracks:
            raise ValueError('aucune piste à enregistrer')
        folder = self.root / safe_name(project.get('name') or project.get('id'), 'Projet sans nom')
        start = max(ring.oldest(), ring.write_abs - int(max(0.0, min(3.0, preroll)) * ring.sample_rate))
        s = TakeSession(ring, take_id, folder, project, tracks, start, block_size, client_id, position)
        with self._lock:
            self.active[take_id] = s
        self._ensure_thread()
        return s

    def anchor(self, take_id: str, anchor: dict) -> bool:
        s = self.active.get(take_id)
        if s is None:
            return False
        s.meta['anchor'] = anchor
        s.save_meta()
        return True

    def stop(self, take_id: str, end_frame: Optional[int] = None, timeout: float = 10.0,
             status: str = 'terminée') -> Optional[dict]:
        """Fin de la prise à `end_frame` (défaut : maintenant) ; attend la fin de l'écriture."""
        s = self.active.get(take_id)
        if s is None:
            return self.finished.get(take_id)
        s.stop_at = int(end_frame) if end_frame is not None else s.ring.write_abs
        if status != 'terminée':
            s.status = status
        self._wake.set()
        if self._thread is None or not self._thread.is_alive():
            self.pump()
        s.done.wait(timeout)
        return self.finished.get(take_id) or s.result()

    def stop_all(self, status: str = 'interrompue', client_id: Optional[str] = None, timeout: float = 10.0) -> List[dict]:
        out = []
        for tid, s in list(self.active.items()):
            if client_id is None or s.client_id == client_id:
                out.append(self.stop(tid, None, timeout, status))
        return out

    def mark_imported(self, take_id: str) -> bool:
        meta = self.find_meta(take_id)
        if not meta:
            return False
        try:
            data = json.loads(meta.read_text(encoding='utf-8'))
            data['imported'] = True
            _write_json(meta, data)
            return True
        except (OSError, ValueError):
            return False

    def find_meta(self, take_id: str) -> Optional[Path]:
        if not TAKE_ID_RX.match(take_id or ''):
            return None
        s = self.active.get(take_id)
        if s:
            return s.meta_path
        r = self.finished.get(take_id)
        if r:
            return Path(r['meta'])
        try:
            for p in self.root.rglob(f'{take_id}.json'):
                return p
        except OSError:
            pass
        return None

    def file_for(self, take_id: str, track_id: str) -> Optional[Path]:
        """Fichier d'une piste d'une prise (seulement ceux listés dans ses métadonnées,
        dans le dossier des prises). Une prise coupée net (pont arrêté) est réparée."""
        if take_id in self.active:
            return None                              # encore en cours d'écriture
        meta = self.find_meta(take_id)
        if not meta:
            return None
        try:
            data = json.loads(meta.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None
        root = self.root.resolve()
        for f in data.get('files') or []:
            if str(f.get('track_id')) != str(track_id):
                continue
            p = (meta.parent / str(f.get('file') or '')).resolve()
            if root not in p.parents or p.suffix.lower() != '.wav' or not p.is_file():
                return None
            if data.get('status') == 'en cours':
                try:
                    repair_wav(p)
                except (OSError, ValueError):
                    return None
            return p
        return None

    def read_meta(self, take_id: str) -> Optional[dict]:
        meta = self.find_meta(take_id)
        if not meta:
            return None
        try:
            return json.loads(meta.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None
