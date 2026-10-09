"""QA 100 % hors production : Supabase simulé pour TOUS les navigateurs de test.

Pourquoi : le 09/10/2026, le projet Supabase de production (mxdrxpzxbgybchzzvpkf :
catalogue, booking, collaboration) a été restreint pour dépassement du quota
gratuit d'egress (réponses 402). Les centaines de passages des scénarios QA
chargeaient le catalogue et streamaient des beats depuis la production.

Ce module, importé par qalib (et en tête de chaque scénario qui lance son propre
navigateur), branche sur Playwright :

  1. une interception réseau par défaut sur CHAQUE contexte (browser.new_context,
     browser.new_page, launch_persistent_context, connect_over_cdp) qui sert un
     CATALOGUE SIMULÉ pour toutes les requêtes *.supabase.co :
       - REST (instrumentals filtrés comme PostgREST, autres tables vides, écritures acceptées),
       - Storage (pochettes, téléversements), Edge Functions (stream-instrumental avec
         plages HTTP 206, stream-drive-audio, nova-billing, daw-session, nova-chat),
       - Auth (sans compte), Realtime (WebSocket muet) ;
     les beats (NOCTAMBULE, Neon Storm, MIDNIGHT…) gardent leur nom : la liste vient
     d'une copie locale du catalogue (identifiants Drive remplacés), l'audio d'un
     fichier LOCAL de D:\\1 WORK\\CONTENU quand il existe, sinon d'un beat synthétique
     (tempo et tonalité de la fiche) ;
  2. toute requête *.supabase.co non simulée est BLOQUÉE et journalisée
     (« requête prod bloquée : … ») : le journal du scénario la compte comme erreur
     et le processus se termine en échec (code 3) ;
  3. deux filets en plus : le navigateur résout *.supabase.co vers « introuvable »
     (--host-resolver-rules), et Python refuse de résoudre *.supabase.co
     (socket.getaddrinfo) : même un route.continue_() ou un urllib oublié ne sort pas.

QA_ALLOW_PROD=1 (désactivé par défaut) n'est accepté que pour qa/collab_reel.py,
qui exige déjà --reel --je-confirme-ecriture-en-production.

Compteur : à la fin de chaque processus, un résumé JSON part dans
QA_HORS_PROD_DIR\\compteurs (requêtes simulées, octets servis par type, requêtes
bloquées, requêtes ayant atteint le réseau = 0 attendu).

Mode « serveur » (QA_HORS_PROD_SERVEUR=1) : au lieu des routes Playwright (qui
désactivent le cache HTTP du navigateur), *.supabase.co est résolu vers un serveur
HTTPS local qui sert le même catalogue simulé. Sert aux mesures d'egress réalistes
(cache HTTP du navigateur actif).
"""
from __future__ import annotations

import atexit
import base64
import email.utils
import hashlib
import io
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl, unquote

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("QA_HORS_PROD_DIR", r"D:\1 WORK\CONTENU\nova-qa-hors-prod"))
GEN_DIR = DATA_DIR / "donnees"          # audio / pochettes générés (pas dans le dépôt)
COUNT_DIR = DATA_DIR / "compteurs"
CATALOG_FILE = HERE / "donnees_hors_prod" / "catalogue.json"
CONTENU = Path(r"D:\1 WORK\CONTENU")

SUPA_HOST_RX = re.compile(r"^([a-z0-9-]+)\.supabase\.co$", re.I)
SUPA_URL_RX = re.compile(r"^(https?|wss?)://[a-z0-9-]+\.supabase\.co(?::\d+)?(/|$)", re.I)
CATALOG_PROJECT = "mxdrxpzxbgybchzzvpkf"
MAIN_PROJECT = "sqduhfckgvyezdiubeei"

_MAIN = Path(sys.argv[0]).name if sys.argv and sys.argv[0] else ""
ALLOW_PROD = os.environ.get("QA_ALLOW_PROD") == "1"
if ALLOW_PROD and _MAIN != "collab_reel.py":
    raise SystemExit(f"QA_ALLOW_PROD=1 refusé pour {_MAIN or 'ce script'} : seul qa/collab_reel.py "
                     "(avec --reel --je-confirme-ecriture-en-production) peut toucher la production.")

_LOCK = threading.RLock()
STATS = {
    "simulees": Counter(),       # catégorie -> nombre de requêtes servies par le simulateur
    "octets": Counter(),         # catégorie -> octets de corps servis
    "bloquees": [],              # requêtes *.supabase.co non simulées (le test échoue)
    "vues": Counter(),           # (méthode url) vues par le navigateur (événement request)
    "traitees": Counter(),       # (méthode url) passées par le simulateur
    "reseau_prod": [],           # réponses venues du réseau (adresse serveur réelle) : 0 attendu
    "filet_dns": [],             # requêtes arrêtées par le filet DNS (non résolues) : 0 attendu
    "websockets": 0,
}
_LOGS: list = []                 # journaux qalib.Log à prévenir d'un blocage


