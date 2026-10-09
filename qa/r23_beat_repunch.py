"""R23 · Changer de beat en gardant les voix, repunch intelligent — preuves sur l'appli RÉELLE
(navigateur headless, aucune fenêtre, ni souris ni clavier du PC).

  A. Une VRAIE voix (« Silence blanc », stem voix) posée sur le beat A (94 BPM, Sol mineur,
     1er temps à 0,35 s) ; « Remplacer l'instru… » (menu de la piste BEAT) → beat B
     (100 BPM, La mineur, 1er temps à 0,12 s, fichier de l'ordinateur).
     Mesures (Python, indépendantes de NOVA) sur le son RENDU de la voix, à sa place dans le
     projet : attaques sur la grille du beat B (même position musicale qu'au départ) à ±5 ms,
     hauteur transposée de +2 demi-tons (le plus court) à ±5 cents.
     Repères et accords suivis ; Avant / Après ; « Revenir à l'ancien beat » (une seule
     annulation) ; Ctrl+Y puis UN Ctrl+Z.
  B. Prise de voix (vraie voix sur le vrai beat de « Silence blanc », 92,3 BPM) dont une
     phrase est volontairement fausse (+45 cents) et en retard (90 ms) : « Repérer les
     passages à refaire » → repère sur cette phrase ; « Refaire ce passage » → zone de punch
     posée sur les temps, pré-roll, piste armée, prise lancée (micro simulé) ; la prise est
     placée dans la zone ; avant / après et choix.
  C. Captures tablette (doigt) et téléphone (version simple), thème clair et sombre.

NOVA_URL=http://127.0.0.1:3476/ PYTHONIOENCODING=utf-8 python qa/r23_beat_repunch.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r23\\
"""
import io, json, os, re, subprocess, sys, time, wave, zipfile
from pathlib import Path
import numpy as np

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r23")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, Log, launch, new_page, shot, OUT  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from r13_transposition import read_wav, wav_bytes, mono, yin_track, buffer_of, st  # noqa
from playwright.sync_api import sync_playwright  # noqa

FFMPEG = "ffmpeg"
SR = 44100
STEMS = Path(r"D:\1 WORK\CONTENU\nova-v18-stems\sorties-pont\Test stems\Silence blanc (extrait) 2026-10-07 22-59-22")
if not STEMS.exists():
    # Le dossier d'origine a été nettoyé : un autre rendu des mêmes stems (« Silence blanc (extrait) »,
    # séparation Voix / Instru du pont) fait l'affaire.
    _alt = sorted((d for d in Path(r"D:\1 WORK\CONTENU").glob("*/**/Test stems/Silence blanc (extrait) *")
                   if (d / "Voix.wav").exists() and (d / "Instru.wav").exists()), key=lambda d: d.name)
    if _alt:
        STEMS = _alt[0]
RES ={"name": "r23_beat_repunch", "ok": True, "etapes": {}}

A_BPM, A_ROOT, A_DB = 94, 55, 0.35      # Sol mineur
B_BPM, B_ROOT, B_DB = 100, 57, 0.12     # La mineur
VOICE_AT = A_DB + 4 * 60 / A_BPM         # la voix entre à la mesure 2 du beat A
SB_BPM = 92.3                            # « Silence blanc » (librosa : 92,3 BPM)
INIT = """try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0');
  localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}"""


