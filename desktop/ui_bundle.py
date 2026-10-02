# -*- coding: utf-8 -*-
"""
Interface du DAW embarquée dans Nova Studio pour Windows, et ses mises à jour.

L'application ne charge plus le DAW depuis Internet à chaque démarrage : une copie
complète du site construit (index.html, assets/, worklets/, drums/, polices…) est
livrée dans l'installateur (« bundled ») et servie localement par WebView2, sous
l'adresse habituelle du DAW (https://nova-studio-daw-0901-9kzo.vercel.app/). Même
origine qu'avant : connexion Supabase, sessions locales (IndexedDB) et réglages sont
conservés, et /api/* part toujours sur Vercel (assistant Nova).

Mises à jour sans réinstaller : en arrière-plan, l'application compare l'index.html
en ligne à celui qu'elle utilise ; s'il a changé, elle télécharge la nouvelle version
dans %LOCALAPPDATA%\\NovaStudio\\ui\\<id>\\ (dossier temporaire puis renommage atomique,
chaque fichier vérifié), et l'utilise au démarrage suivant. Une version téléchargée
incomplète, corrompue ou qui ne démarre pas est ignorée : on garde la précédente,
et en dernier recours la version livrée avec l'installateur.

Format d'une version (dossier + desktop-ui.json écrit en dernier) :
  { "format": 1, "id": "ui-<12 hex>", "kind": "bundled" | "downloaded",
    "stamp": <secondes epoch : construction ou téléchargement>,
    "indexSha256": "...", "source": {...},
    "files": { "assets/index-abc.js": { "size": 123, "sha256": "..." }, ... },
    "inherited": [ "drums/lib/kick-1234abcd.wav", ... ]   # fichiers repris de la version livrée }

Les fichiers dont le nom contient leur empreinte (assets/, drums/, _ext/ = copies
locales de feuilles de style externes versionnées, ex. Font Awesome sur cdnjs) ne
sont pas retéléchargés : une version téléchargée les reprend de la version livrée.
"""
import hashlib
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

PROD_ORIGIN = "https://nova-studio-daw-0901-9kzo.vercel.app"
MANIFEST = "desktop-ui.json"
FORMAT = 1
IMMUTABLE_PREFIXES = ("assets/", "drums/", "_ext/")
EXT_DIR = "_ext"
# Feuilles de style externes copiées localement (le DAW reste complet hors ligne).
EXTERNAL_CSS_HOSTS = ("cdnjs.cloudflare.com",)
# Jamais dans l'interface embarquée : installateurs (68 Mo), service worker (désactivé
# dans l'application : WebView2 sert déjà tout en local).
EXCLUDED_TOP = ("downloads",)
MAX_FILE_BYTES = 64 * 1024 * 1024

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8", ".map": "application/json",
    ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".flac": "audio/flac",
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg", ".webm": "audio/webm",
    ".mp4": "video/mp4", ".pdf": "application/pdf", ".zip": "application/zip",
}


def mime_type(rel: str) -> str:
    return MIME.get(os.path.splitext(rel)[1].lower(), "application/octet-stream")


def is_immutable(rel: str) -> bool:
    return rel.startswith(IMMUTABLE_PREFIXES)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def version_id(index_bytes: bytes) -> str:
    return "ui-" + hashlib.sha256(index_bytes).hexdigest()[:12]


BUILD_META = re.compile(rb'<meta\s+name=["\']nova-build["\']\s+content=["\'](\d{10,16})["\']', re.I)


def build_stamp(index_bytes: bytes) -> "float | None":
    """Date de construction du DAW (meta « nova-build », en ms), ou None pour les
    anciennes versions qui ne la portent pas."""
    m = BUILD_META.search(index_bytes or b"")
    return int(m.group(1)) / 1000.0 if m else None