def is_supabase(url: str) -> bool:
    return bool(SUPA_URL_RX.match(url or ""))


def _cat(path: str, method: str) -> str:
    if method == "OPTIONS":
        return "preflight_cors"
    if path.startswith("/functions/v1/stream-instrumental") or path.startswith("/functions/v1/stream-drive-audio"):
        return "audio_beats"
    if path.startswith("/storage/v1/object/public/instrumental-covers") or path.startswith("/storage/v1/render/"):
        return "pochettes"
    if path.startswith("/rest/v1/instrumentals"):
        return "catalogue_liste"
    if path.startswith("/rest/v1/"):
        return "rest_ecriture" if method in ("POST", "PATCH", "PUT", "DELETE") else "rest_autres"
    if path.startswith("/storage/v1/"):
        return "storage_autres"
    if path.startswith("/functions/v1/"):
        return "fonctions_" + path.split("/")[3].split("?")[0]
    if path.startswith("/auth/v1/"):
        return "auth"
    return "autres"


# ----------------------------------------------------------------- catalogue
_catalog = None


def catalog() -> list:
    global _catalog
    if _catalog is None:
        _catalog = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    return _catalog


def _by_file_id(fid: str):
    for it in catalog():
        if it.get("drive_file_id") == fid or it.get("id") == fid:
            return it
    return None


# ------------------------------------------------------------ audio simulé
NOTES = {"c": 0, "do": 0, "d": 2, "re": 2, "ré": 2, "e": 4, "mi": 4, "f": 5, "fa": 5, "g": 7, "sol": 7,
         "a": 9, "la": 9, "b": 11, "si": 11}


def _root_semitone(key: str | None) -> int:
    k = (key or "").strip().lower()
    m = re.match(r"^(do|ré|re|mi|fa|sol|la|si|[a-g])\s*([#♯b♭]?)", k)
    if not m:
        return 9
    n = NOTES[m.group(1)]
    if m.group(2) in ("#", "♯"):
        n += 1
    elif m.group(2) in ("b", "♭"):
        n -= 1
    return n % 12


def _local_audio(title: str):
    """Fichier audio LOCAL déjà téléchargé/exporté pour ce titre (CONTENU), s'il y en a un."""
    t = (title or "").strip().upper()
    if not t or len(t) < 3:
        return None
    cands = []
    for root in ("integration-nova-2026-10-04", "nova-audit-ux", "nova-autotune", "nova-finitions-2026-10-04"):
        base = CONTENU / root
        if base.exists():
            for p in base.rglob("*.mp3"):
                n = p.name.upper()
                if n.startswith(t + " ") or f"_{t} - " in n:
                    cands.append(p)
    # la « démo » (beat entier) plutôt que l'« extrait »
    cands.sort(key=lambda p: ("EXTRAIT" in p.name.upper(), -p.stat().st_size))
    return cands[0] if cands else None


