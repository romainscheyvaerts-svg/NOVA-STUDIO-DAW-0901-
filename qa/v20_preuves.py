"""V20 · Fredonne → MIDI, Batterie → MIDI, Accords → MIDI et piste d'accords :
preuves dans un navigateur headless (aucune fenêtre).

Usage (serveur NOVA lancé : npx vite --port 3434 --strictPort) :
  NOVA_URL=http://127.0.0.1:3434/ PYTHONIOENCODING=utf-8 python qa/v20_preuves.py [A B C D E]

Matière réelle : « Silence blanc » (session Pro Tools du studio : voix et
instru d'origine) et sa batterie séparée (stems V18). Tempo et premier temps
mesurés ici (92,3 BPM, 1er temps à 0,046 s) : les extraits partent d'un
premier temps, comme un beat posé en début de projet.

  A. PC : la vraie voix → « Mélodie → MIDI » (menu du clip). Notes comparées à
     la hauteur mesurée ICI (YIN en Python, indépendant de NOVA), puis 808
     calée gamme + grille. Piano roll ouvert : accords surlignés.
  B. PC : vraie boucle de batterie (4 mesures) → boîte à rythmes et piste GM.
     Comparée à une détection simple faite ici (bandes d'énergie).
  C. PC : accords. C1 beat aux accords CONNUS (synthé NOVA + 808 + vraie
     batterie) → « Détecter » → taux de réussite par temps. C2 le vrai beat :
     accords trouvés, comparés à la note de la VRAIE basse (stem basse).
     Pose à la main (choix d'accord), piano roll surligné.
  D. Tablette : appui long → Mélodie → MIDI ; menu ☰ → Affichage → piste d'accords.
  E. Téléphone : version simple, « Fredonne → 808 » du panneau voix, au micro
     (le micro simulé de Chrome joue la vraie voix).
"""
import base64, io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v20")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3434/")
from qalib import *  # noqa
from qalib import CHROME, VIEWPORTS
from gel_pre_effet import prepare, open_project_file  # noqa
from v19_justesse import note_pitch, STATE_BASE  # noqa

PT = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
STEMS4 = Path(r"D:\1 WORK\CONTENU\nova-v18-stems\stems-4")
BPM = 92.3
DOWNBEAT0 = 0.0464
BAR = 4 * 60 / BPM
SR = 44100
MAT = OUT / "materiaux"
MAT.mkdir(parents=True, exist_ok=True)
RESULTS = {}


def downbeat(k):
    return DOWNBEAT0 + k * BAR


def stereo_pt(name, t0, dur):
    l, sr = sf.read(str(PT / f"{name}.L.wav"), dtype="float32", start=int(t0 * SR), frames=int(dur * SR))
    r, _ = sf.read(str(PT / f"{name}.R.wav"), dtype="float32", start=int(t0 * SR), frames=int(dur * SR))
    return np.stack([l, r])


def stem(name, t0, dur):
    x, sr = sf.read(str(STEMS4 / f"{name}.wav"), dtype="float32", start=int(t0 * SR), frames=int(dur * SR))
    return x.T if x.ndim > 1 else x[None, :]


def wav_bytes(x, sr=SR):
    x = np.atleast_2d(x)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(x.shape[0]); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x.T.reshape(-1), -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


BASE_TRACK = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
              "outputTrackId": "master", "sends": [], "plugins": []}


