# -*- coding: utf-8 -*-
"""
Préparation de la bibliothèque de kits de batterie de NOVA (rejouable).

Source (lecture seule) : un dossier de sons (WAV) rangés en dossiers numérotés (« 01 KICK »,
« 04 808 »…) et en packs complets. Sortie :
  public/drums/kits/<id>.nks    un fichier par son : FLAC 16 bits (mono si canaux identiques), brouillé
                                (conteneur maison AES-CTR, voir scramble()) : jamais un audio lisible tel quel
  data/drum-kits/index.json     index chargé à la demande par le DAW (utils/drumKitLibrary.ts)
  <privé>/correspondance_privee.csv   identifiant publié -> chemin d'origine (HORS du dépôt)
  <privé>/exclusions_privees.csv      sons écartés et raison (HORS du dépôt)

Rien de la source n'est publié : ni nom de fichier, ni nom de pack ou de producteur, ni métadonnée
(les FLAC sont réécrits à partir des seuls échantillons). Les sons s'appellent « Kick 1 », « 808 12 »…
et les kits « Trap 3 », « Afro 1 », « Kit 2 ».

Traitement de chaque son :
  1. lecture (WAV PCM 16/24/32 bits, flottant…), rééchantillonnage à 48 kHz au-delà de 48 kHz,
     à 44,1 kHz en dessous de 44,1 kHz (sinon fréquence d'origine) ;
  2. mono si les deux canaux sont identiques (écart < 1 pas de quantification 16 bits) ;
  3. normalisation de la crête à -1 dBFS (gain linéaire : aucune compression, dynamique intacte) ;
  4. silence de début (< -80 dBFS) et de fin (< -60 dBFS) retirés, fondu de 8 ms sur la coupe de fin ;
  5. durée maximale par catégorie (boucles écartées), doublons exacts fusionnés (empreinte des
     échantillons après traitement) ;
  6. hauteur fondamentale des 808 et des basses (spectre de la partie tenue), recoupée avec la note
     écrite dans le nom d'origine quand il y en a une ;
  7. quantification 16 bits avec dither triangulaire déterministe, FLAC niveau 8, puis brouillage.

Retirer un son (réclamation) : ajouter son identifiant publié (colonne 1 de la correspondance
privée) dans <privé>/retraits.txt, relancer le script, committer. Les autres sons gardent leur
numéro (« Kick 13 » reste « Kick 13 » si « Kick 12 » est retiré).

Usage :
  python tools/kits/prepare_kits.py                       # tout, avec les chemins par défaut
  python tools/kits/prepare_kits.py --survey              # mesures seulement, rien n'est écrit
  python tools/kits/prepare_kits.py --limit 40 --out-public %TEMP%\\essai   # essai rapide
Dépendances : numpy, scipy, soundfile (libsndfile >= 1.1).
"""
import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import io

import numpy as np
import soundfile as sf
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from scipy.signal import resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
DEFAULT_SOURCE = r"D:\1 WORK\LRS DRUMS KIT\2 DRUMS"
DEFAULT_PRIVATE = r"D:\1 WORK\CONTENU\nova-kits-lrs"
INDEX_VERSION = 1
URL_BASE = "/drums/kits/"
EXT = ".nks"
# Conteneur servi : « NVK1 » + IV (16 octets) + FLAC chiffré en AES-128-CTR. Ce n'est pas une
# protection forte (la clé est dans le code du DAW : utils/drumKitCodec.ts), seulement un frein :
# les fichiers ne sont ni des FLAC ni des WAV lisibles tels quels, ni en ligne ni dans le cache.
MAGIC = b"NVK1"
KEY_HEX = "6e6f76612d6b6974732d6d6d2d323031"  # doit être identique à utils/drumKitCodec.ts


def scramble(sid: str, flac: bytes) -> bytes:
    iv = hashlib.sha256(("nova-kits/" + sid).encode()).digest()[:16]
    enc = Cipher(algorithms.AES(bytes.fromhex(KEY_HEX)), modes.CTR(iv)).encryptor()
    return MAGIC + iv + enc.update(flac) + enc.finalize()