def _synth_wav(it: dict, sr=44100) -> bytes:
    import numpy as np
    seed = int(hashlib.sha1((it.get("id") or it.get("title") or "x").encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    bpm = float(it.get("bpm") or (88 + seed % 70))
    melody = it.get("kind") == "melody"
    dur = 150 + seed % 50 if not melody else 60 + seed % 30
    n = int(dur * sr)
    t = np.arange(n) / sr
    beat = 60.0 / bpm
    root = 110.0 * 2 ** ((_root_semitone(it.get("key")) - 9) / 12)
    chords = [(0, 3, 7), (8, 12, 15), (3, 7, 10), (10, 14, 17)]
    out = np.zeros(n, dtype=np.float32)
    bar = 4 * beat
    for b in range(int(dur / bar) + 1):
        s0 = int(b * bar * sr)
        s1 = min(n, int((b + 1) * bar * sr))
        if s0 >= n:
            break
        tt = t[s0:s1] - b * bar
        ch = chords[b % 4]
        pad = sum(np.sin(2 * np.pi * root * 2 ** (c / 12) * 2 * tt) for c in ch) / len(ch)
        env = np.minimum(1, tt / 0.05) * np.exp(-tt / (bar * 1.2))
        out[s0:s1] += 0.22 * pad * env
        if melody:
            for k in range(8):
                ts = k * beat / 2
                i0 = s0 + int(ts * sr)
                L = int(0.18 * sr)
                if i0 + L > n:
                    break
                f = root * 4 * 2 ** (ch[k % 3] / 12)
                x = np.arange(L) / sr
                out[i0:i0 + L] += 0.18 * np.sin(2 * np.pi * f * x) * np.exp(-x / 0.08)
    if not melody:
        L = int(0.25 * sr)
        x = np.arange(L) / sr
        kick = np.sin(2 * np.pi * (45 + 90 * np.exp(-x / 0.03)) * x) * np.exp(-x / 0.12)
        Ls = int(0.15 * sr)
        snare = rng.standard_normal(Ls).astype(np.float32) * np.exp(-np.arange(Ls) / sr / 0.05)
        Lh = int(0.04 * sr)
        hat = np.diff(rng.standard_normal(Lh + 1)).astype(np.float32) * np.exp(-np.arange(Lh) / sr / 0.01)
        steps = int(dur / (beat / 2))
        for k in range(steps):
            i0 = int(k * beat / 2 * sr)
            if k % 8 in (0, 3, 5):
                e = min(n, i0 + len(kick)); out[i0:e] += 0.8 * kick[:e - i0]
            if k % 4 == 2:
                e = min(n, i0 + Ls); out[i0:e] += 0.35 * snare[:e - i0]
            e = min(n, i0 + Lh); out[i0:e] += 0.12 * hat[:e - i0]
        bassL = int(beat * sr)
        xb = np.arange(bassL) / sr
        for k in range(int(dur / beat)):
            i0 = int(k * beat * sr)
            e = min(n, i0 + bassL)
            ch = chords[(k // 4) % 4]
            out[i0:e] += 0.25 * np.sin(2 * np.pi * root / 2 * 2 ** (ch[0] / 12) * xb[:e - i0]) * np.exp(-xb[:e - i0] / 0.4)
    out /= max(1e-6, float(np.max(np.abs(out)))) / 0.8
    st = np.stack([out, np.roll(out, 64)], axis=1)
    pcm = (st * 32767).astype("<i2").tobytes()
    hdr = b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little") \
        + (1).to_bytes(2, "little") + (2).to_bytes(2, "little") + sr.to_bytes(4, "little") \
        + (sr * 4).to_bytes(4, "little") + (4).to_bytes(2, "little") + (16).to_bytes(2, "little") \
        + b"data" + len(pcm).to_bytes(4, "little")
    return hdr + pcm


def _atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    try:
        os.replace(tmp, path)
    except OSError:
        try: tmp.unlink()
        except OSError: pass


_audio_mem: dict = {}


def audio_bytes(it: dict) -> tuple[bytes, str]:
    """Audio du beat (mp3) : fichier local s'il existe, sinon synthétique encodé en mp3 320 kb/s."""
    key = it.get("drive_file_id") or it.get("id")
    if key in _audio_mem:
        return _audio_mem[key]
    local = _local_audio(it.get("title", ""))
    if local:
        res = (local.read_bytes(), "audio/mpeg")
    else:
        mp3 = GEN_DIR / "audio" / f"{key}.mp3"
        if not mp3.exists():
            wav = GEN_DIR / "audio" / f"{key}.{os.getpid()}.wav"
            _atomic_write(wav, _synth_wav(it))
            tmp = mp3.with_suffix(f".{os.getpid()}.mp3")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "320k", str(tmp)],
                           check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try: wav.unlink()
            except OSError: pass
            try: os.replace(tmp, mp3)
            except OSError: pass
        res = (mp3.read_bytes(), "audio/mpeg")
    _audio_mem[key] = res
    return res


# --------------------------------------------------------- pochettes simulées
def cover_bytes(path: str) -> tuple[bytes, str]:
    ext = path.rsplit(".", 1)[-1].lower()
    ct = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
    f = GEN_DIR / "pochettes" / (hashlib.sha1(path.encode()).hexdigest()[:16] + "." + ext)
    if not f.exists():
        import numpy as np
        from PIL import Image
        seed = int(hashlib.sha1(path.encode()).hexdigest()[:8], 16)
        rng = np.random.default_rng(seed)
        S = 1024
        y, x = np.mgrid[0:S, 0:S].astype(np.float32) / S
        c1 = rng.uniform(0, 255, 3); c2 = rng.uniform(0, 255, 3)
        img = (c1[None, None, :] * (1 - x[..., None]) + c2[None, None, :] * y[..., None])
        img += 40 * np.sin(12 * x + 7 * y)[..., None] + rng.normal(0, 14, (S, S, 3))   # grain « photo »
        im = Image.fromarray(np.clip(img, 0, 255).astype("uint8"))
        bio = io.BytesIO()
        if ext == "png": im.save(bio, "PNG", optimize=False)
        elif ext == "webp": im.save(bio, "WEBP", quality=80)
        else: im.save(bio, "JPEG", quality=88)
        _atomic_write(f, bio.getvalue())
    return f.read_bytes(), ct


# ------------------------------------------------------------- PostgREST
def _coerce(v: str):
    if v == "true": return True
    if v == "false": return False
    if v == "null": return None
    return v


def _match(row: dict, col: str, expr: str) -> bool:
    neg = expr.startswith("not.")
    if neg: expr = expr[4:]
    op, _, val = expr.partition(".")
    cell = row.get(col)
    ok = True
    if op == "eq": ok = str(cell).lower() == str(val).lower() if isinstance(cell, bool) else str(cell) == val
    elif op == "neq": ok = str(cell) != val
    elif op == "is": ok = (cell is None) if val == "null" else (cell is _coerce(val))
    elif op == "in": ok = str(cell) in [s.strip().strip('"') for s in val.strip("()").split(",")]
    elif op in ("gt", "gte", "lt", "lte"):
        try:
            a, b = (float(cell), float(val)) if not isinstance(cell, str) else (cell, val)
            ok = {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[op]
        except Exception:
            ok = False
    elif op in ("like", "ilike"):
        rx = re.escape(val).replace("\\*", ".*").replace("%", ".*")
        ok = bool(re.fullmatch(rx, str(cell or ""), re.I if op == "ilike" else 0))
    return (not ok) if neg else ok


def postgrest(rows: list, query: list, accept: str, prefer: str, method: str):
    sel = "*"; order = None; limit = None; offset = 0
    out = list(rows)
    for k, v in query:
        if k == "select": sel = v
        elif k == "order": order = v
        elif k == "limit": limit = int(v)
        elif k == "offset": offset = int(v)
        elif k in ("or", "and", "columns", "on_conflict"): pass
        else: out = [r for r in out if _match(r, k, v)]
    if order:
        for part in reversed(order.split(",")):
            bits = part.split(".")
            col = bits[0]; desc = "desc" in bits[1:]
            out.sort(key=lambda r: (r.get(col) is None, r.get(col) if r.get(col) is not None else ""), reverse=desc)
    total = len(out)
    out = out[offset:offset + limit] if limit is not None else out[offset:]
    if sel.strip() not in ("*", ""):
        cols = [c.strip().split(":")[0] for c in sel.split(",") if c.strip() and "(" not in c]
        out = [{c: r.get(c) for c in cols} for r in out]
    hdr = {"content-range": f"{offset}-{offset + max(0, len(out) - 1)}/{total if 'count=' in prefer else '*'}"}
    if "vnd.pgrst.object" in accept:
        if len(out) != 1:
            return 406, hdr, {"code": "PGRST116", "details": f"The result contains {len(out)} rows", "hint": None,
                              "message": "JSON object requested, multiple (or no) rows returned"}
        return 200, hdr, out[0]
    return (200, hdr, None if method == "HEAD" else out)


# ---------------------------------------------------------------- réponse
class Resp:
    def __init__(self, status=200, headers=None, body: bytes | str | dict | list | None = b"", content_type=None):
        self.status = status
        self.headers = {k.lower(): str(v) for k, v in (headers or {}).items()}
        if isinstance(body, (dict, list)) or body is None and content_type == "application/json":
            body = json.dumps(body, ensure_ascii=False).encode()
            content_type = content_type or "application/json; charset=utf-8"
        elif isinstance(body, str):
            body = body.encode()
        self.body = body or b""
        if content_type:
            self.headers["content-type"] = content_type


def _cors(origin: str | None) -> dict:
    return {"access-control-allow-origin": origin or "*",
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, range, prefer, accept-profile, content-profile, x-upsert, if-none-match, cache-control",
            "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS",
            "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Content-Type",
            "vary": "Origin"}


def _ranged(data: bytes, ctype: str, req_headers: dict, extra: dict, honor_range=True) -> Resp:
    """Fichier servi avec plages HTTP (206) et validation conditionnelle (ETag → 304)."""
    etag = extra.get("etag")
    inm = req_headers.get("if-none-match")
    if etag and inm and etag in [s.strip() for s in inm.split(",")]:
        return Resp(304, extra)
    rng = req_headers.get("range") if honor_range else None
    m = re.match(r"bytes=(\d*)-(\d*)$", (rng or "").strip())
    size = len(data)
    if m and (m.group(1) or m.group(2)):
        if m.group(1):
            a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else size - 1
        else:
            a = max(0, size - int(m.group(2))); b = size - 1
        b = min(b, size - 1)
        if a >= size:
            return Resp(416, {**extra, "content-range": f"bytes */{size}"})
        return Resp(206, {**extra, "content-range": f"bytes {a}-{b}/{size}", "accept-ranges": "bytes"}, data[a:b + 1], ctype)
    return Resp(200, {**extra, **({"accept-ranges": "bytes"} if honor_range else {})}, data, ctype)


_uploads: dict = {}

# Projet restreint (quota d'egress dépassé) simulé : QA_HORS_PROD_QUOTA=1 ou simulate_quota(True).
# Réponse de Supabase constatée le 09/10/2026 : HTTP 402, violations exceed_egress_quota /
# exceed_cached_egress_quota.
QUOTA = {"actif": os.environ.get("QA_HORS_PROD_QUOTA") == "1"}
QUOTA_BODY = {"code": 402, "error": "exceed_egress_quota",
              "message": "Service for this project is restricted due to the following violations: "
                         "exceed_egress_quota, exceed_cached_egress_quota."}


def simulate_quota(on: bool = True):
    QUOTA["actif"] = bool(on)


def handle(method: str, url: str, headers: dict, body: bytes | None) -> Resp | None:
    """Réponse simulée pour une requête *.supabase.co, ou None si non simulée (→ bloquée)."""
    h = {k.lower(): v for k, v in (headers or {}).items()}
    sp = urlsplit(url)
    host = sp.hostname or ""
    proj = SUPA_HOST_RX.match(host).group(1) if SUPA_HOST_RX.match(host) else ""
    path = unquote(sp.path)
    q = parse_qsl(sp.query, keep_blank_values=True)
    qd = dict(q)
    cors = _cors(h.get("origin"))
    if method == "OPTIONS":
        return Resp(204, cors)
    if QUOTA["actif"]:
        return Resp(402, cors, QUOTA_BODY)

    # ---------------- Edge Functions
    if path.startswith("/functions/v1/"):
        fn = path.split("/")[3]
        if fn == "stream-instrumental":
            fid = qd.get("fileId") or ""
            it = _by_file_id(qd.get("id") or fid) if (qd.get("id") or fid) else None
            if not it:
                return Resp(404, cors, {"error": "File not found"})
            data, ct = audio_bytes(it)
            # Comme la fonction en ligne (site-agenda-studio, e5c2244) : plage relayée, pas d'ETag.
            return _ranged(data, ct, h, {**cors, "cache-control": "private, max-age=300"})
        if fn == "stream-drive-audio":
            it = _by_file_id(qd.get("id") or "")
            if not it:
                return Resp(404, cors, "Google Drive Error: Not Found", "text/plain")
            data, ct = audio_bytes(it)
            # Cette fonction ne relaie pas l'en-tête Range : toujours le fichier entier.
            return _ranged(data, ct, h, {**cors, "cache-control": "public, max-age=3600"}, honor_range=False)
        if fn == "nova-billing":
            try: action = json.loads(body or b"{}").get("action")
            except Exception: action = None
            if action == "status":
                return Resp(200, cors, {"plans": [], "admin": False})
            return Resp(401, cors, {"error": "Connecte-toi pour continuer (QA hors production)."})
        if fn == "daw-session":
            return Resp(401, cors, {"error": "Connecte-toi pour collaborer (QA hors production)."})
        if fn == "nova-chat":
            return Resp(503, cors, {"error": "Assistant indisponible (QA hors production)."})
        return None

    # ---------------- REST (PostgREST)
    if path.startswith("/rest/v1/"):
        table = path[len("/rest/v1/"):].strip("/")
        if method in ("POST", "PATCH", "PUT", "DELETE") and not table.startswith("rpc/"):
            prefer = h.get("prefer", "")
            if "return=representation" in prefer:
                try: payload = json.loads(body or b"[]")
                except Exception: payload = []
                return Resp(201 if method == "POST" else 200, cors, payload if isinstance(payload, list) else [payload])
            return Resp(201 if method == "POST" else 204, cors, b"")
        if table.startswith("rpc/"):
            fn = table[4:]
            return Resp(200, cors, {"mm_is_admin": False, "nova_feedback_statuts": []}.get(fn, None), "application/json")
        rows = catalog() if (table == "instrumentals" and proj == CATALOG_PROJECT) else []
        st, hdr, payload = postgrest(rows, q, h.get("accept", ""), h.get("prefer", ""), method)
        return Resp(st, {**cors, **hdr}, payload if payload is not None else b"",
                    "application/json; charset=utf-8" if payload is not None else None)

    # ---------------- Storage
    if path.startswith("/storage/v1/"):
        rest = path[len("/storage/v1/"):]
        if rest.startswith("object/public/") and method in ("GET", "HEAD"):
            bucket, _, obj = rest[len("object/public/"):].partition("/")
            if bucket == "instrumental-covers" and re.search(r"\.(jpe?g|png|webp)$", obj, re.I):
                data, ct = cover_bytes(obj)
                etag = '"' + hashlib.md5(data).hexdigest() + '"'
                return _ranged(data, ct, h, {**cors, "etag": etag, "cache-control": "max-age=3600",
                                             "last-modified": email.utils.formatdate(1757800000, usegmt=True)})
            if bucket in _uploads and obj in _uploads[bucket]:
                data = _uploads[bucket][obj]
                return _ranged(data, "application/octet-stream", h, {**cors, "cache-control": "max-age=3600"})
            return Resp(400, cors, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
        if rest.startswith("object/upload/sign/") and method == "POST":
            return Resp(200, cors, {"url": "/" + rest + "?token=qa-hors-prod", "token": "qa-hors-prod"})
        if rest.startswith("object/sign/"):
            return Resp(200, cors, {"signedURL": "/" + rest.replace("object/sign/", "object/public/") + "?token=qa"})
        if rest.startswith("object/") and method in ("POST", "PUT"):
            bucket, _, obj = rest[len("object/"):].replace("upload/sign/", "").partition("/")
            _uploads.setdefault(bucket, {})[obj] = body or b""
            return Resp(200, cors, {"Key": f"{bucket}/{obj}", "Id": str(uuid.uuid4())})
        if rest.startswith("object/") and method == "DELETE":
            return Resp(200, cors, [])
        if rest.startswith("object/list/"):
            return Resp(200, cors, [])
        return None

    # ---------------- Realtime : diffusion HTTP (canal non rejoint) → refusée comme avant (pas de relais)
    if path.startswith("/realtime/v1/"):
        return Resp(503, cors, {"error": "Diffusion Realtime indisponible (QA hors production)."})

    # ---------------- Auth (aucun compte : chaque scénario connecté pose ses propres routes)
    if path.startswith("/auth/v1/"):
        ep = path[len("/auth/v1/"):]
        if ep.startswith("user"):
            return Resp(401, cors, {"code": 401, "error_code": "no_authorization", "msg": "QA hors production : aucune session"})
        if ep.startswith("token"):
            return Resp(400, cors, {"error": "invalid_grant", "error_description": "QA hors production : connexion simulée refusée"})
        if ep.startswith("logout"):
            return Resp(204, cors)
        if ep.startswith("settings"):
            return Resp(200, cors, {"external": {"email": True, "google": True}, "disable_signup": False})
        if ep.startswith(("recover", "otp", "resend")):
            return Resp(200, cors, {})
        if ep.startswith("signup"):
            return Resp(400, cors, {"code": 400, "msg": "QA hors production : inscription simulée refusée"})
        if ep.startswith("authorize"):
            return Resp(200, cors, "<!doctype html><title>QA</title><p>Connexion simulée (QA hors production).</p>", "text/html")
        return None
    return None


# --------------------------------------------------------- comptage / blocage
def _record(method, url, resp: Resp | None, logs=None):
    sp = urlsplit(url)
    path = unquote(sp.path)
    with _LOCK:
        STATS["traitees"][f"{method} {url}"] += 1
        if resp is None:
            msg = f"requête prod bloquée : {method} {url[:220]}"
            STATS["bloquees"].append(msg)
            print(msg, file=sys.stderr, flush=True)
            for lg in list(logs if logs is not None else _LOGS):
                try: lg.add("pageerror", msg)
                except Exception: pass
        else:
            c = _cat(path, method)
            STATS["simulees"][c] += 1
            STATS["octets"][c] += len(resp.body) if method != "HEAD" else 0


def _route_handler(route, request):
    url = request.url
    if not is_supabase(url):
        return route.fallback()
    try:
        hdrs = request.all_headers()
    except Exception:
        hdrs = request.headers
    try:
        body = request.post_data_buffer
    except Exception:
        body = None
    resp = handle(request.method, url, hdrs, body)
    logs = None
    try:
        logs = getattr(request.frame.page.context, "_qa_logs", None)
    except Exception:
        pass
    _record(request.method, url, resp, logs)
    if resp is None:
        return _ORIG["route_abort"](route, "blockedbyclient")
    return _ORIG["route_fulfill"](route, status=resp.status, headers=resp.headers, body=resp.body)


def _ws_handler(ws):
    """Realtime simulé : accepte la connexion et ne répond rien (aucun serveur réel)."""
    with _LOCK:
        STATS["websockets"] += 1
        STATS["simulees"]["realtime_ws"] += 1
    ws.on_message(lambda m: None)


def install(context, log=None):
    """Branche le catalogue simulé sur un contexte (une seule fois par contexte)."""
    if log is not None:
        if log not in _LOGS:
            _LOGS.append(log)
        try:
            if not hasattr(context, "_qa_logs"):
                context._qa_logs = []
            if log not in context._qa_logs:
                context._qa_logs.append(log)
        except Exception:
            pass
    if ALLOW_PROD or _SERVER_MODE or getattr(context, "_qa_hors_prod", False):
        return context
    context._qa_hors_prod = True
    _ORIG["ctx_route"](context, SUPA_URL_RX, _route_handler)
    try:
        _ORIG["ctx_route_ws"](context, re.compile(r"^wss?://[a-z0-9-]+\.supabase\.co/", re.I), _ws_handler)
    except Exception:
        pass

    def on_request(req):
        if is_supabase(req.url):
            with _LOCK:
                STATS["vues"][f"{req.method} {req.url}"] += 1

    def on_failed(req):
        if is_supabase(req.url) and "NAME_NOT_RESOLVED" in str(req.failure or ""):
            with _LOCK:
                STATS["filet_dns"].append(f"{req.method} {req.url[:200]}")

    def on_response(resp):
        if not is_supabase(resp.url):
            return
        try:
            addr = resp.server_addr()
        except Exception:
            addr = None
        if addr and addr.get("ipAddress") not in ("127.0.0.1", "::1", "[::1]"):
            with _LOCK:
                STATS["reseau_prod"].append(f"{resp.request.method} {resp.url[:200]} ← {addr.get('ipAddress')}")
    context.on("request", on_request)
    context.on("requestfailed", on_failed)
    context.on("response", on_response)
    return context


# --------------------------------------------------------- patch Playwright
_ORIG: dict = {}
_SERVER_MODE = os.environ.get("QA_HORS_PROD_SERVEUR") == "1" and not ALLOW_PROD
_SERVER = None


def _resolver_args(args):
    args = list(args or [])
    if ALLOW_PROD:
        return args
    if _SERVER_MODE:
        srv = start_server()
        rule = f"MAP *.supabase.co 127.0.0.1:{srv.port}"
        args.append(f"--ignore-certificate-errors-spki-list={srv.spki}")
    else:
        rule = "MAP *.supabase.co ~NOTFOUND"
    for i, a in enumerate(args):
        if a.startswith("--host-resolver-rules="):
            args[i] = a + ", " + rule
            return args
    args.append(f"--host-resolver-rules={rule}")
    return args


def _patch():
    try:
        from playwright.sync_api import BrowserType, Browser, Route
    except Exception:
        return
    if getattr(BrowserType, "_qa_hors_prod", False):
        return
    from playwright.sync_api import BrowserContext
    _ORIG.update(launch=BrowserType.launch, persistent=BrowserType.launch_persistent_context,
                 cdp=BrowserType.connect_over_cdp, new_context=Browser.new_context, new_page=Browser.new_page,
                 route_continue=Route.continue_, route_fetch=Route.fetch, route_abort=Route.abort,
                 route_fulfill=Route.fulfill, ctx_route=BrowserContext.route,
                 ctx_route_ws=getattr(BrowserContext, "route_web_socket", None))

    def launch(self, *a, **kw):
        kw["args"] = _resolver_args(kw.get("args"))
        return _ORIG["launch"](self, *a, **kw)

    def launch_persistent_context(self, *a, **kw):
        kw["args"] = _resolver_args(kw.get("args"))
        return install(_ORIG["persistent"](self, *a, **kw))

    def connect_over_cdp(self, *a, **kw):
        b = _ORIG["cdp"](self, *a, **kw)
        for c in b.contexts:
            install(c)
        return b

    def new_context(self, *a, **kw):
        return install(_ORIG["new_context"](self, *a, **kw))

    def new_page(self, *a, **kw):
        # Comme Browser.new_page, mais le contexte passe d'abord par l'interception.
        ctx = new_context(self, *a, **kw)
        page = ctx.new_page()
        try:
            page._impl_obj._owned_context = ctx._impl_obj
            ctx._impl_obj._owner_page = page._impl_obj
        except Exception:
            pass
        return page

    def route_continue(self, *a, **kw):
        url = kw.get("url") or self.request.url
        if is_supabase(url) and not ALLOW_PROD:
            # Un scénario laisse « passer » : c'est le simulateur qui répond, jamais la production.
            return _route_handler(self, self.request)
        return _ORIG["route_continue"](self, *a, **kw)

    def route_fetch(self, *a, **kw):
        url = kw.get("url") or self.request.url
        if is_supabase(url) and not ALLOW_PROD:
            raise RuntimeError(f"requête prod bloquée : route.fetch {url[:200]}")
        return _ORIG["route_fetch"](self, *a, **kw)

    BrowserType.launch = launch
    BrowserType.launch_persistent_context = launch_persistent_context
    BrowserType.connect_over_cdp = connect_over_cdp
    Browser.new_context = new_context
    Browser.new_page = new_page
    Route.continue_ = route_continue
    Route.fetch = route_fetch
    BrowserType._qa_hors_prod = True


def _patch_dns():
    """Python ne résout plus *.supabase.co (urllib, requests…) : filet contre un appel direct oublié."""
    if ALLOW_PROD or getattr(socket, "_qa_hors_prod", False):
        return
    orig = socket.getaddrinfo

    def getaddrinfo(host, *a, **kw):
        h = host.decode() if isinstance(host, bytes) else str(host or "")
        if h.lower().endswith(".supabase.co"):
            msg = f"requête prod bloquée : résolution de {h} depuis Python"
            with _LOCK:
                STATS["bloquees"].append(msg)
            raise socket.gaierror(socket.EAI_NONAME, msg)
        return orig(host, *a, **kw)
    socket.getaddrinfo = getaddrinfo
    socket._qa_hors_prod = True


# ------------------------------------------------- serveur HTTPS (mesures)
class _Server:
    pass


def start_server():
    """Serveur HTTPS local qui sert le simulateur (mode mesure : cache HTTP du navigateur actif)."""
    global _SERVER
    if _SERVER:
        return _SERVER
    import ssl
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime

    cert_dir = GEN_DIR / "tls"
    cert_dir.mkdir(parents=True, exist_ok=True)
    kf, cf = cert_dir / "cle.pem", cert_dir / "cert.pem"
    if not (kf.exists() and cf.exists()):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "qa-hors-prod.supabase.co")])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
                .not_valid_after(now + datetime.timedelta(days=365))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName("*.supabase.co"), x509.DNSName("supabase.co")]), False)
                .sign(key, hashes.SHA256()))
        _atomic_write(kf, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                            serialization.NoEncryption()))
        _atomic_write(cf, cert.public_bytes(serialization.Encoding.PEM))
    cert = x509.load_pem_x509_certificate(cf.read_bytes())
    spki = cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    spki_b64 = base64.b64encode(hashlib.sha256(spki).digest()).decode()

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def handle(self):
            try:
                super().handle()
            except (ConnectionError, OSError):
                pass   # le navigateur coupe une écoute (plage) : normal

        def _do(self):
            n = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(n) if n else None
            host = (self.headers.get("host") or "").split(":")[0]
            url = f"https://{host}{self.path}"
            with _LOCK:
                STATS["vues"][f"{self.command} {url}"] += 1
            resp = handle(self.command, url, dict(self.headers.items()), body)
            _record(self.command, url, resp)
            if resp is None:
                resp = Resp(451, _cors(self.headers.get("origin")), {"error": "requête prod bloquée (QA hors production)"})
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k not in ("content-length", "connection", "transfer-encoding"):
                    self.send_header(k, v)
            self.send_header("content-length", str(len(resp.body)) if resp.status != 304 else "0")
            self.end_headers()
            if self.command != "HEAD" and resp.status != 304:
                try:
                    self.wfile.write(resp.body)
                except (ConnectionError, OSError):
                    pass

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _do

    class Srv(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            pass   # connexions coupées par le navigateur (écoutes interrompues)

    srv = Srv(("127.0.0.1", 0), H)
    srv.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cf), str(kf))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    s = _Server()
    s.port = srv.server_address[1]
    s.spki = spki_b64
    s.httpd = srv
    _SERVER = s
    return s


