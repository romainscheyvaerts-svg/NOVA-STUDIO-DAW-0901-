"""Mesures et démos des sons du synthé NOVA (headless, aucune fenêtre, hors production).

Rendu hors ligne par le VRAI moteur (audioEngine.renderProject → OfflineAudioContext),
le même code que l'export. Pour chaque préréglage de la banque :

  - niveau : RMS maximal sur 300 ms (accord de 5 notes, vélocité 0,8 ; note seule pour
    les sons mono), la méthode de calibration de la banque (qa/synth_v24_preuve.py) ;
  - crête : accord de 4 voix à la vélocité 127, canaux gauche et droit (≤ -1 dBFS exigé) ;
  - pas de silence : le son est bien là pendant la note ;
  - pas de son continu : après le relâchement, le son retombe sous -60 dBFS (queue
    d'écho comprise) et il ne reste rien à la fin du rendu ;
  - clics à l'attaque et au relâchement (même mesure que la V24).

Les nouveaux sons (isNew) doivent tenir à ±3 dB de la cible de la banque (médiane des
anciens sons). --calibrer propose le volume qui place chaque nouveau son sur la cible.
--demos rend une petite phrase (accords, mélodie, arpège ou ligne de basse) par nouveau
son dans D:\\1 WORK\\CONTENU\\nova-synthe\\demos\\ (+ 00_tous_les_nouveaux.wav).

  NOVA_URL=http://127.0.0.1:3449/ python qa/synthe_sons.py [--demos] [--calibrer] [--tous]
Code de sortie : 0 si tous les nouveaux sons passent, 1 sinon.
"""
import base64, io, json, os, statistics, sys, wave
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3449/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-synthe\captures")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, Log, launch, new_page  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

LIVRABLE = Path(os.environ.get("SYNTHE_OUT", r"D:\1 WORK\CONTENU\nova-synthe"))
DEMOS = LIVRABLE / "demos"
DEMOS_ON = "--demos" in sys.argv
CALIBRER = "--calibrer" in sys.argv
TOUS = "--tous" in sys.argv  # démos aussi pour les 48 anciens sons
# --recalibrer=id1,id2 : propose aussi un volume pour ces anciens sons (corrigés d'après les règles de l'art).
RECALIBRER = {x for a in sys.argv if a.startswith("--recalibrer=") for x in a.split("=", 1)[1].split(",") if x}

LIB = r"""
window.__synthe = (async () => {
  const imp = p => (window.__novaAppModule ? window.__novaAppModule(p) : import(p));
  const { audioEngine } = await imp('/engine/AudioEngine.ts');
  const { TrackType } = await imp('/types.ts');
  const P = await imp('/utils/novaSynthPresets.ts');
  const SR = 48000;
  const CHORD5 = [48, 55, 58, 62, 65];
  const CHORD4 = [48, 55, 58, 62];
  const track = (id, novaSynth, notes, dur) => ({ id, name: id, type: TrackType.MIDI, volume: 1, pan: 0, isMuted: false, isSolo: false,
    clips: [{ id: id + '-c', type: TrackType.MIDI, start: 0, duration: dur, offset: 0, name: 'm', notes }], plugins: [], sends: [], automationLanes: [],
    outputTrackId: 'master', novaSynth });
  const chord = (pitches, at, dur, vel) => pitches.map((p, i) => ({ id: 'n' + i, pitch: p, start: at, duration: dur, velocity: vel }));
  const chans = buf => [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
  const mono = buf => { const [L, R] = chans(buf); const x = new Float32Array(L.length); for (let i = 0; i < x.length; i++) x[i] = (L[i] + R[i]) / 2; return x; };
  const db = v => v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -200;
  const rms = (x, a, b) => { let s = 0; const i0 = Math.max(0, Math.floor(a * SR)), i1 = Math.min(x.length, Math.floor(b * SR)); for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
  const peak = x => { let p = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; } return p; };
  const loud = (x, a, b) => { let best = 0; for (let t = a; t + 0.3 <= b; t += 0.05) best = Math.max(best, rms(x, t, t + 0.3)); return best; };
  const d2 = x => { const d = new Float32Array(x.length); for (let i = 2; i < x.length; i++) d[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]); return d; };
  const maxIn = (d, a, b) => { let m = 0; const i0 = Math.max(2, Math.floor(a * SR)), i1 = Math.min(d.length, Math.floor(b * SR)); for (let i = i0; i < i1; i++) m = Math.max(m, d[i]); return m; };
  const clickAt = (d, t, kind) => { const w = maxIn(d, t - 0.001, t + 0.005); const ref = kind === 'on' ? maxIn(d, t + 0.006, t + 0.05) : maxIn(d, t - 0.04, t - 0.002); return Math.round(w / Math.max(ref, 1e-6) * 100) / 100; };
  const wav = buf => {
    const n = buf.length, ch = 2, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const W = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    W(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); W(8, 'WAVE'); W(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); W(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const [L, R] = chans(buf);
    for (let i = 0; i < n; i++) { out.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true); out.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true); }
    let s = ''; const u = new Uint8Array(out.buffer); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s);
  };
  const render = (tracks, dur) => audioEngine.renderProject(tracks, dur, 0, SR);
  return { P, SR, CHORD5, CHORD4, track, chord, chans, mono, db, rms, peak, loud, d2, clickAt, wav, render };
})();
"""