def version_build_stamp(v: "UiVersion | None") -> "float | None":
    if v is None:
        return None
    try:
        with open(os.path.join(v.root, "index.html"), "rb") as f:
            return build_stamp(f.read())
    except OSError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Versions présentes sur le disque
# ─────────────────────────────────────────────────────────────────────────────

class UiVersion:
    def __init__(self, root: str, manifest: dict, base: "UiVersion | None" = None):
        self.root = root
        self.m = manifest
        self.base = base

    id = property(lambda self: self.m.get("id", "?"))
    kind = property(lambda self: self.m.get("kind", "?"))
    stamp = property(lambda self: float(self.m.get("stamp", 0)))
    index_sha = property(lambda self: self.m.get("indexSha256", ""))

    def __repr__(self):
        return f"<UI {self.id} {self.kind} {time.strftime('%Y-%m-%d %H:%M', time.localtime(self.stamp))}>"

    def resolve(self, rel: str) -> "str | None":
        """Chemin local d'un fichier de l'interface (ou None). rel : chemin URL décodé, sans '/' initial."""
        rel = rel.replace("\\", "/")
        if not rel or rel.startswith("/") or ".." in rel.split("/") or ":" in rel:
            return None
        p = os.path.join(self.root, *rel.split("/"))
        if os.path.isfile(p):
            return p
        if self.base is not None and is_immutable(rel):
            return self.base.resolve(rel)
        return None


def _read_manifest(root: str) -> "dict | None":
    try:
        with open(os.path.join(root, MANIFEST), encoding="utf-8") as f:
            m = json.load(f)
        if m.get("format") != FORMAT or not isinstance(m.get("files"), dict):
            return None
        return m
    except (OSError, ValueError):
        return None


def load_version(root: str, base: "UiVersion | None" = None, deep: bool = False) -> "tuple[UiVersion | None, str]":
    """Charge et vérifie une version (présence + taille de chaque fichier ; deep = empreintes)."""
    m = _read_manifest(root)
    if m is None:
        return None, "manifeste absent ou illisible"
    if os.path.exists(os.path.join(root, "BAD")):
        return None, "marquée défectueuse (n'a pas démarré)"
    v = UiVersion(root, m, base)
    if "index.html" not in m["files"]:
        return None, "index.html absent du manifeste"
    for rel, info in m["files"].items():
        p = os.path.join(root, *rel.split("/"))
        try:
            if os.path.getsize(p) != info["size"]:
                return None, f"taille inattendue : {rel}"
        except OSError:
            return None, f"fichier manquant : {rel}"
        if deep and sha256_file(p) != info["sha256"]:
            return None, f"empreinte inattendue : {rel}"
    for rel in m.get("inherited", []):
        if base is None or base.resolve(rel) is None:
            return None, f"fichier repris manquant : {rel}"
    return v, "ok"


def cache_root(data_dir: str) -> str:
    return os.path.join(data_dir, "ui")


def choose(bundled_root: "str | None", cache_dir: str, log=None) -> "tuple[UiVersion | None, UiVersion | None, list]":
    """(version à utiliser, version livrée, versions téléchargées valides) ; la plus récente gagne."""
    say = log or (lambda *_: None)
    bundled = None
    if bundled_root:
        bundled, why = load_version(bundled_root)
        if bundled is None:
            say(f"interface livrée inutilisable ({bundled_root}) : {why}")
    downloaded = []
    try:
        names = sorted(os.listdir(cache_dir))
    except OSError:
        names = []
    for n in names:
        d = os.path.join(cache_dir, n)
        if not n.startswith("ui-") or not os.path.isdir(d):
            continue
        v, why = load_version(d, base=bundled)
        if v is None:
            say(f"interface téléchargée {n} ignorée : {why}")
            continue
        downloaded.append(v)
    candidates = ([bundled] if bundled else []) + downloaded
    active = max(candidates, key=lambda v: v.stamp) if candidates else None
    # La version vue en ligne lors de la dernière vérification prime (le site en ligne fait foi,
    # même s'il revient en arrière) ; sauf installation plus récente que cette vérification.
    st = read_state(cache_dir)
    seen = next((v for v in candidates if v.id == st.get("online")), None)
    if seen is not None and (bundled is None or seen is bundled or bundled.stamp <= st.get("seenAt", 0)):
        active = seen
    return active, bundled, downloaded


