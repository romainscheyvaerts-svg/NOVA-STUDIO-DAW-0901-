"""AAF de référence pour l'échange de séance avec Pro Tools (chantier 14, A4).

Fabrique, avec pyaaf2 (licence MIT, installé dans le venv du worktree `.venv-aaf`,
jamais dans celui du pont), des AAF construits comme ceux de Pro Tools
(« Export > Selected Tracks as New AAF/OMF ») et la vérité attendue en JSON :

  ref_integre.aaf    médias intégrés (PCM brut et WAVE complet), 48 kHz ;
  ref_lie.aaf        médias liés dans « Audio Files/ » (un fichier volontairement absent) ;
  ref_25ips.aaf      pistes au débit d'édition vidéo (25 images/s), comme une séance
                     « compatible Media Composer » : positions multiples de 1920 échantillons ;
  attendu.json       pistes, clips (position, décalage, longueur EN ÉCHANTILLONS), gain,
                     fondus (longueur, forme), volume et pan, pour chaque fichier.

Contenu : 6 pistes, 47 clips à des positions quelconques (pas sur la grille), décalages
dans le média, gain de clip (constant), fondus d'entrée et de sortie (Transition +
MonoAudioDissolve, interpolations Linear / Power / Log / BSpline / Constant), deux fondus
« rendus » par Pro Tools (clips « Fade … » collés au clip) à remplacer par de vrais fondus,
une piste stéréo (fichier entrelacé) et une piste stéréo en double mono (« Guitare.L/.R »),
volume et pan de piste (OperationGroup MonoAudioGain / MonoAudioPan au niveau de la piste).

Usage :  .venv-aaf/Scripts/python.exe qa/aaf_reference.py <dossier_sortie>
         .venv-aaf/Scripts/python.exe qa/aaf_reference.py --relire <fichier.aaf>   (JSON sur stdout)
"""
from __future__ import annotations

import io
import json
import math
import os
import random
import struct
import sys
import wave
from fractions import Fraction
from pathlib import Path

import aaf2
from aaf2.auid import AUID
from aaf2.rational import AAFRational

SR = 48000

# Définitions AAF (dictionnaire) : AUID du standard (SMPTE / AAF Edit Protocol).
OPDEF_GAIN = "9d2ea894-0968-11d3-8a38-0050040ef7d2"       # Mono Audio Gain
OPDEF_PAN = "9d2ea893-0968-11d3-8a38-0050040ef7d2"        # Mono Audio Pan
OPDEF_DISSOLVE = "0c3bea41-fc05-11d2-8a29-0050040ef7d2"   # Mono Audio Dissolve
PARAM_AMPLITUDE = "e4962321-2267-11d3-8a4c-0050040ef7d2"
PARAM_PAN = "e4962322-2267-11d3-8a4c-0050040ef7d2"
PARAM_LEVEL = "e4962320-2267-11d3-8a4c-0050040ef7d2"
INTERP = {
    "Linear": "5b6c85a4-0ede-11d3-80a9-006008143e6f",
    "Constant": "5b6c85a5-0ede-11d3-80a9-006008143e6f",
    "BSpline": "5b6c85a6-0ede-11d3-80a9-006008143e6f",
    "Log": "15829ec3-1f24-458a-960d-c65bb23c2aa1",
    "Power": "c09153f7-bd18-4e5a-ad09-cbdd654fa001",
}
# Forme NOVA attendue pour chaque interpolation (Constant : inconnue → approchée en linéaire).
SHAPE = {"Linear": "LINEAR", "Power": "EQUAL_POWER", "Log": "EXPONENTIAL", "BSpline": "S_CURVE", "Constant": "LINEAR"}


# ── Médias ──────────────────────────────────────────────────────────────────────────────
def signal(n, ch, seed):
    """Signal déterministe et reconnaissable (sinus + bruit pseudo-aléatoire), canaux distincts."""
    rnd = random.Random(seed)
    f = 110 + 37 * (seed % 11)
    out = []
    for c in range(ch):
        out.append([0.45 * math.sin(2 * math.pi * f * (c + 1) * i / SR) + 0.2 * (rnd.random() - 0.5) for i in range(n)])
    return out