MESURE_JS = r"""
async (ids) => {
  const L = await window.__synthe; const out = [];
  for (const id of ids) {
    const p = L.P.presetById(id); const s = L.P.presetSettings(id);
    // 1) Niveau (méthode de calibration de la banque).
    const pitches = s.mono ? [60] : L.CHORD5;
    const b1 = await L.render([L.track('s', s, L.chord(pitches, 0.25, 1.5, 0.8), 4)], 4);
    const x1 = L.mono(b1), d = L.d2(x1);
    // 2) Crête : accord de 4 voix, vélocité 127 ; queue après le relâchement (1,75 s).
    const T = 10;
    const b2 = await L.render([L.track('s', s, L.chord(L.CHORD4, 0.25, 1.5, 1), T)], T);
    const [cl, cr] = L.chans(b2); const x2 = L.mono(b2);
    // Dernière fenêtre de 50 ms au-dessus de -60 dBFS après le relâchement (null : encore audible à la fin).
    let last = 1.75;
    for (let t = 1.75; t + 0.05 <= T + 1e-9; t += 0.05) if (L.rms(x2, t, t + 0.05) >= 0.001) last = t + 0.05;
    const t60 = last >= T - 0.05 ? null : Math.round((last - 1.75) * 100) / 100;
    out.push({ id, nom: p.name, cat: p.cat, nouveau: !!p.isNew, mono: s.mono, volume: s.level,
      niveau_dB: L.db(L.loud(x1, 0.25, 2.1)),
      crete_4voix_vel127_dBFS: L.db(Math.max(L.peak(cl), L.peak(cr))),
      pendant_la_note_dB: L.db(L.rms(x2, 0.3, 1.7)),
      queue_sous_60dB_apres_s: t60,
      fin_du_rendu_dB: L.db(L.rms(x2, T - 0.5, T)),
      clic_attaque: L.clickAt(d, 0.25, 'on'), clic_relachement: L.clickAt(d, 1.75, 'off') });
  }
  return out;
}
"""

DEMO_JS = r"""
async ([id, notes, dur]) => {
  const L = await window.__synthe; const s = L.P.presetSettings(id);
  const buf = await L.render([L.track('demo', s, notes.map((n, i) => ({ id: 'd' + i, pitch: n[0], start: n[1], duration: n[2], velocity: n[3] ?? 0.85 })), dur)], dur);
  const [l, r] = L.chans(buf);
  return { wav: L.wav(buf), crete_dBFS: L.db(Math.max(L.peak(l), L.peak(r))) };
}
"""