def save():
    (OUT / "r23_preuves.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)), encoding="utf-8")


def step(name):
    def deco(fn):
        def run(*a, **k):
            t0 = time.time()
            try:
                out = fn(*a, **k)
                ok = (out or {}).pop("_ok", True)
                RES["etapes"][name] = {"ok": ok, **(out or {}), "s": round(time.time() - t0, 1)}
                if not ok:
                    RES["ok"] = False
            except Exception as e:  # noqa
                RES["ok"] = False
                RES["etapes"][name] = {"ok": False, "erreur": f"{type(e).__name__}: {str(e)[:600]}", "s": round(time.time() - t0, 1)}
                try:
                    shot(a[0], f"ECHEC_{name[:24]}")
                except Exception:
                    pass
            save()
        return run
    return deco


# ------------------------------------------------------------------ sons
def synth_beat(bpm, root, db, bars, seed=7):
    """Même beat que tests/helpers/synthBeat.ts : kick 1 et 3, caisse claire 2 et 4, charley en croches,
    808 sur la tonique, nappe de l'accord mineur ; levée de charley avant le 1er temps."""
    beat = 60 / bpm
    n = int((db + bars * 4 * beat + 1) * SR)
    x = np.zeros(n)
    rng = np.random.default_rng(seed)
    hz = lambda m: 440 * 2 ** ((m - 69) / 12)

    def add(t0, ln, f):
        a = int(round(t0 * SR)); L = min(int(round(ln * SR)), n - a)
        if L > 0:
            tt = np.arange(L) / SR
            x[a:a + L] += f(tt)
    for k in (1, 0.5):
        add(db - k * beat, 0.05, lambda tt: 0.15 * rng.uniform(-1, 1, len(tt)) * np.exp(-tt * 60))
    for b in range(bars * 4):
        t = db + b * beat
        if b % 2 == 0:
            add(t, 0.3, lambda tt: 0.8 * np.sin(2 * np.pi * (45 * tt + 110 / 25 * (1 - np.exp(-tt * 25)))) * np.exp(-tt * 9))
        else:
            add(t, 0.2, lambda tt: 0.45 * rng.uniform(-1, 1, len(tt)) * np.exp(-tt * 20))
        add(t, 0.05, lambda tt: 0.12 * rng.uniform(-1, 1, len(tt)) * np.exp(-tt * 60))
        add(t + beat / 2, 0.05, lambda tt: 0.12 * rng.uniform(-1, 1, len(tt)) * np.exp(-tt * 60))
        if b % 4 == 0:
            add(t, beat * 4, lambda tt: 0.25 * np.sin(2 * np.pi * hz(root - 24) * tt) * np.minimum(1, tt * 200) * np.exp(-tt * 0.8))
            for iv in (0, 3, 7, 12):
                add(t, beat * 4, lambda tt, iv=iv: 0.04 * np.sin(2 * np.pi * hz(root + iv) * tt) * np.minimum(1, tt * 20))
    return (x * 0.8).astype(np.float32)


def stem(name, a, b):
    x, sr = read_wav(OUT / name)
    return x[:, int(a * sr):int(b * sr)], sr


def prepare_audio():
    for src, dst in (("Voix.wav", "sb_voix.wav"), ("Instru.wav", "sb_instru.wav")):
        if not (OUT / dst).exists():
            subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(STEMS / src), "-ar", "44100", "-c:a", "pcm_s16le", str(OUT / dst)], check=True)
    # A : 12 s de vraie voix (deux phrases), beats synthétiques A et B.
    v, _ = stem("sb_voix.wav", 1.6, 13.4)
    (OUT / "voix_reelle.wav").write_bytes(wav_bytes(v, SR))
    (OUT / "beat_A_94_sol_mineur.wav").write_bytes(wav_bytes(synth_beat(A_BPM, A_ROOT, A_DB, 16), SR))
    (OUT / "beat_B_100_la_mineur.wav").write_bytes(wav_bytes(synth_beat(B_BPM, B_ROOT, B_DB, 16, seed=11), SR))
    # B : 22 s de « Silence blanc » ; la phrase 16,72 → 18,96 s chantée +45 cents trop haut et 90 ms en retard.
    voice, _ = stem("sb_voix.wav", 0, 22)
    instru, _ = stem("sb_instru.wav", 0, 22)
    a, b = 16.55, 19.15
    seg = voice[:, int(a * SR):int(b * SR)]
    (OUT / "_seg.wav").write_bytes(wav_bytes(seg, SR))
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(OUT / "_seg.wav"), "-af", f"rubberband=pitch={2 ** (45 / 1200):.6f}:pitchq=quality",
                    str(OUT / "_seg_faux.wav")], check=True)
    faux, _ = read_wav(OUT / "_seg_faux.wav")
    faux = faux[:, :seg.shape[1]]
    late = int(0.09 * SR)
    shifted = np.zeros_like(seg)
    shifted[:, late:] = faux[:, :seg.shape[1] - late]
    take = voice.copy()
    fade = int(0.01 * SR)
    w = np.ones(seg.shape[1]); w[:fade] = np.linspace(0, 1, fade); w[-fade:] = np.linspace(1, 0, fade)
    take[:, int(a * SR):int(b * SR)] = seg * (1 - w) + shifted * w
    (OUT / "prise_fausse_et_decalee.wav").write_bytes(wav_bytes(take, SR))
    (OUT / "instru_silence_blanc.wav").write_bytes(wav_bytes(instru, SR))
    for f in ("_seg.wav", "_seg_faux.wav"):
        (OUT / f).unlink(missing_ok=True)