def wav_bytes(chans, sr=SR, bits=24):
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(len(chans)); w.setsampwidth(bits // 8); w.setframerate(sr)
    n = len(chans[0])
    full = 2 ** (bits - 1) - 1
    frames = bytearray()
    for i in range(n):
        for c in chans:
            v = max(-full - 1, min(full, int(round(c[i] * full))))
            frames += struct.pack("<i", v)[: bits // 8]
    w.writeframes(bytes(frames)); w.close()
    return buf.getvalue()


# ── Plan de la séance (déterministe) ────────────────────────────────────────────────────
TRACKS = [
    # nom, canaux du média, nb de clips, stéréo double mono
    ("Lead", 1, 10, False),
    ("Double", 1, 9, False),
    ("Backs", 1, 8, False),
    ("Beat", 2, 6, False),
    ("Guitare", 1, 6, True),
    ("Adlibs", 1, 8, False),
]  # 10 + 9 + 8 + 6 + 6 + 8 = 47 clips


def plan(seed=14, petit=False):
    rnd = random.Random(seed)
    M = 6 if petit else 40          # secondes de média par piste
    L = (SR // 10, SR // 2) if petit else (SR // 2, SR * 3)  # longueur des clips
    tracks = []
    media = []
    interps = ["Linear", "Power", "Log", "BSpline", "Constant"]
    k = 0
    for ti, (name, ch, n, dual) in enumerate(TRACKS):
        mlen = SR * M + rnd.randrange(SR)
        mkey = f"m{ti + 1}"
        media.append({"key": mkey, "name": f"{name}_01", "channels": 2 if dual else ch, "length": mlen, "seed": 100 + ti, "dual": dual})
        pos = rnd.randrange(SR // 3, SR * 2)
        clips = []
        for j in range(n):
            length = rnd.randrange(*L)
            offset = rnd.randrange(0, mlen - length)
            fi = fo = None
            if rnd.random() < 0.45:
                fi = {"len": rnd.randrange(240, L[0] // 3), "interp": interps[k % len(interps)]}; k += 1
            if rnd.random() < 0.45:
                fo = {"len": rnd.randrange(240, L[0] // 3), "interp": interps[k % len(interps)]}; k += 1
            gain_db = round(rnd.uniform(-12, 6), 1) if rnd.random() < 0.35 else None
            clips.append({"name": f"{name} {j + 1}", "pos": pos, "offset": offset, "len": length, "fadeIn": fi, "fadeOut": fo,
                          "gainDb": gain_db, "media": mkey})
            pos += length + rnd.randrange(400 + (fo["len"] if fo else 0) + SR // 50, SR)  # trou ≥ fondu (Transition sur un Filler)
            if j + 1 < n and clips[-1]["fadeOut"] is None and rnd.random() < 0.1:
                pass
        vol_db = round(rnd.uniform(-9, 0), 1) if ti % 2 == 0 else None
        pan = round(rnd.uniform(0.15, 0.85), 2) if ti in (1, 4) else None
        tracks.append({"name": name, "clips": clips, "volumeDb": vol_db, "pan": pan, "dual": dual, "channels": 2 if dual else ch})
    # Deux fondus « rendus » par Pro Tools : un fondu d'entrée sur Lead 3, un de sortie sur Double 2.
    rendered = [("Lead", 2, "in", 1200 if petit else 2400), ("Double", 1, "out", 1800 if petit else 3600)]
    for tname, idx, kind, ln in rendered:
        t = next(x for x in tracks if x["name"] == tname)
        c = t["clips"][idx]
        if kind == "in":
            c["fadeIn"] = None
            c["renderedIn"] = ln
        else:
            c["fadeOut"] = None
            c["renderedOut"] = ln
    return tracks, media


def gain_rational(db):
    return AAFRational(round(10 ** (db / 20) * 1_000_000), 1_000_000)


def pan_rational(p):
    return AAFRational(round(p * 1000), 1000)


# ── Écriture avec pyaaf2 ────────────────────────────────────────────────────────────────
def setup_defs(f):
    d = f.dictionary
    rational = f.metadict.lookup_typedef("Rational")
    defs = {}
    for key, name, auid in (("amp", "Amplitude", PARAM_AMPLITUDE), ("pan", "Pan", PARAM_PAN), ("level", "Level", PARAM_LEVEL)):
        p = f.create.ParameterDef(AUID(auid), name, "")
        p["Type"].value = rational
        d.register_def(p); defs[key] = p
    for name, auid in INTERP.items():
        i = f.create.InterpolationDef(AUID(auid), name + "Interp", "")
        d.register_def(i); defs["i_" + name] = i
    for key, name, auid, inputs, params in (("gain", "Mono Audio Gain", OPDEF_GAIN, 1, ["amp"]),
                                           ("panop", "Mono Audio Pan", OPDEF_PAN, 1, ["pan"]),
                                           ("dissolve", "Mono Audio Dissolve", OPDEF_DISSOLVE, 2, ["level"])):
        o = f.create.OperationDef(AUID(auid), name, "")
        o.media_kind = "sound"
        o["NumberInputs"].value = inputs
        o["IsTimeWarp"].value = False
        d.register_def(o)
        for p in params:
            o["ParametersDefined"].append(defs[p])
        defs[key] = o
    return defs


def constant(f, defs, param, value):
    c = f.create.ConstantValue()
    c["Definition"].value = defs[param]["Identification"].value
    c["Value"].value = value
    return c


def fade_transition(f, defs, length, interp):
    t = f.create.Transition("sound", length)
    t["CutPoint"].value = 0
    og = f.create.OperationGroup(defs["dissolve"], length)
    og.media_kind = "sound"
    vv = f.create.VaryingValue()
    vv["Definition"].value = defs["level"]["Identification"].value
    vv["Interpolation"].value = defs["i_" + interp]
    for tm, v in ((AAFRational(0, 1), AAFRational(0, 1)), (AAFRational(1, 1), AAFRational(1, 1))):
        cp = f.create.ControlPoint()
        cp["Time"].value = tm
        cp["Value"].value = v
        cp["EditHint"].value = "Proportional"
        vv["PointList"].append(cp)
    og["Parameters"].append(vv)
    t["OperationGroup"].value = og
    return t


def build(path, tracks, media, mode, edit_rate=SR, media_dir=None, missing=(), sector_size=4096):
    """mode : 'integre' (médias dans l'AAF) ou 'lie' (WAV dans media_dir)."""
    er = Fraction(edit_rate)
    ratio = Fraction(edit_rate, SR)  # unités d'édition par échantillon
    with aaf2.open(str(path), "w", sector_size=sector_size) as f:
        defs = setup_defs(f)
        comp = f.create.CompositionMob("Séance LENNON (référence)")
        comp.usage = "Usage_TopLevel"
        f.content.mobs.append(comp)
        masters = {}
        for mi, m in enumerate(media):
            chans = signal(m["length"], m["channels"], m["seed"])
            files = [(m["name"], chans)] if not m["dual"] else [(m["name"] + ".L", [chans[0]]), (m["name"] + ".R", [chans[1]])]
            mm = f.create.MasterMob(m["name"]); f.content.mobs.append(mm)
            for fi, (fname, fch) in enumerate(files):
                data = wav_bytes(fch)
                sm = f.create.SourceMob(fname + ".PHYS")
                f.content.mobs.append(sm)
                if mode == "integre" and (mi + fi) % 2 == 0:
                    # PCM brut (comme pyaaf2 import_audio_essence)
                    tmp = Path(str(path) + f".{fname}.tmp.wav"); tmp.write_bytes(data)
                    slot = sm.import_audio_essence(str(tmp), SR)
                    tmp.unlink()
                else:
                    # WAVE : fichier complet dans l'AAF (intégré) ou à côté (lié)
                    desc = f.create.WAVEDescriptor()
                    desc["SampleRate"].value = SR
                    desc["Length"].value = m["length"]
                    hdr = data[: data.index(b"data")]
                    desc["Summary"].value = bytearray(hdr)
                    desc["ContainerFormat"].value = f.dictionary.lookup_containerdef("AAF")
                    sm.descriptor = desc
                    if mode == "integre":
                        ed, slot = sm.create_essence(SR, "sound")
                        s = ed.open("w"); s.write(data)
                    else:
                        slot = sm.create_empty_slot(SR, "sound", slot_id=1)
                        p = Path(media_dir) / f"{fname}.wav"
                        if fname not in missing:
                            p.write_bytes(data)
                        loc = f.create.NetworkLocator()
                        loc["URLString"].value = p.resolve().as_uri()
                        desc["Locator"].append(loc)
                    slot.segment.length = m["length"]
                ms = mm.create_timeline_slot(SR)
                ms.segment = sm.create_source_clip(slot.slot_id, media_kind="sound")
                ms.segment.length = m["length"]
            masters[m["key"]] = mm

        slot_id = 1
        for t in tracks:
            subs = [(t["name"] + ".L", 1), (t["name"] + ".R", 2)] if t["dual"] else [(t["name"], 1)]
            for sname, mslot in subs:
                s = comp.create_timeline_slot(er, slot_id); slot_id += 1
                s.name = sname
                seq = f.create.Sequence(media_kind="sound")
                cur = 0  # position courante en unités d'édition
                for c in t["clips"]:
                    rin = c.get("renderedIn", 0); rout = c.get("renderedOut", 0)
                    pos = int(c["pos"] * ratio); length = int(c["len"] * ratio); off = int(c["offset"] * ratio)
                    fi = int(c["fadeIn"]["len"] * ratio) if c["fadeIn"] else 0
                    fo = int(c["fadeOut"]["len"] * ratio) if c["fadeOut"] else 0
                    gap = pos - cur
                    if fi:
                        seq.components.append(f.create.Filler("sound", gap + fi))
                        seq.components.append(fade_transition(f, defs, fi, c["fadeIn"]["interp"]))
                    elif gap > 0:
                        seq.components.append(f.create.Filler("sound", gap))
                    mm = masters[c["media"]]
                    pieces = []
                    if rin:  # fondu rendu : un clip « Fade In » sur sa propre ressource, puis le clip raccourci
                        pieces.append(("fade", int(rin * ratio)))
                    pieces.append(("main", length - int(rin * ratio) - int(rout * ratio)))
                    if rout:
                        pieces.append(("fade", int(rout * ratio)))
                    srcpos = off
                    for kind, ln in pieces:
                        if kind == "fade":
                            fm = f.create.MasterMob(f"Fade {sname} {c['name']}")
                            f.content.mobs.append(fm)
                            fs = f.create.SourceMob("Fade.PHYS"); f.content.mobs.append(fs)
                            fchans = signal(int(ln / ratio), 1, 999)
                            tmp = Path(str(path) + ".fade.tmp.wav"); tmp.write_bytes(wav_bytes(fchans))
                            fsl = fs.import_audio_essence(str(tmp), SR); tmp.unlink()
                            fmsl = fm.create_timeline_slot(SR); fmsl.segment = fs.create_source_clip(fsl.slot_id, media_kind="sound")
                            fmsl.segment.length = int(ln / ratio)
                            sc = fm.create_source_clip(1, start=0, length=ln, media_kind="sound")
                        else:
                            sc = mm.create_source_clip(mslot, start=srcpos, length=ln, media_kind="sound")
                        srcpos += ln
                        if kind == "main" and c["gainDb"] is not None:
                            og = f.create.OperationGroup(defs["gain"], ln)
                            og.media_kind = "sound"
                            og.segments.append(sc)
                            og["Parameters"].append(constant(f, defs, "amp", gain_rational(c["gainDb"])))
                            seq.components.append(og)
                        else:
                            seq.components.append(sc)
                    if fo:
                        seq.components.append(fade_transition(f, defs, fo, c["fadeOut"]["interp"]))
                        cur = pos + length - fo  # la transition chevauche la fin du clip
                        nxt = None
                        # le Filler suivant doit couvrir le fondu : on l'ajoute au prochain tour (gap + fo)
                        seq.components.append(f.create.Filler("sound", fo))
                        cur = pos + length
                    else:
                        cur = pos + length
                seg = seq
                if t["volumeDb"] is not None:
                    og = f.create.OperationGroup(defs["gain"], seq.length); og.media_kind = "sound"
                    og.segments.append(seg)
                    og["Parameters"].append(constant(f, defs, "amp", gain_rational(t["volumeDb"])))
                    seg = og
                if t["pan"] is not None:
                    og = f.create.OperationGroup(defs["panop"], seq.length); og.media_kind = "sound"
                    og.segments.append(seg)
                    og["Parameters"].append(constant(f, defs, "pan", pan_rational(t["pan"])))
                    seg = og
                s.segment = seg


def expected(tracks, media, edit_rate=SR):
    """Vérité attendue, en échantillons (au débit d'édition vidéo : arrondi vers le bas à l'image)."""
    ratio = Fraction(edit_rate, SR)
    q = lambda v: int(int(v * ratio) / ratio)  # noqa: E731
    out = {"sampleRate": SR, "editRate": edit_rate, "tracks": [], "clips": 0}
    for t in tracks:
        clips = []
        for c in t["clips"]:
            e = {"name": c["name"], "pos": q(c["pos"]), "offset": q(c["offset"]), "len": q(c["len"]), "media": next(m["name"] for m in media if m["key"] == c["media"])}
            e["gain"] = float(gain_rational(c["gainDb"])) if c["gainDb"] is not None else 1.0
            e["fadeIn"] = {"len": q(c["fadeIn"]["len"]), "shape": SHAPE[c["fadeIn"]["interp"]], "approx": c["fadeIn"]["interp"] == "Constant"} if c["fadeIn"] else None
            e["fadeOut"] = {"len": q(c["fadeOut"]["len"]), "shape": SHAPE[c["fadeOut"]["interp"]], "approx": c["fadeOut"]["interp"] == "Constant"} if c["fadeOut"] else None
            if c.get("renderedIn"):
                e["fadeIn"] = {"len": q(c["renderedIn"]), "shape": "EQUAL_POWER", "approx": True, "rendered": True}
            if c.get("renderedOut"):
                e["fadeOut"] = {"len": q(c["renderedOut"]), "shape": "EQUAL_POWER", "approx": True, "rendered": True}
            clips.append(e)
        out["tracks"].append({"name": t["name"], "channels": t["channels"], "volume": float(gain_rational(t["volumeDb"])) if t["volumeDb"] is not None else None,
                              "pan": float(pan_rational(t["pan"])) if t["pan"] is not None else None, "clips": clips})
        out["clips"] += len(clips)
    return out


# ── Relecture (aller-retour NOVA → AAF → pyaaf2) ─────────────────────────────────────────
def relire(path):
    """Positions, décalages et longueurs en échantillons, gain et fondus, lus par pyaaf2."""
    res = {"tracks": [], "errors": []}
    with aaf2.open(str(path), "r") as f:
        comps = list(f.content.compositionmobs())
        res["compositions"] = len(comps)
        comp = comps[0]
        res["name"] = comp.name
        res["mobs"] = {k: len(list(getattr(f.content, k)())) for k in ("compositionmobs", "mastermobs", "sourcemobs")}
        res["essence"] = len(list(f.content.essencedata))
        for slot in comp.slots:
            if slot.segment.media_kind != "Sound":
                continue
            er = Fraction(slot["EditRate"].value)
            seg = slot.segment
            vol = pan = None
            while seg.__class__.__name__ == "OperationGroup":
                opname = seg.operation.name
                p = list(seg.parameters)[0] if len(seg.parameters) else None
                if "Gain" in opname and p is not None: vol = float(p.value)
                if "Pan" in opname and p is not None: pan = float(p.value)
                seg = seg.segments[0]
            clips = []
            pos = 0
            comps_ = list(seg.components)
            for i, c in enumerate(comps_):
                cls = c.__class__.__name__
                if cls == "Transition":
                    pos -= c.length
                    continue
                gain = 1.0
                points = None
                inner = c
                if cls == "OperationGroup":
                    p = list(c.parameters)[0]
                    if p.__class__.__name__ == "VaryingValue":
                        gain = None
                        points = [[float(cp["Time"].value), float(cp["Value"].value)] for cp in p["PointList"].value]
                    else:
                        gain = float(p.value)
                    inner = c.segments[0]
                if inner.__class__.__name__ == "SourceClip":
                    mm = inner.mob
                    msl = mm.slot_at(inner.slot_id)
                    src = msl.segment
                    sm = src.mob
                    d = sm.descriptor
                    sr = Fraction(d["SampleRate"].value)
                    k = sr / er
                    fi = comps_[i - 1] if i > 0 and comps_[i - 1].__class__.__name__ == "Transition" else None
                    fo = comps_[i + 1] if i + 1 < len(comps_) and comps_[i + 1].__class__.__name__ == "Transition" else None
                    def fade(t):
                        if t is None: return None
                        og = t["OperationGroup"].value
                        interp = None
                        for p in og.parameters:
                            try: interp = p.interpolationdef.name
                            except Exception: pass
                        return {"len": int(t.length * k), "interp": interp}
                    loc = None
                    try:
                        locs = list(d["Locator"].value) if "Locator" in d.keys() else []
                        loc = locs[0]["URLString"].value if locs else None
                    except Exception:
                        loc = None
                    clips.append({"name": mm.name, "pos": int(pos * k), "offset": int((inner.start + src.start) * k), "len": int(c.length * k),
                                  "gain": gain, "gainPoints": points, "fadeIn": fade(fi), "fadeOut": fade(fo), "file": sm.name,
                                  "descriptor": d.__class__.__name__, "locator": loc, "embedded": sm.mob_id in f.content.essencedata,
                                  "channelSlot": inner.slot_id})
                pos += c.length
            res["tracks"].append({"name": slot.name, "editRate": str(er), "volume": vol, "pan": pan, "clips": clips})
    return res


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--relire":
        print(json.dumps(relire(sys.argv[2]), ensure_ascii=False))
        return
    petit = "--petit" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = Path(args[0] if args else "aaf_reference")
    out.mkdir(parents=True, exist_ok=True)
    tracks, media = plan(petit=petit)
    if petit:  # jeu réduit pour les tests vitest (médias liés : l'AAF ne contient que la séance)
        md = out / "Audio Files"; md.mkdir(exist_ok=True)
        build(out / "ref_lie_petit.aaf", tracks, media, "lie", media_dir=md, missing=("Adlibs_01",), sector_size=512)
        exp = {"lie": expected(tracks, media), "manquant": ["Adlibs_01"]}
        (out / "attendu_petit.json").write_text(json.dumps(exp, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"OK : {exp['lie']['clips']} clips (petit) dans {out}")
        return
    build(out / "ref_integre.aaf", tracks, media, "integre")
    md = out / "Audio Files"; md.mkdir(exist_ok=True)
    build(out / "ref_lie.aaf", tracks, media, "lie", media_dir=md, missing=("Adlibs_01",))
    build(out / "ref_25ips.aaf", tracks, media, "integre", edit_rate=25)
    exp = {"integre": expected(tracks, media), "lie": expected(tracks, media), "25ips": expected(tracks, media, 25),
           "manquant": ["Adlibs_01"]}
    (out / "attendu.json").write_text(json.dumps(exp, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"OK : {exp['integre']['clips']} clips, 3 AAF dans {out}")


if __name__ == "__main__":
    main()
