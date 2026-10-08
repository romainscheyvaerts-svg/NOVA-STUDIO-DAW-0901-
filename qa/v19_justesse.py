"""V19 · Justesse note par note : preuves dans un navigateur headless (aucune fenêtre).

Usage (serveur NOVA lancé : npx vite --port 3425 --strictPort) :
  NOVA_URL=http://localhost:3425/ python qa/v19_justesse.py

  A. PC : voix synthétique fausse de 40 cents (la mineur), « Corriger tout dans la
     gamme » 100 % Naturel, Appliquer. Mesures sur l'EXPORT réel (fichier WAV) et
     sur la LECTURE (son capturé à la sortie du moteur) : justesse (cents), durée,
     formants (enveloppe spectrale), clics (énergie au-dessus de 6 kHz).
     Puis Ctrl+Z / Ctrl+Y, « Revenir à la prise d'origine », sauvegarde → réouverture.
  B. Tablette (doigt) : on touche une note, ▲ quatre fois (+4 demi-tons) : formants
     gardés, comparés à un simple changement de vitesse (effet « chipmunk »).
  C. Téléphone : version simple (dosage), bouton JUSTE de la barre du clip.
  D. Vraie voix : extrait de « Silence blanc (Vocals) », corrigé à 100 % Naturel.

Mesures de hauteur faites ICI, en Python (détecteur indépendant de celui de NOVA).
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v19")
os.environ.setdefault("NOVA_URL", "http://localhost:3425/")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file, export_wav, save_zip  # noqa

SR = 44100
RESULTS = {}
REAL_SRC = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
REAL_EXTRACT = (61.0, 9.0)  # début, durée (s) dans le morceau

# ------------------------------------------------------------ voix synthétique
VOWEL_A = [(730, 90, 1.0), (1090, 110, 0.5), (2440, 170, 0.25)]


def envelope(f):
    a = np.zeros_like(f)
    for F, B, g in VOWEL_A:
        a += g / np.sqrt(1 + ((f - F) / B) ** 2)
    return a / (1 + f / 4000)


# La mineur, chaque note 40 cents à côté (alternativement trop haut / trop bas).
MELODY = [  # (midi juste, écart en cents, début, durée, glissade depuis la note d'avant, vibrato cents)
    (57, +40, 0.50, 0.55, 0, 10), (60, -40, 1.05, 0.45, 0.05, 0), (62, +40, 1.50, 0.50, 0.06, 12),
    (64, -40, 2.20, 0.60, 0, 15), (62, +40, 2.80, 0.40, 0.05, 0), (60, -40, 3.30, 0.45, 0, 10),
    (59, -40, 3.75, 0.45, 0.05, 0), (57, +40, 4.40, 0.80, 0, 18),
]
SYN_DUR = 5.6


def synth_voice():
    t = np.arange(int(SYN_DUR * SR)) / SR
    midi = np.full_like(t, np.nan)
    amp = np.zeros_like(t)
    for k, (m, c, at, ln, gl, vib) in enumerate(MELODY):
        sel = (t >= at) & (t < at + ln)
        u = t[sel] - at
        v = m + c / 100 + (vib / 100) * np.sin(2 * np.pi * 5.5 * u)
        prev = MELODY[k - 1] if k else None
        tied_in = prev is not None and abs(prev[2] + prev[3] - at) < 1e-9
        nxt = MELODY[k + 1] if k + 1 < len(MELODY) else None
        tied_out = nxt is not None and abs(at + ln - nxt[2]) < 1e-9
        if gl and tied_in:
            g = np.clip(u / gl, 0, 1)
            g = 0.5 - 0.5 * np.cos(np.pi * g)
            pm = prev[0] + prev[1] / 100
            v = pm + (v - pm) * g
        midi[sel] = v
        env = np.ones_like(u)
        if not tied_in: env = np.minimum(env, u / 0.012)
        if not tied_out: env = np.minimum(env, (ln - u) / 0.025)
        amp[sel] = np.clip(env, 0, 1)
    f0 = np.where(np.isnan(midi), 0, 440 * 2 ** ((np.nan_to_num(midi, nan=69) - 69) / 12))
    phase = np.cumsum(f0) / SR
    x = np.zeros_like(t)
    for h in range(1, 60):
        fh = h * f0
        a = np.where((fh > 0) & (fh < 5000), envelope(fh), 0)
        x += a * np.sin(2 * np.pi * h * phase)
    x = 0.25 * amp * x / 2
    return x.astype(np.float32), midi


def wav_bytes(x, sr=SR, ch=1):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr)
        data = x if ch == 1 else np.stack(x, axis=1).reshape(-1)
        w.writeframes((np.clip(data, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def read_wav(p):
    with wave.open(str(p)) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        v = np.frombuffer(raw, "<i2").astype(np.float32) / 32768
    elif sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float32) / (1 << 23)
    else:
        v = np.frombuffer(raw, "<f4").astype(np.float32)
    return v.reshape(-1, ch).T, sr


STATE_BASE = {
    "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
    "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
    "trackGroups": [], "markers": [], "selectedTrackId": None, "currentView": "ARRANGEMENT",
    "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
    "recStartTime": None, "isDelayCompEnabled": True,
    "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
    "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
}


def make_project(path: Path, wav: bytes, dur: float, name: str, key=(9, "MINOR"), clip_start=1.0):
    clip = {"id": "voix-1", "name": "Prise 1", "start": clip_start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}
    tracks = [{**base, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": [clip], "plugins": []}]
    state = {**STATE_BASE, "id": f"proj-{name}", "name": name, "tracks": tracks}
    if key:
        state["projectKey"], state["projectScale"] = key
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", wav)


# ------------------------------------------------------------ mesures (Python, indépendantes de NOVA)
def yin_f0(x, sr, fmin=70, fmax=900, frame=2048):
    """Hauteur (Hz) d'une tranche par YIN (différence normalisée cumulée + interpolation)."""
    x = x[:frame].astype(np.float64)
    W = frame // 2
    tmax = int(sr / fmin)
    tmin = int(sr / fmax)
    d = np.array([np.sum((x[:W] - x[t:t + W]) ** 2) for t in range(tmax + 2)])
    cm = np.ones_like(d)
    cs = np.cumsum(d[1:])
    cm[1:] = d[1:] * np.arange(1, len(d)) / np.maximum(cs, 1e-12)
    cand = np.where(cm[tmin:tmax] < 0.15)[0]
    if len(cand):
        t = cand[0] + tmin
        while t + 1 < len(cm) - 1 and cm[t + 1] < cm[t]: t += 1
    else:
        t = int(np.argmin(cm[tmin:tmax])) + tmin
        if cm[t] > 0.3: return None
    a, b, c = d[t - 1], d[t], d[t + 1]
    den = a + c - 2 * b
    sh = (a - c) / (2 * den) if abs(den) > 1e-18 else 0
    return sr / (t + sh)


