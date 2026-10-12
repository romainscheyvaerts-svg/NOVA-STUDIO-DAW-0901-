"""Sauvegarde des projets sur le DISQUE (Nova Studio) : Documents\\Nova Studio\\Projets\\<nom>\\.

Pourquoi : la sauvegarde automatique du studio vit dans IndexedDB, que le navigateur
(WebView2 compris) peut vider (stockage plein, nettoyage, profil réinitialisé). Dans
Nova Studio, chaque version est AUSSI écrite ici par le pont, et « Récupérer » propose
la plus récente des deux.

Disposition d'un projet :
    <nom>\\projet.json            identité (project_id) + dernière version (pour la liste)
    <nom>\\versions\\<id>.json     une version : JSON du projet + sons référencés (id = horodatage ms)
    <nom>\\audio\\<son>.wav        chaque son une seule fois (WAV float 32 bits, lisible partout)

Règles :
  - écriture ATOMIQUE de chaque fichier (fichier temporaire à côté, fsync, puis os.replace) :
    un plantage ou une coupure pendant l'écriture laisse l'ancien fichier intact ;
  - versions tournantes : les 20 dernières + la plus récente de chaque jour ; les versions
    nommées (« Enregistrer comme nouvelle version ») ne sont jamais effacées ;
  - un son que plus aucune version n'utilise est effacé (après 10 min : jamais un son tout
    juste envoyé pour la version suivante).

Aucune dépendance au pont : testé seul (tests/test_project_store.py).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

KEEP_RECENT = 20
AUDIO_GRACE_S = 600
TMP_SUFFIX = ".tmp"

# Point d'injection pour les tests de plantage (écriture coupée au milieu).
_WRITE_HOOK: Optional[Callable[[Path, int], None]] = None


class ProjectStoreError(Exception):
    pass


def default_root() -> Path:
    env = os.environ.get("NOVA_PROJECTS_DIR")
    if env:
        return Path(env)
    docs = Path.home() / "Documents"
    return (docs if docs.is_dir() else Path.home()) / "Nova Studio" / "Projets"


def safe_name(text: str, fallback: str = "Projet") -> str:
    t = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", str(text or "")).strip().strip(".")
    t = re.sub(r"\s+", " ", t)
    # Noms réservés de Windows (CON, NUL, COM1…) : un dossier ainsi nommé est inutilisable.
    if re.fullmatch(r"(?i)(con|prn|aux|nul|com\d|lpt\d)", t):
        t = f"{t} (projet)"
    return (t or fallback)[:60]


def audio_file_name(audio_id: str) -> str:
    """Nom de fichier d'un son : son identifiant s'il est sûr, sinon son empreinte."""
    s = str(audio_id)
    if re.fullmatch(r"[A-Za-z0-9_\-][A-Za-z0-9_.\-]{0,119}", s) and not s.endswith("."):
        return s + ".wav"
    return "h-" + hashlib.sha1(s.encode("utf-8")).hexdigest() + ".wav"


# ─── écriture atomique ───────────────────────────────────────────────────────

def write_atomic(path: Path, data: bytes) -> None:
    """Écrit `data` dans `path` sans jamais laisser un fichier à moitié écrit.

    Fichier temporaire dans le MÊME dossier (même disque : le renommage est atomique),
    vidé sur le disque (fsync), puis renommé par-dessus l'ancien (os.replace). Un
    plantage avant le renommage laisse l'ancien fichier tel quel ; le temporaire est
    ignoré par la lecture et effacé au prochain ménage.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}{TMP_SUFFIX}")
    try:
        with open(tmp, "wb") as f:
            if _WRITE_HOOK is None:
                f.write(data)
            else:
                half = len(data) // 2
                f.write(data[:half])
                f.flush()
                _WRITE_HOOK(path, half)
                f.write(data[half:])
            f.flush()
            os.fsync(f.fileno())
        # Windows : un antivirus ou l'indexation peut tenir le fichier une fraction de seconde.
        for attempt in range(20):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    """WAV float 32 bits. audio : (canaux, échantillons)."""
    audio = np.ascontiguousarray(audio, dtype="<f4")
    nch, n = audio.shape
    data = audio.T.tobytes()
    fmt = struct.pack("<HHIIHH", 3, nch, sr, sr * nch * 4, nch * 4, 32)
    return b"".join([
        b"RIFF", struct.pack("<I", 4 + 8 + len(fmt) + 8 + 4 + 8 + len(data)), b"WAVE",
        b"fmt ", struct.pack("<I", len(fmt)), fmt,
        b"fact", struct.pack("<II", 4, n),
        b"data", struct.pack("<I", len(data)), data,
    ])