def unscramble(blob: bytes) -> bytes:
    if blob[:4] != MAGIC:
        raise ValueError("conteneur inconnu")
    dec = Cipher(algorithms.AES(bytes.fromhex(KEY_HEX)), modes.CTR(blob[4:20])).decryptor()
    return dec.update(blob[20:]) + dec.finalize()

# ── Catégories (ordre = ordre d'affichage) ─────────────────────────────────────────────
CATEGORIES = [
    # id, nom d'un son (numéroté), libellé du groupe, durée max (s)
    ("kick", "Kick", "Kicks", 4.0),
    ("snare", "Snare", "Snares", 4.0),
    ("clap", "Clap", "Claps", 4.0),
    ("snap", "Snap", "Snaps", 4.0),
    ("rim", "Rim", "Rims", 4.0),
    ("hihat", "Hi-hat", "Hi-hats", 4.0),
    ("openhat", "Open hat", "Open hats", 4.0),
    ("roll", "Roll", "Rolls", 4.0),
    ("crash", "Crash", "Crashs", 6.0),
    ("tom", "Tom", "Toms", 4.0),
    ("perc", "Perc", "Percs", 4.0),
    ("shaker", "Shaker", "Shakers", 4.0),
    ("808", "808", "808", 6.0),
    ("bass", "Bass", "Basses", 6.0),
    ("fill", "Fill", "Fills", 4.0),
    ("vocal", "Vox", "Voix", 4.0),
    ("oneshot", "One-shot", "One-shots mélodiques", 6.0),
    ("bongo", "Bongo", "Bongos", 4.0),
    ("conga", "Conga", "Congas", 4.0),
    ("djembe", "Djembé", "Djembés", 4.0),
    ("dundun", "Dundun", "Dunduns", 4.0),
    ("balafon", "Balafon", "Balafons", 4.0),
    ("kalimba", "Kalimba", "Kalimbas", 4.0),
    ("marimba", "Marimba", "Marimbas", 4.0),
    ("udu", "Udu", "Udus", 4.0),
]
CAT = {c[0]: c for c in CATEGORIES}
PITCHED = {"808", "bass"}

# Dossiers numérotés : préfixe -> catégorie (None = exclu)
NUMBERED = {
    "01": "kick", "02": "snare", "03": "hihat", "04": "808", "05": "clap", "06": "openhat",
    "07": "perc", "08": "shaker", "09": "rim", "10": None, "11": "crash", "12": "tom",
    "13": None, "14": "bass", "15": "fill", "16": "vocal", "17": "snare", "18": "bongo",
    "19": "conga", "20": "djembe", "21": "balafon", "22": "dundun", "23": "kalimba",
    "24": "marimba", "25": "udu",
}
# Sous-dossiers des packs : premier motif qui correspond (sur le chemin relatif en majuscules)
PACK_RULES = [
    (r"LOOP", None), (r"\bFX\b", None), (r"TEXTURE", None), (r"\bSAMPLE\b", None),
    (r"808 ?KICK", "kick"), (r"\b808", "808"), (r"BASS", "bass"),
    (r"CLAP", "clap"), (r"CRASH", "crash"), (r"FILL", "fill"),
    (r"HATS?[\\/].*\bOPEN\b|OPEN HAT", "openhat"), (r"ROLL", "roll"), (r"\bHATS?\b", "hihat"),
    (r"KICK", "kick"), (r"PERC", "perc"), (r"SNAP", "snap"), (r"SNARE", "snare"),
    (r"VOX", "vocal"), (r"\bRIM\b", "rim"), (r"ONE SHOT", "oneshot"),
]
SKIP_NAME = re.compile(r"loop", re.I)
MELODIC_NAME = re.compile(r"keys|piano|guitar|synth(?!.*bass)|chord|melod|pluck|bell|flute|string|shamisen", re.I)
PERCUSSIVE_SET = {"kick", "snare", "clap", "snap", "rim", "hihat", "openhat", "perc", "shaker", "tom", "crash"}