# --- Phrases de démonstration (Do mineur) ---------------------------------------------------


def beats(bpm, seq):
    """seq : (note, temps de départ, durée en temps[, vélocité]) → [note, s, s(, vélocité)]."""
    q = 60 / bpm
    out = []
    for item in seq:
        n, a, d = item[:3]
        out.append([n, round(0.1 + a * q, 4), round(d * q, 4), *item[3:4]])
    return out


CHORDS = [[48, 55, 58, 62, 63], [44, 51, 55, 60], [41, 48, 56, 63, 67], [43, 53, 59, 62, 68]]  # Cm9, Lab maj7, Fm9, Sol7(b9)


def accords(bpm=90, beats_per=4):
    return beats(bpm, [(n, i * beats_per, beats_per - 0.1) for i, c in enumerate(CHORDS) for n in c])


def stabs(bpm=115):
    pat = [0.5, 1.5, 2.25, 3.5]  # contretemps « house / amapiano »
    return beats(bpm, [(n, i * 4 + t, 0.4, 0.9 if t % 1 else 0.75) for i, c in enumerate(CHORDS) for t in pat for n in c])


def pompe(bpm=150):
    # Accords tenus 2 temps, relancés : le LFO fait « pomper » le volume.
    return beats(bpm, [(n, i * 4 + h, 1.9) for i, c in enumerate(CHORDS) for h in (0, 2) for n in c])


MELODIE = [(67, 0, 1), (70, 1, 0.5), (72, 1.5, 1.5), (74, 3, 1.2), (75, 4, 0.5), (74, 4.5, 0.5), (72, 5, 1.6), (70, 6.5, 0.5),
           (67, 7, 1), (72, 8, 0.5), (70, 8.5, 0.5), (67, 9, 1.1), (65, 10, 0.5), (67, 10.5, 2.5), (63, 13, 0.5), (62, 13.5, 0.5), (60, 14, 2)]


def melodie(bpm=140, transpose=0):
    # Légers chevauchements : les sons mono glissent d'une note à l'autre.
    return beats(bpm, [(n + transpose, a, d + 0.08) for n, a, d in MELODIE])


def rebond(bpm=140):
    # Jersey club : motif sautillant en croches pointées.
    pat = [(72, 0), (72, 0.75), (75, 1.5), (72, 2.5), (70, 3), (67, 3.75), (70, 4.5), (72, 5.5), (75, 6), (77, 6.75), (75, 7.5)]
    return beats(bpm, [(n, a, 0.4) for n, a in pat] + [(n, a + 8, 0.4) for n, a in pat])


def arpege(bpm=140, pas=0.25, octave=12):
    seq, t = [], 0.0
    for c in CHORDS[:4]:
        up = [n + octave for n in c[1:]] + [c[1] + 2 * octave]
        for n in up + up[-2:0:-1]:
            seq.append((n, t, pas * 0.9)); t += pas
    return beats(bpm, seq)


def cloches(bpm=140):
    pat = [(79, 0), (82, 0.5), (84, 1), (86, 1.5), (87, 2), (86, 3), (84, 3.5), (82, 4), (79, 5), (75, 6), (77, 6.5), (79, 7)]
    return beats(bpm, [(n, a, 0.45) for n, a in pat] + [(n - 2, a + 8, 0.45) for n, a in pat[:8]])


def basse(bpm=140, glisse=True):
    seq = [(36, 0, 1.4), (36, 1.5, 0.5), (39, 2, 1), (41, 3, 0.75), (43, 4, 1.8), (41, 5.75, 0.5), (39, 6.25, 1.6),
           (36, 8, 1.4), (36, 9.5, 0.5), (34, 10, 1), (31, 11, 1.6), (36, 12.5, 1.5), (43, 14, 0.4), (41, 14.5, 1.4)]
    return beats(bpm, [(n, a, d + (0.1 if glisse else 0)) for n, a, d in seq])