STATE = {
    "timeSignature": {"numerator": 4, "denominator": 4},
    "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
    "trackGroups": [], "selectedTrackId": None, "currentView": "ARRANGEMENT",
    "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
    "recStartTime": None, "isDelayCompEnabled": True,
    "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
    "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
}
TBASE = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0, "sends": [], "plugins": [], "outputTrackId": "master", "volume": 0.9}


def clip(cid, name, ref, start, dur, **kw):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1, **kw}


def make_zip(path, name, extra, tracks, files):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps({**STATE, **extra, "id": f"proj-{name}", "name": name, "tracks": tracks}))
        for k, v in files.items():
            z.writestr(k, v)


def projects():
    va, _ = read_wav(OUT / "voix_reelle.wav")
    ba, _ = read_wav(OUT / "beat_A_94_sol_mineur.wav")
    pa = OUT / "projet_voix_beat_A.zip"
    beat = 60 / A_BPM
    make_zip(pa, "R23 voix sur beat A", {
        "bpm": A_BPM, "projectKey": 7, "projectScale": "MINOR", "beatTitle": "Beat A",
        "markers": [{"id": "m-couplet", "name": "Couplet", "time": A_DB + 4 * beat, "endTime": A_DB + 12 * beat, "type": "REGION", "color": "#22d3ee"},
                    {"id": "m-drop", "name": "Drop", "time": A_DB + 16 * beat, "type": "MARKER", "color": "#f97316"}],
        "chords": [{"id": "ch1", "start": A_DB + 4 * beat, "end": A_DB + 8 * beat, "root": 7, "quality": "min"},
                   {"id": "ch2", "start": A_DB + 8 * beat, "end": A_DB + 12 * beat, "root": 3, "quality": "maj"}],
    }, [
        {**TBASE, "id": "instrumental", "name": "BEAT", "type": "AUDIO", "color": "#eab308", "clips": [clip("beat-a", "Beat A", "audio/beatA.wav", 0, ba.shape[1] / SR)]},
        {**TBASE, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee",
         "plugins": [{"id": "at-1", "type": "AUTOTUNE", "name": "Auto-Tune", "isEnabled": True, "params": {"rootKey": 7, "scale": "MINOR", "speed": 0.5, "amount": 0.5}}],
         "clips": [clip("voix-1", "Couplet", "audio/voix.wav", VOICE_AT, va.shape[1] / SR)]},
    ], {"audio/voix.wav": (OUT / "voix_reelle.wav").read_bytes(), "audio/beatA.wav": (OUT / "beat_A_94_sol_mineur.wav").read_bytes()})
    tk, _ = read_wav(OUT / "prise_fausse_et_decalee.wav")
    pb = OUT / "projet_prise_a_refaire.zip"
    make_zip(pb, "R23 prise a refaire", {"bpm": SB_BPM, "projectKey": None, "markers": []}, [
        {**TBASE, "id": "instrumental", "name": "BEAT", "type": "AUDIO", "color": "#eab308", "clips": [clip("beat-sb", "Silence blanc (instru)", "audio/instru.wav", 0, tk.shape[1] / SR)]},
        {**TBASE, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee",
         "clips": [clip("prise-1", "Prise 1", "audio/prise.wav", 0, tk.shape[1] / SR, takeNumber=1)]},
    ], {"audio/prise.wav": (OUT / "prise_fausse_et_decalee.wav").read_bytes(), "audio/instru.wav": (OUT / "instru_silence_blanc.wav").read_bytes()})
    return pa, pb


# ------------------------------------------------------------------ mesures (Python)
def attacks(x, sr, min_gap=0.12):
    """Attaques nettes d'une voix : montée de ≥ 9 dB de l'énergie (trames de 5 ms) au-dessus de −40 dB du max."""
    m = mono(x); hop = int(0.005 * sr)
    n = len(m) // hop
    e = np.sqrt(np.array([np.mean(m[i * hop:(i + 1) * hop] ** 2) for i in range(n)]) + 1e-12)
    db = 20 * np.log10(e)
    top = np.max(db)
    out = []
    for i in range(4, n):
        if db[i] > top - 40 and db[i] - np.mean(db[i - 4:i - 1]) > 9 and (not out or i * 0.005 - out[-1] > min_gap):
            out.append(i * 0.005)
    return out


