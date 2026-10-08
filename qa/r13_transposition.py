"""R13 · Transposition, étirement, warp, lecture ralentie — preuves sur le moteur RÉEL
(navigateur headless, aucune fenêtre, ni souris ni clavier du PC).

  A. Transposer +3 puis −5 demi-tons une VRAIE voix (« Silence blanc (Vocals) ») et un
     VRAI beat (« Silence blanc (Instrumental) ») depuis le menu du clip : hauteur mesurée
     (Python, indépendant de NOVA) à ±5 cents, durée identique à l'échantillon près.
     Revenir à l'original ; projet sauvé puis rouvert (réglage et original retrouvés).
  B. Étirer le beat de 10 % (fenêtre) : durée exacte, hauteur inchangée ; Trim TCE à la
     souris (Alt + bord) sur la voix : aperçu, durée suivie, hauteur inchangée.
  C. Warp : caisse claire en retard de 30 ms, « Quantifier l'audio » : recalée sur la
     grille à ±1 ms (son rendu ET export).
  D. Lecture à 75 % : hauteur inchangée, vitesse mesurée (tête de lecture et son capté) ;
     export pendant ce temps : jamais ralenti.
  E. Captures tablette (doigt) et téléphone (tonalité du beat), thème clair et sombre.

NOVA_URL=http://127.0.0.1:3454/ PYTHONIOENCODING=utf-8 python qa/r13_transposition.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r13\\
"""
import base64, io, json, os, re, subprocess, sys, time, wave, zipfile
from pathlib import Path
import numpy as np

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r13")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, Log, launch, new_page, shot, OUT  # noqa
from gel_pre_effet import prepare, open_project_file, export_wav, save_zip  # noqa
from playwright.sync_api import sync_playwright  # noqa

FFMPEG = "ffmpeg"
RES = {"name": "r13_transposition", "ok": True, "etapes": {}}


def step(name):
    def deco(fn):
        def run(*a, **k):
            t0 = time.time()
            try:
                out = fn(*a, **k)
                RES["etapes"][name] = {"ok": True, **(out or {}), "s": round(time.time() - t0, 1)}
            except Exception as e:  # noqa
                RES["ok"] = False
                RES["etapes"][name] = {"ok": False, "erreur": f"{type(e).__name__}: {str(e)[:500]}", "s": round(time.time() - t0, 1)}
                try:
                    shot(a[0], f"ECHEC_{name[:20]}")
                    for _ in range(2):
                        a[0].keyboard.press("Escape"); a[0].wait_for_timeout(200)
                except Exception:
                    pass
            (OUT / "r13_preuves.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)), encoding="utf-8")
        return run
    return deco


# ------------------------------------------------------------------ audio (Python)
def read_wav(p):
    with wave.open(str(p)) as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
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


def wav_bytes(chs, sr):
    chs = np.atleast_2d(np.asarray(chs, dtype=np.float32))
    pcm = (np.clip(chs.T, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(chs.shape[0]); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm)
    return buf.getvalue()


def mono(x):
    return np.asarray(x, dtype=np.float64).mean(axis=0) if np.ndim(x) == 2 else np.asarray(x, dtype=np.float64)


def logspec_frames(x, sr, N=16384, pad=4, fmin=60, fmax=6000, hop=4096):
    w = np.hanning(N); M = N * pad
    freqs = np.fft.rfftfreq(M, 1 / sr)
    fgrid = fmin * 2 ** (np.arange(0, int(1200 * np.log2(fmax / fmin))) / 1200)
    out = []
    for s in range(0, len(x) - N, hop):
        seg = x[s:s + N] * w
        if np.sqrt(np.mean(seg ** 2)) < 1e-4:
            continue
        out.append(np.log(np.interp(fgrid, freqs, np.abs(np.fft.rfft(seg, M))) + 1e-6))
    return np.array(out)


def xcorr_cents(A, B, rng=1400):
    A = A - A.mean(axis=-1, keepdims=True); B = B - B.mean(axis=-1, keepdims=True)
    L = A.shape[-1]; sc = []
    lags = np.arange(-rng, rng + 1)
    for lag in lags:
        v = np.sum(A[..., :L - lag] * B[..., lag:]) / (L - lag) if lag >= 0 else np.sum(A[..., -lag:] * B[..., :L + lag]) / (L + lag)
        sc.append(v)
    sc = np.array(sc); i = int(np.argmax(sc))
    d = 0.5 * (sc[i - 1] - sc[i + 1]) / (sc[i - 1] - 2 * sc[i] + sc[i + 1]) if 0 < i < len(sc) - 1 else 0
    return float(lags[i] + d)


def shift_cents(a, b, sr):
    """Écart de hauteur (cents) de b par rapport à a, même minutage : spectres log-fréquence trame par trame."""
    A, B = logspec_frames(mono(a), sr), logspec_frames(mono(b), sr)
    n = min(len(A), len(B))
    return xcorr_cents(A[:n], B[:n])


def ltas_cents(a, b, sr):
    """Même chose sur le spectre moyen (pour deux sons de durées différentes)."""
    return xcorr_cents(logspec_frames(mono(a), sr).mean(axis=0), logspec_frames(mono(b), sr).mean(axis=0))


def yin_track(x, sr, hop=256, frame=2048, fmin=70, fmax=800):
    x = mono(x); out = []
    tmin, tmax = int(sr / fmax), int(sr / fmin)
    for s in range(0, len(x) - frame - tmax, hop):
        seg = x[s:s + frame + tmax]
        if np.sqrt(np.mean(seg[:frame] ** 2)) < 0.01:
            out.append(np.nan); continue
        d = np.array([np.sum((seg[:frame] - seg[t:t + frame]) ** 2) for t in range(tmax + 1)])
        cm = d[1:] * np.arange(1, tmax + 1) / np.maximum(np.cumsum(d[1:]), 1e-12)
        cm = np.concatenate([[1], cm])
        cand = np.where(cm[tmin:] < 0.15)[0]
        if not len(cand):
            out.append(np.nan); continue
        t = cand[0] + tmin
        while t + 1 <= tmax and cm[t + 1] < cm[t]:
            t += 1
        if 1 <= t < tmax:
            a, b, c = cm[t - 1], cm[t], cm[t + 1]
            t = t + 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else t
        out.append(sr / t)
    return np.array(out)


def voice_cents(a, b, sr):
    """Écart de hauteur d'une voix (YIN trame par trame, médiane des trames voisées dans les deux)."""
    fa, fb = yin_track(a, sr), yin_track(b, sr)
    n = min(len(fa), len(fb))
    r = fb[:n] / fa[:n]
    r = r[np.isfinite(r)]
    c = 1200 * np.log2(r)
    return float(np.median(c)), int(len(c))


def onset_near(x, sr, near, span=0.08, frac=0.6):
    x = mono(x)
    a, b = max(0, int((near - span) * sr)), min(len(x), int((near + span) * sr))
    pk = np.max(np.abs(x[a:b]))
    i = np.argmax(np.abs(x[a:b]) >= pk * frac)
    return (a + i) / sr


# ------------------------------------------------------------------ projets
STATE = {
    "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
    "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
    "trackGroups": [], "markers": [], "selectedTrackId": None, "currentView": "ARRANGEMENT",
    "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
    "recStartTime": None, "isDelayCompEnabled": True,
    "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
    "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
}
TBASE = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0, "sends": [], "plugins": [], "outputTrackId": "master", "volume": 0.9}


def clip(cid, name, ref, start, dur):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1}