def log_drum(bpm=113):
    # Ligne de log drum : notes courtes, quelques glissés (chevauchements).
    seq = [(43, 0, 0.5), (43, 0.75, 0.4), (46, 1.5, 0.75), (43, 2.5, 0.4), (41, 3, 0.6), (43, 4, 0.5), (48, 4.75, 0.5), (46, 5.25, 0.6),
           (43, 6, 0.4), (39, 6.5, 0.9), (43, 8, 0.5), (43, 8.75, 0.4), (46, 9.5, 0.75), (48, 10.5, 0.5), (46, 11, 0.6), (43, 12, 1.2)]
    return beats(bpm, seq)


def funk(bpm=95):
    seq = [(36, 0, 0.4), (36, 0.75, 0.2), (48, 1, 0.3), (46, 1.5, 0.3), (43, 2, 0.6), (39, 2.75, 0.2), (41, 3, 0.9),
           (36, 4, 0.4), (36, 4.75, 0.2), (48, 5, 0.3), (51, 5.5, 0.4), (50, 6, 0.3), (46, 6.5, 0.6), (43, 7.25, 0.7)]
    return beats(bpm, seq)


DEMO = {
    'orgue-house': stabs(118), 'accords-amapiano': stabs(113), 'accords-future-bass': pompe(150),
    'nappe-drill-sombre': accords(70), 'nappe-synthwave': accords(90), 'nappe-vinyle': accords(80), 'choeur-sombre': accords(70),
    'cuivres-trap': accords(75), 'pluck-lofi': arpege(80, 0.5), 'pluck-afro': arpege(110, 0.5), 'pluck-rage': arpege(150),
    'arp-ambient': arpege(80, 0.5), 'cloche-noel': cloches(140), 'lead-jersey': rebond(140), 'lead-gfunk': melodie(92),
    'lead-voix': melodie(140), 'lead-rage': melodie(150), 'lead-hyperpop': melodie(160), 'flute-afro': melodie(105),
    'basse-funk': funk(95), 'reese-drill': basse(140), 'log-drum': log_drum(113),
}


def demo_for(p):
    if p["id"] in DEMO:
        return DEMO[p["id"]]
    c = p["cat"]
    if c == "Basses":
        return basse(140)
    if p["mono"]:
        return melodie(140)
    if c in ("Plucks", "Arpèges", "Cloches & mallets"):
        return arpege(140)
    return accords(90)