def env_ms(x, sr, t, half=40, scale=1.0):
    m = mono(x)
    out = []
    for k in range(-half, half + 1):
        i = int(round((t + k * 0.001 * scale) * sr))
        seg = m[max(0, i):max(0, i + 44)]
        out.append(np.sqrt(np.mean(seg ** 2)) if len(seg) else 0)
    return np.array(out)


def locate(a, sra, ta, b, srb, expect, scale):
    """Où est passée l'attaque `ta` du son a dans b (près de `expect`) : corrélation des enveloppes (1 ms)."""
    ea = env_ms(a, sra, ta, scale=scale)
    best, bv = 0, -2
    for L in np.arange(-25, 25.5, 0.5):
        eb = env_ms(b, srb, expect + L / 1000)
        r = np.corrcoef(ea, eb)[0, 1]
        if r > bv:
            bv, best = r, L
    return best, bv


# ------------------------------------------------------------------ page
def state_summary(page):
    return st(page, """s => ({ bpm: s.bpm, key: s.projectKey, scale: s.projectScale, beatTitle: s.beatTitle,
      beat: s.tracks.find(t => t.id === 'instrumental').clips.map(c => ({ id: c.id, name: c.name, start: c.start, duration: c.duration, bufferId: c.bufferId })),
      voix: s.tracks.find(t => t.id === 'voix').clips.map(c => ({ id: c.id, start: c.start, offset: c.offset, duration: c.duration, bufferId: c.bufferId, elastic: c.elastic ? { semitones: c.elastic.semitones, duration: c.elastic.duration, sourceDuration: c.elastic.sourceDuration, attacks: c.elastic.attacks, used: c.elastic.used } : null })),
      autotune: (s.tracks.find(t => t.id === 'voix').plugins[0] || {}).params,
      markers: s.markers.map(m => ({ id: m.id, time: m.time, endTime: m.endTime })), chords: (s.chords || []).map(c => ({ id: c.id, start: c.start, end: c.end, root: c.root })) })""")


def header_menu(page, track_name, item):
    """Clic droit sur l'en-tête de la piste, puis l'élément du menu."""
    h = page.locator("[data-track-header], .nova-grille").get_by_text(track_name, exact=True).first
    h.click(button="right")
    page.wait_for_timeout(500)
    page.get_by_text(item, exact=False).first.click()


