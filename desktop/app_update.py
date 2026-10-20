# -*- coding: utf-8 -*-
"""
Mise à jour du PROGRAMME Nova Studio (exe, pont Python, NovaVSTHost, NovaARAHost, Python
embarqué), en plus de l'interface (ui_bundle.py) qui se met déjà à jour toute seule.

Fonctionnement :
  1. Le site publie un manifeste : https://<site>/downloads/nova-studio-latest.json
     { version, url: "downloads/NovaStudioSetup-X.Y.Z.exe", sha256, size, date, notes[], minVersion? }
     (écrit par build.py à chaque construction).
  2. L'appli le lit en HTTPS (origine fixe) après le démarrage puis toutes les 6 h. Version plus
     récente (jamais de retour en arrière) : l'installateur est téléchargé en arrière-plan dans
     %LOCALAPPDATA%\\NovaStudio\\updates\\ (fichier .part repris là où il s'est arrêté, puis taille
     et SHA-256 vérifiés, puis renommage). Un fichier non vérifié n'est jamais lancé.
  3. La page affiche « Nova Studio X.Y.Z est prête » : « Redémarrer et mettre à jour » (refusé
     pendant un enregistrement, une lecture ou une collaboration) ou « Plus tard ».
  4. Sans rien faire : installation À LA FERMETURE de l'appli (installateur caché /VERYSILENT,
     lancé par un petit script PowerShell caché qui attend la fin du processus), sinon au
     démarrage suivant, avant la fenêtre (/SILENT : la petite fenêtre de progression de
     l'installateur sert d'écran « Mise à jour en cours… »).
  5. Après la mise à jour : « Mis à jour en X.Y.Z ✓ » une fois. Échec : l'ancienne version reste,
     l'erreur est journalisée, et on ne retente qu'une fois par version et par jour.

Ce module ne dépend ni de .NET ni de WebView2 : il est testé seul (test/test_app_update.py) et
de bout en bout avec un faux installateur (qa/desktop_maj_auto.py).

Variables d'environnement :
  NOVA_DESKTOP_NO_UPDATE=1                 aucune mise à jour (interface ni programme)
  NOVA_DESKTOP_UPDATE_TEST_ORIGIN=http://127.0.0.1:8802
                                           TESTS SEULEMENT : autre origine du manifeste
                                           (acceptée uniquement en 127.0.0.1 / localhost)
"""
import hashlib
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse

PROD_ORIGIN = "https://nova-studio-daw-0901-9kzo.vercel.app"
MANIFEST_REL = "downloads/nova-studio-latest.json"
TEST_ORIGIN_ENV = "NOVA_DESKTOP_UPDATE_TEST_ORIGIN"
INSTALLER_PREFIX = "NovaStudioSetup-"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_INSTALLER_BYTES = 400 * 1024 * 1024
LOOPBACK = ("127.0.0.1", "localhost")
LOCK_STALE_S = 15 * 60

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000

# Modes d'installation : à la fermeture (rien ne s'affiche), à la demande de l'utilisateur ou
# au démarrage (petite fenêtre de progression de l'installateur, puis relance de l'appli).
MODE_CLOSE, MODE_APPLY, MODE_STARTUP = "close", "apply", "startup"


class UpdateError(Exception):
    """Erreur de mise à jour (message en français, journalisé)."""


# ─────────────────────────────────────────────────────────────────────────────
# Versions
# ─────────────────────────────────────────────────────────────────────────────

_VERSION = re.compile(r"^\d{1,4}(\.\d{1,6}){0,3}$")


def parse_version(s) -> "tuple | None":
    """« 1.5.3 » -> (1, 5, 3, 0) ; None si le texte n'est pas une version simple."""
    if not isinstance(s, str) or not _VERSION.match(s.strip()):
        return None
    parts = [int(x) for x in s.strip().split(".")]
    return tuple(parts + [0] * (4 - len(parts)))


def is_newer(candidate, current) -> bool:
    """candidate strictement plus récente que current (jamais de rétrogradation)."""
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b


def today(now: "float | None" = None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.time() if now is None else now))


# ─────────────────────────────────────────────────────────────────────────────
# Origine et manifeste
# ─────────────────────────────────────────────────────────────────────────────

def update_origin(env=None, log=None) -> str:
    """Origine du manifeste : la prod, sauf surcharge de TEST en boucle locale uniquement."""
    env = os.environ if env is None else env
    o = (env.get(TEST_ORIGIN_ENV) or "").strip().rstrip("/")
    if o:
        p = urlparse(o)
        if p.scheme in ("http", "https") and (p.hostname or "") in LOOPBACK and p.path in ("", "/") \
                and not p.query and not p.username:
            return f"{p.scheme}://{p.netloc}"
        if log:
            log(f"{TEST_ORIGIN_ENV} ignorée (seulement http://127.0.0.1:<port> pour les tests)")
    return PROD_ORIGIN


