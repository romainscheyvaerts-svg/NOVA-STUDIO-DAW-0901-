"""Pont Pro Tools (chantier 9, B2) : prises BWF écrites dans le dossier choisi par l'ingé.

L'ingé garde Pro Tools. Chaque prise de l'artiste posée chez lui par la collaboration NOVA
est aussi écrite ici, en WAV BWF horodaté (chunk « bext » TimeReference = position de la
prise dans le morceau + départ de la séance Pro Tools, en échantillons) : Pro Tools
l'importe en mode Spot (« Original Time Stamp ») à l'échantillon près.

Les octets du fichier sont fabriqués par la page (utils/bwf.ts : un seul encodeur pour
le pont, le dossier du navigateur et le téléchargement). Le pont :
  - vérifie le nom (`<piste>_Prise <n>_<artiste>.wav`, caractères interdits refusés) et le
    dossier (chemin absolu, jamais un dossier du système) ;
  - vérifie que c'est bien un WAV BWF (RIFF/WAVE, fmt, bext, data, tailles cohérentes) ;
  - écrit de façon atomique (fichier temporaire, fsync, renommage) : Pro Tools ne voit
    jamais un fichier à moitié écrit ;
  - fichier déjà ouvert dans Pro Tools (verrouillé, ne peut pas être remplacé) : la
    nouvelle version est écrite à côté, « … (2).wav », et le pont le dit.

`read_bwf` relit un fichier (tests, qa/pont_protools.py).
"""
from __future__ import annotations

import os
import re
import struct
import threading
import time
from pathlib import Path
from typing import Optional, Tuple

import project_store

NAME_RX = re.compile(r'^[^<>:"/\\|?*\x00-\x1f]{1,140}\.wav$', re.IGNORECASE)
RESERVED_RX = re.compile(r'(?i)^(con|prn|aux|nul|com\d|lpt\d)$')
MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1       # WAV RIFF : 4 Go maxi, on reste sous 2 Go
TMP_TAG = '.nova-pt.tmp'


class ProToolsFileError(Exception):
    pass


def default_folder() -> Path:
    """Documents\\Nova Studio\\Pro Tools (à côté des projets). NOVA_PT_DIR : autre dossier (tests)."""
    env = os.environ.get('NOVA_PT_DIR')
    return Path(env) if env else project_store.default_root().parent / 'Pro Tools'


def _forbidden_roots():
    roots = []
    for var in ('SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData'):
        v = os.environ.get(var)
        if v:
            try:
                roots.append(Path(v).resolve())
            except OSError:
                pass
    return roots


def check_folder(folder: str) -> Path:
    """Dossier demandé par la page : absolu, local ou réseau, jamais un dossier du système."""
    s = str(folder or '').strip()
    if not s:
        return default_folder()
    p = Path(s)
    if not p.is_absolute():
        raise ProToolsFileError('Le dossier doit être un chemin complet (ex. D:\\Séances\\Pro Tools\\Prises).')
    try:
        r = p.resolve()
    except OSError as e:
        raise ProToolsFileError(f'Dossier inaccessible : {e}')
    for root in _forbidden_roots():
        if r == root or root in r.parents:
            raise ProToolsFileError('Ce dossier appartient à Windows ou aux programmes : choisis un dossier de séance.')
    if r == Path(r.anchor):
        raise ProToolsFileError('Choisis un dossier, pas la racine du disque.')
    return r


def check_name(name: str) -> str:
    n = str(name or '').strip()
    if not NAME_RX.match(n) or n.startswith('.') or RESERVED_RX.match(n[:-4].strip()):
        raise ProToolsFileError('Nom de fichier refusé.')
    return n