STATE = "state.json"


def read_state(cache_dir: str) -> dict:
    try:
        with open(os.path.join(cache_dir, STATE), encoding="utf-8") as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(cache_dir: str, online_id: str) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    tmp = os.path.join(cache_dir, STATE + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"online": online_id, "seenAt": time.time()}, f)
    os.replace(tmp, os.path.join(cache_dir, STATE))


BAD_LIST = "bad-ids.txt"


def mark_bad(v: UiVersion, reason: str) -> None:
    """Version qui n'a pas démarré : écartée maintenant et jamais retéléchargée."""
    line = f"{v.id} {time.strftime('%Y-%m-%d %H:%M:%S')} {reason}\n"
    try:
        with open(os.path.join(v.root, "BAD"), "w", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    if v.kind == "downloaded":
        try:
            with open(os.path.join(os.path.dirname(v.root), BAD_LIST), "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass


def bad_ids(cache_dir: str) -> "set[str]":
    try:
        with open(os.path.join(cache_dir, BAD_LIST), encoding="utf-8") as f:
            return {ln.split()[0] for ln in f if ln.strip()}
    except OSError:
        return set()


def prune(cache_dir: str, keep_ids: "set[str]", log=None) -> None:
    """Supprime les anciennes versions téléchargées et les restes de téléchargements interrompus."""
    try:
        names = os.listdir(cache_dir)
    except OSError:
        return
    for n in names:
        d = os.path.join(cache_dir, n)
        if not os.path.isdir(d) or n in keep_ids:
            continue
        if n.startswith("ui-") or n.startswith(".partial-"):
            # un téléchargement en cours (autre instance) a moins d'une heure : on n'y touche pas
            if n.startswith(".partial-") and time.time() - os.path.getmtime(d) < 3600:
                continue
            shutil.rmtree(d, ignore_errors=True)
            if log:
                log(f"ancienne interface supprimée : {n}")


# ─────────────────────────────────────────────────────────────────────────────
# Écriture d'une version (construction ou téléchargement)
# ─────────────────────────────────────────────────────────────────────────────

def write_manifest(root: str, kind: str, source: dict, stamp: "float | None" = None,
                   inherited: "list | None" = None) -> dict:
    files = {}
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, root).replace("\\", "/")
            if rel in (MANIFEST, "BAD"):
                continue
            files[rel] = {"size": os.path.getsize(p), "sha256": sha256_file(p)}
    with open(os.path.join(root, "index.html"), "rb") as f:
        index = f.read()
    m = {
        "format": FORMAT,
        "id": version_id(index),
        "kind": kind,
        "stamp": float(stamp if stamp is not None else time.time()),
        "indexSha256": hashlib.sha256(index).hexdigest(),
        "source": source,
        "files": dict(sorted(files.items())),
        "inherited": sorted(inherited or []),
    }
    tmp = os.path.join(root, MANIFEST + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(root, MANIFEST))
    return m


# ─────────────────────────────────────────────────────────────────────────────
# Téléchargement depuis le site en ligne
# ─────────────────────────────────────────────────────────────────────────────

class UpdateError(Exception):
    pass


ASSET_REF = re.compile(r"""(?:["'(=\s]|^)/?(assets/[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8})""")
CHUNK_REF = re.compile(r"""["'`]\./([A-Za-z0-9_.\-]+\.(?:js|mjs|css|wasm))["'`]""")
CSS_URL = re.compile(r"""url\(\s*['"]?([^'")]+?)['"]?\s*\)""")
EXT_CSS = re.compile(r"""<link[^>]+href=["'](https://([A-Za-z0-9.\-]+)/[^"']+\.css)["']""", re.I)
DRUM_ID = re.compile(r"""["']([a-z0-9]+(?:[-_][a-z0-9]+)*-[0-9a-f]{8})["']""")


def http_get(url: str, ua: str, timeout: float = 30.0) -> "tuple[bytes, str]":
    req = urllib.request.Request(url, headers={
        "User-Agent": ua, "Cache-Control": "no-cache", "Pragma": "no-cache", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise UpdateError(f"HTTP {r.status} : {url}")
        ctype = (r.headers.get("Content-Type") or "").lower()
        expected = r.headers.get("Content-Length")
        data = r.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise UpdateError(f"fichier trop gros : {url}")
        if expected is not None and expected.isdigit() and int(expected) != len(data):
            raise UpdateError(f"téléchargement tronqué : {url}")
        return data, ctype


def _looks_like_spa_fallback(rel: str, data: bytes, ctype: str) -> bool:
    """Vercel renvoie index.html (200) pour un fichier inconnu : ce n'est pas le fichier demandé."""
    if rel.endswith((".html", ".htm")):
        return False
    return "text/html" in ctype or data[:200].lstrip().lower().startswith((b"<!doctype html", b"<html"))


def _refs_in(rel: str, data: bytes) -> "set[str]":
    """Fichiers assets/ référencés par un fichier texte (html, js, css) de l'interface."""
    out = set()
    if not rel.endswith((".html", ".js", ".mjs", ".css")):
        return out
    text = data.decode("utf-8", "replace")
    for m in ASSET_REF.finditer(text):
        out.add(m.group(1))
    if rel.startswith("assets/"):
        for m in CHUNK_REF.finditer(text):
            out.add("assets/" + m.group(1))
        if rel.endswith(".css"):
            for m in CSS_URL.finditer(text):
                u = m.group(1)
                if u.startswith(("data:", "http:", "https:", "#")):
                    continue
                if u.startswith("/"):
                    out.add(u.lstrip("/").split("?")[0].split("#")[0])
                else:
                    out.add(os.path.normpath(os.path.join("assets", u)).replace("\\", "/").split("?")[0])
    return {r for r in out if r.startswith("assets/") and ".." not in r}


def mirror_external_css(index_html: bytes, dest_root: str, ua: str, have=None, log=None) -> "list[str]":
    """Copie locale des feuilles de style externes (Font Awesome sur cdnjs) et de leurs polices
    woff2, sous _ext/<hôte>/<chemin>. have(rel) -> chemin existant (réutilisation)."""
    say = log or (lambda *_: None)
    written = []
    for m in EXT_CSS.finditer(index_html.decode("utf-8", "replace")):
        url, host = m.group(1), m.group(2).lower()
        if host not in EXTERNAL_CSS_HOSTS:
            continue
        p = urllib.parse.urlparse(url)
        css_rel = f"{EXT_DIR}/{host}{p.path}"
        existing = have(css_rel) if have else None
        if existing:
            with open(existing, "rb") as f:
                css = f.read()
            written.append(css_rel)
        else:
            css, ctype = http_get(url, ua)
            if "css" not in ctype and not css.lstrip().startswith((b"/*", b":root", b".", b"@")):
                raise UpdateError(f"feuille de style inattendue : {url}")
            _save(dest_root, css_rel, css)
            written.append(css_rel)
        jobs = []
        for u in set(CSS_URL.findall(css.decode("utf-8", "replace"))):
            if u.startswith(("data:", "#")):
                continue
            absu = urllib.parse.urljoin(url, u).split("#")[0].split("?")[0]
            pu = urllib.parse.urlparse(absu)
            if pu.hostname != host or not pu.path.endswith(".woff2"):
                continue  # Chromium n'utilise que le woff2 (le ttf de secours n'est jamais demandé)
            jobs.append((absu, f"{EXT_DIR}/{host}{pu.path}"))
        for absu, rel in sorted(jobs):
            if have and have(rel):
                written.append(rel)
                continue
            data, ctype = http_get(absu, ua)
            if not data.startswith(b"wOF2"):
                raise UpdateError(f"police inattendue : {absu}")
            _save(dest_root, rel, data)
            written.append(rel)
        say(f"copie locale de {url} ({len(jobs)} polices)")
    return written


def _save(root: str, rel: str, data: bytes) -> None:
    p = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)


def fetch_online_index(origin: str, ua: str) -> bytes:
    data, ctype = http_get(origin + "/", ua)
    if b'id="root"' not in data or b"<script" not in data:
        raise UpdateError("index.html en ligne inattendu (pas de #root ni de script)")
    return data


def download_version(origin: str, cache_dir: str, bundled: "UiVersion | None", mutable_files: "list[str]",
                     ua: str, index_bytes: "bytes | None" = None, log=None,
                     kind: str = "downloaded", dest: "str | None" = None) -> UiVersion:
    """Télécharge la version en ligne complète dans un dossier temporaire, la vérifie, puis la
    renomme en cache_dir/<id> (ou dest). Lève UpdateError si quoi que ce soit manque."""
    say = log or (lambda *_: None)
    index = index_bytes if index_bytes is not None else fetch_online_index(origin, ua)
    vid = version_id(index)
    final = dest or os.path.join(cache_dir, vid)
    os.makedirs(os.path.dirname(final) or ".", exist_ok=True)
    tmp = os.path.join(os.path.dirname(final), f".partial-{vid}-{os.getpid()}")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    inherited = []
    t0 = time.time()
    nbytes = 0

    def have_inherited(rel):
        return bundled.resolve(rel) if (bundled is not None and is_immutable(rel)) else None

    try:
        _save(tmp, "index.html", index)
        # 1. assets/ : tout ce qui est référencé depuis index.html, puis récursivement
        todo = sorted(_refs_in("index.html", index))
        seen = set()
        while todo:
            rel = todo.pop()
            if rel in seen:
                continue
            seen.add(rel)
            local = have_inherited(rel)
            if local:
                inherited.append(rel)
                with open(local, "rb") as f:
                    data = f.read()
            else:
                data, ctype = http_get(f"{origin}/{rel}", ua)
                if _looks_like_spa_fallback(rel, data, ctype):
                    raise UpdateError(f"fichier absent en ligne : {rel}")
                _save(tmp, rel, data)
                nbytes += len(data)
            todo.extend(sorted(_refs_in(rel, data) - seen))
        # 2. fichiers publics non versionnés (worklets, polices, icônes, ir, manifest…) : toujours frais
        for rel in mutable_files:
            if rel == "index.html" or is_immutable(rel) or rel.split("/")[0] in EXCLUDED_TOP:
                continue
            try:
                data, ctype = http_get(f"{origin}/{urllib.parse.quote(rel)}", ua)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    say(f"  {rel} n'existe plus en ligne")
                    continue
                raise
            if _looks_like_spa_fallback(rel, data, ctype):
                say(f"  {rel} n'existe plus en ligne")
                continue
            _save(tmp, rel, data)
            nbytes += len(data)
        # 3. sons de batterie (noms = empreinte) : repris de la version livrée ; les nouveaux
        #    sons cités par le code sont téléchargés (sinon chargés en ligne à la demande)
        if bundled is not None:
            for rel in bundled.m.get("files", {}):
                if rel.startswith("drums/"):
                    inherited.append(rel)
            for rel in bundled.m.get("inherited", []):
                if rel.startswith("drums/"):
                    inherited.append(rel)
        known = {r for r in inherited if r.startswith("drums/lib/")}
        new_drums = set()
        for rel in list(seen):
            p = os.path.join(tmp, *rel.split("/"))
            src = p if os.path.isfile(p) else have_inherited(rel)
            if not src or not rel.endswith(".js"):
                continue
            with open(src, "rb") as f:
                text = f.read()
            if b"drums/lib/" not in text:
                continue
            for m in DRUM_ID.finditer(text.decode("utf-8", "replace")):
                cand = f"drums/lib/{m.group(1)}.wav"
                if cand not in known:
                    new_drums.add(cand)
        for rel in sorted(new_drums)[:400]:
            try:
                data, ctype = http_get(f"{origin}/{rel}", ua)
            except Exception:
                continue
            if data[:4] == b"RIFF" and not _looks_like_spa_fallback(rel, data, ctype):
                _save(tmp, rel, data)
                nbytes += len(data)
        # 4. feuilles de style externes (Font Awesome)
        def have_ext(rel):
            return have_inherited(rel)
        ext = mirror_external_css(index, tmp, ua, have=have_ext, log=say)
        for rel in ext:
            if not os.path.isfile(os.path.join(tmp, *rel.split("/"))):
                inherited.append(rel)
        # 5. manifeste + vérification complète, puis renommage atomique
        m = write_manifest(tmp, kind, {"type": "online", "origin": origin}, inherited=sorted(set(inherited)))
        v, why = load_version(tmp, base=bundled if kind == "downloaded" else None, deep=True)
        if v is None:
            raise UpdateError(f"vérification : {why}")
        if os.path.isdir(final):
            shutil.rmtree(final, ignore_errors=True)
        os.replace(tmp, final)
        say(f"interface {m['id']} téléchargée : {len(m['files'])} fichiers, {nbytes / 1e6:.1f} Mo "
            f"en {time.time() - t0:.1f} s ({len(m['inherited'])} repris de la version livrée)")
        v2, why = load_version(final, base=bundled if kind == "downloaded" else None)
        if v2 is None:
            raise UpdateError(f"après renommage : {why}")
        return v2
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def check_for_update(origin: str, data_dir: str, active: "UiVersion | None", bundled: "UiVersion | None",
                     known: "list[UiVersion]", ua: str, log=None) -> "UiVersion | None":
    """Version en ligne différente de celle utilisée ? -> la renvoie (téléchargée au besoin), pour le
    prochain démarrage ; None si l'interface utilisée est déjà celle du site en ligne."""
    say = log or (lambda *_: None)
    cache = cache_root(data_dir)
    index = fetch_online_index(origin, ua)
    sha = hashlib.sha256(index).hexdigest()
    vid = version_id(index)
    if active is not None and active.index_sha == sha:
        write_state(cache, vid)
        say(f"interface à jour ({vid})")
        return None
    if vid in bad_ids(cache):
        say(f"interface en ligne {vid} déjà écartée (n'avait pas démarré)")
        return None
    # Jamais vers une version plus ancienne que celle qu'on a (installateur
    # construit avant la mise en ligne, ou mise en ligne bloquée) : avant, « le
    # site fait foi » faisait revenir l'application en arrière.
    mine = version_build_stamp(active)
    online_stamp = build_stamp(index)
    if mine is not None and (online_stamp is None or online_stamp < mine):
        say(f"interface en ligne {vid} plus ancienne que la nôtre ({active.id}) : on garde la nôtre")
        return None
    for v in [bundled, *known]:
        if v is not None and v.index_sha == sha:
            write_state(cache, vid)
            say(f"interface en ligne = {v.id}, déjà sur le disque : prise au prochain démarrage")
            return v
    mutable = sorted(set((bundled.m["files"] if bundled else {}).keys()) |
                     set((active.m["files"] if active else {}).keys()))
    v = download_version(origin, cache, bundled, mutable, ua, index_bytes=index, log=say)
    write_state(cache, v.id)
    return v