def reset_stats():
    with _LOCK:
        for k in ("simulees", "octets", "vues", "traitees"):
            STATS[k].clear()
        STATS["bloquees"].clear()
        STATS["reseau_prod"].clear()
        STATS["filet_dns"].clear()
        STATS["websockets"] = 0


def summary() -> dict:
    with _LOCK:
        vues = STATS["vues"]; tr = STATS["traitees"]
        nv = sum(vues.values())
        n_qa = sum(STATS["simulees"].values()) - STATS["websockets"]
        return {
            "script": _MAIN, "argv": sys.argv[1:], "pid": os.getpid(), "fin": time.strftime("%Y-%m-%d %H:%M:%S"),
            "mode": "production autorisée (QA_ALLOW_PROD=1)" if ALLOW_PROD else ("serveur local" if _SERVER_MODE else "routes Playwright"),
            "requetes_simulees": sum(STATS["simulees"].values()),
            "par_type": dict(STATS["simulees"]),
            "octets_par_type": dict(STATS["octets"]),
            "octets_total": sum(STATS["octets"].values()),
            "requetes_bloquees": len(STATS["bloquees"]),
            "bloquees": STATS["bloquees"][:50],
            "vues_navigateur": nv,
            # requêtes servies par les simulateurs propres au scénario (collab_sim, routes de test…)
            "simulees_par_le_scenario": max(0, nv - n_qa - len(STATS["bloquees"]) - len(STATS["filet_dns"])),
            "filet_dns": len(STATS["filet_dns"]),
            "filet_dns_detail": STATS["filet_dns"][:20],
            "requetes_prod": len(STATS["reseau_prod"]),
            "requetes_prod_detail": STATS["reseau_prod"][:20],
        }