@step("A_changer_de_beat")
def part_a(page):
    out = {}
    page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
    before = state_summary(page)
    out["avant"] = {"bpm": before["bpm"], "tonalite": before["key"], "voix": before["voix"]}
    try:
        header_menu(page, "BEAT", "Remplacer l’instru")
        out["ouverture"] = "menu de la piste BEAT"
    except Exception as e:  # noqa
        out["ouverture"] = f"menu introuvable ({str(e)[:80]}) : bus"
        page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); m.r23Bus.emit({ kind: 'openSwap' }); }")
    page.wait_for_selector("[data-testid=beat-swap-dialog]", timeout=15000)
    shot(page, "A1_fenetre_choisir_le_beat")
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_test_id("beatswap-file").click()
    fc.value.set_files(str(OUT / "beat_B_100_la_mineur.wav"))
    page.wait_for_selector("[data-testid=beatswap-plan]", timeout=180000)
    page.wait_for_timeout(600)
    shot(page, "A2_plan_avant_remplacement")
    out["plan"] = page.inner_text("[data-testid=beatswap-plan]")
    out["ancien"] = page.inner_text("[data-testid=beatswap-old]")
    out["nouveau"] = page.inner_text("[data-testid=beatswap-new]")
    out["alertes"] = [page.locator("[data-testid=beatswap-warning]").nth(i).inner_text() for i in range(page.locator("[data-testid=beatswap-warning]").count())]
    t0 = time.time()
    page.get_by_test_id("beatswap-go").click()
    page.wait_for_selector("[data-testid=beat-swap-result]", timeout=300000)
    out["rendu_s"] = round(time.time() - t0, 1)
    page.wait_for_timeout(800)
    shot(page, "A3_nouveau_beat_voix_recalee")
    after = state_summary(page)
    out["apres"] = {k: after[k] for k in ("bpm", "key", "beatTitle", "voix", "autotune", "markers", "chords")}
    # Son rendu de la voix, à sa place dans le projet.
    c = after["voix"][0]
    y, sr = buffer_of(page, c["bufferId"])
    a0 = int(round(c["offset"] * sr))
    y = y[:, a0:a0 + int(round(c["duration"] * sr))]
    (OUT / "voix_recalee_nova.wav").write_bytes(wav_bytes(y, sr))
    x, _ = read_wav(OUT / "voix_reelle.wav")
    k = A_BPM / B_BPM
    # Attaques : position musicale (en temps du beat A) → instant attendu sur la grille du beat B.
    rows = []
    for ta in attacks(x, SR):
        t_proj = VOICE_AT + ta
        beats = (t_proj - A_DB) / (60 / A_BPM)
        expect_proj = B_DB + beats * 60 / B_BPM
        expect_local = expect_proj - c["start"]
        if expect_local < 0.05 or expect_local > c["duration"] - 0.05:
            continue
        lag, r = locate(x, SR, ta, y, sr, expect_local, scale=k)
        if r < 0.5:
            continue
        rows.append({"attaque_s": round(t_proj, 3), "temps_du_beat": round(beats, 3), "attendu_s": round(expect_proj, 4), "ecart_ms": round(lag, 1), "corr": round(r, 2)})
    errs = np.array([abs(r["ecart_ms"]) for r in rows])
    out["attaques"] = rows
    out["attaques_n"] = len(rows)
    out["attaques_ecart_median_ms"] = round(float(np.median(errs)), 2) if len(errs) else None
    out["attaques_ecart_max_ms"] = round(float(np.max(errs)), 2) if len(errs) else None
    out["attaques_a_5ms"] = int(np.sum(errs <= 5.0))
    # Hauteur : YIN trame par trame, l'axe du temps du rendu ramené à celui de l'original.
    fa = yin_track(x, SR, hop=256)
    fb_full = yin_track(y, sr, hop=256)
    t_b = np.arange(len(fb_full)) * 256 / sr
    cents = []
    shift_local = (c["start"] - (B_DB + (VOICE_AT - A_DB) * k))  # début du clip rendu par rapport à la position attendue
    for i, f0 in enumerate(fa):
        if not np.isfinite(f0):
            continue
        tb = i * 256 / SR * k - shift_local
        j = int(round(tb * sr / 256))
        if 0 <= j < len(fb_full) and np.isfinite(fb_full[j]):
            cents.append(1200 * np.log2(fb_full[j] / f0))
    cents = np.array(cents)
    med = float(np.median(cents)) if len(cents) else float("nan")
    out["hauteur_cents_mediane"] = round(med, 2)
    out["hauteur_trames"] = int(len(cents))
    out["hauteur_ecart_a_200_cents"] = round(abs(med - 200), 2)
    # Repères et accords : même position musicale.
    def mus(t):
        return B_DB + (t - A_DB) * k
    mk = {m["id"]: m for m in after["markers"]}
    out["repere_couplet_ecart_ms"] = round(abs(mk["m-couplet"]["time"] - mus(A_DB + 4 * 60 / A_BPM)) * 1000, 2)
    out["accord_1_root"] = after["chords"][0]["root"]
    ok = (after["bpm"] == B_BPM and after["key"] == 9 and len(rows) >= 5 and out["attaques_ecart_median_ms"] <= 5
          and out["hauteur_ecart_a_200_cents"] <= 5 and after["voix"][0]["elastic"]["semitones"] == 2 and out["accord_1_root"] == 9
          and out["repere_couplet_ecart_ms"] < 20 and after["autotune"].get("rootKey") == 9)
    out["_ok"] = bool(ok)
    RES["_avant"], RES["_apres"] = before, after
    return out