def _origin_of(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}".lower()


def check_url(url: str, origin: str) -> str:
    """URL autorisée : même origine que le manifeste, HTTPS (sauf origine de test locale)."""
    p = urlparse(url)
    if _origin_of(url) != origin.lower():
        raise UpdateError(f"adresse hors du site ({p.netloc or url[:60]})")
    if p.scheme != "https" and (p.hostname or "") not in LOOPBACK:
        raise UpdateError("adresse non sécurisée (HTTPS obligatoire)")
    return url


class Manifest:
    def __init__(self, version, url, sha256, size, date="", notes=(), min_version=None):
        self.version, self.url, self.sha256, self.size = version, url, sha256, size
        self.date, self.notes, self.min_version = date, list(notes), min_version

    def to_dict(self) -> dict:
        return {"version": self.version, "url": self.url, "sha256": self.sha256, "size": self.size,
                "date": self.date, "notes": self.notes, "minVersion": self.min_version}

    @property
    def file_name(self) -> str:
        return f"{INSTALLER_PREFIX}{self.version}.exe"


def parse_manifest(data, origin: str) -> Manifest:
    """Manifeste vérifié (champ par champ) ; UpdateError sinon."""
    if isinstance(data, (bytes, bytearray)):
        if len(data) > MAX_MANIFEST_BYTES:
            raise UpdateError("manifeste trop gros")
        try:
            data = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise UpdateError("manifeste illisible (pas du JSON)")
    if not isinstance(data, dict):
        raise UpdateError("manifeste illisible")
    version = data.get("version")
    if parse_version(version) is None:
        raise UpdateError(f"version invalide : {str(version)[:20]!r}")
    url = data.get("url")
    if not isinstance(url, str) or not url or len(url) > 300:
        raise UpdateError("adresse de l'installateur absente")
    full = check_url(urljoin(origin.rstrip("/") + "/", url), origin)
    path = urlparse(full).path
    if not re.fullmatch(r"/downloads/NovaStudioSetup(-[0-9.]+)?\.exe", path):
        raise UpdateError(f"installateur inattendu : {path[:80]}")
    sha = data.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha):
        raise UpdateError("empreinte SHA-256 invalide")
    size = data.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not (100_000 <= size <= MAX_INSTALLER_BYTES):
        raise UpdateError("taille invalide")
    notes = data.get("notes") or []
    if isinstance(notes, str):
        notes = [notes]
    if not isinstance(notes, list):
        notes = []
    notes = [str(n).strip()[:240] for n in notes if isinstance(n, str) and n.strip()][:8]
    mv = data.get("minVersion")
    mv = mv if parse_version(mv) is not None else None
    date = str(data.get("date") or "")[:40]
    return Manifest(version.strip(), full, sha.lower(), size, date, notes, mv)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise UpdateError(f"redirection refusée ({code})")


def _opener():
    return urllib.request.build_opener(_NoRedirect)


