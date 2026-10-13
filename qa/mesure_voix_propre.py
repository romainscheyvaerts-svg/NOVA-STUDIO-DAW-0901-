"""Lot 1 « Voix propre » : mesures du nettoyage de voix (bruit, qualité, temps).

Prises : 10 vraies prises rap SÈCHES du studio (cabine, séance « 13 mini 22 04 vs 2 »,
liste de nova-r24/transcription/reference_prises_rap.json), mêlées à 3 bruits
synthétiques reproductibles (graine fixe) :
  - ventilation : bruit rose filtré (bosse 100 Hz – 1,2 kHz), ronflement du moteur
    (100 / 200 / 300 Hz) et battement des pales (12 Hz) ;
  - souffle     : souffle de préampli / micro de téléphone (bruit blanc filtré au-dessus de 2 kHz) ;
  - pièce       : bruit de pièce et de rue lointaine (grondement grave < 400 Hz + bruit rose).
Voix ramenée à −20 dBFS efficaces sur les phrases ; bruit à −30 dBFS (prise très
bruyante, environ 10 dB sous la voix) et à −45 dBFS (prise maison courante).

Moteurs :
  - site : la VRAIE chaîne du navigateur (utils/voiceClean + RNNoise WASM) sous Node
    (qa/mesure_voix_propre_moteur.ts, vite-node), Léger / Moyen / Fort ;
  - Windows : DeepFilterNet 3 du module voix installé sur ce PC (%LOCALAPPDATA%\\NovaStudio\\voice,
    même exécutable que le pont), sans la réverbe tardive, puis la même finition (mélange, niveau).

Mesures :
  - bruit dans les silences (trames de 20 ms où la prise sèche est muette, ±100 ms) :
    énergie après / avant, en dB (niveau désactivé pour isoler le débruitage) ;
  - qualité de la voix : écart du spectre moyen de la voix (tiers d'octave 315 Hz – 5 kHz)
    traitée vs la prise sèche, SI-SDR avant / après ; « null test » : la prise SÈCHE
    passée seule dans le nettoyage, résidu (traitée − sèche) en dB sous la voix ;
  - réverbe : prise sèche + vraie réverbe de salon (RT60 0,8 s, nova-r24/deverb), queue
    après les fins de phrase (même mesure que B7) : site (pas de déréverbération, contrôle)
    et Windows (DeepFilterNet 3 + réverbe tardive) ;
  - temps de calcul et facteur temps réel (× la durée du clip).

Usage : python qa/mesure_voix_propre.py [--rapide] [--sans-windows] [sortie]
Sortie par défaut : D:\\1 WORK\\CONTENU\\nova-bandlab\\lot1_voix_propre\\mesures
"""
import json, os, subprocess, sys, time
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly, fftconvolve, welch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
ARGS = [a for a in sys.argv[1:]]
RAPIDE = "--rapide" in ARGS
SANS_WIN = "--sans-windows" in ARGS
ARGS = [a for a in ARGS if not a.startswith("--")]
OUT = Path(ARGS[0]) if ARGS else Path(r"D:\1 WORK\CONTENU\nova-bandlab\lot1_voix_propre\mesures")
WORK = OUT / "wav"
SR = 48000
SESSION = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
R24 = Path(r"D:\1 WORK\CONTENU\nova-r24")
VOICE_HOME = Path(os.environ.get("LOCALAPPDATA", "")) / "NovaStudio" / "voice"
VOICE_PY = VOICE_HOME / "env" / "Scripts" / "python.exe"
NOISES = ["ventilation", "souffle", "piece"]
LEVELS = [-30, -45]
STRENGTHS = ["light", "medium", "strong"]
NO_WINDOW = 0x08000000


def load48(path):
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.mean(1)
    if sr != SR:
        g = gcd(sr, SR)
        x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    return x


def frames_db(x, hop=0.02):
    n = int(hop * SR)
    m = len(x) // n
    e = np.mean(np.square(x[: m * n].reshape(m, n), dtype=np.float64), 1)
    return 10 * np.log10(e + 1e-14), n


def active_rms_db(x):
    db, n = frames_db(x)
    act = db > np.percentile(db, 99) - 30
    return 10 * np.log10(np.mean(np.power(10, db[act] / 10)))


# ─── Bruits ───────────────────────────────────────────────────────────────────