def note_pitch(x, sr, t0, t1, hop=0.01):
    """Hauteur perçue (MIDI) entre t0 et t1 : moyenne des trames à moins de 3/4 de
    demi-ton de la médiane (la médiane seule est biaisée par un vibrato)."""
    v = []
    t = t0
    while t + 2048 / sr <= t1:
        f = yin_f0(x[int(t * sr):int(t * sr) + 2048], sr)
        if f: v.append(69 + 12 * np.log2(f / 440))
        t += hop
    if not v:
        return float("nan")
    v = np.array(v)
    med = np.median(v)
    k = v[np.abs(v - med) <= 0.75]
    return float(k.mean()) if len(k) else float(med)


def harmonic_envelope(x, sr, t0, t1, f0, N=8192):
    """Enveloppe spectrale (dB) relevée sur les harmoniques, interpolée de 300 à 4000 Hz."""
    a, b = int(t0 * sr), int(t1 * sr)
    seg = x[a:b]
    if len(seg) < N:
        seg = np.pad(seg, (0, N - len(seg)))
    win = np.hanning(N)
    spec = np.zeros(N // 2 + 1)
    cnt = 0
    for s in range(0, len(seg) - N + 1, N // 4):
        spec += np.abs(np.fft.rfft(seg[s:s + N] * win)); cnt += 1
    spec /= max(1, cnt)
    fr = np.fft.rfftfreq(N, 1 / sr)
    pts_f, pts_a = [], []
    h = 1
    while h * f0 < 4600:
        k = int(round(h * f0 * N / sr))
        lo, hi = max(0, k - 4), min(len(spec), k + 5)
        pts_f.append(h * f0); pts_a.append(20 * np.log10(spec[lo:hi].max() + 1e-12)); h += 1
    grid = np.arange(300, 4001, 25)
    return grid, np.interp(grid, pts_f, pts_a)


def true_env_error(x, sr, t0, t1, f0, N=8192):
    """Écart moyen (dB) entre les harmoniques mesurées et la VRAIE enveloppe de la
    voyelle (connue pour la voix synthétique), après normalisation du niveau ;
    et F1 estimé (barycentre des harmoniques entre 300 et 1300 Hz)."""
    a, b = int(t0 * sr), int(t1 * sr)
    seg = x[a:b]
    win = np.hanning(N)
    spec = np.zeros(N // 2 + 1)
    cnt = 0
    for s0 in range(0, max(1, len(seg) - N + 1), N // 4):
        part = seg[s0:s0 + N]
        if len(part) < N:
            part = np.pad(part, (0, N - len(part)))
        spec += np.abs(np.fft.rfft(part * win))
        cnt += 1
    spec /= cnt
    fs, meas = [], []
    h = 1
    while h * f0 < 4000:
        k = int(round(h * f0 * N / sr))
        meas.append(20 * np.log10(spec[max(0, k - 4):k + 5].max() + 1e-12))
        fs.append(h * f0)
        h += 1
    fs = np.array(fs)
    meas = np.array(meas)
    ref = 20 * np.log10(envelope(fs))
    off = np.median(meas - ref)
    err = float(np.mean(np.abs(meas - ref - off)))
    m = (fs >= 300) & (fs <= 1300)
    pw = 10 ** (meas[m] / 10)
    f1 = float(np.sum(fs[m] * pw) / np.sum(pw))
    return round(err, 2), int(round(f1))


def formant_peaks(grid, env):
    f1 = grid[(grid >= 450) & (grid <= 900)][np.argmax(env[(grid >= 450) & (grid <= 900)])]
    f2 = grid[(grid >= 1000) & (grid <= 1500)][np.argmax(env[(grid >= 1000) & (grid <= 1500)])]
    return int(f1), int(f2)


def hf_artifacts(x, sr, ranges):
    """Énergie au-dessus de 6 kHz (dB sous la voix), par blocs de 5 ms : pire bloc."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / sr)
    hp = np.fft.irfft(np.where(f > 6000, X, 0), n=len(x))
    blk = int(0.005 * sr)
    worst = -200.0
    voice_rms = np.sqrt(np.mean(x[np.abs(x) > 1e-4] ** 2)) if np.any(np.abs(x) > 1e-4) else 1e-9
    for a, b in ranges:
        for s in range(int(a * sr), int(b * sr) - blk, blk):
            r = np.sqrt(np.mean(hp[s:s + blk] ** 2))
            worst = max(worst, 20 * np.log10(r / voice_rms + 1e-12))
    return round(float(worst), 1)


def max_jump_ratio(y, x):
    """Plus grand saut d'un échantillon au suivant (sortie / entrée) : un clic le ferait bondir."""
    jy = np.max(np.abs(np.diff(y))); jx = np.max(np.abs(np.diff(x)))
    return round(float(jy / max(jx, 1e-9)), 3)


# ------------------------------------------------------------ outils page
def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def clip_info(page):
    return st(page, "s => { const c = s.tracks.find(t => t.id === 'voix').clips[0]; return { id: c.id, name: c.name, bufferId: c.bufferId, offset: c.offset, start: c.start, duration: c.duration, pitchEdit: c.pitchEdit ? { source: c.pitchEdit.sourceBufferId, regionStart: c.pitchEdit.regionStart, edits: c.pitchEdit.edits.length, amount: c.pitchEdit.amount, style: c.pitchEdit.style } : null }; }")


def buffer_of(page, bid):
    """Canal 0 d'un son du registre (Float32 → liste)."""
    return np.array(page.evaluate("""async (bid) => {
      const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
      const b = audioBufferRegistry.get(bid); if (!b) return null;
      return { sr: b.sampleRate, x: Array.from(b.getChannelData(0)) };
    }""", bid)["x"], dtype=np.float32)


def canvas_box(page):
    return page.evaluate("""() => { const c = document.querySelectorAll('.nova-grille canvas')[1]; const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


def open_clip_menu(page, t=2.0):
    """Clic droit sur le clip de voix (arrangement : piste 1, 40 px par seconde à 120 BPM)."""
    page.mouse.click(800, 600); page.wait_for_timeout(200)
    box = canvas_box(page)
    page.mouse.click(box["x"] + t * 40 - box["sl"], box["y"] + box.get("tt", 40) + 60 - box["st"], button="right")
    page.wait_for_timeout(400)


def open_editor_desktop(page, label):
    open_clip_menu(page)
    shot(page, f"{label}_menu_clip")
    page.get_by_text("Justesse note par note…", exact=True).first.click()
    page.wait_for_selector("[data-testid=pitch-editor]", timeout=8000)
    page.wait_for_function("() => !document.querySelector('[data-testid=pitch-status]')", timeout=30000)
    page.wait_for_timeout(400)


def set_range(page, testid, value):
    page.evaluate("""([id, v]) => {
      const el = document.querySelector(`[data-testid=${id}]`);
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }""", [testid, value])
    page.wait_for_timeout(300)


CAPTURE_JS = """
async (seconds) => {
  const { audioEngine: e } = await import('/engine/AudioEngine.ts');
  await e.resume();
  const ctx = e.ctx;
  const sp = ctx.createScriptProcessor(4096, 2, 2);
  const chunks = [];
  sp.onaudioprocess = ev => { chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
  const mute = ctx.createGain(); mute.gain.value = 0;
  e.masterOutput.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
  window.__capture = { stop: () => { try { e.masterOutput.disconnect(sp); } catch (x) {} sp.disconnect(); const n = chunks.reduce((a, c) => a + c.length, 0); const out = new Float32Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return { sr: ctx.sampleRate, x: Array.from(out) }; } };
  return ctx.sampleRate;
}
"""


def live_capture(page, seconds):
    """Lecture réelle (barre d'espace) capturée à la sortie du moteur."""
    page.evaluate(CAPTURE_JS, seconds)
    page.evaluate("() => window.__novaEdit && document.body.focus()")
    page.keyboard.press("Home"); page.wait_for_timeout(200)
    page.keyboard.press("Space")
    page.wait_for_timeout(int(seconds * 1000))
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    r = page.evaluate("() => window.__capture.stop()")
    return np.array(r["x"], dtype=np.float32), r["sr"]


def align(ref, y):
    """Décalage (échantillons) de y par rapport à ref (corrélation croisée sur l'enveloppe)."""
    n = 1 << int(np.ceil(np.log2(len(ref) + len(y))))
    c = np.fft.irfft(np.fft.rfft(y, n) * np.conj(np.fft.rfft(ref, n)), n)
    lag = int(np.argmax(c))
    return lag if lag < n // 2 else lag - n


# ------------------------------------------------------------ A. PC
def scenario_pc(p):
    log = Log("A_pc")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique_40ct.zip"
    make_project(proj, wav_bytes(x), SYN_DUR, "Justesse synthétique")
    (OUT / "A_voix_avant.wav").write_bytes(wav_bytes(x))
    b = launch(p)
    _, page = new_page(b, "pc", log)
    prepare(page)
    open_project_file(page, proj, RESULTS, "A0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    before = clip_info(page)
    open_editor_desktop(page, "A1")
    shot(page, "A2_editeur_pc_analyse")
    notes = page.evaluate("() => document.querySelector('[data-testid=pitch-selection]').innerText")
    set_range(page, "pitch-amount", 100)
    shot(page, "A3_corriger_tout_100_naturel")
    # Sélection d'une note au clic pour la capture « note sélectionnée ».
    cv = page.locator("[data-testid=pitch-grid] canvas").first
    box = cv.bounding_box()
    t0 = time.time()
    page.get_by_test_id("pitch-apply").click()
    page.wait_for_selector("[data-testid=pitch-editor]", state="detached", timeout=60000)
    apply_s = time.time() - t0
    page.wait_for_timeout(600)
    after = clip_info(page)
    shot(page, "A4_clip_corrige_dans_arrangement")
    corrected = buffer_of(page, after["bufferId"])
    src = buffer_of(page, before["bufferId"])

    # Export réel (fichier WAV), comme l'artiste.
    exp_path = OUT / "A_export_corrige.wav"
    export_ok = True
    try:
        export_wav(page, exp_path, "A5")
        ex, esr = read_wav(exp_path)
        ex = ex[0]
    except Exception as e:  # noqa
        export_ok = False
        log.add("export", f"export UI impossible : {e}")
        r = page.evaluate("""async () => { const { audioEngine } = await import('/engine/AudioEngine.ts');
          const s = window.__novaEdit.getState(); const b = await audioEngine.renderProject(s.tracks, 7.0, 0, 44100);
          return { sr: b.sampleRate, x: Array.from(b.getChannelData(0)) }; }""")
        ex, esr = np.array(r["x"], dtype=np.float32), r["sr"]
        (OUT / "A_export_corrige.wav").write_bytes(wav_bytes(ex, esr))

    # Lecture réelle capturée.
    live, lsr = live_capture(page, SYN_DUR + 1.6)
    (OUT / "A_lecture_capturee.wav").write_bytes(wav_bytes(np.clip(live, -1, 1), lsr))

    # Mesures
    clip_start = 1.0
    res = {"notes_trouvees": notes, "apply_s": round(apply_s, 2), "avant": before, "apres": after, "export_ui": export_ok}
    per_note = []
    for (m, c, at, ln, gl, vib) in MELODY:
        a, z = at + 0.12, at + ln - 0.1
        pin = note_pitch(x, SR, a, z)
        pex = note_pitch(ex, esr, clip_start + a, clip_start + z)
        lag_l = None
        per_note.append({"note": m, "avant_ct": round((pin - m) * 100, 1), "export_ct": round((pex - m) * 100, 2)})
    # Lecture : aligne la capture sur l'export.
    lag_l = align(ex[: len(live)] if len(ex) >= len(live) else np.pad(ex, (0, len(live) - len(ex))), live)
    live_al = live[lag_l:] if lag_l >= 0 else np.pad(live, (-lag_l, 0))
    for k, (m, c, at, ln, gl, vib) in enumerate(MELODY):
        a, z = at + 0.12, at + ln - 0.1
        per_note[k]["lecture_ct"] = round((note_pitch(live_al, lsr, clip_start + a, clip_start + z) - m) * 100, 2)
    res["par_note"] = per_note
    res["max_ecart_export_ct"] = max(abs(n["export_ct"]) for n in per_note)
    res["max_ecart_lecture_ct"] = max(abs(n["lecture_ct"]) for n in per_note)
    res["max_ecart_avant_ct"] = max(abs(n["avant_ct"]) for n in per_note)
    # Lecture = export : même son, échantillon par échantillon (après alignement).
    # Par tranches de 0,1 s, chacune recalée (la capture temps réel du navigateur
    # sans écran peut perdre un bloc de 4096 échantillons) : écart lecture - export,
    # en dB sous le signal. Identique = sous -90 dB.
    wins = []
    for (m, c, at, ln, gl, vib) in MELODY:
        t = at + 0.02
        while t + 0.1 <= at + ln - 0.02:
            a0, a1 = int((clip_start + t) * esr), int((clip_start + t + 0.1) * esr)
            ref = ex[a0:a1]
            lo, hi = a0 + lag_l - 6000, a1 + lag_l + 6000
            t += 0.1
            if lo < 0 or hi > len(live):
                continue
            part = live[lo:hi]
            cc = np.correlate(part, ref, "valid")
            k = int(np.argmax(cc))
            err = part[k:k + len(ref)] - ref
            wins.append(float(20 * np.log10(np.sqrt(np.mean(err ** 2)) / (np.sqrt(np.mean(ref ** 2)) + 1e-12) + 1e-12)))
    ident = [w for w in wins if w < -90]
    res["lecture_vs_export"] = {"tranches": len(wins), "identiques_sous_moins_90_db": len(ident),
                                "ecart_median_db": round(float(np.median(wins)), 1) if wins else None,
                                "pire_db": round(max(wins), 1) if wins else None}
    # Durée : clip inchangé, son corrigé = région analysée, attaques au même endroit.
    res["duree"] = {"clip_avant_s": before["duration"], "clip_apres_s": after["duration"], "son_origine_s": round(len(src) / SR, 4),
                    "son_corrige_s": round(len(corrected) / SR, 4), "region_debut_s": after["pitchEdit"]["regionStart"] if after["pitchEdit"] else None,
                    "export_s": round(len(ex) / esr, 3)}
    # Attaques : début et fin de chaque note (niveau), avant / après.
    def onsets(sig, sr, off):
        env = np.sqrt(np.convolve(sig ** 2, np.ones(int(0.005 * sr)) / int(0.005 * sr), "same"))
        out = []
        for (m, c, at, ln, gl, vib) in MELODY:
            a = int((off + at - 0.05) * sr); z = int((off + at + 0.08) * sr)
            th = 0.5 * env[int((off + at + 0.15) * sr)]
            i = np.argmax(env[a:z] > th)
            out.append((a + i) / sr - off)
        return out
    on_a, on_b = onsets(x, SR, 0), onsets(ex, esr, clip_start)
    res["duree"]["ecart_attaques_ms_max"] = round(max(abs(p - q) for p, q in zip(on_a, on_b)) * 1000, 2)
    # Formants : enveloppe spectrale de chaque note, avant / après.
    envs = []
    for (m, c, at, ln, gl, vib) in MELODY:
        fa = 440 * 2 ** ((m + c / 100 - 69) / 12); fb = 440 * 2 ** ((m - 69) / 12)
        g, ea = harmonic_envelope(x, SR, at + 0.08, at + ln - 0.05, fa)
        _, eb = harmonic_envelope(ex, esr, clip_start + at + 0.08, clip_start + at + ln - 0.05, fb)
        ea -= ea.max(); eb -= eb.max()
        ea_err, ea_f1 = true_env_error(x, SR, at + 0.08, at + ln - 0.05, fa)
        eb_err, eb_f1 = true_env_error(ex, esr, clip_start + at + 0.08, clip_start + at + ln - 0.05, fb)
        envs.append({"note": m, "ecart_vraie_enveloppe_avant_db": ea_err, "ecart_vraie_enveloppe_apres_db": eb_err, "F1_avant_Hz": ea_f1, "F1_apres_Hz": eb_f1})
    res["formants"] = envs
    # Clics : énergie au-dessus de 6 kHz (la voix synthétique n'a rien au-dessus de 5 kHz).
    voiced = [(clip_start + at - 0.02, clip_start + at + ln + 0.02) for (m, c, at, ln, gl, vib) in MELODY]
    res["clics"] = {"hf_avant_db": hf_artifacts(np.pad(x, (int(clip_start * SR), 0)), SR, voiced), "hf_export_db": hf_artifacts(ex, esr, voiced),
                    "saut_max_sortie_sur_entree": max_jump_ratio(ex[int(clip_start * esr):], x)}

    # Annuler / rétablir, revenir à l'original.
    page.keyboard.press("Escape")
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    undo = clip_info(page)
    page.keyboard.press("Control+y"); page.wait_for_timeout(600)
    redo = clip_info(page)
    res["annuler"] = {"ctrl_z_retour_original": undo["bufferId"] == before["bufferId"] and undo["pitchEdit"] is None,
                      "ctrl_y_version_corrigee": redo["bufferId"] == after["bufferId"] and redo["pitchEdit"] is not None}
    # Rouvrir l'éditeur : les réglages reviennent, retour à la prise d'origine possible.
    open_editor_desktop(page, "A6")
    res["reouverture_dosage"] = page.get_by_test_id("pitch-amount").input_value()
    shot(page, "A7_reouverture_revenir_original")
    page.get_by_test_id("pitch-revert").click(); page.wait_for_timeout(600)
    rev = clip_info(page)
    res["revenir_original"] = rev["bufferId"] == before["bufferId"] and rev["pitchEdit"] is None
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    # Sauvegarde puis réouverture : la prise d'origine est dans le fichier.
    pj, names = save_zip(page, OUT / "A_projet_corrige.zip")
    c = pj["tracks"][0]["clips"][0]
    res["sauvegarde"] = {"fichiers": names, "pitchEdit_sourceRef": (c.get("pitchEdit") or {}).get("sourceRef"), "audioRef": c.get("audioRef")}
    _, page2 = new_page(b, "pc", log)
    prepare(page2)
    open_project_file(page2, OUT / "A_projet_corrige.zip", RESULTS, "A8_reouvert")
    page2.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    ci = clip_info(page2)
    has_src = page2.evaluate("async (id) => (await import('/utils/audioBufferRegistry.ts')).audioBufferRegistry.has(id)", ci["pitchEdit"]["source"] if ci["pitchEdit"] else "")
    res["reouvert"] = {"clip": ci, "prise_origine_chargee": has_src}
    RESULTS["A_pc"] = res
    save_log(log, {"errors": log.errors()})
    b.close()


def geom(page):
    return json.loads(page.locator("[data-testid=pitch-grid] canvas").first.get_attribute("data-geom"))


def tap_note(page, i):
    """Touche (doigt) le bloc de la note i dans la grille."""
    g = next(n for n in geom(page) if n["i"] == i)
    cv = page.locator("[data-testid=pitch-grid] canvas").first.bounding_box()
    page.touchscreen.tap(cv["x"] + (g["x0"] + g["x1"]) / 2, cv["y"] + g["y"])
    page.wait_for_timeout(250)


def tap(page, loc, left=False):
    bb = loc.bounding_box()
    page.touchscreen.tap(bb["x"] + (min(40, bb["width"] / 2) if left else bb["width"] / 2), bb["y"] + bb["height"] / 2)
    page.wait_for_timeout(250)


def long_press(page, x, y, ms=800):
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    page.wait_for_timeout(ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(300)


def wait_editor(page):
    page.wait_for_selector("[data-testid=pitch-editor]", timeout=8000)
    page.wait_for_function("() => !document.querySelector('[data-testid=pitch-status]')", timeout=60000)
    page.wait_for_timeout(300)


# ------------------------------------------------------------ B. Tablette (doigt)
def scenario_tablet(p):
    log = Log("B_tablette")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique_40ct.zip"
    b = launch(p)
    _, page = new_page(b, "tab", log)
    prepare(page)
    open_project_file(page, proj, RESULTS, "B0_projet_tablette")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    box = canvas_box(page)
    long_press(page, box["x"] + 2.0 * 40 - box["sl"], box["y"] + box.get("tt", 40) + 60 - box["st"])
    shot(page, "B1_appui_long_menu_clip")
    tap(page, page.get_by_text("Justesse note par note…", exact=True).first)
    wait_editor(page)
    shot(page, "B2_editeur_tablette")
    res = {"mode": page.get_attribute("[data-testid=pitch-editor]", "data-mode")}
    # Note 3 (Ré3 + 40 ct) : touchée au doigt puis ▲ quatre fois.
    tap_note(page, 2)
    res["selection"] = page.get_by_test_id("pitch-selection").inner_text().split("\n")[0]
    for _ in range(4):
        tap(page, page.get_by_test_id("pitch-up"))
    shot(page, "B3_note_montee_au_doigt")
    target = next(n for n in geom(page) if n["i"] == 2)["c"]
    # Glisser au doigt la 1re note vers le bas (environ un demi-ton et demi).
    g0 = next(n for n in geom(page) if n["i"] == 0)
    cv = page.locator("[data-testid=pitch-grid] canvas").first.bounding_box()
    nrows = page.evaluate("() => document.querySelectorAll('[data-testid=pitch-grid] canvas').length")
    cdp = page.context.new_cdp_session(page)
    x0, y0 = cv["x"] + (g0["x0"] + g0["x1"]) / 2, cv["y"] + g0["y"]
    g2 = next(n for n in geom(page) if n["i"] == 2)
    row = abs(g2["y"] - next(n for n in geom(page) if n["i"] == 2)["y"]) or 0
    # Hauteur d'une ligne : écart vertical entre deux notes de hauteur connue.
    gl = geom(page)
    rh = abs(gl[1]["y"] - gl[0]["y"]) / max(1e-6, abs(gl[1]["c"] - gl[0]["c"]))
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for k in range(1, 9):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0, "y": y0 + k * rh * 1.4 / 8}]})
        page.wait_for_timeout(30)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(300)
    shot(page, "B4_note_glissee_au_doigt")
    g0b = next(n for n in geom(page) if n["i"] == 0)
    res["note3_visee_midi"] = target
    res["note1_glissee_midi"] = {"avant": g0["c"], "apres": g0b["c"]}
    tap(page, page.get_by_test_id("pitch-apply"))
    page.wait_for_selector("[data-testid=pitch-editor]", state="detached", timeout=60000)
    page.wait_for_timeout(400)
    after = clip_info(page)
    y = buffer_of(page, after["bufferId"])
    m, c, at, ln, gl_, vib = MELODY[2]
    pin = note_pitch(x, SR, at + 0.12, at + ln - 0.1)
    pout = note_pitch(y, SR, at + 0.12, at + ln - 0.1)
    res["note3"] = {"avant_midi": round(pin, 3), "apres_midi": round(pout, 3), "ecart_a_la_cible_ct": round((pout - target) * 100, 2)}
    m1 = MELODY[0]
    res["note1_mesuree_midi"] = round(note_pitch(y, SR, m1[2] + 0.12, m1[2] + m1[3] - 0.1), 3)
    m5 = MELODY[5]
    res["note6_non_touchee_ecart_ct"] = round((note_pitch(y, SR, m5[2] + 0.12, m5[2] + m5[3] - 0.1) - note_pitch(x, SR, m5[2] + 0.12, m5[2] + m5[3] - 0.1)) * 100, 2)
    a, z = int(4.45 * SR), int(5.15 * SR)
    res["derniere_note_non_touchee_identique"] = bool(np.max(np.abs(y[a:z] - x[a:z])) < 1e-4)
    # Formants : justesse (PSOLA) contre simple changement de vitesse (« chipmunk »).
    ratio = 2 ** ((pout - pin) / 12)
    seg = x[int(at * SR): int((at + ln) * SR)]
    idx = np.arange(0, len(seg) - 1, ratio)
    chip = np.interp(idx, np.arange(len(seg)), seg).astype(np.float32)
    f_in, f_out = 440 * 2 ** ((pin - 69) / 12), 440 * 2 ** ((pout - 69) / 12)
    g, e_in = harmonic_envelope(x, SR, at + 0.08, at + ln - 0.05, f_in)
    _, e_out = harmonic_envelope(y, SR, at + 0.08, at + ln - 0.05, f_out)
    o_err, o_f1 = true_env_error(x, SR, at + 0.08, at + ln - 0.05, f_in)
    j_err, j_f1 = true_env_error(y, SR, at + 0.08, at + ln - 0.05, f_out)
    c_err, c_f1 = true_env_error(chip, SR, 0.05, len(chip) / SR - 0.03, f_out)
    res["formants_note_montee"] = {
        "decalage_demi_tons": round(pout - pin, 2),
        "F1_vrai_Hz": 730,
        "F1_origine_Hz": o_f1, "F1_justesse_Hz": j_f1, "F1_vitesse_chipmunk_Hz": c_f1,
        "ecart_vraie_enveloppe_origine_db": o_err, "ecart_vraie_enveloppe_justesse_db": j_err, "ecart_vraie_enveloppe_chipmunk_db": c_err,
    }
    (OUT / "B_note_montee_justesse.wav").write_bytes(wav_bytes(y[int(at * SR): int((at + ln) * SR)]))
    (OUT / "B_note_montee_chipmunk.wav").write_bytes(wav_bytes(chip))
    res["duree_s"] = {"avant": len(x) / SR, "apres": len(y) / SR}
    RESULTS["B_tablette"] = res
    save_log(log, {"errors": log.errors()})
    b.close()


# ------------------------------------------------------------ C. Téléphone
def scenario_phone(p):
    log = Log("C_telephone")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique_40ct.zip"
    b = launch(p)
    _, page = new_page(b, "tel", log)
    prepare(page)
    open_project_file(page, proj, RESULTS, "C0_projet_telephone")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    res = {}
    clip_el = page.locator("[data-clip-id='voix-1']").first
    if not clip_el.count() or not clip_el.is_visible():
        for name in ("Arrangement", "Studio", "Pistes"):
            t = page.get_by_role("button", name=re.compile(name, re.I)).locator("visible=true")
            try:
                if t.count():
                    tap(page, t.first); page.wait_for_timeout(500)
            except Exception:
                pass
            if clip_el.count() and clip_el.is_visible():
                break
    shot(page, "C1_arrangement_telephone")
    tap(page, clip_el, left=True)
    page.wait_for_timeout(400)
    shot(page, "C2_barre_du_clip_bouton_juste")
    page.get_by_test_id("mobile-clip-pitch").scroll_into_view_if_needed()
    tap(page, page.get_by_test_id("mobile-clip-pitch"))
    wait_editor(page)
    res["mode"] = page.get_attribute("[data-testid=pitch-editor]", "data-mode")
    shot(page, "C3_justesse_telephone")
    tap(page, page.get_by_test_id("pitch-style-robot"))
    set_range(page, "pitch-amount", 60)
    shot(page, "C4_robot_60")
    res["debordements"] = overflow_report(page)
    res["cibles_tactiles_trop_petites"] = page.evaluate("""() => Array.from(document.querySelectorAll('[data-testid=pitch-editor] button, [data-testid=pitch-editor] select'))
      .filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return { t: (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; })
      .filter(r => r.h < 32 || r.w < 32)""")
    tap(page, page.get_by_test_id("pitch-apply"))
    page.wait_for_selector("[data-testid=pitch-editor]", state="detached", timeout=60000)
    page.wait_for_timeout(400)
    after = clip_info(page)
    res["clip"] = after
    y = buffer_of(page, after["bufferId"])
    per = []
    for (m, c, at, ln, gl, vib) in MELODY:
        per.append({"note": m, "avant_ct": round((note_pitch(x, SR, at + 0.12, at + ln - 0.1) - m) * 100, 1),
                    "apres_ct": round((note_pitch(y, SR, at + 0.12, at + ln - 0.1) - m) * 100, 1)})
    res["dosage_60_robot"] = per
    shot(page, "C5_clip_corrige_telephone")
    RESULTS["C_telephone"] = res
    save_log(log, {"errors": log.errors()})
    b.close()


# ------------------------------------------------------------ D. Vraie voix
def read_mono24(p):
    with wave.open(str(p)) as w:
        sr, n, sw = w.getframerate(), w.getnframes(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 3:
        bb = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = bb[:, 0].astype(np.int32) | (bb[:, 1].astype(np.int32) << 8) | (bb[:, 2].astype(np.int32) << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        return v.astype(np.float32) / (1 << 23), sr
    return np.frombuffer(raw, "<i2").astype(np.float32) / 32768, sr


def real_voice():
    l, sr = read_mono24(REAL_SRC / "Silence blanc (Vocals).L.wav")
    r, _ = read_mono24(REAL_SRC / "Silence blanc (Vocals).R.wav")
    a, z = int(REAL_EXTRACT[0] * sr), int((REAL_EXTRACT[0] + REAL_EXTRACT[1]) * sr)
    return l[a:z], r[a:z], sr


def scenario_real(p, detune=0.0, tag="D_vraie_voix"):
    log = Log(tag)
    l, r, sr = real_voice()
    if detune:
        # Voix désaccordée pour l'essai : rééchantillonnage (+detune cents, 2 % plus courte).
        k = 2 ** (detune / 1200)
        idx = np.arange(0, len(l) - 1, k)
        l = np.interp(idx, np.arange(len(l)), l).astype(np.float32)
        r = np.interp(idx, np.arange(len(r)), r).astype(np.float32)
    proj = OUT / f"{tag}.zip"
    dur = len(l) / sr
    make_project(proj, wav_bytes([l, r], sr, 2), dur, "Justesse vraie voix", key=None)
    (OUT / f"{tag}_avant.wav").write_bytes(wav_bytes([l, r], sr, 2))
    b = launch(p)
    _, page = new_page(b, "pc", log)
    prepare(page)
    open_project_file(page, proj, RESULTS, f"{tag}_0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    before = clip_info(page)
    t0 = time.time()
    open_editor_desktop(page, f"{tag}_1")
    res = {"analyse_s": round(time.time() - t0, 2), "extrait": f"Silence blanc (Vocals), {REAL_EXTRACT[0]} a {REAL_EXTRACT[0] + REAL_EXTRACT[1]} s"}
    res["gamme"] = {"tonique": page.get_by_test_id("pitch-key-root").input_value(),
                    "gamme": page.get_by_test_id("pitch-key-scale").input_value() if page.get_by_test_id("pitch-key-scale").count() else "CHROMATIC",
                    "devinee": page.get_by_text("devinée d’après ta voix").count() > 0}
    shot(page, f"{tag}_2_notes")
    set_range(page, "pitch-amount", 100)
    shot(page, f"{tag}_3_corrigee_100_naturel")
    notes = geom(page)
    cvw = page.locator("[data-testid=pitch-grid] canvas").first.bounding_box()["width"]
    t1 = time.time()
    page.get_by_test_id("pitch-apply").click()
    page.wait_for_selector("[data-testid=pitch-editor]", state="detached", timeout=120000)
    res["rendu_s"] = round(time.time() - t1, 2)
    page.wait_for_timeout(400)
    after = clip_info(page)
    y = buffer_of(page, after["bufferId"])
    region = after["pitchEdit"]["regionStart"]
    x = (l + r) / 2
    yy = np.zeros_like(x)
    n = min(len(y), len(x))
    yy[:n] = y[:n]
    root = int(res["gamme"]["tonique"]) if res["gamme"]["tonique"] != "" else None
    iv = {"MINOR": [0, 2, 3, 5, 7, 8, 10], "MAJOR": [0, 2, 4, 5, 7, 9, 11]}.get(res["gamme"]["gamme"], list(range(12)))

    def cents_scale(mm):
        best = 999
        for q in range(int(mm) - 3, int(mm) + 4):
            if root is None or (q - root) % 12 in iv:
                best = min(best, abs(mm - q) * 100)
        return best
    pps = cvw / dur
    per = []
    for g in notes:
        ta, tz = g["x0"] / pps, g["x1"] / pps
        if tz - ta < 0.14:
            continue
        pa, pb = note_pitch(x, sr, ta + 0.04, tz - 0.04, 0.008), note_pitch(yy, sr, ta + 0.04, tz - 0.04, 0.008)
        if np.isnan(pa) or np.isnan(pb):
            continue
        per.append({"t": round(ta, 2), "avant_ct": round(cents_scale(pa), 1), "apres_ct": round(cents_scale(pb), 1)})
    av = [q["avant_ct"] for q in per]
    ap = [q["apres_ct"] for q in per]
    res["notes_trouvees"] = len(notes)
    res["notes_mesurees"] = len(per)
    if per:
        res["ecart_a_la_gamme_median_ct"] = {"avant": round(float(np.median(av)), 1), "apres": round(float(np.median(ap)), 1)}
        res["notes_a_moins_de_10ct"] = {"avant": int(sum(v <= 10 for v in av)), "apres": int(sum(v <= 10 for v in ap)), "sur": len(per)}
    res["par_note"] = per
    res["duree"] = {"clip_avant_s": before["duration"], "clip_apres_s": after["duration"], "son_origine_s": round(dur, 4), "son_corrige_s": round(len(y) / sr, 4), "region_debut_s": region}

    def ltas(sig):
        f = np.fft.rfftfreq(len(sig), 1 / sr)
        S = np.abs(np.fft.rfft(sig)) ** 2
        bands, fc = [], 160.0
        while fc < 8000:
            m = (f >= fc / 2 ** (1 / 6)) & (f < fc * 2 ** (1 / 6))
            bands.append(10 * np.log10(S[m].mean() + 1e-20))
            fc *= 2 ** (1 / 3)
        return np.array(bands)
    la, lb = ltas(x), ltas(yy)
    res["timbre_ecart_moyen_db_tiers_octave"] = round(float(np.mean(np.abs(la - lb))), 2)
    res["timbre_ecart_max_db_tiers_octave"] = round(float(np.max(np.abs(la - lb))), 2)

    def hf_blocks(sig):
        X = np.fft.rfft(sig)
        f = np.fft.rfftfreq(len(sig), 1 / sr)
        hp = np.fft.irfft(np.where(f > 8000, X, 0), n=len(sig))
        blk = int(0.005 * sr)
        return np.array([np.sqrt(np.mean(hp[s:s + blk] ** 2)) for s in range(0, len(sig) - blk, blk)])
    ha, hb = hf_blocks(x), hf_blocks(yy)
    lvl = np.sqrt(np.mean(x ** 2))
    rise = 20 * np.log10((hb + 1e-9) / (ha + 1e-9))
    res["aigus_pire_hausse_locale_db"] = round(float(np.max(rise[hb > lvl * 0.003])) if np.any(hb > lvl * 0.003) else 0.0, 1)

    # Clic = pointe isolée dans les aigus (facteur de crête élevé sur 5 ms).
    def crest(sig):
        X = np.fft.rfft(sig)
        f = np.fft.rfftfreq(len(sig), 1 / sr)
        hp = np.fft.irfft(np.where(f > 4000, X, 0), n=len(sig))
        blk = int(0.005 * sr)
        out = []
        for s0 in range(0, len(sig) - blk, blk):
            rr = np.sqrt(np.mean(hp[s0:s0 + blk] ** 2))
            if rr > lvl * 0.002:
                out.append(float(np.max(np.abs(hp[s0:s0 + blk])) / rr))
        return out, hp
    cx, hpx = crest(x)
    cy, hpy = crest(yy)
    res["clics"] = {"crete_max_aigus_avant": round(max(cx), 1), "crete_max_aigus_apres": round(max(cy), 1),
                    "aigus_total_avant_db": round(float(20 * np.log10(np.sqrt(np.mean(hpx ** 2)) / lvl)), 2),
                    "aigus_total_apres_db": round(float(20 * np.log10(np.sqrt(np.mean(hpy ** 2)) / lvl)), 2)}
    res["saut_max_sortie_sur_entree"] = max_jump_ratio(yy, x)
    (OUT / f"{tag}_apres.wav").write_bytes(wav_bytes(np.clip(yy, -1, 1), sr))
    shot(page, f"{tag}_4_clip_corrige")
    if detune:
        res["desaccord_cents"] = detune
    RESULTS[tag] = res
    save_log(log, {"errors": log.errors()})
    b.close()


def run():
    only = os.environ.get("V19_ONLY", "ABCDE")
    with sync_playwright() as p:
        for name, fn in [("A", scenario_pc), ("B", scenario_tablet), ("C", scenario_phone), ("D", scenario_real),
                         ("E", lambda p: scenario_real(p, 35.0, "E_vraie_voix_desaccordee"))]:
            if name not in only:
                continue
            try:
                fn(p)
            except Exception as e:  # noqa
                import traceback
                RESULTS[f"{name}_erreur"] = traceback.format_exc()[-2500:]
            mf = OUT / "mesures.json"
            prev = {}
            if mf.exists():
                try:
                    prev = json.loads(mf.read_text(encoding="utf-8"))
                except Exception:
                    prev = {}
            for k in list(prev):
                if k.startswith(f"{name}_"):
                    del prev[k]
            prev.update(RESULTS)
            mf.write_text(json.dumps(prev, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(RESULTS, ensure_ascii=True, indent=1)[:6000])


if __name__ == "__main__":
    run()