def fetch_manifest(origin: str, ua: str, timeout: float = 20, opener=None) -> Manifest:
    url = check_url(f"{origin.rstrip('/')}/{MANIFEST_REL}?t={int(time.time())}", origin)
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Cache-Control": "no-cache",
                                               "Accept": "application/json"})
    try:
        with (opener or _opener()).open(req, timeout=timeout) as r:
            if r.status != 200:
                raise UpdateError(f"manifeste : HTTP {r.status}")
            data = r.read(MAX_MANIFEST_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise UpdateError(f"manifeste : HTTP {e.code}")
    except (urllib.error.URLError, OSError) as e:
        raise UpdateError(f"pas de connexion au site ({getattr(e, 'reason', e)})")
    return parse_manifest(data, origin)


# ─────────────────────────────────────────────────────────────────────────────
# Téléchargement (reprise + vérification)
# ─────────────────────────────────────────────────────────────────────────────

def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_file(path: str, sha256: str, size: int) -> bool:
    """Taille ET empreinte : la seule condition pour lancer un installateur."""
    try:
        return os.path.getsize(path) == size and sha256_file(path) == sha256.lower()
    except OSError:
        return False


def _part_meta_ok(meta_path: str, m: Manifest) -> bool:
    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        return meta.get("sha256") == m.sha256 and meta.get("size") == m.size
    except (OSError, ValueError):
        return False


def _remove(*paths):
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def download(m: Manifest, dest_dir: str, ua: str, log=None, attempts: int = 5,
             backoff=(2, 5, 15, 30, 60), sleep=time.sleep, stop: "threading.Event | None" = None,
             progress=None, opener=None, timeout: float = 30, chunk: int = 1 << 16) -> str:
    """Télécharge l'installateur de m dans dest_dir et renvoie son chemin vérifié.

    Fichier temporaire « .part » (+ « .part.json » : quelle version il contient) repris avec un
    en-tête Range après une coupure ; renommé seulement après contrôle de la taille et du SHA-256.
    UpdateError après `attempts` essais (le .part reste pour la reprise suivante)."""
    say = log or (lambda *_: None)
    os.makedirs(dest_dir, exist_ok=True)
    final = os.path.join(dest_dir, m.file_name)
    if os.path.exists(final):
        if verify_file(final, m.sha256, m.size):
            return final
        say(f"{m.file_name} présent mais abîmé : retéléchargé")
        _remove(final)
    part, meta = final + ".part", final + ".part.json"
    if not _part_meta_ok(meta, m):
        _remove(part)
        with open(meta, "w", encoding="utf-8") as f:
            json.dump({"version": m.version, "sha256": m.sha256, "size": m.size}, f)
    last = "?"
    bad_hash = 0
    op = opener or _opener()
    for i in range(max(1, attempts)):
        if stop is not None and stop.is_set():
            raise UpdateError("téléchargement interrompu (fermeture)")
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have > m.size:
            _remove(part)
            have = 0
        try:
            if have < m.size:
                headers = {"User-Agent": ua}
                if have:
                    headers["Range"] = f"bytes={have}-"
                req = urllib.request.Request(check_url(m.url, _origin_of(m.url)), headers=headers)
                with op.open(req, timeout=timeout) as r:
                    status = r.status
                    if have and status == 206:
                        cr = r.headers.get("Content-Range", "")
                        mm = re.match(r"bytes (\d+)-", cr)
                        if not mm or int(mm.group(1)) != have:
                            _remove(part)
                            raise UpdateError(f"reprise incohérente ({cr or 'sans Content-Range'})")
                        mode = "ab"
                    elif status == 200:
                        if have:
                            say("le serveur ne reprend pas : téléchargement depuis le début")
                        have, mode = 0, "wb"
                    else:
                        raise UpdateError(f"HTTP {status}")
                    with open(part, mode) as f:
                        while True:
                            if stop is not None and stop.is_set():
                                raise UpdateError("téléchargement interrompu (fermeture)")
                            buf = r.read(chunk)
                            if not buf:
                                break
                            have += len(buf)
                            if have > m.size:
                                raise UpdateError("fichier plus gros qu'annoncé")
                            f.write(buf)
                            if progress:
                                progress(have, m.size)
            if os.path.getsize(part) != m.size:
                raise UpdateError(f"incomplet ({os.path.getsize(part)} / {m.size} octets)")
            if sha256_file(part) != m.sha256:
                _remove(part)
                bad_hash += 1
                raise UpdateError("empreinte SHA-256 différente de celle du manifeste")
            os.replace(part, final)
            _remove(meta)
            say(f"installateur {m.version} téléchargé et vérifié ({m.size / 1e6:.1f} Mo)")
            return final
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code == 416:  # plage refusée : on repart de zéro
                _remove(part)
        except UpdateError as e:
            last = str(e)
            if "interrompu" in last or bad_hash >= 2:
                raise
            if "fichier plus gros" in last:
                _remove(part)
        except (urllib.error.URLError, OSError, ValueError) as e:  # coupure réseau, disque…
            last = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
        if i + 1 < attempts:
            wait = backoff[min(i, len(backoff) - 1)]
            say(f"téléchargement de la mise à jour : {last} ; nouvel essai dans {wait} s")
            if stop is not None:
                if stop.wait(wait):
                    raise UpdateError("téléchargement interrompu (fermeture)")
            else:
                sleep(wait)
    raise UpdateError(f"téléchargement impossible : {last}")


# ─────────────────────────────────────────────────────────────────────────────
# État (updates\state.json) et règle anti-boucle
# ─────────────────────────────────────────────────────────────────────────────

STATE_FILE = "state.json"
RESULT_FILE = "install-result.json"
LOCK_FILE = "installing.lock"
RELAUNCH_FLAG = "relaunch-wanted"
INSTALL_LOG = "install.log"


def default_state() -> dict:
    return {"auto": True, "ready": None, "attempts": {}, "announce": None, "lastCheck": 0, "lastError": "",
            "pendingDownload": None, "available": None}


def load_state(updates_dir: str) -> dict:
    st = default_state()
    try:
        with open(os.path.join(updates_dir, STATE_FILE), encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            st.update({k: raw[k] for k in st if k in raw})
    except (OSError, ValueError):
        pass
    if not isinstance(st.get("attempts"), dict):
        st["attempts"] = {}
    st["auto"] = st.get("auto") is not False
    return st


def save_state(updates_dir: str, st: dict) -> None:
    os.makedirs(updates_dir, exist_ok=True)
    tmp = os.path.join(updates_dir, STATE_FILE + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(updates_dir, STATE_FILE))


def can_attempt(st: dict, version: str, day: str) -> bool:
    """Une seule tentative d'installation par version et par jour : une installation ratée (ou
    interrompue) n'est pas relancée en boucle, l'ancienne version reste utilisable."""
    a = (st.get("attempts") or {}).get(version)
    return not (isinstance(a, dict) and a.get("day") == day)


def record_attempt(st: dict, version: str, day: str, mode: str, now: "float | None" = None) -> None:
    st.setdefault("attempts", {})[version] = {"day": day, "mode": mode, "result": "pending",
                                              "at": time.time() if now is None else now}


def read_result(updates_dir: str) -> "dict | None":
    """Compte rendu écrit par le script d'installation (PowerShell : UTF-8 avec BOM)."""
    p = os.path.join(updates_dir, RESULT_FILE)
    try:
        with open(p, encoding="utf-8-sig") as f:
            r = json.load(f)
        return r if isinstance(r, dict) else None
    except (OSError, ValueError):
        return None


def resolve_attempts(st: dict, app_version: str, result: "dict | None") -> list:
    """Au démarrage : chaque tentative « en cours » est tranchée selon la version qui tourne.
    Renvoie [(version, 'ok'|'fail', détail)]."""
    out = []
    for v, a in list((st.get("attempts") or {}).items()):
        if not isinstance(a, dict) or a.get("result") != "pending":
            continue
        detail = ""
        if result and result.get("version") == v:
            if result.get("error"):
                detail = str(result.get("error"))[:200]
            elif result.get("exitCode") not in (None, 0):
                detail = f"code de sortie de l'installateur : {result.get('exitCode')}"
        ok = parse_version(app_version) is not None and parse_version(v) is not None \
            and parse_version(app_version) >= parse_version(v)
        a["result"] = "ok" if ok else "fail"
        if not ok:
            a["error"] = detail or "la version installée n'a pas changé"
        out.append((v, a["result"], detail))
    # on ne garde que les 10 dernières versions tentées
    if len(st.get("attempts") or {}) > 10:
        keep = sorted(st["attempts"].items(), key=lambda kv: kv[1].get("at", 0) if isinstance(kv[1], dict) else 0)[-10:]
        st["attempts"] = dict(keep)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Page occupée ? (jamais pendant un enregistrement, une lecture ou une collaboration)
# ─────────────────────────────────────────────────────────────────────────────

# Évalué dans la page (ExecuteScriptAsync renvoie l'objet en JSON). window.__novaBusy est
# fourni par le DAW (hooks/useDesktopBusyProbe.ts) ; repli sur window.__novaCollab.
BUSY_PROBE_JS = r"""
(function () {
  var r = { recording: false, playing: false, collab: false, src: 'none' };
  try {
    if (typeof window.__novaBusy === 'function') {
      var b = window.__novaBusy() || {};
      r.recording = !!b.recording; r.playing = !!b.playing; r.collab = !!b.collab; r.src = 'page';
      return r;
    }
  } catch (e) {}
  try {
    var c = window.__novaCollab;
    if (c) {
      var t = c.engineTime && c.engineTime();
      r.playing = !!(t && t.playing); r.collab = !!(c.role && c.role()); r.src = 'collab';
    }
  } catch (e) {}
  return r;
})()
"""

BUSY_TEXT = {
    "recording": "Un enregistrement est en cours : arrête-le, puis relance la mise à jour.",
    "playing": "La lecture est en cours : mets-la en pause, puis relance la mise à jour.",
    "collab": "Une séance de collaboration est ouverte : quitte-la, puis relance la mise à jour.",
    "unknown": "Nova Studio ne répond pas pour l'instant : réessaie dans un moment.",
    "failed": "L'installation n'a pas abouti aujourd'hui : ta version actuelle reste utilisable. "
              "Nouvel essai demain (ou télécharge l'installateur sur le site).",
}


def busy_reason(probe) -> "str | None":
    """None si on peut redémarrer ; sinon 'recording' | 'playing' | 'collab' | 'unknown'
    ('failed' est ajouté par Updater.request_apply : installation déjà ratée aujourd'hui)."""
    if not isinstance(probe, dict):
        return "unknown"
    for k in ("recording", "playing", "collab"):
        if probe.get(k):
            return k
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Installation : script PowerShell caché qui attend la fin de l'appli
# ─────────────────────────────────────────────────────────────────────────────

def installer_args(mode: str, log_file: str) -> list:
    """/VERYSILENT à la fermeture (rien ne s'affiche) ; /SILENT sinon (fenêtre de progression)."""
    return ["/VERYSILENT" if mode == MODE_CLOSE else "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART",
            "/CLOSEAPPLICATIONS", "/SP-", f'/LOG="{log_file}"']


def _ps(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _ps_array(items) -> str:
    return "@(" + ", ".join(_ps(x) for x in items) + ")"


def waiter_script(pid: int, setup: str, sha256: str, size: int, version: str, mode: str,
                  updates_dir: str, relaunch_cmd: "list | None", relaunch: bool) -> str:
    """Script PowerShell : attend la fin de Nova Studio, revérifie l'installateur (taille +
    SHA-256) juste avant de le lancer, l'exécute en silencieux, écrit le compte rendu, enlève le
    verrou, puis relance l'appli si demandé (ou si quelqu'un l'a ouverte pendant l'installation)."""
    args = installer_args(mode, os.path.join(updates_dir, INSTALL_LOG))
    app = relaunch_cmd[0] if relaunch_cmd else ""
    app_args = relaunch_cmd[1:] if relaunch_cmd else []
    # Arguments en UNE chaîne déjà guillemetée (Start-Process colle un tableau sans guillemets :
    # un chemin avec espaces serait coupé en deux).
    start_app = ("Start-Process -FilePath $app" +
                 (f" -ArgumentList {_ps(subprocess.list2cmdline(app_args))}" if app_args else ""))
    return f"""$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dir = {_ps(updates_dir)}
$setup = {_ps(setup)}
$app = {_ps(app)}
$res = [ordered]@{{ version = {_ps(version)}; mode = {_ps(mode)}; exitCode = $null; error = ''; started = (Get-Date).ToString('o') }}
try {{
  try {{ Wait-Process -Id {int(pid)} -Timeout 300 -ErrorAction SilentlyContinue }} catch {{}}
  if (Get-Process -Id {int(pid)} -ErrorAction SilentlyContinue) {{ throw 'Nova Studio ne s''est pas fermé' }}
  $item = Get-Item -LiteralPath $setup
  if ($item.Length -ne {int(size)}) {{ throw 'installateur : taille inattendue' }}
  $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLower()
  if ($h -ne {_ps(sha256.lower())}) {{ throw 'installateur : empreinte SHA-256 inattendue' }}
  $p = Start-Process -FilePath $setup -ArgumentList {_ps_array(args)} -PassThru -Wait
  $res.exitCode = $p.ExitCode
}} catch {{
  $res.error = $_.Exception.Message
}}
$res.finished = (Get-Date).ToString('o')
try {{ ($res | ConvertTo-Json -Compress) | Set-Content -LiteralPath (Join-Path $dir {_ps(RESULT_FILE)}) -Encoding UTF8 }} catch {{}}
Remove-Item -LiteralPath (Join-Path $dir {_ps(LOCK_FILE)}) -ErrorAction SilentlyContinue
$wanted = Test-Path -LiteralPath (Join-Path $dir {_ps(RELAUNCH_FLAG)})
Remove-Item -LiteralPath (Join-Path $dir {_ps(RELAUNCH_FLAG)}) -ErrorAction SilentlyContinue
if ($app -and ({'$true' if relaunch else '$false'} -or $wanted)) {{ try {{ {start_app} }} catch {{}} }}
"""


def powershell_exe() -> str:
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    p = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return p if os.path.isfile(p) else "powershell.exe"


def launch_waiter(script: str, updates_dir: str, version: str, popen=subprocess.Popen) -> int:
    """Écrit le script et le lance caché, détaché de l'appli (survit à sa fermeture)."""
    os.makedirs(updates_dir, exist_ok=True)
    path = os.path.join(updates_dir, f"install-{version}.ps1")
    with open(path, "w", encoding="utf-8-sig") as f:  # BOM : PowerShell 5.1 lit alors l'UTF-8
        f.write(script)
    _remove(os.path.join(updates_dir, RESULT_FILE))
    with open(os.path.join(updates_dir, LOCK_FILE), "w", encoding="utf-8") as f:
        f.write(json.dumps({"version": version, "at": time.time()}))
    cmd = [powershell_exe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-WindowStyle", "Hidden", "-File", path]
    base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
              close_fds=True, cwd=updates_dir)
    try:  # hors du « job » de l'appli s'il y en a un (sinon il mourrait avec elle)
        p = popen(cmd, creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **kw)
    except OSError:
        p = popen(cmd, creationflags=base, **kw)
    return p.pid


def install_in_progress(updates_dir: str, now: "float | None" = None) -> bool:
    """Une installation est-elle en cours (verrou récent) ?"""
    try:
        with open(os.path.join(updates_dir, LOCK_FILE), encoding="utf-8") as f:
            at = float(json.load(f).get("at", 0))
    except (OSError, ValueError, AttributeError):
        return False
    return ((time.time() if now is None else now) - at) < LOCK_STALE_S


def request_relaunch_after_install(updates_dir: str) -> None:
    with open(os.path.join(updates_dir, RELAUNCH_FLAG), "w", encoding="utf-8") as f:
        f.write(str(time.time()))


def windows_shutting_down() -> bool:
    """Fermeture de session / arrêt du PC en cours : on n'installe pas (Windows pourrait couper
    l'installateur en plein travail) ; ce sera au démarrage suivant."""
    try:
        import ctypes
        return bool(ctypes.windll.user32.GetSystemMetrics(0x2000))  # SM_SHUTTINGDOWN
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Chef d'orchestre (utilisé par nova_desktop.py, sans .NET)
# ─────────────────────────────────────────────────────────────────────────────

class Updater:
    """État de la mise à jour du programme, partagé entre la fenêtre et les fils d'arrière-plan.

    post(state_dict) : envoie l'état à la page (message {type:'nova-desktop-update', ...})."""

    def __init__(self, app_version: str, data_dir: str, ua: str, log=None, post=None,
                 origin: "str | None" = None, popen=subprocess.Popen, now=time.time,
                 relaunch_cmd: "list | None" = None, opener=None, backoff=(2, 5, 15, 30, 60)):
        self.app_version = app_version
        self.dir = os.path.join(data_dir, "updates")
        self.ua = ua
        self.log = log or (lambda *_: None)
        self.post = post or (lambda *_: None)
        self.origin = origin or update_origin(log=self.log)
        self.popen = popen
        self.now = now
        self.relaunch_cmd = relaunch_cmd
        self.opener = opener
        self.backoff = backoff
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.st = load_state(self.dir)
        self.phase = "idle"       # idle | checking | downloading | ready | uptodate | error | installing
        self.progress = 0.0
        self.error = ""
        self.busy = None
        self.relaunch_requested = False
        self.dismissed = False
        self.page_ready = False
        self.launched = False
        self._check_lock = threading.Lock()

    # ── état envoyé à la page ───────────────────────────────────────────
    def ready_manifest(self) -> "Manifest | None":
        r = self.st.get("ready")
        if not isinstance(r, dict) or not is_newer(r.get("version"), self.app_version):
            return None
        try:
            return Manifest(r["version"], r["url"], r["sha256"], int(r["size"]), r.get("date", ""),
                            r.get("notes") or [], r.get("minVersion"))
        except (KeyError, TypeError, ValueError):
            return None

    def snapshot(self) -> dict:
        with self.lock:
            m = self.ready_manifest()
            phase = self.phase
            if m is not None and phase in ("idle", "uptodate", "checking", "error"):
                phase = "ready"
            return {
                "type": "nova-desktop-update",
                "installed": self.app_version,
                "auto": bool(self.st.get("auto", True)),
                "phase": phase,
                "progress": round(self.progress, 3),
                "available": ({"version": m.version, "notes": m.notes, "size": m.size, "date": m.date}
                              if m is not None else None),
                "error": self.error,
                "busy": self.busy,
                "busyText": BUSY_TEXT.get(self.busy or "", ""),
                "dismissed": self.dismissed,
                "justUpdated": self.st.get("announce"),
                "lastCheck": int(self.st.get("lastCheck") or 0),
            }

    def push(self) -> None:
        try:
            self.post(self.snapshot())
        except Exception:
            pass

    def _save(self) -> None:
        try:
            save_state(self.dir, self.st)
        except OSError as e:
            self.log(f"mise à jour : état non enregistré ({e})")

    # ── démarrage ───────────────────────────────────────────────────────
    def startup(self) -> None:
        """Tranche les installations précédentes et range le dossier updates\\."""
        with self.lock:
            result = read_result(self.dir)
            for v, outcome, detail in resolve_attempts(self.st, self.app_version, result):
                if outcome == "ok":
                    notes = (self.st.get("ready") or {}).get("notes") if \
                        (self.st.get("ready") or {}).get("version") == v else []
                    self.st["announce"] = {"version": self.app_version, "notes": notes or []}
                    self.log(f"mise à jour : Nova Studio {v} installée")
                else:
                    self.log(f"mise à jour : l'installation de {v} a échoué ({detail or 'version inchangée'}) ; "
                             f"l'ancienne version {self.app_version} reste utilisée, nouvel essai demain")
                    self.error = BUSY_TEXT["failed"]
            r = self.st.get("ready")
            if isinstance(r, dict) and not is_newer(r.get("version"), self.app_version):
                self.st["ready"] = None
            if result is not None:
                _remove(os.path.join(self.dir, RESULT_FILE))
            self._save()
            self.cleanup()

    def cleanup(self) -> None:
        """Enlève les installateurs et fichiers .part qui ne servent plus."""
        m = self.ready_manifest()
        keep = {m.file_name, m.file_name + ".part", m.file_name + ".part.json"} if m else set()
        try:
            names = os.listdir(self.dir)
        except OSError:
            return
        for n in names:
            if n.startswith(INSTALLER_PREFIX) and n not in keep:
                # le .part de la version en ligne la plus récente est gardé pour la reprise
                cur = (self.st.get("pendingDownload") or "")
                if cur and n.startswith(f"{INSTALLER_PREFIX}{cur}.exe.part"):
                    continue
                _remove(os.path.join(self.dir, n))
            elif n.startswith("install-") and n.endswith(".ps1") and not install_in_progress(self.dir):
                _remove(os.path.join(self.dir, n))

    def auto_enabled(self, m: "Manifest | None" = None) -> bool:
        if self.st.get("auto", True):
            return True
        # version trop ancienne (minVersion) : la mise à jour se fait même sans l'automatique
        return bool(m and m.min_version and is_newer(m.min_version, self.app_version))

    def startup_install(self, pid: int) -> bool:
        """Mise à jour prête mais pas installée à la fermeture (appli tuée, PC éteint…) :
        installée maintenant, avant la fenêtre. True = l'appli doit quitter tout de suite."""
        with self.lock:
            m = self.ready_manifest()
            if m is None or not self.auto_enabled(m):
                return False
            return self._launch(m, pid, MODE_STARTUP, relaunch=True)

    # ── recherche + téléchargement ──────────────────────────────────────
    def check(self, manual: bool = False) -> str:
        """Lit le manifeste et télécharge si plus récent. Renvoie la phase finale."""
        if not self._check_lock.acquire(blocking=False):
            return self.phase
        try:
            with self.lock:
                if self.ready_manifest() is not None and not manual:
                    return "ready"
                self.phase, self.error, self.progress = "checking", "", 0.0
            self.push()
            try:
                m = fetch_manifest(self.origin, self.ua, opener=self.opener)
            except UpdateError as e:
                return self._fail(str(e), manual)
            with self.lock:
                self.st["lastCheck"] = int(self.now() * 1000)
                if not is_newer(m.version, self.app_version):
                    self.phase = "uptodate"
                    self._save()
                    self.log(f"mise à jour : {self.app_version} est à jour (en ligne : {m.version})")
                    self.push()
                    return self.phase
                cur = self.ready_manifest()
                if cur is not None and cur.version == m.version and cur.sha256 == m.sha256 and \
                        verify_file(os.path.join(self.dir, m.file_name), m.sha256, m.size):
                    self.phase = "ready"
                    self.push()
                    return self.phase
                if not manual and not self.auto_enabled(m):
                    self.phase = "idle"
                    self.st["available"] = m.version
                    self._save()
                    self.log(f"mise à jour {m.version} disponible (automatique désactivée)")
                    self.push()
                    return self.phase
                self.phase = "downloading"
                self.st["pendingDownload"] = m.version
                self._save()
            self.log(f"mise à jour : Nova Studio {m.version} disponible, téléchargement en arrière-plan")
            self.push()
            last_push = [0.0]

            def prog(have, total):
                self.progress = have / max(1, total)
                t = time.time()
                if t - last_push[0] > 1.0:
                    last_push[0] = t
                    self.push()

            try:
                path = download(m, self.dir, self.ua, log=self.log, stop=self.stop, progress=prog,
                                opener=self.opener, backoff=self.backoff)
            except UpdateError as e:
                return self._fail(str(e), manual)
            with self.lock:
                if not verify_file(path, m.sha256, m.size):  # ceinture et bretelles
                    _remove(path)
                    return self._fail("installateur abîmé après téléchargement", manual)
                self.st["ready"] = dict(m.to_dict(), file=m.file_name)
                self.st["pendingDownload"] = None
                self.st["lastError"] = ""
                self.phase, self.progress, self.dismissed = "ready", 1.0, False
                self._save()
                self.cleanup()
            self.log(f"mise à jour : Nova Studio {m.version} prête (installation à la fermeture)")
            self.push()
            return "ready"
        finally:
            self._check_lock.release()

    def _fail(self, msg: str, manual: bool) -> str:
        with self.lock:
            self.phase, self.error = "error", msg
            self.st["lastError"] = msg
            self._save()
        self.log(f"mise à jour du programme impossible pour l'instant : {msg}")
        self.push()
        return "error"

    def loop(self, first_delay: float, every: float) -> None:
        if self.stop.wait(first_delay):
            return
        while not self.stop.is_set():
            try:
                self.check()
            except Exception as e:  # jamais d'exception qui tue le fil
                self.log(f"mise à jour : erreur inattendue ({type(e).__name__}: {e})")
            if self.stop.wait(every):
                return

    # ── actions de la page ──────────────────────────────────────────────
    def set_auto(self, on: bool) -> None:
        with self.lock:
            self.st["auto"] = bool(on)
            self._save()
        self.log(f"mises à jour automatiques {'activées' if on else 'désactivées'}")
        self.push()

    def later(self) -> None:
        with self.lock:
            self.dismissed, self.busy = True, None
        self.push()

    def seen_announce(self) -> None:
        with self.lock:
            if self.st.get("announce"):
                self.st["announce"] = None
                self._save()

    def request_apply(self, probe) -> "str | None":
        """L'utilisateur clique « Redémarrer et mettre à jour ». None = on peut fermer l'appli
        (sauvegarde puis installation et relance) ; sinon la raison du refus."""
        with self.lock:
            if self.ready_manifest() is None:
                self.busy = None
                return "none"
            reason = busy_reason(probe)
            if reason is None and not can_attempt(self.st, self.ready_manifest().version, today(self.now())):
                reason = "failed"  # sinon l'appli se fermerait sans rien installer ni se rouvrir
            self.busy = reason
            if reason is None:
                self.relaunch_requested = True
                self.phase = "installing"
        self.push()
        return reason

    # ── fermeture de l'appli ────────────────────────────────────────────
    def on_exit(self, pid: int) -> bool:
        """Après la fermeture de la fenêtre : lance l'installation si une mise à jour est prête."""
        self.stop.set()
        with self.lock:
            m = self.ready_manifest()
            if m is None:
                return False
            if not self.relaunch_requested and not self.auto_enabled(m):
                return False
            if not self.relaunch_requested and windows_shutting_down():
                self.log("mise à jour : arrêt de Windows en cours, installation au prochain démarrage")
                return False
            mode = MODE_APPLY if self.relaunch_requested else MODE_CLOSE
            ok = self._launch(m, pid, mode, relaunch=self.relaunch_requested)
            if not ok and self.relaunch_requested and self.relaunch_cmd:
                # L'utilisateur a demandé « Redémarrer » : même sans installation, l'appli se rouvre.
                try:
                    self.popen(self.relaunch_cmd, close_fds=True, creationflags=0x00000008)  # DETACHED_PROCESS
                    self.log("mise à jour non lancée : Nova Studio est rouvert tel quel")
                except Exception as e:
                    self.log(f"relance impossible ({e})")
            return ok

    def _launch(self, m: Manifest, pid: int, mode: str, relaunch: bool) -> bool:
        if self.launched:
            return True
        day = today(self.now())
        if not can_attempt(self.st, m.version, day):
            self.log(f"mise à jour {m.version} : déjà tentée aujourd'hui, nouvel essai demain")
            return False
        path = os.path.join(self.dir, m.file_name)
        if not verify_file(path, m.sha256, m.size):
            self.log(f"mise à jour {m.version} : installateur absent ou abîmé, il sera retéléchargé")
            self.st["ready"] = None
            _remove(path)
            self._save()
            return False
        script = waiter_script(pid, path, m.sha256, m.size, m.version, mode, self.dir,
                               self.relaunch_cmd, relaunch)
        record_attempt(self.st, m.version, day, mode, self.now())
        self._save()
        try:
            wpid = launch_waiter(script, self.dir, m.version, popen=self.popen)
        except Exception as e:
            self.st["attempts"][m.version]["result"] = "fail"
            self.st["attempts"][m.version]["error"] = f"lancement impossible : {e}"
            self._save()
            self.log(f"mise à jour {m.version} : lancement de l'installation impossible ({e})")
            return False
        self.launched = True
        self.log(f"mise à jour {m.version} : installation lancée ({mode}, script pid {wpid}"
                 f"{', relance ensuite' if relaunch else ''})")
        return True


# Repli : interface trop ancienne pour afficher elle-même la carte (pas de « hello » reçu).
FALLBACK_TOAST_JS = r"""
(function (st) {
  var old = document.getElementById('nova-desktop-app-update');
  if (old) old.remove();
  if (!st || !st.available || st.dismissed) return;
  var d = document.createElement('div');
  d.id = 'nova-desktop-app-update';
  d.setAttribute('role', 'status');
  d.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;max-width:360px;' +
    'background:rgba(12,13,16,.96);color:#e2e8f0;border:1px solid rgba(34,211,238,.5);border-radius:12px;' +
    'padding:12px 14px;font:500 13px/1.4 Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)';
  var t = document.createElement('div');
  t.style.cssText = 'font-weight:700;margin-bottom:4px';
  t.textContent = 'Nova Studio ' + st.available.version + ' est prête';
  d.appendChild(t);
  var ul = document.createElement('ul');
  ul.style.cssText = 'margin:0 0 8px 16px;padding:0;font-weight:400;font-size:12px';
  (st.available.notes || []).slice(0, 6).forEach(function (n) { var li = document.createElement('li'); li.textContent = n; ul.appendChild(li); });
  d.appendChild(ul);
  var msg = document.createElement('div');
  msg.style.cssText = 'font-size:12px;margin-bottom:8px;color:#fcd34d';
  msg.textContent = st.busyText || '';
  d.appendChild(msg);
  function btn(label, a, main) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.style.cssText = main ? 'margin-right:8px;padding:6px 12px;border:0;border-radius:8px;background:#22d3ee;color:#021014;font-weight:700;cursor:pointer'
                           : 'padding:6px 12px;border:1px solid #475569;border-radius:8px;background:transparent;color:#e2e8f0;cursor:pointer';
    b.addEventListener('click', function () {
      try { window.chrome.webview.postMessage('nova-desktop:update:' + a); } catch (e) {}
      if (a === 'later') d.remove(); else msg.textContent = 'Sauvegarde de la session…';
    });
    d.appendChild(b);
  }
  btn('Redémarrer et mettre à jour', 'apply', true);
  btn('Plus tard', 'later', false);
  (document.body || document.documentElement).appendChild(d);
})(%s);
"""