@step("A_avant_apres_et_annulation")
def part_a_undo(page):
    out = {}
    before, after = RES["_avant"], RES["_apres"]
    same = lambda s, ref: s["bpm"] == ref["bpm"] and s["key"] == ref["key"] and [c["bufferId"] for c in s["voix"]] == [c["bufferId"] for c in ref["voix"]] \
        and abs(s["voix"][0]["start"] - ref["voix"][0]["start"]) < 1e-6 and [c["bufferId"] for c in s["beat"]] == [c["bufferId"] for c in ref["beat"]] \
        and [round(m["time"], 6) for m in s["markers"]] == [round(m["time"], 6) for m in ref["markers"]] and [c["root"] for c in s["chords"]] == [c["root"] for c in ref["chords"]] \
        and s["autotune"].get("rootKey") == ref["autotune"].get("rootKey")
    page.get_by_test_id("beatswap-show-before").click(); page.wait_for_timeout(700)
    out["avant_bouton_egal_etat_initial"] = same(state_summary(page), before)
    shot(page, "A4_avant")
    page.get_by_test_id("beatswap-show-after").click(); page.wait_for_timeout(700)
    out["apres_bouton_egal_nouveau"] = same(state_summary(page), after)
    page.get_by_test_id("beatswap-revert").click(); page.wait_for_timeout(900)
    s1 = state_summary(page)
    out["revenir_ancien_beat_complet"] = same(s1, before)
    shot(page, "A5_revenu_ancien_beat")
    # Ctrl+Y (le nouveau beat revient) puis UN SEUL Ctrl+Z.
    page.mouse.click(5, 5)
    page.keyboard.press("Control+y"); page.wait_for_timeout(900)
    out["ctrl_y_egal_nouveau"] = same(state_summary(page), after)
    page.keyboard.press("Control+z"); page.wait_for_timeout(900)
    out["un_seul_ctrl_z_egal_initial"] = same(state_summary(page), before)
    out["_ok"] = all(v for k, v in out.items())
    return out


@step("B_reperes_a_refaire")
def part_b(page):
    out = {}
    page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
    try:
        header_menu(page, "Voix lead", "Repérer les passages à refaire")
        out["ouverture"] = "menu de la piste voix"
    except Exception as e:  # noqa
        out["ouverture"] = f"menu introuvable ({str(e)[:80]}) : bus"
        page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); m.r23Bus.emit({ kind: 'findSpots', trackId: 'voix' }); }")
    page.wait_for_selector("[data-testid=redo-spot]", timeout=60000)
    page.wait_for_timeout(600)
    spots = page.evaluate("""async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); return m.redoSpotsStore.get().map(s => ({ id: s.id, start: s.start, end: s.end, reasons: s.reasons, label: s.label, score: s.score })); }""")
    out["reperes"] = spots
    hit = [s for s in spots if s["start"] < 18.9 and s["end"] > 16.8]
    out["phrase_fausse_reperee"] = bool(hit)
    out["phrase_fausse_rang"] = (spots.index(hit[0]) + 1) if hit else None
    out["raisons_phrase_fausse"] = hit[0]["reasons"] if hit else None
    # La timeline montre le passage : on y va.
    page.evaluate("""() => { const sc = document.querySelector('.nova-grille .custom-scroll'); if (sc) sc.scrollLeft = 0; }""")
    page.wait_for_timeout(500)
    shot(page, "B1_reperes_a_refaire_timeline")
    out["_ok"] = bool(hit) and ("justesse" in hit[0]["reasons"] or "calage" in hit[0]["reasons"])
    RES["_spot"] = hit[0] if hit else None
    return out