def make_project(path: Path, name, audio_tracks, key=None, bpm=BPM, chords=None):
    """audio_tracks : [(id, nom, wav, durée, début)]."""
    tracks = []
    with zipfile.ZipFile(path, "w") as z:
        for tid, tname, wav, dur, start in audio_tracks:
            clip = {"id": f"{tid}-1", "name": tname, "start": start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                    "color": "#22d3ee", "type": "AUDIO", "audioRef": f"audio/{tid}.wav", "gain": 1, **({"takeNumber": 1} if tid == "voix" else {})}
            tracks.append({**BASE_TRACK, "id": tid, "name": tname, "type": "AUDIO", "color": "#22d3ee", "volume": 0.9, "clips": [clip]})
            z.writestr(f"audio/{tid}.wav", wav)
        state = {**STATE_BASE, "bpm": bpm, "id": f"proj-{re.sub(r'[^a-z0-9]+', '-', name.lower())}", "name": name, "tracks": tracks}
        if key:
            state["projectKey"], state["projectScale"] = key
        if chords is not None:
            state["chords"] = chords
        z.writestr("project.json", json.dumps(state))


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def canvas_box(page):
    return page.evaluate("""() => { const c = (document.querySelector('.nova-grille canvas[data-tracks-top]') || document.querySelectorAll('.nova-grille canvas')[1]); const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


def clip_point(page, track_index, t):
    box = canvas_box(page)
    return box["x"] + t * 40 - box["sl"], box["y"] + box.get("tt", 40) + track_index * 120 + 60 - box["st"]


def track_index(page, tid):
    return st(page, f"s => s.tracks.filter(t => t.id !== 'master' && t.type !== 'SEND').findIndex(t => t.id === '{tid}')")


def clip_menu(page, track_index, t, touch=False):
    if isinstance(track_index, str):
        track_index = globals()["track_index"](page, track_index)
    x, y = clip_point(page, track_index, t)
    if touch:
        page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); const o = { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 7, isPrimary: true };
          el.dispatchEvent(new PointerEvent('pointerdown', o)); }""", [x, y])
        page.wait_for_timeout(800)
        page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 7 })); }""", [x, y])
    else:
        page.mouse.click(x, y, button="right")
    page.wait_for_timeout(500)


def set_range(page, testid, value):
    page.evaluate("""([id, v]) => {
      const el = document.querySelector(`[data-testid=${id}]`);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }""", [testid, value])
    page.wait_for_timeout(250)


def listen_check(page):
    """« Écouter » : l'aperçu démarre (bouton Stop) et le son sort (niveau mesuré sur la sortie de l'aperçu)."""
    page.evaluate("""() => { window.__a2mPeak = 0; const C = window.AudioContext; if (C.__spied) return; C.__spied = true;
      const orig = C.prototype.createGain; C.prototype.createGain = function () { const g = orig.call(this);
        if (!this.__an) { const an = this.createAnalyser(); an.fftSize = 2048; this.__an = an; const buf = new Float32Array(2048);
          const tick = () => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); window.__a2mPeak = Math.max(window.__a2mPeak, m); if (this.state !== 'closed') setTimeout(tick, 30); }; tick();
          const od = this.destination; const ctx = this; const oc = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function (dst, ...a) { if (dst === od && this.context === ctx) { oc.call(this, an); } return oc.call(this, dst, ...a); }; }
        return g; }; }""")
    page.get_by_test_id("a2m-listen").click()
    page.wait_for_timeout(1800)
    playing = "Stop" in page.get_by_test_id("a2m-listen").inner_text()
    peak = page.evaluate("() => window.__a2mPeak")
    page.get_by_test_id("a2m-listen").click(); page.wait_for_timeout(200)
    return {"lecture": playing, "crete_sortie": round(float(peak or 0), 3)}


def wait_dialog_ready(page, timeout=60000):
    page.wait_for_selector("[data-testid=audio-to-midi]", timeout=10000)
    page.wait_for_function("() => { const d = document.querySelector('[data-testid=audio-to-midi]'); return d && !/J’écoute/.test(d.innerText); }", timeout=timeout)
    page.wait_for_timeout(300)


def advanced(page):
    page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_count_in', '0'); } catch (e) {}")


def mono(x):
    return np.atleast_2d(x).mean(axis=0)


# ------------------------------------------------------------ matière
VOICE_K = 23           # extrait voix : 4 mesures à partir du 24e premier temps (59,85 s)
DRUM_K = 29            # boucle : 4 mesures à partir de 75,45 s
BEAT_K, BEAT_BARS = 11, 24


def voice_material():
    t0, dur = downbeat(VOICE_K), 4 * BAR
    v = stereo_pt("Silence blanc (Vocals)", t0, dur)
    i = stereo_pt("Silence blanc (Instrumental)", t0, dur)
    return v, i, dur, t0


def key_of_instru(page, wav):
    """Tonalité du beat par NOVA (utils/keyDetect), sur l'audio décodé dans la page."""
    return page.evaluate("""async (b64) => {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const ctx = new OfflineAudioContext(2, 44100, 44100);
      const buf = await ctx.decodeAudioData(bin.buffer);
      const { detectKey } = await import('/utils/keyDetect.ts');
      return await detectKey(buf);
    }""", base64.b64encode(wav).decode())