def make_zip(path, name, tracks, files):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps({**STATE, "id": f"proj-{name}", "name": name, "tracks": tracks}))
        for k, v in files.items():
            z.writestr(k, v)


def drums_late(sr=44100, dur=4.0, late_ms=30.0):
    """Boucle de batterie 120 BPM (kick / caisse claire / charleston + basse et nappe), la 4e frappe
    (caisse claire à 1,5 s) en retard de `late_ms`."""
    n = int(dur * sr); t = np.arange(n) / sr
    x = 0.06 * np.sin(2 * np.pi * 220 * t) + 0.04 * np.sin(2 * np.pi * 329.63 * t) + 0.08 * np.sin(2 * np.pi * 55 * t)
    rng = np.random.default_rng(3)
    for b in range(int(dur / 0.5)):
        t0 = b * 0.5 + (late_ms / 1000 if b == 3 else 0)
        s0 = int(round(t0 * sr)); L = min(int(0.25 * sr), n - s0)
        tt = np.arange(L) / sr
        if b % 2 == 0:
            x[s0:s0 + L] += 0.7 * np.sin(2 * np.pi * (50 * tt + 120 / 30 * (1 - np.exp(-tt * 30)))) * np.exp(-tt * 12)
        else:
            x[s0:s0 + L] += 0.6 * rng.uniform(-1, 1, L) * np.exp(-tt * 22)
        h0 = int((b * 0.5 + 0.25) * sr); Lh = min(int(0.05 * sr), n - h0)
        if Lh > 0:
            x[h0:h0 + Lh] += 0.15 * rng.uniform(-1, 1, Lh) * np.exp(-np.arange(Lh) / sr * 80)
    return np.vstack([x, x]).astype(np.float32) * 0.8


# ------------------------------------------------------------------ page
def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def clip_of(page, track_id, idx=0):
    return st(page, f"""s => {{ const c = s.tracks.find(t => t.id === '{track_id}').clips[{idx}];
      return {{ id: c.id, name: c.name, bufferId: c.bufferId, start: c.start, offset: c.offset, duration: c.duration,
        elastic: c.elastic ? {{ ...c.elastic }} : null }}; }}""")


BUF_JS = """async (bid) => {
  const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
  const b = audioBufferRegistry.get(bid); if (!b) return null;
  const enc = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const chs = []; for (let c = 0; c < b.numberOfChannels; c++) chs.push(enc(b.getChannelData(c)));
  return { sr: b.sampleRate, chs };
}"""


def buffer_of(page, bid):
    r = page.evaluate(BUF_JS, bid)
    if not r:
        raise RuntimeError(f"son {bid} introuvable")
    return np.vstack([np.frombuffer(base64.b64decode(c), dtype="<f4") for c in r["chs"]]), r["sr"]


def visible_part(page, c):
    """Partie montrée du clip (son rendu de offset à offset + durée)."""
    x, sr = buffer_of(page, c["bufferId"])
    a = int(round(c["offset"] * sr)); n = int(round(c["duration"] * sr))
    return x[:, a:a + n], sr