@step("B_refaire_ce_passage")
def part_b_redo(page):
    out = {}
    spot = RES.get("_spot")
    if not spot:
        raise RuntimeError("pas de repère à refaire")
    before = st(page, "s => s.tracks.find(t => t.id === 'voix').clips.map(c => ({ id: c.id, start: c.start, duration: c.duration, muted: !!c.isMuted, take: c.takeNumber }))")
    loc = page.locator(f"[data-spot-id='{spot['id']}'] [data-testid=redo-spot-go]")
    if loc.count() and loc.first.is_visible():
        loc.first.click(); out["declenche"] = "bouton Refaire du repère"
    else:
        page.evaluate(f"""async () => {{ const m = await window.__novaAppModule('/utils/r23Store.ts'); m.r23Bus.emit({{ kind: 'redo', spotId: '{spot['id']}' }}); }}""")
        out["declenche"] = "bus (repère hors écran)"
    page.wait_for_function("() => window.__novaEdit.getState().isRecording", timeout=30000)
    p = st(page, "s => ({ ...s.punch, armed: s.tracks.filter(t => t.isTrackArmed).map(t => t.id) })")
    out["zone_punch"] = {k: p.get(k) for k in ("enabled", "punchIn", "punchOut", "preRollOn", "preRollBars", "preRollSec")}
    out["pistes_armees"] = p["armed"]
    page.wait_for_timeout(1500)
    shot(page, "B2_prise_en_cours_zone_de_punch")
    page.wait_for_function("() => !window.__novaEdit.getState().isRecording", timeout=120000)
    page.wait_for_timeout(1500)
    after = st(page, "s => s.tracks.find(t => t.id === 'voix').clips.map(c => ({ id: c.id, start: c.start, duration: c.duration, muted: !!c.isMuted, take: c.takeNumber, fadeIn: c.fadeIn, fadeOut: c.fadeOut }))")
    out["clips_apres"] = after
    new = [c for c in after if c["take"] == 2]
    out["zone_sur_les_temps"] = None
    pin, pout = p["punchIn"], p["punchOut"]
    if new:
        n0 = new[0]
        xf = 0.01
        out["prise_debut_ecart_ms"] = round((n0["start"] - (pin - xf / 2)) * 1000, 2)
        out["prise_fin_ecart_ms"] = round((n0["start"] + n0["duration"] - (pout + xf / 2)) * 1000, 2)
    old_muted = [c for c in after if c["take"] == 1 and c["muted"] and c["start"] >= pin - 0.02 and c["start"] + c["duration"] <= pout + 0.02]
    out["ancien_passage_garde_mute"] = bool(old_muted)
    out["zone_couvre_le_repere"] = pin <= spot["start"] + 0.05 and pout >= spot["end"] - 0.05
    page.wait_for_selector("[data-testid=repunch-compare]", timeout=20000)
    page.wait_for_timeout(500)
    out["avant_apres"] = {"avant": page.inner_text("[data-testid=repunch-before]"), "apres": page.inner_text("[data-testid=repunch-after]"), "verdict": page.inner_text("[data-testid=repunch-verdict]")}
    shot(page, "B3_avant_apres")
    page.get_by_test_id("repunch-show-before").click(); page.wait_for_timeout(1200)
    old_audible = st(page, "s => s.tracks.find(t => t.id === 'voix').clips.filter(c => !c.isMuted).map(c => c.takeNumber)")
    out["ecoute_ancienne_take_audible"] = old_audible
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    page.get_by_test_id("repunch-show-after").click(); page.wait_for_timeout(800)
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    page.get_by_test_id("repunch-keep-new").click(); page.wait_for_timeout(600)
    final = st(page, "s => s.tracks.find(t => t.id === 'voix').clips.filter(c => !c.isMuted && c.takeNumber === 2).length")
    out["nouvelle_gardee"] = final >= 1
    shot(page, "B4_nouvelle_prise_gardee")
    out["_ok"] = bool(new) and out["zone_couvre_le_repere"] and abs(out.get("prise_debut_ecart_ms", 99)) <= 2 and abs(out.get("prise_fin_ecart_ms", 99)) <= 2 \
        and p["enabled"] and "voix" in p["armed"] and out["ancien_passage_garde_mute"] and out["nouvelle_gardee"] and old_audible.count(1) >= 1
    return out


def set_theme(page, theme):
    page.evaluate(f"() => {{ try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}} document.documentElement.setAttribute('data-theme', '{theme}'); }}")
    page.wait_for_timeout(300)