def read_wav_float(path: Path) -> Tuple[np.ndarray, int]:
    buf = Path(path).read_bytes()
    if buf[:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise ProjectStoreError(f"Son illisible : {Path(path).name}")
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(buf):
        cid, size = buf[pos:pos + 4], struct.unpack_from("<I", buf, pos + 4)[0]
        body = buf[pos + 8: pos + 8 + size]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            data = body
        pos += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise ProjectStoreError(f"Son incomplet : {Path(path).name}")
    tag, nch, sr, _br, _ba, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag != 3 or bits != 32:
        raise ProjectStoreError(f"Format inattendu ({tag}, {bits} bits) : {Path(path).name}")
    arr = np.frombuffer(data, dtype="<f4")
    n = arr.size // max(1, nch)
    return arr[: n * nch].reshape(n, nch).T.copy(), sr


# ─── versions à garder ───────────────────────────────────────────────────────

def is_named(meta: dict) -> bool:
    return meta.get("reason") == "named" or bool(meta.get("versionNumber"))


def versions_to_prune(metas: List[dict], keep_recent: int = KEEP_RECENT) -> List[int]:
    """Identifiants à effacer : on garde les `keep_recent` plus récentes, la plus récente
    de chaque jour (heure locale) et toutes les versions nommées."""
    ordered = sorted(metas, key=lambda m: int(m["id"]), reverse=True)
    keep = {int(m["id"]) for m in ordered[:keep_recent]}
    days = set()
    for m in ordered:
        day = time.strftime("%Y-%m-%d", time.localtime(int(m.get("savedAt") or m["id"]) / 1000))
        if day not in days:
            days.add(day)
            keep.add(int(m["id"]))
        if is_named(m):
            keep.add(int(m["id"]))
    return [int(m["id"]) for m in ordered if int(m["id"]) not in keep]


# ─── magasin ─────────────────────────────────────────────────────────────────

META_FIELDS = ("id", "projectId", "name", "savedAt", "reason", "tracks", "takes", "beatTitle",
               "hasLyrics", "needsCatalogBeat", "versionNumber", "comment")


class ProjectStore:
    def __init__(self, root: Optional[Path] = None):
        self.root = Path(root) if root else default_root()
        self._lock = threading.RLock()
        self._folders: Dict[str, Path] = {}

    # --- dossiers ---------------------------------------------------------------

    def _read_json(self, path: Path) -> Optional[dict]:
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _scan(self) -> Dict[str, Path]:
        found: Dict[str, Path] = {}
        if self.root.is_dir():
            for d in self.root.iterdir():
                if not d.is_dir():
                    continue
                info = self._read_json(d / "projet.json")
                if info and info.get("project_id"):
                    found.setdefault(str(info["project_id"]), d)
        return found

    def folder_for(self, project_id: str, name: str, create: bool = True) -> Optional[Path]:
        """Dossier du projet : retrouvé par son identifiant (même s'il a été renommé),
        sinon créé à son nom (« Nom (2) » si un autre projet porte déjà ce nom)."""
        project_id = str(project_id or "")
        if not project_id:
            raise ProjectStoreError("Projet sans identifiant")
        with self._lock:
            d = self._folders.get(project_id)
            if d is not None and (d / "projet.json").exists():
                return d
            self._folders.update(self._scan())
            d = self._folders.get(project_id)
            if d is not None or not create:
                return d
            base = safe_name(name)
            for i in range(1, 1000):
                cand = self.root / (base if i == 1 else f"{base} ({i})")
                if not cand.exists():
                    break
            else:
                raise ProjectStoreError("Trop de projets portent ce nom")
            (cand / "versions").mkdir(parents=True, exist_ok=True)
            (cand / "audio").mkdir(parents=True, exist_ok=True)
            write_atomic(cand / "projet.json", json.dumps(
                {"project_id": project_id, "name": str(name or "Projet"), "created_at": int(time.time() * 1000)},
                ensure_ascii=False).encode("utf-8"))
            self._folders[project_id] = cand
            return cand

    # --- sons -------------------------------------------------------------------

    def missing_audio(self, project_id: str, name: str, audio_ids: List[str]) -> List[str]:
        d = self.folder_for(project_id, name)
        return [a for a in dict.fromkeys(map(str, audio_ids)) if not (d / "audio" / audio_file_name(a)).exists()]

    def put_audio(self, project_id: str, name: str, audio_id: str, audio: np.ndarray, sr: int) -> Path:
        d = self.folder_for(project_id, name)
        if audio.ndim != 2 or audio.shape[0] < 1 or audio.shape[0] > 32:
            raise ProjectStoreError("Son mal formé")
        path = d / "audio" / audio_file_name(audio_id)
        write_atomic(path, wav_bytes(audio, int(sr)))
        return path

    # --- versions ---------------------------------------------------------------

    def save_version(self, project_id: str, name: str, record: dict) -> dict:
        """Écrit une version (atomiquement), met à jour projet.json, puis fait le ménage."""
        try:
            vid = int(record.get("id"))
        except (TypeError, ValueError):
            raise ProjectStoreError("Version sans identifiant")
        if not isinstance(record.get("json"), str):
            raise ProjectStoreError("Version sans projet")
        with self._lock:
            d = self.folder_for(project_id, name)
            audio_ids = [str(a) for a in record.get("audioIds") or []]
            absent = [a for a in audio_ids if not (d / "audio" / audio_file_name(a)).exists()]
            if absent:
                raise ProjectStoreError(f"{len(absent)} son(s) pas encore écrit(s) sur le disque")
            rec = dict(record, projectId=str(project_id), name=str(name or record.get("name") or "Projet"))
            write_atomic(d / "versions" / f"{vid}.json", json.dumps(rec, ensure_ascii=False).encode("utf-8"))
            info = self._read_json(d / "projet.json") or {"project_id": str(project_id)}
            info.update({"project_id": str(project_id), "name": rec["name"], "latest": {k: rec.get(k) for k in META_FIELDS if k in rec}})
            write_atomic(d / "projet.json", json.dumps(info, ensure_ascii=False).encode("utf-8"))
            pruned = self.prune(d)
            return {"folder": str(d), "version_id": vid, "pruned": pruned}

    def _version_metas(self, d: Path) -> List[dict]:
        out = []
        for f in (d / "versions").glob("*.json"):
            if f.name.startswith("."):
                continue
            rec = self._read_json(f)
            if not rec or "id" not in rec:
                continue  # fichier abîmé : jamais compté, jamais choisi
            out.append({**{k: rec.get(k) for k in META_FIELDS if k in rec}, "audioIds": rec.get("audioIds") or []})
        return out

    def prune(self, d: Path) -> int:
        metas = self._version_metas(d)
        drop = set(versions_to_prune(metas))
        for vid in drop:
            try:
                (d / "versions" / f"{vid}.json").unlink()
            except OSError:
                pass
        used = {audio_file_name(a) for m in metas if int(m["id"]) not in drop for a in m["audioIds"]}
        now = time.time()
        for f in list((d / "audio").glob("*.wav")) + list((d / "audio").glob(f".*{TMP_SUFFIX}")) + list((d / "versions").glob(f".*{TMP_SUFFIX}")):
            try:
                old = now - f.stat().st_mtime > AUDIO_GRACE_S
                if f.name.endswith(TMP_SUFFIX):
                    if old:
                        f.unlink()  # reste d'une écriture coupée
                elif f.name not in used and old:
                    f.unlink()
            except OSError:
                pass
        return len(drop)

    def list_versions(self, project_id: str) -> List[dict]:
        d = self.folder_for(project_id, "", create=False)
        if d is None:
            return []
        metas = self._version_metas(d)
        for m in metas:
            m.pop("audioIds", None)
        return sorted(metas, key=lambda m: int(m["id"]), reverse=True)

    def list_projects(self) -> List[dict]:
        out = []
        with self._lock:
            self._folders.update(self._scan())
            for pid, d in self._folders.items():
                versions = self.list_versions(pid)
                if not versions:
                    continue
                info = self._read_json(d / "projet.json") or {}
                out.append({"project_id": pid, "name": info.get("name") or d.name, "folder": str(d),
                            "versions": len(versions), "latest": versions[0]})
        return sorted(out, key=lambda p: int(p["latest"]["id"]), reverse=True)

    def load_version(self, project_id: str, version_id: Optional[int] = None) -> Tuple[dict, List[Tuple[str, np.ndarray, int]], List[str]]:
        """(version, sons [(id, audio, fréquence)], sons manquants). La plus récente si
        `version_id` est absent. Une version abîmée est sautée au profit de la précédente."""
        d = self.folder_for(project_id, "", create=False)
        if d is None:
            raise ProjectStoreError("Projet introuvable sur le disque")
        ids = [int(version_id)] if version_id else [int(m["id"]) for m in self.list_versions(project_id)]
        rec = None
        for vid in ids:
            rec = self._read_json(d / "versions" / f"{vid}.json")
            if rec and isinstance(rec.get("json"), str):
                break
            rec = None
        if rec is None:
            raise ProjectStoreError("Version introuvable sur le disque")
        audio, missing = [], []
        for a in rec.get("audioIds") or []:
            p = d / "audio" / audio_file_name(a)
            try:
                data, sr = read_wav_float(p)
                audio.append((str(a), data, sr))
            except (OSError, ProjectStoreError):
                missing.append(str(a))
        return rec, audio, missing