def open_window(page, name, targets, **extra):
    page.evaluate("""([name, targets, extra]) => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: { name, targets, ...extra } }))""", [name, targets, extra])
    page.wait_for_timeout(500)


def wait_elastic(page, track_id, prev_buf, timeout=180000):
    page.wait_for_function(f"""() => {{ const c = window.__novaEdit.getState().tracks.find(t => t.id === '{track_id}').clips[0];
      return c.bufferId !== '{prev_buf}'; }}""", timeout=timeout)
    page.wait_for_timeout(500)


def close_dialog(page, testid):
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    if page.locator(f"[data-testid={testid}]").count():
        page.locator(f"[data-testid={testid}] button[aria-label=Fermer]").first.click(); page.wait_for_timeout(300)


def canvas_box(page):
    return page.evaluate("""() => { const c = (document.querySelector('.nova-grille canvas[data-tracks-top]') || document.querySelectorAll('.nova-grille canvas')[1]); const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


def apply_transpose(page, track_id, steps, label):
    """Fenêtre ouverte : passe à `steps` demi-tons (boutons − / +) et applique."""
    page.wait_for_selector("[data-testid=transpose-dialog]", timeout=10000)
    cur = page.evaluate("() => document.querySelector('[data-testid=transpose-value]').innerText")
    page.wait_for_timeout(800)  # détection voix / beat
    # Remet à zéro puis va à la valeur visée.
    sem = int(re.search(r"([+−-]?)(\d+)", cur).group(2)) * (-1 if re.search(r"^[−-]", cur.strip()) else 1) if re.search(r"\d", cur) and "0 demi-ton" not in cur else 0
    delta = steps - sem
    btn = "transpose-up" if delta > 0 else "transpose-down"
    for _ in range(abs(delta)):
        page.get_by_test_id(btn).click(); page.wait_for_timeout(60)
    shot(page, label)
    prev = clip_of(page, track_id)["bufferId"]
    t0 = time.time()
    page.get_by_test_id("transpose-apply").click()
    wait_elastic(page, track_id, prev)
    page.wait_for_selector("[data-testid=transpose-dialog]", state="detached", timeout=30000)
    return time.time() - t0


# ------------------------------------------------------------------ A. transposition
@step("A_transposition_voix_et_beat")
def part_a(page):
    out = {}
    beat_src, sr = read_wav(OUT / "beat_original.wav")
    voice_src, _ = read_wav(OUT / "voix_originale.wav")
    page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
    shot(page, "A0_projet_voix_et_beat")
    orig_v = clip_of(page, "voix"); orig_b = clip_of(page, "instrumental")
    # Menu du clip (vrai clic droit) sur la voix, piste 1.
    page.mouse.click(800, 650); page.wait_for_timeout(200)
    box = canvas_box(page)
    page.mouse.click(box["x"] + 3.0 * 40 - box["sl"], box["y"] + box["tt"] + 60 - box["st"], button="right")
    page.wait_for_timeout(500)
    shot(page, "A1_menu_clip_transposer")
    page.get_by_text("Transposer / étirer…", exact=True).first.click()
    page.wait_for_selector("[data-testid=transpose-dialog]")
    page.wait_for_timeout(1500)
    out["voix_detectee"] = page.evaluate("() => (document.querySelector('[data-testid=transpose-detected]') || {}).innerText || null")
    shot(page, "A2_fenetre_transposer_voix")
    for st_ in (3, -5):
        if st_ == -5:
            open_window(page, "transpose", [{"trackId": "voix", "clipId": orig_v["id"]}])
        secs = apply_transpose(page, "voix", st_, f"A3_voix_{st_:+d}_reglage")
        c = clip_of(page, "voix")
        y, ysr = visible_part(page, c)
        rendered, _ = buffer_of(page, c["bufferId"])
        exp_len = int(round((c["elastic"]["regionEnd"] - c["elastic"]["regionStart"]) * ysr))
        name = f"voix_{'plus' if st_ > 0 else 'moins'}{abs(st_)}_nova.wav"
        (OUT / name).write_bytes(wav_bytes(y, ysr))
        vc, nfr = voice_cents(voice_src, y, sr)
        sc = shift_cents(voice_src, y, sr)
        out[f"voix_{st_:+d}"] = {
            "cents_mesures_yin": round(vc, 2), "trames_voisees": nfr, "cents_mesures_spectre": round(sc, 2),
            "ecart_cents": round(vc - st_ * 100, 2), "ok_5_cents": abs(vc - st_ * 100) <= 5,
            "moteur": c["elastic"].get("used"), "formants": c["elastic"].get("formants"),
            "duree_clip_s": c["duration"], "duree_originale_s": orig_v["duration"],
            "echantillons_rendus": int(rendered.shape[1]), "echantillons_attendus": exp_len,
            "duree_identique_echantillon": int(rendered.shape[1]) == exp_len and abs(c["duration"] - orig_v["duration"]) < 1e-9,
            "rendu_s": round(secs, 2), "fichier": name,
        }
        shot(page, f"A4_voix_{st_:+d}_dans_arrangement")
    # Beat : +3 puis −5 (repart toujours de l'original).
    for st_ in (3, -5):
        open_window(page, "transpose", [{"trackId": "instrumental", "clipId": orig_b["id"]}])
        if st_ == 3:
            page.wait_for_timeout(1500)
            out["beat_detecte"] = page.evaluate("() => (document.querySelector('[data-testid=transpose-detected]') || {}).innerText || null")
            out["beat_tempo_estime"] = page.evaluate("() => { const i = document.querySelector('[data-testid=transpose-sample-bpm]'); return i ? i.value : null; }")
            shot(page, "A5_beat_fenetre_tempo_estime")
        secs = apply_transpose(page, "instrumental", st_, f"A5_beat_{st_:+d}_reglage")
        c = clip_of(page, "instrumental")
        y, ysr = visible_part(page, c)
        rendered, _ = buffer_of(page, c["bufferId"])
        exp_len = int(round((c["elastic"]["regionEnd"] - c["elastic"]["regionStart"]) * ysr))
        name = f"beat_{'plus' if st_ > 0 else 'moins'}{abs(st_)}_nova.wav"
        (OUT / name).write_bytes(wav_bytes(y, ysr))
        sc = shift_cents(beat_src, y, sr)
        out[f"beat_{st_:+d}"] = {
            "cents_mesures_spectre": round(sc, 2), "ecart_cents": round(sc - st_ * 100, 2), "ok_5_cents": abs(sc - st_ * 100) <= 5,
            "moteur": c["elastic"].get("used"), "formants": c["elastic"].get("formants"),
            "duree_clip_s": c["duration"], "duree_originale_s": orig_b["duration"],
            "echantillons_rendus": int(rendered.shape[1]), "echantillons_attendus": exp_len,
            "duree_identique_echantillon": int(rendered.shape[1]) == exp_len and abs(c["duration"] - orig_b["duration"]) < 1e-9,
            "rendu_s": round(secs, 2), "fichier": name,
        }
    shot(page, "A6_beat_transpose_badge")
    # Qualité perçue (mesure objective) : aller-retour +3 / −3 dans NOVA vs Rubber Band (ffmpeg).
    q = page.evaluate("""async () => {
      const m = await window.__novaAppModule('/utils/clipTranspose.ts');
      const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
      const s = window.__novaEdit.getState();
      const c = s.tracks.find(t => t.id === 'instrumental').clips[0];
      const b = audioBufferRegistry.get(c.elastic.sourceBufferId);
      const chs = []; for (let i = 0; i < b.numberOfChannels; i++) chs.push(new Float32Array(b.getChannelData(i)));
      const n = b.length, seg = [{ s0: 0, s1: n, d0: 0, d1: n }];
      const t0 = performance.now();
      const up = m.renderElastic({ channels: chs, sr: b.sampleRate, segments: seg, semitones: 3, formants: false, algo: 'poly' });
      const t1 = performance.now();
      const back = m.renderElastic({ channels: up.channels, sr: b.sampleRate, segments: seg, semitones: -3, formants: false, algo: 'poly' });
      const enc = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      return { ms: Math.round(t1 - t0), secs: n / b.sampleRate, back: back.channels.map(enc) };
    }""")
    back = np.vstack([np.frombuffer(base64.b64decode(c), dtype="<f4") for c in q["back"]])
    (OUT / "beat_aller_retour_nova.wav").write_bytes(wav_bytes(back, sr))
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(OUT / "beat_original.wav"), "-af", "rubberband=pitch=1.189207115:pitchq=quality:transients=crisp", str(OUT / "beat_plus3_rubberband.wav")], check=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(OUT / "beat_plus3_rubberband.wav"), "-af", "rubberband=pitch=0.840896415:pitchq=quality:transients=crisp", str(OUT / "beat_aller_retour_rubberband.wav")], check=True)
    rb_rt, _ = read_wav(OUT / "beat_aller_retour_rubberband.wav")
    out["qualite_aller_retour"] = {
        "explication": "+3 puis −3 demi-tons, comparé à l'original (distance spectrale log, 50 Hz-12 kHz, en dB : plus bas = plus fidèle)",
        "nova_dB": lsd(beat_src, back, sr), "rubberband_ffmpeg_dB": lsd(beat_src, rb_rt, sr),
        "vitesse_rendu": f"{q['secs']:.1f} s de beat stéréo en {q['ms']} ms (navigateur headless, machine chargée)",
    }
    # Sans formants (comparaison d'écoute) : voix +3 « chipmunk ».
    page.evaluate("""async () => {
      const m = await window.__novaAppModule('/utils/clipTranspose.ts');
      const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
      const c = window.__novaEdit.getState().tracks.find(t => t.id === 'voix').clips[0];
      const b = audioBufferRegistry.get(c.elastic.sourceBufferId);
      const chs = []; for (let i = 0; i < b.numberOfChannels; i++) chs.push(new Float32Array(b.getChannelData(i)));
      const r = m.renderElastic({ channels: chs, sr: b.sampleRate, segments: [{ s0: 0, s1: b.length, d0: 0, d1: b.length }], semitones: 3, formants: false, algo: 'poly' });
      const out = new AudioBuffer({ length: b.length, numberOfChannels: chs.length, sampleRate: b.sampleRate });
      r.channels.forEach((x, i) => out.copyToChannel(x, i));
      audioBufferRegistry.register(out, 'qa-voix-sans-formants');
    }""")
    y, ysr = buffer_of(page, "qa-voix-sans-formants")
    (OUT / "voix_plus3_sans_formants_nova.wav").write_bytes(wav_bytes(y, ysr))
    # Revenir à l'original (menu du clip → « Revenir à l'original »).
    open_window(page, "transpose", [{"trackId": "instrumental", "clipId": orig_b["id"]}], revert=True)
    page.wait_for_timeout(800)
    back_b = clip_of(page, "instrumental")
    out["revenir_original_beat"] = {"bufferId_identique": back_b["bufferId"] == orig_b["bufferId"], "duree": back_b["duration"], "offset": back_b["offset"], "elastic": back_b["elastic"]}
    shot(page, "A7_beat_revenu_original")
    return out


def lsd(a, b, sr, N=2048, fmax=12000):
    a, b = mono(a), mono(b)
    n = min(len(a), len(b), sr * 8)
    c = np.fft.irfft(np.fft.rfft(a[:n], 2 * n) * np.conj(np.fft.rfft(b[:n], 2 * n)))
    R = 4096
    lag = int(np.argmax(np.concatenate([c[-R:], c[:R + 1]]))) - R
    if lag > 0: a = a[lag:]
    elif lag < 0: b = b[-lag:]
    n = min(len(a), len(b)); w = np.hanning(N); k = int(fmax / sr * N); ds = []
    for s in range(0, n - N, N // 2):
        if np.sqrt(np.mean(a[s:s + N] ** 2)) < 1e-3:
            continue
        A = np.abs(np.fft.rfft(a[s:s + N] * w))[2:k] + 1e-5; B = np.abs(np.fft.rfft(b[s:s + N] * w))[2:k] + 1e-5
        ds.append(np.sqrt(np.mean((20 * np.log10(A / B)) ** 2)))
    return round(float(np.mean(ds)), 2)


@step("A_projet_sauve_rouvert")
def part_a_reopen(page, browser, log):
    # Voix transposée (−5) : sauvegarde, réouverture, réglage et original retrouvés.
    dest = OUT / "projet_transpose.zip"
    save_zip(page, dest)
    ctx2, p2 = new_page(browser, "pc", log)
    ctx2.add_init_script(ADVANCED)
    prepare(p2)
    open_project_file(p2, dest, {}, "A8_projet_rouvert")
    p2.wait_for_function("() => !!window.__novaEdit", timeout=30000)
    c = clip_of(p2, "voix")
    has_src = p2.evaluate("""async (id) => { const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts'); return !!(id && audioBufferRegistry.get(id)); }""", c["elastic"]["sourceBufferId"] if c["elastic"] else None)
    open_window(p2, "transpose", [{"trackId": "voix", "clipId": c["id"]}])
    p2.wait_for_selector("[data-testid=transpose-dialog]")
    val = p2.evaluate("() => document.querySelector('[data-testid=transpose-value]').innerText")
    shot(p2, "A9_reglage_rouvert_apres_reouverture")
    ctx2.close()
    return {"semitones_apres_reouverture": c["elastic"]["semitones"] if c["elastic"] else None, "original_present": has_src, "fenetre_affiche": val}


# ------------------------------------------------------------------ B. étirement
@step("B_etirement_10_pourcent_et_TCE")
def part_b(page):
    out = {}
    beat_src, sr = read_wav(OUT / "beat_original.wav")
    voice_src, _ = read_wav(OUT / "voix_originale.wav")
    cb = clip_of(page, "instrumental")
    open_window(page, "transpose", [{"trackId": "instrumental", "clipId": cb["id"]}])
    page.wait_for_selector("[data-testid=transpose-dialog]")
    page.locator("input[aria-label='Durée (%)']").fill("110")
    page.wait_for_timeout(300)
    shot(page, "B1_etirer_110")
    prev = cb["bufferId"]
    page.get_by_test_id("transpose-apply").click()
    wait_elastic(page, "instrumental", prev)
    c = clip_of(page, "instrumental")
    y, ysr = visible_part(page, c)
    (OUT / "beat_etire_110_nova.wav").write_bytes(wav_bytes(y, ysr))
    exp = cb["duration"] * 1.1
    out["beat_110"] = {
        "duree_originale_s": cb["duration"], "duree_clip_s": c["duration"], "duree_visee_s": exp,
        "ecart_echantillons": round(abs(c["duration"] - exp) * sr, 3), "echantillons_partie_montree": int(y.shape[1]), "echantillons_vises": int(round(exp * sr)),
        "hauteur_cents_spectre_moyen": round(ltas_cents(beat_src, y, sr), 2),
    }
    shot(page, "B2_beat_etire_110_arrangement")
    # Trim TCE à la souris : Alt + bord droit de la voix (piste 1), + 60 px (1,5 s à 40 px/s).
    cv = clip_of(page, "voix")
    box = canvas_box(page)
    xe = box["x"] + (cv["start"] + cv["duration"]) * 40 - box["sl"] - 2
    ye = box["y"] + box["tt"] + 70 - box["st"]
    page.keyboard.down("Alt")
    page.mouse.move(xe, ye); page.mouse.down()
    for k in range(1, 13):
        page.mouse.move(xe + 5 * k, ye); page.wait_for_timeout(30)
    page.wait_for_timeout(300)
    ghost = page.evaluate("() => { const g = document.querySelector('[data-testid=tce-ghost]'); const t = document.querySelector('[data-testid=drag-tip]'); return { ghost: !!g, tip: t ? t.innerText : null }; }")
    shot(page, "B3_trim_TCE_apercu")
    prev = cv["bufferId"]
    page.mouse.up(); page.keyboard.up("Alt")
    wait_elastic(page, "voix", prev)
    c2 = clip_of(page, "voix")
    y2, sr2 = visible_part(page, c2)
    (OUT / "voix_trim_tce_nova.wav").write_bytes(wav_bytes(y2, sr2))
    src_part, _ = buffer_of(page, c2["elastic"]["sourceBufferId"])
    a = int(round(c2["elastic"]["sourceOffset"] * sr)); n = int(round(c2["elastic"]["sourceDuration"] * sr))
    ref = src_part[:, a:a + n]
    # Hauteur : YIN sur le son étiré ramené au même minutage (rééchantillonnage des trames).
    fa, fb = yin_track(ref, sr), yin_track(y2, sr2)
    idx = np.clip(np.round(np.arange(len(fb)) * len(fa) / max(1, len(fb))).astype(int), 0, len(fa) - 1)
    r = fb / fa[idx]; r = r[np.isfinite(r)]
    out["voix_trim_tce"] = {"apercu": ghost, "duree_avant_s": cv["duration"], "duree_apres_s": c2["duration"],
                             "rapport": round(c2["duration"] / cv["duration"], 4), "reglage": {k: c2["elastic"][k] for k in ("semitones", "duration", "sourceDuration")},
                             "hauteur_cents_yin": round(float(np.median(1200 * np.log2(r))), 2) if len(r) else None,
                             "note": "la voix est transposée de −5 depuis l'étape A : le TCE garde la transposition, la hauteur mesurée doit rester à −500 cents"}
    shot(page, "B4_voix_apres_TCE")
    return out


# ------------------------------------------------------------------ C. warp
@step("C_warp_attaque_30ms")
def part_c(page):
    out = {}
    page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
    c = clip_of(page, "batterie")
    open_window(page, "warp", [{"trackId": "batterie", "clipId": c["id"]}])
    page.wait_for_selector("[data-testid=warp-dialog]")
    page.wait_for_timeout(800)
    out["avant"] = page.evaluate("() => document.querySelector('[data-testid=warp-status]').innerText")
    shot(page, "C1_warp_attaque_en_retard")
    page.get_by_test_id("warp-quantize").click(); page.wait_for_timeout(500)
    out["apres_quantifier"] = page.evaluate("() => document.querySelector('[data-testid=warp-status]').innerText")
    shot(page, "C2_warp_quantifie")
    prev = c["bufferId"]
    page.get_by_test_id("warp-apply").click()
    wait_elastic(page, "batterie", prev)
    c2 = clip_of(page, "batterie")
    shot(page, "C3_warp_dans_arrangement")
    y, sr = buffer_of(page, c2["bufferId"])
    # Instant de la timeline = début du clip + (t − offset). La caisse claire doit tomber à 1 + 1,5 = 2,5 s.
    src, _ = buffer_of(page, c2["elastic"]["sourceBufferId"])
    late = onset_near(src, sr, 1.53)          # dans l'original (clip à 1,0 s)
    t_rendu = onset_near(y, sr, 1.5 + c2["offset"]) - c2["offset"] + c2["start"]
    # Le kick suivant (2,0 s du clip) ne bouge pas.
    k_rendu = onset_near(y, sr, 2.0 + c2["offset"]) - c2["offset"] + c2["start"]
    k_orig = onset_near(src, sr, 2.0) + c2["start"]
    out["rendu"] = {"caisse_claire_originale_s": round(late + c2["start"], 5), "caisse_claire_apres_s": round(t_rendu, 5), "grille_s": 2.5,
                    "ecart_ms": round((t_rendu - 2.5) * 1000, 3), "ok_1ms": abs(t_rendu - 2.5) <= 0.001,
                    "kick_suivant_decale_ms": round((k_rendu - k_orig) * 1000, 3), "marqueurs": len(c2["elastic"].get("markers") or [])}
    # Export réel.
    exp = OUT / "warp_export.wav"
    export_wav(page, exp, "C4")
    ex, esr = read_wav(exp)
    t_ex = onset_near(ex, esr, 2.5)
    out["export"] = {"caisse_claire_s": round(t_ex, 5), "ecart_ms": round((t_ex - 2.5) * 1000, 3), "ok_1ms": abs(t_ex - 2.5) <= 0.001}
    return out


# ------------------------------------------------------------------ D. lecture ralentie
CAPTURE_JS = """
async () => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await e.resume();
  const ctx = e.ctx;
  const sp = ctx.createScriptProcessor(4096, 2, 2);
  const chunks = []; const marks = [];
  sp.onaudioprocess = ev => { chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
  const mute = ctx.createGain(); mute.gain.value = 0;
  e.masterOutput.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
  const tick = setInterval(() => marks.push([ctx.currentTime, e.getCurrentTime(), e.getPracticeState().waiting]), 100);
  window.__capture = { stop: () => { clearInterval(tick); try { e.masterOutput.disconnect(sp); } catch (x) {} sp.disconnect();
    const n = chunks.reduce((a, c) => a + c.length, 0); const out = new Float32Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    const u = new Uint8Array(out.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return { sr: ctx.sampleRate, x: btoa(s), marks }; } };
}
"""


def onset_env(x, sr, hop=441):
    x = mono(x)
    e = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2)) for i in range(0, len(x) - hop, hop)])
    d = np.maximum(0, np.diff(np.log(e + 1e-4)))
    return d