# ------------------------------------------------------------ A. PC : vraie voix → MIDI
def scenario_a(p):
    log = Log("A_pc_fredonne")
    res = {}
    v, i, dur, t0 = voice_material()
    vw, iw = wav_bytes(v), wav_bytes(i)
    (MAT / "A_voix_extrait.wav").write_bytes(vw)
    b = launch(p)
    ctx, page = new_page(b, "pc", log)
    advanced(page); prepare(page)
    page.goto(BASE, wait_until="domcontentloaded")
    key = key_of_instru(page, wav_bytes(stereo_pt("Silence blanc (Instrumental)", downbeat(BEAT_K), BEAT_BARS * BAR)))
    res["tonalite_detectee"] = key
    proj = MAT / "A_projet_voix.zip"
    make_project(proj, "Fredonne vraie voix", [("instrumental", "Silence blanc (instru)", iw, dur, 0), ("voix", "Silence blanc (voix)", vw, dur, 0)],
                 key=(key["rootKey"], key["scale"]) if key else None)
    open_project_file(page, proj, res, "A0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    clip_menu(page, 1, 3.0)
    shot(page, "A1_menu_clip")
    page.get_by_text("Mélodie → MIDI (808, piano…)…", exact=True).first.click()
    t_a = time.time()
    wait_dialog_ready(page)
    res["analyse_s"] = round(time.time() - t_a, 2)
    # 1) fidélité : piano, sans calage (gamme 0 %, grille 0 %)
    page.locator("[data-instrument=piano]").click()
    set_range(page, "hum-scale", 0); set_range(page, "hum-grid", 0)
    shot(page, "A2_fredonne_piano_brut")
    res["resume_brut"] = page.get_by_test_id("hum-summary").inner_text()
    page.get_by_test_id("a2m-create").click(); page.wait_for_timeout(600)
    raw = st(page, "s => { const t = s.tracks.find(x => x.id.startsWith('track-hum-')); const c = t.clips[0]; return { name: t.name, synth: t.novaSynth && t.novaSynth.presetId, start: c.start, notes: c.notes.map(n => [n.pitch, +(c.start + n.start).toFixed(4), +n.duration.toFixed(4), +n.velocity.toFixed(2)]) }; }")
    res["piste_piano"] = {k: raw[k] for k in ("name", "synth", "start")}
    # Comparaison note par note avec la hauteur mesurée ici (YIN), sur la voix d'origine.
    vm = mono(v)
    rows, ok, ok1 = [], 0, 0
    for pitch, s0, d, vel in raw["notes"]:
        a, z = s0 + 0.2 * d, s0 + d - 0.2 * d
        m = note_pitch(vm, SR, a, max(a + 0.05, z)) if d > 0.08 else float("nan")
        if np.isnan(m):
            rows.append({"note": pitch, "debut": s0, "duree": d, "mesure": None}); continue
        e = abs(pitch - m)
        ok += e <= 0.5 + 1e-9; ok1 += e <= 1.0
        rows.append({"note": pitch, "debut": s0, "duree": d, "mesure": round(m, 2), "ecart_demi_tons": round(pitch - m, 2)})
    measured = [r for r in rows if r.get("mesure") is not None]
    res["comparaison"] = {"notes": len(raw["notes"]), "notes_mesurees": len(measured),
                          "a_moins_d_un_demi_ton": f"{ok}/{len(measured)}", "a_moins_d_un_ton": f"{ok1}/{len(measured)}",
                          "ecart_median_demi_tons": round(float(np.median([abs(r['ecart_demi_tons']) for r in measured])), 3) if measured else None}
    res["notes_detail"] = rows[:60]
    # Timing : chaque début de note tombe sur une attaque de la voix (niveau qui monte) ?
    # 2) 808 calée gamme 100 % + grille 75 % (réglages par défaut)
    clip_menu(page, 1, 3.0)
    page.get_by_text("Mélodie → MIDI (808, piano…)…", exact=True).first.click()
    wait_dialog_ready(page)
    page.locator("[data-instrument='808']").click()
    set_range(page, "hum-scale", 100); set_range(page, "hum-grid", 100)
    res["gamme_utilisee"] = page.locator("label", has=page.get_by_test_id("hum-scale")).inner_text().splitlines()[0]
    shot(page, "A3_fredonne_808_gamme_grille")
    res["ecoute_808"] = listen_check(page)
    res["resume_808"] = page.get_by_test_id("hum-summary").inner_text()
    page.get_by_test_id("a2m-create").click(); page.wait_for_timeout(600)
    b808 = st(page, "s => { const t = s.tracks.filter(x => x.id.startsWith('track-hum-')).find(x => x.bass808); const c = t.clips[0]; return { name: t.name, bass808: t.bass808, notes: c.notes.map(n => [n.pitch, +(c.start + n.start).toFixed(4), +n.duration.toFixed(4)]) }; }")
    beat = 60 / BPM
    on_grid = sum(1 for n in b808["notes"] if abs(n[1] / (beat / 4) - round(n[1] / (beat / 4))) < 0.01)
    key_pc = None
    fr = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si']
    m = re.search(r"\(([^ ,)]+) (mineur|majeur)", res["gamme_utilisee"], re.I)
    if m and m.group(1) in fr:
        iv = [0, 2, 3, 5, 7, 8, 10] if m.group(2).lower() == "mineur" else [0, 2, 4, 5, 7, 9, 11]
        key_pc = {(fr.index(m.group(1)) + x) % 12 for x in iv}
    res["piste_808"] = {"name": b808["name"], "notes": len(b808["notes"]), "hauteurs": sorted({n[0] for n in b808["notes"]}),
                        "dans_la_gamme": (f"{sum(1 for n in b808['notes'] if n[0] % 12 in key_pc)}/{len(b808['notes'])}" if key_pc else None),
                        "sur_la_grille_1_16": f"{on_grid}/{len(b808['notes'])}"}
    shot(page, "A4_pistes_creees")
    # Piano roll de la piste 808 (double-clic sur le clip MIDI créé : piste 3)
    tracks_order = st(page, "s => s.tracks.filter(t => t.id !== 'master').map(t => t.id)")
    idx = next(k for k, tid in enumerate(tracks_order) if tid.startswith("track-hum-") and "808" in st(page, f"s => s.tracks.find(t => t.id === '{tid}').name"))
    x, y = clip_point(page, idx, 1.0)
    page.mouse.dblclick(x, y); page.wait_for_timeout(1200)
    shot(page, "A5_piano_roll_808")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    res["erreurs_page"] = [e["text"][:200] for e in log.errors()]
    save_log(log, {"result": res})
    RESULTS["A_pc"] = res
    ctx.close(); b.close()


# ------------------------------------------------------------ B. PC : vraie boucle de batterie
def py_drum_reference(x, sr, bpm, bars):
    """Référence simple et indépendante : énergie par bande à chaque double croche
    (grave < 150 Hz, médium 1-5 kHz, aigu > 7 kHz) ; un coup = pic local net."""
    step = 60 / bpm / 4
    n = 16 * bars
    N = 2048
    out = {"kick": [], "snare": [], "hat": []}
    fr = np.fft.rfftfreq(N, 1 / sr)
    bands = {"kick": (fr < 150), "snare": (fr > 1000) & (fr < 5000), "hat": fr > 7000}
    E = {k: [] for k in bands}
    for s in range(n):
        a = int(s * step * sr)
        seg = x[a:a + N]
        if len(seg) < N: seg = np.pad(seg, (0, N - len(seg)))
        pre = x[max(0, a - N):a]
        if len(pre) < N: pre = np.pad(pre, (N - len(pre), 0))
        S1 = np.abs(np.fft.rfft(seg * np.hanning(N))) ** 2
        S0 = np.abs(np.fft.rfft(pre * np.hanning(N))) ** 2
        for k, m in bands.items():
            E[k].append(max(0.0, S1[m].sum() - S0[m].sum()))
    for k in bands:
        e = np.array(E[k]); thr = 0.25 * e.max()
        out[k] = [int(s) for s in np.where(e > thr)[0]]
    return out


def scenario_b(p):
    log = Log("B_pc_batterie")
    res = {}
    t0, dur = downbeat(DRUM_K), 4 * BAR
    d = stem("drums", t0, dur)
    dw = wav_bytes(d)
    (MAT / "B_boucle_batterie.wav").write_bytes(dw)
    proj = MAT / "B_projet_boucle.zip"
    make_project(proj, "Boucle de batterie", [("boucle", "Boucle batterie (Silence blanc)", dw, dur, 0)])
    b = launch(p)
    ctx, page = new_page(b, "pc", log)
    advanced(page); prepare(page)
    open_project_file(page, proj, res, "B0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    clip_menu(page, 0, 3.0)
    shot(page, "B1_menu_clip")
    page.get_by_text("Batterie → MIDI…", exact=True).first.click()
    wait_dialog_ready(page)
    shot(page, "B2_batterie_apercu")
    res["ecoute"] = listen_check(page)
    res["resume"] = page.get_by_test_id("drum-summary").inner_text()
    found = page.evaluate("""() => { const rows = Array.from(document.querySelectorAll('[data-testid=drum-preview] > div'));
      return rows.map(r => Array.from(r.querySelectorAll('[data-step]')).filter(c => c.dataset.on).map(c => +c.dataset.step)); }""")
    nova = dict(zip(["kick", "snare", "hat"], found))
    ref = py_drum_reference(mono(d), SR, BPM, 4)
    agree = {}
    for k in nova:
        a, r = set(nova[k]), set(ref[k])
        agree[k] = {"nova": sorted(a), "reference_python": sorted(r), "communs": len(a & r),
                    "precision": round(len(a & r) / max(1, len(a)), 2), "rappel": round(len(a & r) / max(1, len(r)), 2)}
    # La bande aiguë de la référence capte aussi le haut des snares : hats comparés hors des coups de snare.
    ref_hat = set(ref["hat"]) - set(ref["snare"])
    a = set(nova["hat"])
    agree["hat_hors_snare"] = {"reference_python": sorted(ref_hat), "communs": len(a & ref_hat), "rappel": round(len(a & ref_hat) / max(1, len(ref_hat)), 2),
                               "en_plus_chez_nova": sorted(a - ref_hat)}
    res["comparaison_par_double_croche"] = agree
    page.get_by_test_id("a2m-create").click(); page.wait_for_timeout(1500)
    dm = st(page, "s => { const t = s.tracks.find(x => x.id === 'track-drums'); if (!t) return null; const dm = t.drumMachine; return { bars: dm.bars, rows: dm.rows.filter(r => r.steps.some(v => v > 0)).map(r => ({ id: r.id, on: r.steps.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0) })), clips: t.clips.length, notes: t.clips.reduce((a, c) => a + (c.notes || []).length, 0) }; }")
    res["boite_a_rythmes"] = dm
    shot(page, "B3_boite_a_rythmes_posee")
    # Piste General MIDI (36 / 38 / 42)
    clip_menu(page, "boucle", 3.0)
    page.get_by_text("Batterie → MIDI…", exact=True).first.click()
    wait_dialog_ready(page)
    page.get_by_role("radio", name=re.compile("Piste MIDI")).click(); page.wait_for_timeout(200)
    page.get_by_test_id("a2m-create").click(); page.wait_for_timeout(800)
    gm = st(page, "s => { const t = s.tracks.find(x => x.id.startsWith('track-gm-')); const n = t.clips[0].notes; return { name: t.name, kick36: n.filter(x => x.pitch === 36).length, snare38: n.filter(x => x.pitch === 38).length, hat42: n.filter(x => x.pitch === 42).length }; }")
    res["piste_general_midi"] = gm
    shot(page, "B4_piste_gm")
    res["erreurs_page"] = [e["text"][:200] for e in log.errors()]
    save_log(log, {"result": res})
    RESULTS["B_pc"] = res
    ctx.close(); b.close()


# ------------------------------------------------------------ C. accords
KNOWN = [  # (racine, qualité, temps) — progression trap / R&B en La mineur, 140 BPM
    (9, "min", 8), (5, "maj7", 8), (0, "maj", 8), (7, "maj", 4), (4, "min7", 4),
    (2, "min", 8), (5, "maj", 8), (4, "7", 8), (9, "min", 8),
]
KNOWN_BPM = 140
SYMB = {"maj": "", "min": "m", "7": "7", "maj7": "maj7", "min7": "m7", "sus2": "sus2", "sus4": "sus4", "dim": "dim"}
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def sym(r, q):
    return NAMES[r % 12] + SYMB[q]


RENDER_JS = r"""
async ([prog, bpm]) => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const { presetSettings } = await import('/utils/novaSynthPresets.ts');
  const { chordPitches } = await import('/utils/chordDetect.ts');
  const beat = 60 / bpm;
  const keys = [], bass = [], pluck = [];
  let t = 0, prev;
  for (const [r, q, beats] of prog) {
    const d = beats * beat;
    const up = chordPitches(r, q, { center: 62, prev }); prev = up;
    up.forEach((p, i) => keys.push({ id: `k${t}-${i}`, pitch: p, start: t, duration: d - 0.02, velocity: 0.7 }));
    bass.push({ id: `b${t}`, pitch: 36 + r - (r > 5 ? 12 : 0), start: t, duration: d - 0.05, velocity: 0.9 });
    for (let k = 0; k < beats * 2; k++) pluck.push({ id: `p${t}-${k}`, pitch: up[k % up.length] + 12, start: t + k * beat / 2, duration: beat / 2 - 0.02, velocity: 0.5 });
    t += d;
  }
  const tr = (id, extra, notes) => ({ id, name: id, type: TrackType.MIDI, volume: 0.8, pan: 0, isMuted: false, isSolo: false, sends: [], plugins: [], automationLanes: [],
    outputTrackId: 'master', clips: [{ id: id + '-c', type: TrackType.MIDI, start: 0, duration: t, offset: 0, name: id, notes }], ...extra });
  const tracks = [tr('keys', { novaSynth: presetSettings('keys-rnb') }, keys), tr('808', { bass808: { style: '808', glide: true } }, bass),
                  tr('pluck', { novaSynth: presetSettings('pluck-trap') }, pluck)];
  const b = await audioEngine.renderProject(tracks, t + 0.5, 0, 44100);
  const b64 = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  return { sr: b.sampleRate, l: b64(b.getChannelData(0)), r: b64(b.getChannelData(Math.min(1, b.numberOfChannels - 1))) };
}
"""


def detect_in_lane(page):
    page.get_by_test_id("chord-detect").click()
    page.wait_for_function("() => !document.querySelector('[data-testid=chord-detect]')?.disabled", timeout=60000)
    page.wait_for_timeout(500)
    return st(page, "s => (s.chords || []).map(c => [c.start, c.end, c.root, c.quality])")


def hit_rate(found, truth, beat, same_triad=False):
    ok = n = 0
    tri = {"maj": "M", "maj7": "M", "7": "M", "min": "m", "min7": "m", "sus2": "s2", "sus4": "s4", "dim": "d"}
    for (r, q, a, z) in truth:
        t = a
        while t < z - 1e-6:
            n += 1
            mid = t + beat / 2
            f = next((c for c in found if c[0] <= mid < c[1]), None)
            if f and f[2] == r and (tri[f[3]] == tri[q] if same_triad else f[3] == q):
                ok += 1
            t += beat
    return ok, n


def bass_pitch(x, sr, t0, t1):
    """Note de la basse (MIDI) entre t0 et t1 : YIN sur la basse filtrée sous 400 Hz,
    pour des notes de 808 jusqu'à ~30 Hz (trames de 4096), médiane des trames."""
    a, z = int(t0 * sr), int(t1 * sr)
    seg = x[a:z].astype(np.float64)
    if len(seg) < 4096:
        return float("nan")
    X = np.fft.rfft(seg)
    f = np.fft.rfftfreq(len(seg), 1 / sr)
    seg = np.fft.irfft(np.where(f < 400, X, 0), n=len(seg))
    if np.sqrt(np.mean(seg ** 2)) < 1e-3:
        return float("nan")
    v = []
    for s0 in range(0, len(seg) - 4096, 1024):
        fr = seg[s0:s0 + 4096]
        W = 2048
        tmax, tmin = int(sr / 28), int(sr / 400)
        d = np.array([np.sum((fr[:W] - fr[t:t + W]) ** 2) for t in range(tmax + 2)])
        cm = np.ones_like(d); cs = np.cumsum(d[1:]); cm[1:] = d[1:] * np.arange(1, len(d)) / np.maximum(cs, 1e-12)
        cand = np.where(cm[tmin:tmax] < 0.2)[0]
        if not len(cand):
            continue
        t = cand[0] + tmin
        while t + 1 < len(cm) - 1 and cm[t + 1] < cm[t]: t += 1
        v.append(69 + 12 * np.log2(sr / t / 440))
    return float(np.median(v)) if v else float("nan")


def scenario_c(p):
    log = Log("C_pc_accords")
    res = {}
    b = launch(p)
    ctx, page = new_page(b, "pc", log)
    advanced(page); prepare(page)
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    # C1 : beat aux accords connus, rendu par les instruments NOVA + la vraie batterie.
    r = page.evaluate(RENDER_JS, [[list(x) for x in KNOWN], KNOWN_BPM])
    harm = np.stack([np.frombuffer(base64.b64decode(r["l"]), "<f4"), np.frombuffer(base64.b64decode(r["r"]), "<f4")])
    total_beats = sum(x[2] for x in KNOWN)
    dur = total_beats * 60 / KNOWN_BPM
    # Vraie batterie (Silence blanc) remise au tempo (rééchantillonnée) et bouclée dessous.
    dr = mono(stem("drums", downbeat(DRUM_K), 4 * BAR))
    k = BPM / KNOWN_BPM
    idx = np.arange(0, len(dr) - 1, 1 / k)
    dr = np.interp(idx, np.arange(len(dr)), dr).astype(np.float32)
    n = harm.shape[1]
    drums = np.tile(dr, int(np.ceil(n / len(dr))))[:n]
    beat_mix = harm / max(1e-6, np.abs(harm).max()) * 0.6 + drums[None, :] * 0.7
    bw = wav_bytes(beat_mix)
    (MAT / "C1_beat_accords_connus.wav").write_bytes(bw)
    proj = MAT / "C1_projet.zip"
    make_project(proj, "Accords connus", [("instrumental", "Beat accords connus", bw, n / SR, 0)], key=(9, "MINOR"), bpm=KNOWN_BPM)
    open_project_file(page, proj, res, "C0_projet_accords_connus")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    shot(page, "C1_couloir_vide")
    t_d = time.time()
    found = detect_in_lane(page)
    res["C1_detection_s"] = round(time.time() - t_d, 2)
    beat = 60 / KNOWN_BPM
    truth, t = [], 0.0
    for (rt, q, bts) in KNOWN:
        truth.append((rt, q, t, t + bts * beat)); t += bts * beat
    ok, nb = hit_rate(found, truth, beat)
    ok3, _ = hit_rate(found, truth, beat, True)
    res["C1_accords_connus"] = {"vrais": " ".join(f"{sym(r, q)}({b_}t)" for r, q, b_ in KNOWN),
                                "trouves": " ".join(f"{sym(c[2], c[3])}({round((c[1] - c[0]) / beat)}t)" for c in found),
                                "reussite_par_temps_exacte": f"{ok}/{nb} = {round(100 * ok / nb)} %",
                                "reussite_par_temps_meme_triade": f"{ok3}/{nb} = {round(100 * ok3 / nb)} %",
                                "changements_sur_les_temps": all(abs(c[0] / beat - round(c[0] / beat)) < 1e-6 for c in found)}
    shot(page, "C2_couloir_accords_detectes")
    # Pose à la main : clic sur un accord → choix (accords de la gamme d'abord)
    lane = page.get_by_test_id("chord-lane").bounding_box()
    head = page.evaluate("() => document.querySelector('[data-testid=chord-lane] > div').getBoundingClientRect().width")
    page.mouse.click(lane["x"] + head + 2.2 * 40, lane["y"] + lane["height"] / 2); page.wait_for_timeout(400)
    shot(page, "C3_choix_accord")
    page.locator("[data-testid=chord-picker] [data-chord='Dm']").first.click(); page.wait_for_timeout(400)
    res["C1_apres_pose_main"] = st(page, "s => (s.chords || []).slice(0, 3).map(c => [+c.start.toFixed(3), +c.end.toFixed(3), c.root, c.quality])")
    page.keyboard.press("Control+z"); page.wait_for_timeout(400)
    res["C1_apres_ctrl_z"] = st(page, "s => (s.chords || []).slice(0, 3).map(c => [+c.start.toFixed(3), +c.end.toFixed(3), c.root, c.quality])")
    # Accords → MIDI sur le beat, puis piano roll surligné
    clip_menu(page, 0, 3.0)
    page.get_by_text("Accords → MIDI…", exact=True).first.click()
    wait_dialog_ready(page)
    shot(page, "C4_accords_vers_midi")
    res["C1_ecoute_accords"] = listen_check(page)
    page.get_by_test_id("a2m-create").click(); page.wait_for_timeout(800)
    harm_track = st(page, "s => { const t = s.tracks.find(x => x.id.startsWith('track-harm-')); return { name: t.name, preset: t.novaSynth && t.novaSynth.presetId, notes: t.clips[0].notes.length }; }")
    res["C1_piste_accords_midi"] = harm_track
    x, y = clip_point(page, 1, 1.0)
    page.mouse.dblclick(x, y); page.wait_for_timeout(1500)
    res["C1_piano_roll_lignes_surlignees"] = page.locator("[data-testid=chord-roll-overlay] [data-chord-row]").count()
    shot(page, "C5_piano_roll_accords_surlignes")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    # Sauvegarde : les accords sont dans le projet .zip
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    try:
        loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
        with page.expect_download(timeout=90000) as dl:
            loc.click()
        dest = MAT / "C1_projet_sauve.zip"
        dl.value.save_as(str(dest))
        with zipfile.ZipFile(dest) as z:
            saved = json.loads(z.read("project.json"))
        res["C1_sauvegarde"] = {"accords_dans_project_json": len(saved.get("chords") or []), "premier": (saved.get("chords") or [None])[0]}
    except Exception as e:  # noqa
        res["C1_sauvegarde"] = f"échec : {e}"
    ctx.close(); b.close()

    # C2 : le vrai beat (instru d'origine), comparé à la note de la vraie basse.
    ctx, page = new_page(launch(p), "pc", log)
    advanced(page); prepare(page)
    t0, dur = downbeat(BEAT_K), BEAT_BARS * BAR
    instru = stereo_pt("Silence blanc (Instrumental)", t0, dur)
    iw = wav_bytes(instru)
    proj = MAT / "C2_projet_vrai_beat.zip"
    make_project(proj, "Vrai beat", [("instrumental", "Silence blanc (instru)", iw, dur, 0)])
    open_project_file(page, proj, res, "C6_projet_vrai_beat")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    t_d = time.time()
    found = detect_in_lane(page)
    res["C2_detection_s"] = round(time.time() - t_d, 2)
    shot(page, "C7_vrai_beat_accords")
    # Basse réelle (stem) : note par temps (YIN), comparée à l'accord trouvé.
    bass = mono(stem("bass", t0, dur))
    beat = 60 / BPM
    same_root = in_chord = counted = 0
    tones = {"maj": [0, 4, 7], "min": [0, 3, 7], "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11], "min7": [0, 3, 7, 10], "sus2": [0, 2, 7], "sus4": [0, 5, 7], "dim": [0, 3, 6]}
    per_beat = []
    for kb in range(int(dur / beat)):
        a = kb * beat
        f = next((c for c in found if c[0] <= a + beat / 2 < c[1]), None)
        m = bass_pitch(bass, SR, a + 0.03, a + beat - 0.03)
        if np.isnan(m) or f is None:
            continue
        pc = int(round(m)) % 12
        counted += 1
        same_root += pc == f[2]
        in_chord += pc in {(f[2] + x) % 12 for x in tones[f[3]]}
        per_beat.append((kb, NAMES[pc], sym(f[2], f[3])))
    res["C2_vrai_beat"] = {"extrait": f"Silence blanc (Instrumental), {round(t0, 2)} à {round(t0 + dur, 2)} s, {BPM} BPM",
                           "accords_trouves": " ".join(f"{sym(c[2], c[3])}({round((c[1] - c[0]) / beat)}t)" for c in found),
                           "temps_avec_basse_mesuree": counted,
                           "basse_sur_la_fondamentale": f"{same_root}/{counted} = {round(100 * same_root / max(1, counted))} %",
                           "basse_dans_l_accord": f"{in_chord}/{counted} = {round(100 * in_chord / max(1, counted))} %",
                           "exemples_temps_basse_accord": per_beat[:16]}
    res["erreurs_page"] = [e["text"][:200] for e in log.errors()]
    save_log(log, {"result": res})
    RESULTS["C_accords"] = res
    ctx.close()


# ------------------------------------------------------------ D. tablette
def scenario_d(p):
    log = Log("D_tablette")
    res = {}
    v, i, dur, t0 = voice_material()
    proj = MAT / "D_projet_tablette.zip"
    make_project(proj, "Tablette", [("instrumental", "Silence blanc (instru)", wav_bytes(i), dur, 0), ("voix", "Silence blanc (voix)", wav_bytes(v), dur, 0)], key=(7, "MINOR"),
                 chords=[{"id": f"c{k}", "start": k * BAR, "end": (k + 1) * BAR, "root": 7 if k % 2 == 0 else 0, "quality": "min"} for k in range(4)])
    b = launch(p)
    ctx, page = new_page(b, "tab", log)
    prepare(page)  # mode simple (par défaut sur le web) : couloir masqué
    open_project_file(page, proj, res, "D0_projet_tablette")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    res["couloir_visible_mode_simple"] = page.get_by_test_id("chord-lane").count() > 0
    page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(500)
    shot(page, "D1_menu_affichage")
    page.get_by_test_id("menu-chord-lane").click(); page.wait_for_timeout(600)
    res["couloir_visible_apres_menu"] = page.get_by_test_id("chord-lane").count() > 0
    shot(page, "D2_couloir_accords_tablette")
    clip_menu(page, 1, 3.0, touch=True)
    shot(page, "D3_appui_long_menu_clip")
    page.get_by_text("Mélodie → MIDI (808, piano…)…", exact=True).first.tap()
    wait_dialog_ready(page)
    shot(page, "D4_fredonne_tablette")
    page.get_by_test_id("a2m-create").tap(); page.wait_for_timeout(800)
    res["piste_creee"] = st(page, "s => { const t = s.tracks.find(x => x.id.startsWith('track-hum-')); return t ? { name: t.name, notes: t.clips[0].notes.length } : null; }")
    shot(page, "D5_piste_creee_tablette")
    res["debordements"] = overflow_report(page)[:10]
    res["erreurs_page"] = [e["text"][:200] for e in log.errors()]
    save_log(log, {"result": res})
    RESULTS["D_tablette"] = res
    ctx.close(); b.close()


# ------------------------------------------------------------ E. téléphone (micro simulé = vraie voix)
def scenario_e(p):
    log = Log("E_telephone")
    res = {}
    v, i, dur, t0 = voice_material()
    # Micro simulé de Chrome : 1 mesure de silence (décompte) puis la vraie voix, en boucle.
    pad = np.zeros((2, int(BAR * SR) + int(0.15 * SR)), np.float32)
    mic_wav = MAT / "E_micro_voix.wav"
    mic_wav.write_bytes(wav_bytes(np.concatenate([pad, v, np.zeros((2, SR), np.float32)], axis=1)))
    proj = MAT / "E_projet_tel.zip"
    make_project(proj, "Téléphone", [("instrumental", "Silence blanc (instru)", wav_bytes(i), dur, 0)], key=(7, "MINOR"))
    b = p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={mic_wav}%noloop",
        "--autoplay-policy=no-user-gesture-required"])
    ctx, page = new_page(b, "tel", log)
    prepare(page)
    open_project_file(page, proj, res, "E0_projet_tel")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    page.locator("[data-nova-target=mix-auto]").first.tap(); page.wait_for_timeout(600)
    page.get_by_test_id("hum-quick").scroll_into_view_if_needed()
    shot(page, "E1_panneau_voix_fredonne")
    page.locator("[data-hum='808']").first.tap()
    page.wait_for_selector("[data-testid=audio-to-midi]")
    page.wait_for_timeout(400)
    shot(page, "E2_fredonne_simple_micro")
    page.get_by_test_id("hum-record").tap()
    page.wait_for_function("() => /Je t’écoute/.test(document.querySelector('[data-testid=audio-to-midi]').innerText)", timeout=15000)
    shot(page, "E3_enregistrement")
    page.wait_for_timeout(int(dur * 1000) + 300)
    page.get_by_test_id("hum-stop").tap()
    wait_dialog_ready(page)
    shot(page, "E4_notes_808_telephone")
    try:
        res["resume"] = page.get_by_test_id("hum-summary").inner_text()
    except Exception:  # noqa
        res["resume"] = page.locator("[data-testid=audio-to-midi]").inner_text()[:300]
    page.get_by_test_id("a2m-create").tap(); page.wait_for_timeout(800)
    res["piste_creee"] = st(page, "s => { const t = s.tracks.find(x => x.id.startsWith('track-hum-')); return t ? { name: t.name, bass808: !!t.bass808, notes: t.clips[0].notes.length, debut: t.clips[0].start, hauteurs: [...new Set(t.clips[0].notes.map(n => n.pitch))].sort((a, b) => a - b) } : null; }")
    shot(page, "E5_piste_creee_tel")
    res["debordements"] = overflow_report(page)[:10]
    res["erreurs_page"] = [e["text"][:200] for e in log.errors()]
    save_log(log, {"result": res})
    RESULTS["E_telephone"] = res
    ctx.close(); b.close()


def main():
    want = set(a.upper() for a in sys.argv[1:]) or {"A", "B", "C", "D", "E"}
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        for k, fn in (("A", scenario_a), ("B", scenario_b), ("C", scenario_c), ("D", scenario_d), ("E", scenario_e)):
            if k not in want:
                continue
            t = time.time()
            try:
                fn(p)
            except Exception as e:  # noqa
                RESULTS[f"{k}_ECHEC"] = f"{type(e).__name__}: {str(e)[:500]}"
                print(f"[{k}] ÉCHEC", e)
            print(f"[{k}] {round(time.time() - t, 1)} s")
    prev = {}
    mf = OUT / "mesures.json"
    if mf.exists():
        try: prev = json.loads(mf.read_text(encoding="utf-8"))
        except Exception: prev = {}
    prev.update(RESULTS)
    mf.write_text(json.dumps(prev, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(RESULTS, ensure_ascii=False, indent=1)[:6000])


if __name__ == "__main__":
    main()