def _at_exit():
    if not (STATS["vues"] or STATS["simulees"] or STATS["bloquees"]) and not os.environ.get("QA_HORS_PROD_COMPTEUR"):
        return
    s = summary()
    try:
        target = os.environ.get("QA_HORS_PROD_COMPTEUR")
        if target:
            Path(target).parent.mkdir(parents=True, exist_ok=True)
            Path(target).write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")
        COUNT_DIR.mkdir(parents=True, exist_ok=True)
        (COUNT_DIR / f"{Path(_MAIN).stem or 'qa'}_{os.getpid()}_{int(time.time())}.json").write_text(
            json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass
    line = (f"[QA hors prod] {s['requetes_simulees']} requêtes Supabase simulées "
            f"({s['octets_total'] / 1e6:.1f} Mo servis), {s['requetes_bloquees']} bloquées, "
            f"{s['requetes_prod']} vers la production")
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:
        pass
    if (s["requetes_bloquees"] or s["requetes_prod"] or s["filet_dns"]) and not ALLOW_PROD:
        for m in s["bloquees"][:10] + s["filet_dns_detail"][:5] + s["requetes_prod_detail"][:5]:
            print("  " + m, file=sys.stderr, flush=True)
        sys.stderr.flush(); sys.stdout.flush()
        os._exit(3)


_patch()
_patch_dns()
atexit.register(_at_exit)