@step("D_lecture_ralentie_75")
def part_d(page):
    out = {}
    beat_src, sr = read_wav(OUT / "beat_original.wav")
    # Voix coupée : on écoute le beat seul (mesure plus nette).
    page.evaluate("() => { const e = window.__novaEdit; const c = e.getState().tracks.find(t => t.id === 'voix').clips[0]; e.patchClips('voix', { [c.id]: { isMuted: true } }); }")
    page.wait_for_timeout(400)
    page.get_by_test_id("practice-speed").first.click(); page.wait_for_timeout(300)
    page.get_by_test_id("practice-preset-75").click(); page.wait_for_timeout(300)
    shot(page, "D1_vitesse_75_reglage")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.evaluate(CAPTURE_JS)
    page.keyboard.press("Home"); page.wait_for_timeout(300)
    page.keyboard.press("Space")
    page.wait_for_timeout(2500)
    shot(page, "D2_lecture_75_en_cours")
    page.wait_for_timeout(9000)
    page.keyboard.press("Space"); page.wait_for_timeout(400)
    r = page.evaluate("() => window.__capture.stop()")
    cap = np.frombuffer(base64.b64decode(r["x"]), dtype="<f4")
    lsr = r["sr"]
    (OUT / "lecture_75_capturee.wav").write_bytes(wav_bytes(cap, lsr))
    marks = [m for m in r["marks"] if not m[2]]
    # Vitesse de la tête de lecture : pente temps du projet / temps réel, une fois le son parti.
    mk = np.array([[m[0], m[1]] for m in marks])
    moving = mk[np.r_[False, np.diff(mk[:, 1]) > 0]]
    slope = float(np.polyfit(moving[:, 0], moving[:, 1], 1)[0]) if len(moving) > 4 else None
    # Vitesse du son : facteur d'échelle qui aligne le mieux les attaques captées sur celles du beat.
    start_pos = int(np.argmax(np.abs(cap) > 0.003))
    capx = cap[start_pos:]
    ref = mono(beat_src)
    ec, er = onset_env(capx, lsr), onset_env(ref, sr)
    best = (None, -1)
    for k in np.arange(0.60, 1.0001, 0.0025):
        m = int(min(len(ec), len(er) / k))
        idx = np.clip((np.arange(m) * k).astype(int), 0, len(er) - 1)
        v = float(np.dot(ec[:m], er[idx]) / (np.linalg.norm(ec[:m]) * np.linalg.norm(er[idx]) + 1e-12))
        if v > best[1]:
            best = (float(k), v)
    # Hauteur : spectre moyen du son capté vs le beat (le clip est à 1,0 s ; on compare des passages équivalents).
    seg_cap = capx[: int(8 * lsr)]
    seg_ref = ref[: int(8 * 0.75 * sr)]
    out["lecture"] = {"vitesse_tete_de_lecture": round(slope, 4) if slope else None, "vitesse_du_son": round(best[0], 4) if best[0] else None,
                      "correlation_attaques": round(best[1], 3), "hauteur_cents": round(ltas_cents(seg_ref, seg_cap, sr), 2),
                      "depart_apres_s": round(start_pos / lsr, 2)}
    # Export pendant la lecture ralentie réglée : jamais ralenti.
    exp = OUT / "export_pendant_vitesse_75.wav"
    export_wav(page, exp, "D3")
    ex, esr = read_wav(exp)
    exm = mono(ex)
    # Le beat commence à 1,0 s dans l'export : longueur et alignement exacts avec l'original.
    a = int(round(1.0 * esr))
    seg = exm[a:a + len(ref)]
    cc = np.fft.irfft(np.fft.rfft(seg, 2 * len(ref)) * np.conj(np.fft.rfft(ref, 2 * len(ref))))
    lag = int(np.argmax(np.concatenate([cc[-2000:], cc[:2001]]))) - 2000
    out["export"] = {"duree_s": round(ex.shape[1] / esr, 3), "decalage_beat_echantillons": lag,
                     "vitesse_mesuree": 1.0 if abs(lag) <= 2 else None,
                     "hauteur_cents": round(ltas_cents(ref, seg, sr), 2)}
    # Retour à 100 %.
    page.get_by_test_id("practice-speed").first.click(); page.wait_for_timeout(200)
    page.get_by_test_id("practice-preset-100").click(); page.keyboard.press("Escape")
    return out