def captures(browser, log, pa, pb):
    out = {}
    for vp in ("tab", "tel"):
        for theme in (("dark", "light") if vp == "tab" else ("dark",)):
            ctx, page = new_page(browser, vp, log)
            ctx.add_init_script(INIT)
            page.set_default_timeout(30000)
            prepare(page)
            open_project_file(page, pa, {}, f"C_{vp}_{theme}_0_projet")
            page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
            set_theme(page, theme)
            # Panneau voix : les deux boutons (Changer de beat, Refaire un passage).
            b = page.locator("[data-nova-target=mix-auto]").locator("visible=true")
            if b.count():
                b.first.click(); page.wait_for_timeout(800)
                shot(page, f"C_{vp}_{theme}_1_panneau_voix")
                page.get_by_test_id("r23-swap").first.click()
            else:
                page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); m.r23Bus.emit({ kind: 'openSwap' }); }")
            page.wait_for_selector("[data-testid=beat-swap-dialog]", timeout=15000)
            with page.expect_file_chooser(timeout=10000) as fc:
                page.get_by_test_id("beatswap-file").click()
            fc.value.set_files(str(OUT / "beat_B_100_la_mineur.wav"))
            page.wait_for_selector("[data-testid=beatswap-plan]", timeout=180000)
            page.wait_for_timeout(500)
            shot(page, f"C_{vp}_{theme}_2_changer_de_beat")
            out[f"{vp}_{theme}_debordement"] = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            page.get_by_test_id("beatswap-go").click()
            page.wait_for_selector("[data-testid=beat-swap-result]", timeout=300000)
            page.wait_for_timeout(600)
            shot(page, f"C_{vp}_{theme}_3_resultat")
            ctx.close()
            # Repères à refaire (prise fausse).
            ctx, page = new_page(browser, vp, log)
            ctx.add_init_script(INIT)
            page.set_default_timeout(30000)
            prepare(page)
            open_project_file(page, pb, {}, f"C_{vp}_{theme}_4_projet_prise")
            page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
            set_theme(page, theme)
            b = page.locator("[data-nova-target=mix-auto]").locator("visible=true")
            if b.count():
                b.first.click(); page.wait_for_timeout(800)
                page.get_by_test_id("r23-find").first.click()
            else:
                page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); m.r23Bus.emit({ kind: 'findSpots', trackId: 'voix' }); }")
            page.wait_for_timeout(4000)
            out[f"{vp}_{theme}_reperes"] = page.locator("[data-testid=redo-spot]").count()
            # On fait défiler la timeline jusqu'au passage repéré.
            page.evaluate("""async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); const s = m.redoSpotsStore.get()[0]; const sc = document.querySelector('.nova-grille .custom-scroll');
              if (s && sc) { const z = sc.scrollWidth / Math.max(60, 300); sc.scrollLeft = Math.max(0, s.start * 40 - 120); } }""")
            page.wait_for_timeout(700)
            sp = page.locator("[data-testid=redo-spot]").locator("visible=true")
            if sp.count():
                # Clic sur le début du bandeau (pas sur « Refaire ») : la bulle des raisons.
                sp.first.click(position={"x": 8, "y": 10}); page.wait_for_timeout(500)
            out[f"{vp}_{theme}_liste_telephone"] = page.locator("[data-testid=redo-spot-row]").count()
            shot(page, f"C_{vp}_{theme}_5_reperes_a_refaire")
            if vp == "tel" and page.locator("[data-testid=redo-spot-row-go]").count():
                page.locator("[data-testid=redo-spot-row-go]").first.click()
                try:
                    page.wait_for_function("() => window.__novaEdit.getState().isRecording", timeout=30000)
                    page.wait_for_timeout(1200)
                    shot(page, f"C_{vp}_{theme}_6_refaire_en_cours")
                    page.wait_for_function("() => !window.__novaEdit.getState().isRecording", timeout=120000)
                    page.wait_for_selector("[data-testid=repunch-compare]", timeout=20000)
                    page.wait_for_timeout(500)
                    shot(page, f"C_{vp}_{theme}_7_avant_apres")
                    out[f"{vp}_{theme}_refaire_ok"] = True
                except Exception as e:  # noqa
                    out[f"{vp}_{theme}_refaire_ok"] = f"échec : {str(e)[:120]}"
                    RES["ok"] = False
            ctx.close()
    return out


def run():
    prepare_audio()
    pa, pb = projects()
    parts = os.environ.get("R23_PARTS", "ABC")
    with sync_playwright() as p:
        b = launch(p)
        log = Log("r23")
        if "A" in parts:
            ctx, page = new_page(b, "pc", log)
            ctx.add_init_script(INIT)
            page.set_default_timeout(30000)
            prepare(page)
            open_project_file(page, pa, {}, "A0_projet_voix_beat_A")
            part_a(page)
            if RES.get("_apres"):
                part_a_undo(page)
            ctx.close()
        if "B" in parts:
            ctx, page = new_page(b, "pc", log)
            ctx.add_init_script(INIT)
            page.set_default_timeout(30000)
            prepare(page)
            open_project_file(page, pb, {}, "B0_projet_prise_a_refaire")
            part_b(page)
            part_b_redo(page)
            ctx.close()
        if "C" in parts:
            t0 = time.time()
            try:
                RES["etapes"]["C_captures"] = {"ok": True, **captures(b, log, pa, pb), "s": round(time.time() - t0, 1)}
            except Exception as e:  # noqa
                RES["ok"] = False
                RES["etapes"]["C_captures"] = {"ok": False, "erreur": f"{type(e).__name__}: {str(e)[:500]}"}
        RES["erreurs_console"] = [e["text"][:300] for e in log.errors()][:30]
        b.close()
    RES.pop("_avant", None); RES.pop("_apres", None); RES.pop("_spot", None)
    save()
    print(json.dumps(RES, ensure_ascii=False, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


if __name__ == "__main__":
    run()