def pink(n, rng):
    X = rng.standard_normal(n // 2 + 1) + 1j * rng.standard_normal(n // 2 + 1)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = 1
    X /= np.sqrt(f)
    X[0] = 0
    return np.fft.irfft(X, n)


def make_noise(kind, n, seed):
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    if kind == "ventilation":
        x = sosfilt(butter(2, [100, 1200], "bandpass", fs=SR, output="sos"), pink(n, rng))
        x /= np.std(x) + 1e-12
        hum = sum(a * np.sin(2 * np.pi * f * t + rng.uniform(0, 6)) for f, a in ((100, 0.5), (200, 0.3), (300, 0.15)))
        x = (x + hum) * (1 + 0.15 * np.sin(2 * np.pi * 12 * t))
    elif kind == "souffle":
        x = sosfilt(butter(2, 2000, "highpass", fs=SR, output="sos"), rng.standard_normal(n)) + 0.25 * rng.standard_normal(n)
    else:  # pièce / rue lointaine
        brown = np.cumsum(rng.standard_normal(n))
        brown = sosfilt(butter(2, [20, 400], "bandpass", fs=SR, output="sos"), brown)
        brown /= np.std(brown) + 1e-12
        p = pink(n, rng)
        x = brown + 0.6 * p / (np.std(p) + 1e-12)
    return (x / (np.sqrt(np.mean(x ** 2)) + 1e-12)).astype(np.float32)


# ─── Mesures ──────────────────────────────────────────────────────────────────

def silence_mask(clean):
    """Trames de 20 ms où la prise sèche est muette, et le reste ±100 ms autour."""
    db, n = frames_db(clean)
    quiet = db < max(-60.0, np.percentile(db, 99) - 50)
    k = 5
    ok = np.array([quiet[max(0, i - k): i + k + 1].all() for i in range(len(quiet))])
    return ok, n


def energy_on(x, mask, n):
    m = len(mask)
    e = np.mean(np.square(x[: m * n].reshape(m, n), dtype=np.float64), 1)
    return float(np.sum(e[mask]))


def noise_reduction_db(noisy, out, clean):
    mask, n = silence_mask(clean)
    if mask.sum() < 10:
        return None, int(mask.sum())
    return round(10 * np.log10(energy_on(out, mask, n) / max(1e-20, energy_on(noisy, mask, n))), 1), int(mask.sum())


THIRD = [315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000]


def voice_spectrum(x, clean):
    db, n = frames_db(clean)
    act = db > np.percentile(db, 99) - 25
    seg = np.concatenate([x[i * n:(i + 1) * n] for i in np.where(act)[0]])
    f, p = welch(seg, SR, nperseg=4096)
    bands = []
    for fc in THIRD:
        lo, hi = fc / 2 ** (1 / 6), fc * 2 ** (1 / 6)
        bands.append(np.mean(p[(f >= lo) & (f < hi)]))
    return 10 * np.log10(np.array(bands) + 1e-20)


def spectral_dev(out, clean):
    """Écart du spectre de la voix (dB par tiers d'octave, 315 Hz – 5 kHz). « forme » : écart
    une fois retiré le changement de volume moyen (utile quand le niveau est égalisé)."""
    d = voice_spectrum(out, clean) - voice_spectrum(clean, clean)
    f = d - np.mean(d)
    return {"max_abs_db": round(float(np.max(np.abs(d))), 2), "moyen_abs_db": round(float(np.mean(np.abs(d))), 2),
            "forme_max_abs_db": round(float(np.max(np.abs(f))), 2), "gain_moyen_db": round(float(np.mean(d)), 2),
            "par_bande_db": [round(float(v), 1) for v in d]}


def si_sdr(est, ref):
    est = est - est.mean(); ref = ref - ref.mean()
    a = np.dot(est, ref) / (np.dot(ref, ref) + 1e-12)
    s = a * ref
    return round(float(10 * np.log10(np.sum(s ** 2) / (np.sum((est - s) ** 2) + 1e-20))), 1)


def null_residual_db(out, clean):
    db, n = frames_db(clean)
    act = db > np.percentile(db, 99) - 25
    idx = np.concatenate([np.arange(i * n, (i + 1) * n) for i in np.where(act)[0]])
    r = out[idx] - clean[idx]
    return round(float(10 * np.log10(np.sum(r ** 2) / (np.sum(clean[idx] ** 2) + 1e-20))), 1)


def phrase_ends(ref):
    db, n = frames_db(ref, 0.01)
    top = np.percentile(db, 99)
    act = db > top - 25
    quiet = db < top - 40
    ends, i = [], 1
    while i < len(db) - 30:
        if act[i - 1] and not act[i]:
            j = i
            while j < len(db) and not quiet[j] and j - i < 15:
                j += 1
            if j < len(db) - 20 and quiet[j: j + 20].all():
                ends.append(i * n); i = j + 20; continue
        i += 1
    return ends


def tail_db(sig, ends):
    vals = []
    a, b, c = int(0.25 * SR), int(0.02 * SR), int(0.25 * SR)
    for e in ends:
        if e - a < 0 or e + c > len(sig):
            continue
        before = np.mean(np.square(sig[e - a: e], dtype=np.float64))
        after = np.mean(np.square(sig[e + b: e + c], dtype=np.float64))
        if before > 0:
            vals.append(10 * np.log10(after / before + 1e-14))
    return (round(float(np.mean(vals)), 1) if vals else None), len(vals)


# ─── Moteurs ──────────────────────────────────────────────────────────────────

def run_web(jobs, tag):
    jp, rp = WORK / f"travaux_{tag}.json", WORK / f"resultats_{tag}.json"
    jp.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
    t = time.time()
    r = subprocess.run(["cmd", "/c", "npx", "vite-node", "qa/mesure_voix_propre_moteur.ts", "--", str(jp), str(rp)], cwd=str(ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError("moteur web : " + (r.stderr or r.stdout)[-1500:])
    print(f"  moteur web ({tag}) : {len(jobs)} traitements en {time.time() - t:.0f} s", flush=True)
    return json.loads(rp.read_text(encoding="utf-8"))


def run_dfn3(src, dst, late=False):
    args = [str(VOICE_PY), str(VOICE_HOME / "voice_worker.py"), "deverb", "--input", str(src), "--output", str(dst)] + ([] if late else ["--no-late"])
    t = time.time()
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    done = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]
    done = [d for d in done if d.get("event") == "done"]
    if not done:
        raise RuntimeError("DeepFilterNet 3 : " + (r.stdout + r.stderr)[-800:])
    return {"seconds_worker": done[0].get("seconds"), "seconds_total": round(time.time() - t, 2)}


def wavw(path, x):
    sf.write(str(path), np.asarray(x, np.float32), SR, subtype="FLOAT")


def wavr(path):
    return sf.read(str(path), dtype="float32", always_2d=True)[0].mean(1)


# ─── Déroulé ──────────────────────────────────────────────────────────────────

def main():
    WORK.mkdir(parents=True, exist_ok=True)
    ref = json.loads((R24 / "transcription" / "reference_prises_rap.json").read_text(encoding="utf-8"))
    files = [p["fichier"] for p in ref["prises"]][: (3 if RAPIDE else 10)]
    takes = {}
    for f in files:
        x = load48(SESSION / f)
        x = x * (10 ** ((-20 - active_rms_db(x)) / 20))
        takes[f.replace(".wav", "")] = x.astype(np.float32)
    print(f"{len(takes)} prises : {', '.join(takes)}", flush=True)

    # 1. Fichiers : prise sèche, et prise + bruit (3 bruits × 2 niveaux)
    items = []
    for ti, (name, clean) in enumerate(takes.items()):
        wavw(WORK / f"{name}_sec.wav", clean)
        for ni, kind in enumerate(NOISES):
            nz = make_noise(kind, len(clean), 1000 + 10 * ti + ni)
            for lv in LEVELS:
                noisy = clean + nz * 10 ** (lv / 20)
                key = f"{name}_{kind}_{lv}"
                wavw(WORK / f"{key}.wav", noisy)
                items.append({"key": key, "take": name, "noise": kind, "level": lv})

    # 2. Site : RNNoise + finition, Léger / Moyen / Fort (niveau désactivé pour mesurer le bruit), puis niveau activé (Moyen)
    jobs = []
    for it in items:
        for st in STRENGTHS:
            jobs.append({"input": str(WORK / f"{it['key']}.wav"), "output": str(WORK / f"{it['key']}_web_{st}.wav"), "cacheKey": it["key"],
                         "options": {"noise": True, "reverb": False, "level": False, "strength": st}})
        jobs.append({"input": str(WORK / f"{it['key']}.wav"), "output": str(WORK / f"{it['key']}_web_medium_tout.wav"), "cacheKey": it["key"],
                     "options": {"noise": True, "reverb": True, "level": True, "strength": "medium"}})
    for name, clean in takes.items():  # temps sur un projet à 44,1 kHz (conversion 48 kHz aller-retour comprise)
        noisy = clean + make_noise("ventilation", len(clean), 7) * 10 ** (-30 / 20)
        sf.write(str(WORK / f"{name}_44k.wav"), resample_poly(noisy, 147, 160).astype(np.float32), 44100, subtype="FLOAT")
        jobs.append({"input": str(WORK / f"{name}_44k.wav"), "output": str(WORK / f"{name}_44k_web_tout.wav"),
                     "options": {"noise": True, "reverb": True, "level": True, "strength": "medium"}})
    for name in takes:  # null test : la prise sèche seule
        for st in STRENGTHS:
            jobs.append({"input": str(WORK / f"{name}_sec.wav"), "output": str(WORK / f"{name}_sec_web_{st}.wav"), "cacheKey": f"{name}_sec",
                         "options": {"noise": True, "reverb": False, "level": False, "strength": st}})
    web = run_web(jobs, "bruit")
    web_by_out = {Path(r["output"]).name: r for r in web["results"]}

    # 3. Windows : DeepFilterNet 3 (module voix installé), puis la même finition
    win = {}
    if not SANS_WIN and VOICE_PY.is_file():
        jobs2 = []
        for it in items + [{"key": f"{n}_sec"} for n in takes]:
            src = WORK / f"{it['key']}.wav"
            dfn = WORK / f"{it['key']}_dfn3.wav"
            win[it["key"]] = run_dfn3(src, dfn, late=False)
            for st in STRENGTHS:
                jobs2.append({"input": str(src), "output": str(WORK / f"{it['key']}_win_{st}.wav"), "external": str(dfn), "reverb": False,
                              "options": {"noise": True, "reverb": False, "level": False, "strength": st}})
        print(f"  DeepFilterNet 3 : {len(win)} fichiers", flush=True)
        web2 = run_web(jobs2, "windows")
        for r in web2["results"]:
            web_by_out[Path(r["output"]).name] = r

    # 4. Mesures
    rows = []
    for it in items:
        clean = takes[it["take"]]
        noisy = wavr(WORK / f"{it['key']}.wav")
        base = {"prise": it["take"], "bruit": it["noise"], "niveau_bruit_dbfs": it["level"], "si_sdr_avant": si_sdr(noisy, clean)}
        for eng in ("web", "win"):
            for st in STRENGTHS + (["medium_tout"] if eng == "web" else []):
                p = WORK / f"{it['key']}_{eng}_{st}.wav"
                if not p.is_file():
                    continue
                out = wavr(p)
                nr, nsil = noise_reduction_db(noisy, out, clean)
                r = web_by_out.get(p.name, {})
                t = r.get("ms", 0) / 1000
                if eng == "win":
                    t += win[it["key"]]["seconds_total"]
                rows.append({**base, "moteur": "site (RNNoise)" if eng == "web" else "Windows (DeepFilterNet 3)", "force": st, "cache_reutilise": bool(r.get("cache_reutilise")),
                             "bruit_retire_db": nr, "trames_silence": nsil, "si_sdr_apres": si_sdr(out, clean),
                             "spectre_voix": spectral_dev(out, clean), "temps_s": round(t, 2), "duree_s": round(len(clean) / SR, 2),
                             "facteur_temps_reel": round(t / (len(clean) / SR), 3), "stats_nova": r.get("stats")})
    nulls = []
    for name, clean in takes.items():
        for eng in ("web", "win"):
            for st in STRENGTHS:
                p = WORK / f"{name}_sec_{eng}_{st}.wav"
                if p.is_file():
                    out = wavr(p)
                    nulls.append({"prise": name, "moteur": eng, "force": st, "residu_db": null_residual_db(out, clean), "spectre_voix": spectral_dev(out, clean)})

    # 5. Réverbe (site) : prise sèche + vraie réverbe de salon
    rev = {}
    dry = load48(R24 / "deverb" / "rap_0_sec.wav")
    wet = load48(R24 / "deverb" / "rap_salon_RT60_0.8s_2m_1_avant.wav")
    wavw(WORK / "salon_avant.wav", wet)
    jobs3 = [{"input": str(WORK / "salon_avant.wav"), "output": str(WORK / f"salon_web_{st}.wav"), "cacheKey": "salon",
              "options": {"noise": True, "reverb": True, "level": False, "strength": st}} for st in STRENGTHS]
    web3 = run_web(jobs3, "reverbe")
    ends = phrase_ends(dry)
    q_dry, q_wet = tail_db(dry, ends)[0], tail_db(wet, ends)[0]
    rev = {"fins_de_phrase": len(ends), "queue_seche_db": q_dry, "queue_salon_db": q_wet, "site": {}}
    for r in web3["results"]:
        out = wavr(r["output"])
        q = tail_db(out, ends)[0]
        rev["site"][Path(r["output"]).stem.replace("salon_web_", "")] = {"queue_db": q, "reverbe_retiree_db": None if q is None else round(q - q_wet, 1),
                                                                          "temps_s": round(r["ms"] / 1000, 2), "rt60_lu": (r.get("stats") or {}).get("rt60")}
    if not SANS_WIN and VOICE_PY.is_file():
        tw = run_dfn3(WORK / "salon_avant.wav", WORK / "salon_dfn3_late.wav", late=True)
        q = tail_db(wavr(WORK / "salon_dfn3_late.wav"), ends)[0]
        rev["windows_dfn3_queue"] = {"queue_db": q, "reverbe_retiree_db": None if q is None else round(q - q_wet, 1), "temps_s": tw["seconds_total"]}

    # 6. Synthèse
    def agg(sel):
        if not sel:
            return None
        nr = [r["bruit_retire_db"] for r in sel if r["bruit_retire_db"] is not None]
        return {"n": len(sel), "bruit_retire_db_median": round(float(np.median(nr)), 1) if nr else None,
                "bruit_retire_db_pire": round(float(np.max(nr)), 1) if nr else None,
                "spectre_voix_max_abs_db_median": round(float(np.median([r["spectre_voix"]["max_abs_db"] for r in sel])), 2),
                "spectre_voix_max_abs_db_pire": round(float(np.max([r["spectre_voix"]["max_abs_db"] for r in sel])), 2),
                "spectre_voix_forme_max_abs_db_median": round(float(np.median([r["spectre_voix"]["forme_max_abs_db"] for r in sel])), 2),
                "si_sdr_gain_db_median": round(float(np.median([r["si_sdr_apres"] - r["si_sdr_avant"] for r in sel])), 1),
                "facteur_temps_reel_median": (round(float(np.median([r["facteur_temps_reel"] for r in sel if not r["cache_reutilise"]])), 3)
                                              if any(not r["cache_reutilise"] for r in sel) else None)}
    synth = {}
    for eng in ("site (RNNoise)", "Windows (DeepFilterNet 3)"):
        for st in STRENGTHS + ["medium_tout"]:
            for lv in LEVELS:
                for kind in NOISES + ["tous"]:
                    sel = [r for r in rows if r["moteur"] == eng and r["force"] == st and r["niveau_bruit_dbfs"] == lv and (kind == "tous" or r["bruit"] == kind)]
                    a = agg(sel)
                    if a:
                        synth[f"{eng} · {st} · bruit {lv} dBFS · {kind}"] = a
    null_synth = {}
    for eng in ("web", "win"):
        for st in STRENGTHS:
            sel = [x for x in nulls if x["moteur"] == eng and x["force"] == st]
            if sel:
                null_synth[f"{eng} · {st}"] = {"residu_db_median": round(float(np.median([x["residu_db"] for x in sel])), 1),
                                               "spectre_voix_max_abs_db_median": round(float(np.median([x["spectre_voix"]["max_abs_db"] for x in sel])), 2)}
    t44 = [web_by_out[f"{n}_44k_web_tout.wav"] for n in takes if f"{n}_44k_web_tout.wav" in web_by_out]
    temps = {"site_48k_complet_rtf_median": round(float(np.median([r["facteur_temps_reel"] for r in rows if r["moteur"].startswith("site") and not r["cache_reutilise"]])), 3),
             "site_44k_complet_rtf_median": round(float(np.median([r["rtf"] for r in t44])), 3) if t44 else None,
             "windows_dfn3_rtf_median": round(float(np.median([r["facteur_temps_reel"] for r in rows if r["moteur"].startswith("Windows") and r["force"] == "light"])), 3) if win else None,
             "duree_prises_s": [round(len(c) / SR, 1) for c in takes.values()]}
    report = {"date": time.strftime("%Y-%m-%d %H:%M"), "temps": temps, "prises": list(takes), "bruits": NOISES, "niveaux_bruit_dbfs": LEVELS,
              "chargement_wasm_ms": web.get("chargement_wasm_ms"), "node": web.get("node"),
              "synthese": synth, "null_test": null_synth, "reverbe": rev, "detail": rows, "null_detail": nulls}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "mesures_voix_propre.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    for k, v in synth.items():
        if k.endswith("· tous"):
            print(f"{k:70s} bruit {v['bruit_retire_db_median']:>6} dB (pire {v['bruit_retire_db_pire']}) · spectre max {v['spectre_voix_max_abs_db_median']} dB (forme {v['spectre_voix_forme_max_abs_db_median']}) · SI-SDR {v['si_sdr_gain_db_median']:+} · ×{v['facteur_temps_reel_median']}")
    for k, v in null_synth.items():
        print(f"null {k:12s} résidu {v['residu_db_median']} dB · spectre max {v['spectre_voix_max_abs_db_median']} dB")
    print("réverbe", json.dumps(rev, ensure_ascii=False))
    print("temps", json.dumps(temps, ensure_ascii=False))


if __name__ == "__main__":
    main()