def wav_concat(paths, dest, gap=0.6):
    with wave.open(str(paths[0])) as w0:
        params = w0.getparams()
    silence = b"\x00" * int(params.framerate * gap) * params.nchannels * params.sampwidth
    with wave.open(str(dest), "wb") as out:
        out.setparams(params)
        for pth in paths:
            with wave.open(str(pth)) as w:
                out.writeframes(w.readframes(w.getnframes()))
            out.writeframes(silence)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    LIVRABLE.mkdir(parents=True, exist_ok=True)
    log = Log("synthe_sons")
    with sync_playwright() as pw:
        b = launch(pw)
        ctx, page = new_page(b, "pc", log)
        page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.evaluate(LIB)
        page.wait_for_function("() => window.__synthe", timeout=30000)
        ids = page.evaluate("async () => (await window.__synthe).P.SYNTH_PRESETS.map(p => p.id)")
        mesures = []
        for i in range(0, len(ids), 8):
            mesures += page.evaluate(MESURE_JS, ids[i:i + 8])
        demos = {}
        if DEMOS_ON:
            DEMOS.mkdir(parents=True, exist_ok=True)
            for old in DEMOS.glob("*.wav"):
                old.unlink()
            todo = [m for m in mesures if m["nouveau"] or TOUS]
            files = []
            for k, m in enumerate(todo, 1):
                notes = demo_for(m)
                dur = max(n[1] + n[2] for n in notes) + 3.5
                r = page.evaluate(DEMO_JS, [m["id"], notes, dur])
                f = DEMOS / f"{k:02d}_{m['id']}.wav"
                f.write_bytes(base64.b64decode(r["wav"]))
                files.append(f)
                demos[m["id"]] = {"fichier": f.name, "duree_s": round(dur, 1), "crete_dBFS": r["crete_dBFS"]}
            if files:
                wav_concat(files, DEMOS / "00_tous_les_nouveaux.wav")
        ctx.close(); b.close()

    anciens = [m for m in mesures if not m["nouveau"]]
    nouveaux = [m for m in mesures if m["nouveau"]]
    cible = round(statistics.median(m["niveau_dB"] for m in anciens), 1)
    verdicts = []
    for m in mesures:
        ko = []
        if m["crete_4voix_vel127_dBFS"] > -1.0: ko.append(f"crête {m['crete_4voix_vel127_dBFS']} dBFS > -1")
        if abs(m["niveau_dB"] - cible) > 3.0: ko.append(f"niveau {m['niveau_dB']} dB hors de {cible} ± 3")
        if m["pendant_la_note_dB"] < -40: ko.append("silence pendant la note")
        if m["queue_sous_60dB_apres_s"] is None or m["fin_du_rendu_dB"] > -70: ko.append("son qui continue après le relâchement")
        # Clics : pas pire que les sons déjà validés de la banque (attaques percussives : ≤ 1,9 ; relâchement ≤ 1,5).
        if m["clic_attaque"] > 1.9 or m["clic_relachement"] > 1.5: ko.append(f"clic ({m['clic_attaque']} / {m['clic_relachement']})")
        m["defauts"] = ko
        if CALIBRER and (m["nouveau"] or m["id"] in RECALIBRER):
            m["volume_propose"] = round(min(1.0, m["volume"] * 10 ** ((cible - m["niveau_dB"]) / 20)), 3)
    res = {
        "cible_banque_dB": cible,
        "anciens": {"n": len(anciens), "min": min(m["niveau_dB"] for m in anciens), "max": max(m["niveau_dB"] for m in anciens),
                    "pire_crete_dBFS": max(m["crete_4voix_vel127_dBFS"] for m in anciens),
                    "avec_defaut": {m["id"]: m["defauts"] for m in anciens if m["defauts"]}},
        "nouveaux": {"n": len(nouveaux), "min": min((m["niveau_dB"] for m in nouveaux), default=None), "max": max((m["niveau_dB"] for m in nouveaux), default=None),
                     "pire_crete_dBFS": max((m["crete_4voix_vel127_dBFS"] for m in nouveaux), default=None),
                     "avec_defaut": {m["id"]: m["defauts"] for m in nouveaux if m["defauts"]}},
        "mesures": mesures, "demos": demos,
        "erreurs_page": [e["text"][:200] for e in log.errors()][:5],
    }
    (LIVRABLE / "mesures.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"cible de la banque (médiane des {len(anciens)} anciens) : {cible} dB RMS")
    for m in sorted(mesures, key=lambda m: (not m["nouveau"], m["niveau_dB"])):
        tag = "NOUVEAU" if m["nouveau"] else "       "
        extra = f"  -> volume {m['volume_propose']}" if "volume_propose" in m else ""
        print(f"{tag} {m['id']:22s} niv {m['niveau_dB']:6.1f}  crête {m['crete_4voix_vel127_dBFS']:6.1f}  note {m['pendant_la_note_dB']:6.1f}"
              f"  queue {m['queue_sous_60dB_apres_s']}  fin {m['fin_du_rendu_dB']:7.1f}  clics {m['clic_attaque']:.2f}/{m['clic_relachement']:.2f}"
              f"  vol {m['volume']:.3f}{extra}  {'; '.join(m['defauts'])}")
    print(json.dumps({k: v for k, v in res.items() if k in ("cible_banque_dB", "anciens", "nouveaux", "erreurs_page")}, ensure_ascii=False, indent=1))
    ok = not res["nouveaux"]["avec_defaut"] and not res["erreurs_page"]
    print("OK : tous les nouveaux sons passent" if ok else "KO : au moins un nouveau son a un défaut")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