# Styles déduits du chemin d'origine (jamais publiés tels quels : seul le style l'est)
STYLE_RULES = [
    ("drill", r"drill|\buk\b|[_ ]uk[_ ]|ukg|grime"),
    ("afro", r"afro|amapiano|bongo|conga|djemb|balafon|dundun|kalimba|marimba|\budu\b|brazil|favela|favella"),
    ("detroit", r"detroit|jerk"),
    ("boombap", r"boom ?bap|vintage|mpc|dusty|lofi|lo-fi|soul"),
    ("pop", r"\bpop\b|_pop_|house|dance|edm"),
    ("acoustique", r"acousti"),
    ("trap", r"trap|rage|plugg|\b808|bwb|starboy|metro"),
]
STYLES = {
    "trap": "Trap", "drill": "Drill", "afro": "Afro", "detroit": "Detroit / Jerk",
    "boombap": "Boom bap", "pop": "Pop", "acoustique": "Acoustique",
}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE_IN_NAME = re.compile(r"(?:^|[ _\-\(\[])([A-G])(#|b|s|♯|♭)?(?:m|min|maj)?(-?\d)?(?=$|[ _\-\)\]\.])")


def rel_category(rel_dir: str, fname: str):
    """Catégorie d'un son d'après son dossier et son nom ; None = exclu, avec la raison."""
    up = rel_dir.upper()
    top = rel_dir.replace("\\", "/").split("/")[0]
    m = re.match(r"^(\d\d) ", top)
    if m:
        cat = NUMBERED.get(m.group(1))
        if cat is None:
            return None, "dossier exclu (boucles / FX)"
        if cat == "rim" and re.search(r"snap", fname, re.I):
            cat = "snap"
    else:
        cat = None
        for pat, c in PACK_RULES:
            if re.search(pat, up):
                cat = c
                if c is None:
                    return None, "dossier de pack exclu (boucles / FX / textures / samples)"
                break
        if cat is None:
            return None, "dossier de pack non reconnu"
    if SKIP_NAME.search(fname):
        return None, "boucle (nom)"
    if cat in PERCUSSIVE_SET and MELODIC_NAME.search(fname):
        cat = "oneshot"
    return cat, ""


def styles_of(rel_path: str, cat: str):
    low = rel_path.lower().replace("\\", "/")
    out = []
    for st, pat in STYLE_RULES:
        if re.search(pat, low):
            out.append(st)
    if cat in ("bongo", "conga", "djembe", "dundun", "balafon", "kalimba", "marimba", "udu") and "afro" not in out:
        out.append("afro")
    return out


def note_from_name(stem: str):
    """Classe de hauteur (0-11) écrite dans le nom (« _F# », « (C) », « D#1 »), sinon None."""
    hits = list(NOTE_IN_NAME.finditer(stem))
    if not hits:
        return None
    m = hits[-1]
    pc = NOTE_NAMES.index(m.group(1))
    acc = m.group(2)
    if acc in ("#", "s", "♯"):
        pc += 1
    elif acc in ("b", "♭"):
        pc -= 1
    return pc % 12


def detect_f0(x: np.ndarray, sr: int):
    """Fondamentale (Hz) de la partie tenue d'une 808 / basse : pic du spectre entre 25 et 330 Hz,
    avec vérification de la sous-octave (le 2e harmonique est parfois plus fort)."""
    a = int(0.06 * sr)
    b = min(len(x), int(1.2 * sr))
    if b - a < int(0.12 * sr):
        a, b = 0, len(x)
    seg = x[a:b].astype(np.float64)
    if len(seg) < 2048 or np.max(np.abs(seg)) < 1e-4:
        return None
    seg = seg * np.hanning(len(seg))
    n = 1 << 19
    spec = np.abs(np.fft.rfft(seg, n))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    lo, hi = np.searchsorted(freqs, 25.0), np.searchsorted(freqs, 330.0)
    band = spec[lo:hi]
    if band.size == 0 or band.max() <= 0:
        return None
    i = int(np.argmax(band)) + lo

    def interp(k):
        if 1 <= k < len(spec) - 1:
            y0, y1, y2 = spec[k - 1], spec[k], spec[k + 1]
            d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2)) if (y0 - 2 * y1 + y2) != 0 else 0.0
            return freqs[k] + d * (freqs[1] - freqs[0])
        return freqs[k]

    f = interp(i)
    half = f / 2
    if half >= 25:
        k = int(round(half / (freqs[1] - freqs[0])))
        w = max(2, int(2.0 / (freqs[1] - freqs[0])))
        if spec[max(0, k - w):k + w].max() > 0.35 * spec[i]:
            k2 = int(np.argmax(spec[max(0, k - w):k + w])) + max(0, k - w)
            f = interp(k2)
    return float(f)


