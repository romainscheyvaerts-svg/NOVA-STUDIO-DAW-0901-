"""L5 · écart 19 · Étirement « haute qualité » dans la vraie page (navigateur headless, aucune fenêtre,
Supabase simulé : jamais la production).

Une boucle de batterie STÉRÉO (coups toutes les 250 ms, droite en retard de 0,3 ms) calée sur le tempo
(warp) à 90 BPM ; le tempo du projet passe à 112,5 puis à 72 BPM (comme l'utilisateur au clavier) :
NOVA réétire le clip depuis l'original, dans le Worker de utils/timeStretch. On relit le son
enregistré dans le projet (.zip) et on mesure :
  - chaque attaque à sa nouvelle place, à ±2 ms (−20 % et +25 % de durée) ;
  - pas de pré-écho (énergie avant l'attaque ≥ 30 dB sous l'attaque) ;
  - l'image stéréo gardée (corrélation gauche / droite au retard d'origine ≥ 0,99) ;
  - la durée exacte ; le temps de calcul.

NOVA_URL=http://127.0.0.1:3523/ python qa/etirement_banc.py
Sortie : D:\\1 WORK\\CONTENU\\nova-pro-2026\\voixrep\\etirement (QA_OUT) ; code 0 si tout passe.
"""
import io, json, os, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\voixrep\etirement")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3523/")
from qalib import *  # noqa
from qalib import OUT, run_one, shot  # noqa
from gel_pre_effet import open_project_file, save_zip  # noqa
from stems_separation import prepare, dismiss_popups  # noqa
from voix_propre import read_wav_bytes, theme  # noqa

SR = 48000
SECS = 4.0
ONSETS = [0.25 + 0.25 * k for k in range(15)]
DELAY = int(round(0.0003 * SR))


