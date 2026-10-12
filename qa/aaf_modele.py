"""Fabrique utils/aaf/aafTemplate.ts : la partie FIXE d'un fichier AAF écrit par NOVA.

Tout fichier AAF porte un méta-dictionnaire (définitions de toutes les classes et de
tous les types du modèle AAF) et un dictionnaire (définitions des données, conteneurs,
codecs, opérations, paramètres, interpolations). Ce bloc ne dépend pas de la séance :
NOVA le reprend tel quel, tel que pyaaf2 (licence MIT, © Mark Reid) l'écrit — pyaaf2
est l'écrivain AAF libre utilisé par OpenTimelineIO pour Media Composer et Pro Tools.

NOVA écrit lui-même le reste : objet racine, en-tête (Header), contenu (mobs, essence)
et identification. Le modèle garde la table des « propriétés référencées » (références
faibles) pour que les index restent cohérents.

Usage : .venv-aaf/Scripts/python.exe qa/aaf_modele.py   (réécrit utils/aaf/aafTemplate.ts)
"""
from __future__ import annotations

import base64
import io
import json
import sys
import zlib
from pathlib import Path

import aaf2
import aaf2.cfb as cfbmod

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aaf_reference import setup_defs  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "utils" / "aaf" / "aafTemplate.ts"


def main():
    buf = io.BytesIO()
    f = aaf2.open(None, "w")
    setup_defs(f)
    f.save()
    table = [list(p) for p in f.weakref_table]
    f.manager.remove_temp()
    cfb = f.cfb
    entries = []
    skip_prefix = ("/Header-2/Content-", "/Header-2/Identifi")
    for root, storages, streams in cfb.walk():
        path = root.path()
        if path.startswith(skip_prefix) or path.startswith("/tmp"):
            continue
        if path not in ("/", "/Header-2"):
            entries.append({"p": path, "c": str(root.class_id) if root.class_id else None})
        for s in streams:
            sp = (path.rstrip("/") + "/" + s.name)
            if sp in ("/properties", "/Header-2/properties", "/referenced properties") or sp.startswith(skip_prefix):
                continue
            data = s.open("r").read()
            entries.append({"p": sp, "d": base64.b64encode(data).decode("ascii")})
    payload = json.dumps({"table": table, "entries": entries}, separators=(",", ":")).encode("utf-8")
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    z = comp.compress(payload) + comp.flush()
    b64 = base64.b64encode(z).decode("ascii")
    lines = [b64[i:i + 120] for i in range(0, len(b64), 120)]
    ts = [
        "/**",
        " * Partie fixe d'un fichier AAF (méta-dictionnaire + dictionnaire), générée par",
        " * qa/aaf_modele.py à partir de pyaaf2 " + getattr(aaf2, "__version__", "1.7.1") + " (licence MIT, © Mark Reid).",
        " * NE PAS MODIFIER À LA MAIN : relancer le script.",
        " *",
        " * Contenu (JSON compressé deflate brut, base64) : { table, entries } :",
        " *  - table   : propriétés référencées (chemins de pid des références faibles) ;",
        " *  - entries : stockages { p, c } (chemin, CLSID) et flux { p, d } (chemin, base64).",
        " */",
        f"export const AAF_TEMPLATE_SIZE = {len(payload)};",
        "export const AAF_TEMPLATE_B64 =",
    ]
    ts += [f"  '{l}'" + (" +" if i < len(lines) - 1 else ";") for i, l in enumerate(lines)]
    OUT.write_text("\n".join(ts) + "\n", encoding="utf-8")
    print(f"{OUT} : {len(entries)} entrées, {len(payload)} octets → {len(b64)} en base64 ; table : {table}")


if __name__ == "__main__":
    main()