def check_bwf(data: bytes) -> dict:
    """En-tête d'un WAV BWF (fmt + bext + data). Renvoie les informations utiles."""
    if len(data) < 12 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ProToolsFileError("Ce n'est pas un fichier WAV.")
    if struct.unpack_from('<I', data, 4)[0] + 8 != len(data):
        raise ProToolsFileError('Fichier WAV incomplet.')
    info = {}
    p = 12
    while p + 8 <= len(data):
        cid = data[p:p + 4]
        size = struct.unpack_from('<I', data, p + 4)[0]
        if p + 8 + size > len(data):
            raise ProToolsFileError('Chunk WAV tronqué.')
        if cid == b'fmt ':
            tag, nch, sr, _, align, bits = struct.unpack_from('<HHIIHH', data, p + 8)
            info.update(format=tag, channels=nch, sample_rate=sr, align=align, bits=bits)
        elif cid == b'bext':
            if size < 602:
                raise ProToolsFileError('Chunk bext trop court.')
            lo, hi = struct.unpack_from('<II', data, p + 8 + 338)
            info['time_reference'] = lo + (hi << 32)
        elif cid == b'data':
            info['data_bytes'] = size
        p += 8 + size + (size & 1)
    for k, what in (('format', 'fmt'), ('time_reference', 'bext'), ('data_bytes', 'data')):
        if k not in info:
            raise ProToolsFileError(f'Chunk « {what} » absent : ce n’est pas un BWF horodaté.')
    if info['format'] not in (1, 3) or info['sample_rate'] not in (44100, 48000, 88200, 96000, 176400, 192000):
        raise ProToolsFileError('Format audio non pris en charge.')
    return info


def _try_replace(tmp: Path, path: Path, tries: int = 4) -> bool:
    """Renomme le temporaire par-dessus `path`. False : fichier verrouillé (ouvert dans Pro Tools)."""
    for attempt in range(tries):
        try:
            os.replace(tmp, path)
            return True
        except PermissionError:
            time.sleep(0.04 * (attempt + 1))
    return False


def write_take(folder: str, name: str, data: bytes) -> Tuple[Path, bool]:
    """Écrit la prise. Rend (chemin écrit, renommé ?)."""
    if len(data) > MAX_BYTES:
        raise ProToolsFileError('Prise trop longue pour un seul fichier WAV.')
    d = check_folder(folder)
    n = check_name(name)
    check_bwf(data)
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ProToolsFileError(f'Impossible de créer le dossier : {e}')
    tmp = d / f'.{n}.{os.getpid()}.{threading.get_ident()}{TMP_TAG}'
    try:
        with open(tmp, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        target = d / n
        if _try_replace(tmp, target):
            return target, False
        stem = n[:-4]
        for k in range(2, 100):
            alt = d / f'{stem} ({k}).wav'
            if _try_replace(tmp, alt, 1):
                return alt, True
        raise ProToolsFileError('Fichier verrouillé (ouvert dans Pro Tools ?) : écriture impossible.')
    except OSError as e:
        raise ProToolsFileError(f'Écriture impossible : {e}')
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def folder_status(folder: Optional[str]) -> dict:
    """Le dossier existe-t-il / peut-il être créé et écrit ?"""
    out = {'default_folder': str(default_folder()), 'folder': None, 'writable': False}
    try:
        d = check_folder(folder or '')
        out['folder'] = str(d)
        probe = d
        while not probe.exists() and probe.parent != probe:
            probe = probe.parent
        out['exists'] = d.is_dir()
        out['writable'] = probe.is_dir() and os.access(probe, os.W_OK)
        if not out['writable']:
            out['error'] = 'Dossier en lecture seule ou introuvable.'
    except ProToolsFileError as e:
        out['error'] = str(e)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Lecture (tests, QA)
# ─────────────────────────────────────────────────────────────────────────────

def read_bwf(path) -> dict:
    """Relit un BWF : fréquence, format, TimeReference, description, iXML, échantillons bruts."""
    data = Path(path).read_bytes()
    info = check_bwf(data)
    p = 12
    out = {'sample_rate': info['sample_rate'], 'channels': info['channels'], 'bits': info['bits'],
           'float': info['format'] == 3, 'time_reference': info['time_reference'], 'ixml': None}
    while p + 8 <= len(data):
        cid = data[p:p + 4]
        size = struct.unpack_from('<I', data, p + 4)[0]
        body = data[p + 8:p + 8 + size]
        if cid == b'bext':
            out['description'] = body[:256].split(b'\0', 1)[0].decode('ascii', 'replace')
            out['originator'] = body[256:288].split(b'\0', 1)[0].decode('ascii', 'replace')
            out['bext_version'] = struct.unpack_from('<H', body, 346)[0]
            out['coding_history'] = body[602:].split(b'\0', 1)[0].decode('ascii', 'replace')
        elif cid == b'iXML':
            out['ixml'] = body.decode('utf-8', 'replace')
        elif cid == b'data':
            out['data'] = body
        p += 8 + size + (size & 1)
    out['frames'] = len(out['data']) // max(1, out['channels'] * out['bits'] // 8)
    return out