def make_project(path: Path):
    n = int(SECS * SR)
    rng = np.random.default_rng(9)
    L = np.zeros(n)
    for t in ONSETS:
        i0 = int(round(t * SR)); m = int(0.06 * SR)
        L[i0:i0 + m] += 0.6 * np.exp(-np.arange(m) / (0.006 * SR)) * rng.uniform(-1, 1, m)
    R = np.zeros(n); R[DELAY:] = L[:-DELAY]
    st = np.stack([L, R], 1)
    q = np.clip(np.round(st * 32767), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(q.tobytes())
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    beat = {**base, "id": "beat", "name": "Beat", "type": "AUDIO", "color": "#22d3ee",
            "clips": [{"id": "boucle", "name": "Boucle", "type": "AUDIO", "audioRef": "audio/boucle.wav", "color": "#22d3ee",
                       "fadeIn": 0, "fadeOut": 0, "gain": 1.0, "start": 0.0, "offset": 0.0, "duration": SECS,
                       "warp": {"enabled": True, "mode": "BEATS", "originalBpm": 90, "preservePitch": True}}]}
    state = {
        "id": "proj-etirement", "name": "Banc d'étirement (L5)", "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [beat], "trackGroups": [], "markers": [], "selectedTrackId": "beat", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/boucle.wav", buf.getvalue())


def read_stereo(raw):
    with wave.open(io.BytesIO(raw)) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        frames = w.readframes(n)
    if sw == 4:
        y = np.frombuffer(frames, "<f4").reshape(-1, ch).astype(np.float64)
    elif sw == 3:
        b = np.frombuffer(frames, np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        v = np.where(v & 0x800000, v - 0x1000000, v)
        y = (v.reshape(-1, ch) / 8388608).astype(np.float64)
    else:
        y = np.frombuffer(frames, "<i2").reshape(-1, ch).astype(np.float64) / 32768
    return y, sr


def coherence(L, R, sr):
    """Corrélation gauche / droite au meilleur retard autour de 0,3 ms (le projet peut tourner à 44,1 kHz)."""
    i0, i1 = int(len(L) * 0.1), int(len(L) * 0.9)
    best = -1.0
    for d in range(0, int(round(0.0006 * sr)) + 1):
        a, b = L[i0:i1], R[i0 + d:i1 + d]
        best = max(best, float(np.sum(a * b) / np.sqrt(np.sum(a * a) * np.sum(b * b) + 1e-20)))
    return best


def measure(y, sr, factor):
    L = y[:, 0]; R = y[:, 1] if y.shape[1] > 1 else y[:, 0]
    w = max(1, int(0.0005 * sr))
    env = np.convolve(np.abs(L), np.ones(w) / w, mode="same")
    errs, pre_db = [], []
    for t in ONSETS:
        c = int(round(t * factor * sr))
        a, b = max(0, c - int(0.03 * sr)), min(len(env), c + int(0.03 * sr))
        seg = env[a:b]; pk = seg.max(); pki = a + int(seg.argmax())
        on = pki
        while on > a and env[on - 1] >= pk / 2:
            on -= 1
        errs.append((on - c) / sr * 1000)
        pre = np.sum(L[max(0, c - int(0.02 * sr)):c - int(0.002 * sr)] ** 2)
        post = np.sum(L[c:c + int(0.02 * sr)] ** 2)
        pre_db.append(10 * np.log10((pre + 1e-20) / (post + 1e-20)))
    coh = coherence(L, R, sr)
    return {"attaques_ms_max": round(max(abs(e) for e in errs), 3), "attaques_ms_moy": round(float(np.mean(np.abs(errs))), 3),
            "pre_echo_db_pire": round(max(pre_db), 1), "stereo": round(coh, 4), "duree_s": round(len(L) / sr, 4)}


def stretch_to(page, bpm, label, res):
    b0 = page.evaluate("() => window.DAW_CONTROL.getState().tracks[0].clips[0].bufferId")
    t0 = time.time()
    page.evaluate(f"() => window.DAW_CONTROL.setBpm({bpm})")
    page.wait_for_function(f"(b0) => {{ const c = window.DAW_CONTROL.getState().tracks[0].clips[0]; return c.bufferId !== b0 && c.warp && Math.abs(c.warp.originalBpm - {bpm}) < 0.01; }}", arg=b0, timeout=120000)
    res[f"calcul_{label}_s"] = round(time.time() - t0, 2)
    page.wait_for_timeout(800)
    shot(page, f"{label}_cale")
    d, _ = save_zip(page, OUT / f"{label}.zip")
    c = d["tracks"][0]["clips"][0]
    with zipfile.ZipFile(OUT / f"{label}.zip") as z:
        y, sr = read_stereo(z.read(c["audioRef"]))
    off = int(round((c.get("offset") or 0) * sr))
    y = y[off: off + int(round(c["duration"] * sr))]
    factor = 90 / bpm
    m = measure(y, sr, factor)
    m["frequence"] = sr
    m["duree_attendue_s"] = round(SECS * factor, 4)
    res[label] = m


def scenario(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "00_projet")
    dismiss_popups(page, 3000)
    # Référence : la boucle telle que NOVA la joue avant tout étirement (même fréquence de projet).
    d, _ = save_zip(page, OUT / "origine.zip")
    c = d["tracks"][0]["clips"][0]
    with zipfile.ZipFile(OUT / "origine.zip") as z:
        y, sr = read_stereo(z.read(c["audioRef"]))
    res["origine"] = measure(y, sr, 1.0)
    stretch_to(page, 112.5, "plus_rapide_x0_8", res)
    stretch_to(page, 72, "plus_lent_x1_25", res)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    PROJECT = OUT / "projet_etirement.zip"
    make_project(PROJECT)
    theme("dark")
    R = run_one(scenario, "pc", "etirement")
    checks = {}
    for k in ("plus_rapide_x0_8", "plus_lent_x1_25"):
        m = R.get(k) or {}
        checks[f"{k} · attaques à ±2 ms de leur nouvelle place"] = bool(m) and m["attaques_ms_max"] <= 2
        checks[f"{k} · pas de pré-écho (≥ 30 dB sous l'attaque)"] = bool(m) and m["pre_echo_db_pire"] < -30
        o = R.get("origine") or {}
        checks[f"{k} · image stéréo gardée (à 0,01 près de l'original)"] = bool(m) and bool(o) and m["stereo"] >= o["stereo"] - 0.01
        checks[f"{k} · durée exacte"] = bool(m) and abs(m["duree_s"] - m["duree_attendue_s"]) < 0.002
    checks["aucune erreur dans la console"] = R.get("ok") and not R.get("errors")
    report = {"url": os.environ["NOVA_URL"], "resultat": R, "verifications": checks, "ok": all(bool(v) for v in checks.values())}
    (OUT / "qa_etirement.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for k, v in checks.items():
        print(("OK   " if v else "ÉCHEC"), k)
    print("origine", R.get("origine"))
    for k in ("plus_rapide_x0_8", "plus_lent_x1_25"):
        print(k, R.get(k), "calcul", R.get(f"calcul_{k}_s"), "s")
    if R.get("notes") or R.get("errors"):
        print(R.get("notes"), (R.get("errors") or [])[:5])
    print("OK" if report["ok"] else "ÉCHEC")
    sys.exit(0 if report["ok"] else 1)