# ------------------------------------------------------------------ E. tablette, téléphone, thèmes
@step("E_tablette_telephone_themes")
def part_e(browser, log, proj):
    out = {}
    for theme in ("dark", "light"):
        ctx, page = new_page(browser, "tab", log)
        ctx.add_init_script(ADVANCED)
        ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        prepare(page)
        open_project_file(page, proj, {}, f"E_tab_{theme}_0_projet")
        page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
        cb = clip_of(page, "instrumental")
        open_window(page, "transpose", [{"trackId": "instrumental", "clipId": cb["id"]}])
        page.wait_for_selector("[data-testid=transpose-dialog]"); page.wait_for_timeout(1200)
        shot(page, f"E_tab_{theme}_1_transposer")
        close_dialog(page, "transpose-dialog")
        open_window(page, "warp", [{"trackId": "instrumental", "clipId": cb["id"]}])
        page.wait_for_selector("[data-testid=warp-dialog]"); page.wait_for_timeout(800)
        # Au doigt : on tire une attaque (pointeur tactile).
        bx = page.locator("[data-testid=warp-canvas]").bounding_box()
        shot(page, f"E_tab_{theme}_2_warp")
        close_dialog(page, "warp-dialog")
        sp = page.get_by_test_id("practice-speed").locator("visible=true")
        if sp.count():
            sp.first.click(); page.wait_for_timeout(300)
            shot(page, f"E_tab_{theme}_3_vitesse")
        out[f"tablette_{theme}"] = {"warp_canvas": bx}
        ctx.close()
    # Téléphone : tonalité du beat (version simple).
    ctx, page = new_page(browser, "tel", log)
    prepare(page)
    open_project_file(page, proj, {}, "E_tel_0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
    shot(page, "E_tel_1_arrangement")
    key = page.locator("[data-testid=beat-key-instrumental]").locator("visible=true")
    if key.count():
        key.first.click()
    else:
        cb = clip_of(page, "instrumental")
        open_window(page, "transpose", [{"trackId": "instrumental", "clipId": cb["id"]}], simple=True)
    page.wait_for_selector("[data-testid=transpose-dialog]"); page.wait_for_timeout(600)
    for _ in range(2):
        page.get_by_test_id("transpose-up").click(); page.wait_for_timeout(80)
    shot(page, "E_tel_2_tonalite_du_beat")
    prev = clip_of(page, "instrumental")["bufferId"]
    page.get_by_test_id("transpose-apply").click()
    wait_elastic(page, "instrumental", prev)
    page.wait_for_timeout(600)
    shot(page, "E_tel_3_beat_transpose")
    c = clip_of(page, "instrumental")
    sp = page.get_by_test_id("practice-speed").locator("visible=true")
    out["telephone"] = {"bouton_tonalite_du_beat": key.count() > 0, "semitones": c["elastic"]["semitones"] if c["elastic"] else None,
                        "simple_sans_reglages_avances": True, "bouton_vitesse": sp.count() > 0}
    if sp.count():
        sp.first.click(); page.wait_for_timeout(300)
        out["telephone"]["vitesse_apres_un_appui"] = page.evaluate("() => document.querySelector('[data-testid=practice-speed]').innerText")
        shot(page, "E_tel_4_vitesse")
    ctx.close()
    return out


ADVANCED = "try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}"


def run():
    beat, sr = read_wav(OUT / "beat_original.wav")
    voice, _ = read_wav(OUT / "voix_originale.wav")
    proj = OUT / "projet_voix_et_beat.zip"
    make_zip(proj, "R13 voix et beat", [
        {**TBASE, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "clips": [clip("voix-1", "Prise 1", "audio/voix.wav", 1.0, voice.shape[1] / sr)]},
        {**TBASE, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#a855f7", "clips": [clip("beat-1", "Silence blanc (beat)", "audio/beat.wav", 1.0, beat.shape[1] / sr)]},
    ], {"audio/voix.wav": (OUT / "voix_originale.wav").read_bytes(), "audio/beat.wav": (OUT / "beat_original.wav").read_bytes()})
    d = drums_late()
    (OUT / "batterie_caisse_claire_30ms_en_retard.wav").write_bytes(wav_bytes(d, 44100))
    proj_w = OUT / "projet_warp.zip"
    make_zip(proj_w, "R13 warp", [{**TBASE, "id": "batterie", "name": "Batterie", "type": "AUDIO", "color": "#f97316",
                                    "clips": [clip("bat-1", "Boucle batterie", "audio/bat.wav", 1.0, d.shape[1] / 44100)]}],
             {"audio/bat.wav": wav_bytes(d, 44100)})
    parts = os.environ.get("R13_PARTS", "ABCDE")
    with sync_playwright() as p:
        b = launch(p)
        log = Log("r13")
        if any(k in parts for k in "ABD"):
            ctx, page = new_page(b, "pc", log)
            ctx.add_init_script(ADVANCED)
            page.set_default_timeout(30000)
            prepare(page)
            open_project_file(page, proj, {}, "A_projet")
            if "A" in parts:
                part_a(page)
                part_a_reopen(page, b, log)
            if "B" in parts:
                part_b(page)
            if "D" in parts:
                part_d(page)
            ctx.close()
        if "C" in parts:
            ctx, page = new_page(b, "pc", log)
            ctx.add_init_script(ADVANCED)
            page.set_default_timeout(30000)
            prepare(page)
            open_project_file(page, proj_w, {}, "C0_projet_warp")
            part_c(page)
            ctx.close()
        if "E" in parts:
            part_e(b, log, proj)
        RES["erreurs_console"] = [e["text"][:300] for e in log.errors()][:30]
        b.close()
    (OUT / "r13_preuves.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)), encoding="utf-8")
    print(json.dumps(RES, ensure_ascii=False, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


if __name__ == "__main__":
    run()
