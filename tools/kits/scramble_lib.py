"""Batterie du studio (public/drums/lib) : chaque WAV devient un conteneur brouillé « .nks », comme les kits.

Règle de Romain : aucun son du DAW ne se télécharge, il sert uniquement à composer. Même mécanisme que
tools/kits/prepare_kits.py (« NVK1 » + IV 16 octets + audio chiffré en AES-128-CTR, même clé que
utils/drumKitCodec.ts) ; l'audio d'origine (WAV) est gardé à l'identique dans le conteneur.

Compatibilité : les projets gardent leur référence « url:/drums/lib/<id>.wav » ; c'est le chargeur
(utils/drumSounds.ts) qui lit « /drums/lib/<id>.nks ». Rien à migrer dans les projets.

  python tools/kits/scramble_lib.py            # convertit, puis supprime les .wav
  python tools/kits/scramble_lib.py --check    # vérifie : aucun .wav, chaque .nks se relit en RIFF
"""
import argparse
import hashlib
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"NVK1"
KEY_HEX = "6e6f76612d6b6974732d6d6d2d323031"  # = utils/drumKitCodec.ts et tools/kits/prepare_kits.py
LIB = Path(__file__).resolve().parents[2] / "public" / "drums" / "lib"


def scramble(sid: str, data: bytes) -> bytes:
    iv = hashlib.sha256(("nova-lib/" + sid).encode()).digest()[:16]
    enc = Cipher(algorithms.AES(bytes.fromhex(KEY_HEX)), modes.CTR(iv)).encryptor()
    return MAGIC + iv + enc.update(data) + enc.finalize()


def unscramble(blob: bytes) -> bytes:
    if blob[:4] != MAGIC:
        raise ValueError("conteneur inconnu")
    dec = Cipher(algorithms.AES(bytes.fromhex(KEY_HEX)), modes.CTR(blob[4:20])).decryptor()
    return dec.update(blob[20:]) + dec.finalize()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check:
        wav = sorted(LIB.glob("*.wav"))
        nks = sorted(LIB.glob("*.nks"))
        bad = [p.name for p in nks if unscramble(p.read_bytes())[:4] != b"RIFF"]
        print(f"{len(nks)} conteneurs, {len(wav)} WAV restants, {len(bad)} illisibles")
        sys.exit(0 if nks and not wav and not bad else 1)
    n = 0
    for p in sorted(LIB.glob("*.wav")):
        data = p.read_bytes()
        if data[:4] != b"RIFF":
            raise SystemExit(f"{p.name} n'est pas un WAV")
        out = p.with_suffix(".nks")
        out.write_bytes(scramble(p.stem, data))
        if unscramble(out.read_bytes()) != data:
            raise SystemExit(f"{out.name} : relecture différente")
        p.unlink()
        n += 1
    print(f"{n} sons brouillés dans {LIB}")


if __name__ == "__main__":
    main()