def hz_to_midi(f):
    return 69 + 12 * math.log2(f / 440.0)


def midi_name(m: int):
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def process_one(job):
    """Lit, nettoie et encode un son. Renvoie un dict (ou une raison d'exclusion)."""
    path, rel, cat, out_dir, write = job
    try:
        data, sr = sf.read(path, dtype="float32", always_2d=True)
    except Exception as e:
        return {"rel": rel, "skip": f"illisible ({e.__class__.__name__})"}
    if data.size == 0:
        return {"rel": rel, "skip": "vide"}
    data = np.nan_to_num(data)
    if data.shape[1] > 2:
        data = data[:, :2]
    # 1. fréquence d'échantillonnage
    target = 48000 if sr > 48000 else (44100 if sr < 44100 else sr)
    if target != sr:
        g = math.gcd(int(sr), int(target))
        data = resample_poly(data, target // g, int(sr) // g, axis=0).astype(np.float32)
        sr = target
    # 2. mono si les canaux sont identiques
    if data.shape[1] == 2:
        if np.max(np.abs(data[:, 0] - data[:, 1])) < 1.0 / 32768:
            data = data[:, :1]
    peak = float(np.max(np.abs(data)))
    if peak < 1e-5:
        return {"rel": rel, "skip": "silencieux"}
    # 3. crête à -1 dBFS
    data = data * (10 ** (-1 / 20) / peak)
    env = np.max(np.abs(data), axis=1)
    # 4. silences de début et de fin
    start_thr, end_thr = 10 ** (-80 / 20), 10 ** (-60 / 20)
    nz = np.nonzero(env > start_thr)[0]
    start = int(nz[0]) if nz.size else 0
    loud = np.nonzero(env > end_thr)[0]
    end = int(loud[-1]) + 1 if loud.size else len(env)
    end = min(len(env), end + int(0.01 * sr))
    data = data[start:end]
    if end < len(env):
        fade = min(len(data), int(0.008 * sr))
        if fade > 1:
            data[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]
    dur = len(data) / sr
    maxdur = CAT[cat][3]
    if dur > maxdur:
        return {"rel": rel, "skip": f"trop long ({dur:.2f} s > {maxdur:.0f} s : boucle ou texture)", "dur": dur}
    if dur < 0.01:
        return {"rel": rel, "skip": "trop court"}
    # 7. 16 bits, dither triangulaire déterministe
    rng = np.random.default_rng(1234)
    tpdf = (rng.random(data.shape) - rng.random(data.shape)).astype(np.float32)
    q = np.clip(np.round(data * 32767.0 + tpdf), -32768, 32767).astype(np.int16)
    digest = hashlib.sha1(q.tobytes() + f"{sr}/{q.shape[1]}".encode()).hexdigest()
    sid = f"{cat}-{digest[:8]}"
    # 6. hauteur
    hz = None
    if cat in PITCHED:
        hz = detect_f0(data.mean(axis=1), sr)
    res = {"rel": rel, "cat": cat, "id": sid, "sr": int(sr), "ch": int(q.shape[1]),
           "dur": round(dur, 3), "hz": hz, "digest": digest}
    if write:
        out = os.path.join(out_dir, sid + EXT)
        if not os.path.isfile(out):
            buf = io.BytesIO()
            with sf.SoundFile(buf, "w", samplerate=sr, channels=q.shape[1], format="FLAC",
                              subtype="PCM_16", compression_level=1.0) as f:
                f.write(q)
            res["flac_bytes"] = len(buf.getvalue())
            tmp = out + ".part"
            with open(tmp, "wb") as f:
                f.write(scramble(sid, buf.getvalue()))
            os.replace(tmp, out)
        res["bytes"] = os.path.getsize(out)
    return res


def load_withdrawals(path):
    """retraits.txt (privé) : une ligne par son à retirer, identifiant publié (« kick-1a2b3c4d ») ou
    chemin d'origine (ou un morceau de chemin assez long) ; « # » = commentaire."""
    if not os.path.isfile(path):
        return set()
    with open(path, encoding="utf-8-sig") as f:
        return {ln.split("#", 1)[0].strip().lower() for ln in f if ln.split("#", 1)[0].strip()}


def scan(source):
    """Liste (chemin, chemin relatif, catégorie | None, raison) de tous les WAV de la source."""
    out = []
    for root, dirs, files in os.walk(source):
        dirs.sort()
        rel_dir = os.path.relpath(root, source)
        for f in sorted(files):
            if not f.lower().endswith(".wav"):
                continue  # .asd (Ableton), « Ableton Folder Info »…
            p = os.path.join(root, f)
            rel = os.path.relpath(p, source)
            cat, why = rel_category(rel_dir, f)
            out.append((p, rel, cat, why))
    return out


# ── Kits ─────────────────────────────────────────────────────────────────────────────
# Rôles des pads d'un kit (ordre = ordre des pads proposés). Le DAW place chaque rôle sur
# la voie correspondante de la boîte à rythmes (utils/drumKitLibrary.ts).
ROLES = ["kick", "snare", "clap", "hihat", "openhat", "808", "perc", "rim", "crash", "tom",
         "shaker", "perc2", "snap", "roll", "vocal", "fill"]
ROLE_CATS = {
    "kick": ["kick"], "snare": ["snare"], "clap": ["clap", "snap"], "hihat": ["hihat"],
    "openhat": ["openhat"], "808": ["808"], "perc": ["perc", "bongo", "conga"],
    "rim": ["rim", "snap"], "crash": ["crash"], "tom": ["tom", "perc"], "shaker": ["shaker", "perc"],
    "perc2": ["perc", "conga", "bongo"], "snap": ["snap", "rim", "clap"], "roll": ["roll", "hihat"],
    "vocal": ["vocal"], "fill": ["fill"],
}
AFRO_ROLE_CATS = dict(ROLE_CATS, perc=["bongo", "perc"], perc2=["conga"], tom=["djembe", "dundun", "tom"],
                      shaker=["shaker", "udu"], snap=["balafon", "kalimba", "marimba", "snap"])


def pick(pool_by_cat, cats, k, used, prefer=None):
    """k-ième son des catégories voulues (en préférant ceux de `prefer`), sans réutiliser un son."""
    for c in cats:
        lst = pool_by_cat.get(c, [])
        if prefer is not None:
            lst = [s for s in lst if prefer(s)] or []
        lst = [s for s in lst if s["id"] not in used]
        if lst:
            s = lst[k % len(lst)]
            used.add(s["id"])
            return s["id"]
    return None


def build_kits(sounds):
    by_cat = {}
    for s in sounds:
        by_cat.setdefault(s["cat"], []).append(s)
    kits = []

    def make(name, style, k, prefer=None, role_cats=ROLE_CATS, pool=by_cat, fallback=True):
        used, pads = set(), {}
        for role in ROLES:
            sid = pick(pool, role_cats[role], k, used, prefer)
            if sid is None and fallback:
                sid = pick(by_cat, role_cats[role], k, used)
            if sid:
                pads[role] = sid
        if "kick" in pads and ("snare" in pads or "clap" in pads):
            kits.append({"id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"), "name": name,
                         "style": style, "pads": pads})

    # 1. un kit par pack (les packs complets, plusieurs variantes) : style trap
    packs = sorted({s["pack"] for s in sounds if s["pack"]})
    n_trap = 0
    for p in packs:
        pool = {}
        for s in sounds:
            if s["pack"] == p:
                pool.setdefault(s["cat"], []).append(s)
        for k in range(4):
            n_trap += 1
            make(f"Trap {n_trap}", "trap", k * 3, pool=pool)
    # 2. kits par style, à partir des sons marqués de ce style
    for st, count in (("trap", 3), ("drill", 3), ("afro", 3), ("detroit", 2), ("boombap", 2),
                      ("pop", 2)):
        for k in range(count):
            if st == "trap":
                n_trap += 1
                name = f"Trap {n_trap}"
            else:
                name = f"{STYLES[st]} {k + 1}"
            rc = AFRO_ROLE_CATS if st == "afro" else ROLE_CATS
            make(name, st, k * 2 + 1, prefer=lambda s, st=st: st in s["styles"], role_cats=rc)
    # 3. kits génériques tirés des dossiers numérotés (hors packs)
    gen = {}
    for s in sounds:
        if not s["pack"]:
            gen.setdefault(s["cat"], []).append(s)
    for k in range(8):
        make(f"Kit {k + 1}", "", k * 7 + 2, pool=gen)
    return kits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--out-public", default=os.path.join(REPO, "public", "drums", "kits"))
    ap.add_argument("--out-index", default=os.path.join(REPO, "data", "drum-kits", "index.json"))
    ap.add_argument("--private", default=DEFAULT_PRIVATE,
                    help="dossier HORS du dépôt pour la correspondance identifiant -> chemin d'origine")
    ap.add_argument("--survey", action="store_true", help="mesurer seulement (rien n'est écrit)")
    ap.add_argument("--limit", type=int, default=0, help="n'en traiter que N (essai)")
    ap.add_argument("--jobs", type=int, default=max(1, min(6, (os.cpu_count() or 2) // 4)))
    ap.add_argument("--budget-mb", type=float, default=300.0)
    a = ap.parse_args()

    priv = os.path.abspath(a.private)
    def inside(child, parent):
        try:
            return os.path.commonpath([os.path.normcase(child), os.path.normcase(parent)]) == os.path.normcase(parent)
        except ValueError:  # lecteurs différents
            return False

    if inside(priv, REPO):
        sys.exit("La correspondance privée doit être écrite HORS du dépôt.")
    write = not a.survey
    t0 = time.time()
    files = scan(a.source)
    if a.limit:
        files = files[:a.limit]
    excluded = [(rel, why) for (_, rel, cat, why) in files if cat is None]
    jobs = [(p, rel, cat, a.out_public, write) for (p, rel, cat, _) in files if cat is not None]
    print(f"{len(files)} WAV dans la source, {len(jobs)} à traiter, {len(excluded)} exclus d'office")
    if write:
        os.makedirs(a.out_public, exist_ok=True)
    results = []
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for i, r in enumerate(ex.map(process_one, jobs, chunksize=8)):
            results.append(r)
            if (i + 1) % 200 == 0:
                print(f"  {i + 1}/{len(jobs)} ({time.time() - t0:.0f} s)")
    kept, dups = {}, {}
    for r in results:
        if "skip" in r:
            excluded.append((r["rel"], r["skip"]))
            continue
        if r["id"] in kept:
            dups.setdefault(r["id"], []).append(r["rel"])
            excluded.append((r["rel"], f"doublon exact de {r['id']}"))
            continue
        kept[r["id"]] = r
    sounds = list(kept.values())
    # ordre stable : catégorie, puis chemin d'origine (privé : seul le numéro qui en découle est publié)
    order = {c[0]: i for i, c in enumerate(CATEGORIES)}
    sounds.sort(key=lambda s: (order[s["cat"]], s["rel"].lower()))
    counters = {}
    for s in sounds:
        counters[s["cat"]] = counters.get(s["cat"], 0) + 1
        s["num"] = counters[s["cat"]]
        s["name"] = f"{CAT[s['cat']][1]} {s['num']}"
        top = s["rel"].replace("\\", "/").split("/")[0]
        s["pack"] = "" if re.match(r"^\d\d ", top) else top
        s["styles"] = styles_of(s["rel"], s["cat"])
        if s["pack"] and "trap" not in s["styles"]:
            s["styles"].append("trap")
        # hauteur : détection, recoupée avec la note écrite dans le nom d'origine
        s["note"] = None
        if s["cat"] in PITCHED and s.get("hz"):
            m = hz_to_midi(s["hz"])
            pc_name = note_from_name(os.path.splitext(os.path.basename(s["rel"]))[0])
            s["pitch_src"] = "analyse"
            if pc_name is not None and round(m) % 12 != pc_name:
                # la note du nom fait foi ; octave la plus proche de la mesure
                cand = [o * 12 + pc_name for o in range(0, 9)]
                mm = min(cand, key=lambda c: abs(c - m))
                s["pitch_src"] = "nom (analyse : %s)" % midi_name(round(m))
                m = mm
            elif pc_name is not None:
                s["pitch_src"] = "analyse = nom"
            s["midi"] = int(round(m))
            s["note"] = midi_name(s["midi"])
            s["hz_note"] = 440.0 * 2 ** ((s["midi"] - 69) / 12)
    # Retraits à la demande (liste privée) : le son disparaît, les autres GARDENT leur numéro.
    withdrawn = load_withdrawals(os.path.join(priv, "retraits.txt"))
    if withdrawn:
        out = []
        for s in sounds:
            src = os.path.join(a.source, s["rel"]).lower()
            if s["id"] in withdrawn or any(w in src for w in withdrawn if len(w) > 12):
                excluded.append((s["rel"], f"retiré à la demande ({s['id']}, {s['name']})"))
            else:
                out.append(s)
        print(f"{len(sounds) - len(out)} son(s) retiré(s) à la demande (retraits.txt)")
        sounds = out
        counters = {}
        for s in sounds:
            counters[s["cat"]] = counters.get(s["cat"], 0) + 1
    total = sum(s.get("bytes", 0) for s in sounds)
    kits = build_kits(sounds)

    print(f"{len(sounds)} sons gardés, {len(excluded)} écartés, {total / 1e6:.1f} Mo, "
          f"{len(kits)} kits, {time.time() - t0:.0f} s")
    for c in CATEGORIES:
        n = sum(1 for s in sounds if s["cat"] == c[0])
        if n:
            print(f"  {c[2]:24s} {n:4d}")
    reasons = {}
    for _, why in excluded:
        k = re.sub(r" de [a-z0-9]+-[0-9a-f]{8}$", "", re.sub(r"\(.*\)", "(…)", why))
        reasons[k] = reasons.get(k, 0) + 1
    for k, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  écartés : {k:60s} {n:4d}")
    if not write:
        return
    if total / 1e6 > a.budget_mb:
        print(f"ATTENTION : {total / 1e6:.1f} Mo > budget de {a.budget_mb:.0f} Mo")

    # index publié : aucune trace de l'origine
    index = {
        "version": INDEX_VERSION,
        "base": URL_BASE,
        "ext": EXT,
        "categories": [{"id": c[0], "label": c[2], "count": counters.get(c[0], 0)}
                       for c in CATEGORIES if counters.get(c[0])],
        "styles": STYLES,
        "roles": ROLES,
        "totalBytes": total,
        # [id, numéro, durée (s), canaux, styles, note 808/basse (midi) ou 0]
        "sounds": [[s["id"], s["num"], round(s["dur"], 2), s["ch"], s["styles"], s.get("midi") or 0]
                   for s in sounds],
        "kits": kits,
    }
    os.makedirs(os.path.dirname(a.out_index), exist_ok=True)
    with open(a.out_index, "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    # ménage : fichiers publiés qui ne sont plus dans l'index
    keep = {s["id"] + EXT for s in sounds}
    removed = 0
    for f in os.listdir(a.out_public):
        if f not in keep:
            os.remove(os.path.join(a.out_public, f))
            removed += 1
    # correspondance privée (hors dépôt)
    os.makedirs(priv, exist_ok=True)
    with open(os.path.join(priv, "correspondance_privee.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["identifiant publié", "nom affiché", "catégorie", "fichier publié", "chemin d'origine",
                    "doublons fusionnés", "durée (s)", "canaux", "Hz mesurés", "note", "origine de la note", "styles"])
        for s in sounds:
            w.writerow([s["id"], s["name"], s["cat"], URL_BASE + s["id"] + EXT,
                        os.path.join(a.source, s["rel"]), " | ".join(dups.get(s["id"], [])),
                        f"{s['dur']:.3f}", s["ch"], f"{s['hz']:.2f}" if s.get("hz") else "",
                        s.get("note") or "", s.get("pitch_src", ""), ",".join(s["styles"])])
    with open(os.path.join(priv, "exclusions_privees.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["chemin d'origine", "raison"])
        for rel, why in sorted(excluded):
            w.writerow([os.path.join(a.source, rel), why])
    with open(os.path.join(priv, "kits_prives.json"), "w", encoding="utf-8") as f:
        json.dump({k["name"]: {r: kept[i]["rel"] for r, i in k["pads"].items()} for k in kits}, f,
                  ensure_ascii=False, indent=1)
    print(f"index : {a.out_index} ; {removed} fichier(s) obsolète(s) retiré(s) ; correspondance : {priv}")


if __name__ == "__main__":
    main()
