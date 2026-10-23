#!/usr/bin/env python3
"""
Mesure BOÎTE NOIRE d'un correcteur de justesse VST3 installé (référence du marché), HORS LIGNE.

Règles (Romain) : modélisation boîte noire uniquement (signaux de test → mesures), aucune
décompilation ; à lancer via bureau_cache.py (bureau Windows invisible : aucune fenêtre à
l'écran) ; une fenêtre de licence / activation → l'hôte est tué (« Quitter »), rien n'est
accepté ; l'éditeur du plugin n'est jamais ouvert. Aucun accès à l'ASIO, au micro, ni aux ports
du pont (8765/8766) : le plugin tourne dans son propre NovaVSTHost.exe, en mémoire partagée.

Usage : python boite_noire.py <plugin.vst3> <dossier_sortie> [probe|mesure|mesure2|ecoute <voix.wav>]
Sortie : <dossier>/params.json, mesures.json, et quelques .wav (entrée / sortie).
"""
import json
import os
import sys
import threading
import time
import traceback

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "bridge-python"))
sys.path.insert(0, HERE)

import garde_fenetres  # noqa: E402

SR = 48000
FORMANTS = [(700, 110), (1220, 120), (2600, 160)]


def log(*a):
    print(*a, flush=True)


# ─── Signaux ─────────────────────────────────────────────────────────────────

def env_formants(f):
    """Enveloppe spectrale fixe (3 résonances) : les formants ne dépendent pas de la hauteur."""
    g = np.zeros_like(f, dtype=np.float64)
    for fc, bw in FORMANTS:
        g += 1.0 / np.sqrt(1 + ((f - fc) / (bw / 2)) ** 2)
    return g * (1.0 / np.maximum(1.0, f / 1000.0))


def vowel_track(midi, sr=SR, amp=0.25, fmax=6000.0):
    """Voyelle synthétique de hauteur midi(t) (tableau par échantillon), formants fixes."""
    f0 = 440.0 * 2 ** ((np.asarray(midi, np.float64) - 69) / 12)
    ph = 2 * np.pi * np.cumsum(f0) / sr
    out = np.zeros(len(f0))
    kmax = int(fmax / f0.min())
    for k in range(1, kmax + 1):
        fk = k * f0
        a = env_formants(fk) * (fk < fmax)
        out += a * np.sin(k * ph) / k ** 0.3
    out /= np.max(np.abs(out)) + 1e-12
    fade = int(0.01 * sr)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    return (amp * out).astype(np.float32)


def const(m, dur, sr=SR):
    return np.full(int(dur * sr), float(m))


# ─── Analyse ─────────────────────────────────────────────────────────────────

def pitch_track(x, sr=SR, hop=0.005, win=0.03, fmin=60, fmax=1000):
    """(t, midi) : NSDF (McLeod) par trame, pic interpolé ; 0 si non voisé."""
    x = np.asarray(x, np.float64)
    W = int(win * sr)
    H = int(hop * sr)
    lmin, lmax = int(sr / fmax), int(sr / fmin)
    ts, ms = [], []
    nfft = 1
    while nfft < 2 * (W + lmax):
        nfft *= 2
    for a in range(0, len(x) - W - lmax - 2, H):
        fr = x[a:a + W + lmax + 2]
        if np.sqrt(np.mean(fr[:W] ** 2)) < 1e-4:
            ts.append((a + W / 2) / sr); ms.append(0.0); continue
        F = np.fft.rfft(fr, nfft)
        F2 = np.fft.rfft(fr[:W], nfft)
        r = np.fft.irfft(np.conj(F2) * F, nfft)[:lmax + 2]
        e0 = np.sum(fr[:W] ** 2)
        c2 = np.concatenate([[0], np.cumsum(fr ** 2)])
        el = c2[np.arange(lmax + 2) + W] - c2[np.arange(lmax + 2)]
        n = 2 * r / (e0 + el + 1e-20)
        seg = n[lmin:lmax]
        thr = 0.8 * seg.max()
        # premier maximum local au-dessus du seuil (méthode MPM)
        k = None
        for i in range(1, len(seg) - 1):
            if seg[i] >= thr and seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1]:
                k = i; break
        if k is None or seg.max() < 0.5:
            ts.append((a + W / 2) / sr); ms.append(0.0); continue
        L = k + lmin
        y0, y1, y2 = n[L - 1], n[L], n[L + 1]
        den = y0 - 2 * y1 + y2
        Lf = L + (0.5 * (y0 - y2) / den if abs(den) > 1e-12 else 0)
        ts.append((a + W / 2) / sr)
        ms.append(69 + 12 * np.log2(sr / Lf / 440))
    return np.array(ts), np.array(ms)


def latency_by_xcorr(x, y, sr=SR, maxlag=0.2):
    """Retard de y sur x (échantillons, fractionnaire) par intercorrélation."""
    n = min(len(x), len(y))
    x = x[:n].astype(np.float64); y = y[:n].astype(np.float64)
    nfft = 1
    while nfft < 2 * n:
        nfft *= 2
    r = np.fft.irfft(np.fft.rfft(y, nfft) * np.conj(np.fft.rfft(x, nfft)), nfft)
    L = int(maxlag * sr)
    rr = np.concatenate([r[-L:], r[:L + 1]])
    k = int(np.argmax(rr))
    if 0 < k < len(rr) - 1:
        a, b, c = rr[k - 1], rr[k], rr[k + 1]
        den = a - 2 * b + c
        f = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0
    else:
        f = 0
    return k - L + f


def fit_tau(t, dev, lo=3.0, hi=None):
    """Constante de temps d'une décroissance exponentielle (écart → 0), en ms."""
    hi = hi if hi is not None else 0.8 * dev[np.isfinite(dev)].max()
    sel = (dev > lo) & (dev < hi) & np.isfinite(dev)
    if sel.sum() < 3:
        return None
    p = np.polyfit(t[sel], np.log(dev[sel]), 1)
    return -1000.0 / p[0] if p[0] < 0 else None


def t_reach(t, dev, frac, start_dev):
    """Premier instant où l'écart passe sous frac × écart de départ."""
    thr = frac * start_dev
    idx = np.where((dev <= thr) & (t > 0))[0]
    return float(t[idx[0]] * 1000) if len(idx) else None


def spectral_peaks(x, sr=SR):
    """Enveloppe spectrale (cepstre lissé) → fréquences des 3 premiers pics (formants)."""
    x = np.asarray(x, np.float64)
    n = 8192
    seg = x[:n] * np.hanning(min(n, len(x)))
    S = np.abs(np.fft.rfft(seg, n)) + 1e-9
    c = np.fft.irfft(np.log(S))
    lift = int(sr / 1000 * 1.2)   # quéfrence < 1,2 ms : enveloppe, pas les harmoniques
    c[lift:-lift] = 0
    env = np.fft.rfft(c).real[:len(S)]
    f = np.fft.rfftfreq(n, 1 / sr)
    pk = [i for i in range(2, len(env) - 2) if env[i] > env[i - 1] and env[i] > env[i + 1] and 300 < f[i] < 4000]
    pk = sorted(pk, key=lambda i: -env[i])[:3]
    band = (f > 200) & (f < 5000)
    cent = float(np.sum(f[band] * S[band] ** 2) / np.sum(S[band] ** 2))
    return {"pics": sorted(round(float(f[i])) for i in pk), "centroide_hz": round(cent, 1)}


def write_wav(path, x, sr=SR):
    try:
        import soundfile as sf
        sf.write(path, np.asarray(x, np.float32), sr, subtype="FLOAT")
    except Exception as e:  # noqa: BLE001
        log("wav", path, e)


# ─── Plugin ──────────────────────────────────────────────────────────────────

class Plugin:
    def __init__(self, path):
        import vst_native
        self.vn = vst_native
        self.p = None
        self.licence = None
        self.garde = garde_fenetres.Garde(self._licence)
        box = {}

        def load():
            try:
                box["p"] = vst_native.load_plugin(path)
            except Exception as e:  # noqa: BLE001
                box["e"] = e
        th = threading.Thread(target=load, daemon=True)
        th.start()
        th.join(90)
        if self.licence:
            raise RuntimeError(f"fenêtre de licence : {self.licence}")
        if th.is_alive():
            self.kill_all()
            raise RuntimeError("chargement bloqué > 90 s (fenêtre cachée ?) : arrêt, rien accepté")
        if "e" in box:
            raise box["e"]
        self.p = box["p"]
        try:
            self.garde.pids.add(int(self.p._host.pid))
        except Exception:  # noqa: BLE001
            pass

    def _licence(self, w):
        self.licence = w.get("texte") or w.get("title")
        log("!!! fenêtre de licence / activation détectée → arrêt (Quitter) :", self.licence)
        self.kill_all()

    def kill_all(self):
        try:
            if self.p is not None:
                self.p._host.kill()
        except Exception:  # noqa: BLE001
            pass
        # Les NovaVSTHost.exe de ce script sont dans un objet tâche (vst_native._attach_to_job) :
        # la sortie du processus les emporte.
        os._exit(5)

    def set(self, **kw):
        for k, v in kw.items():
            setattr(self.p, k, v)

    def run(self, x):
        x2 = np.stack([x, x]).astype(np.float32)
        pad = np.zeros((2, SR), np.float32)
        y = self.p.process(np.concatenate([x2, pad], axis=1), SR, buffer_size=512, reset=True)
        return y[0]

    def latency(self):
        try:
            return int(self.p.latency_samples)
        except Exception:  # noqa: BLE001
            return None


# ─── Mesures ─────────────────────────────────────────────────────────────────

def probe(pl, out):
    params = {}
    for k, prm in pl.p.parameters.items():
        d = {"type": prm.type.__name__, "min": prm.min_value, "max": prm.max_value, "label": getattr(prm, "label", None)}
        try:
            d["value"] = getattr(pl.p, k)
        except Exception:  # noqa: BLE001
            pass
        vv = getattr(prm, "valid_values", None)
        if vv and len(vv) <= 40:
            d["values"] = [str(v) for v in vv]
        params[k] = d
    res = {"name": pl.p.name, "latency": pl.latency(), "params": params}
    json.dump(res, open(os.path.join(out, "params.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    log("params", len(params), "latence", res["latency"])


def deviation(y, lat, target_midi, t0=0.0):
    t, m = pitch_track(y[lat:])
    v = m > 0
    return t[v] - t0, (m[v] - target_midi) * 100


def mesure(pl, out):
    R = {"sr": SR}
    base = dict(correction_mode="Auto mode", master_bypass=False, key="C", modern_scale="Chromatic",
                humanize=0.0, flex_tune=0.0, wet_dry_mix=100.0)
    for k, v in list(base.items()):
        try:
            setattr(pl.p, k, v)
        except Exception as e:  # noqa: BLE001
            log("réglage", k, v, "refusé :", e); base.pop(k)
    R["base"] = base

    def apply(**kw):
        for k, v in {**base, **kw}.items():
            try:
                setattr(pl.p, k, v)
            except Exception as e:  # noqa: BLE001
                log("réglage", k, v, "refusé :", e)

    # Latence annoncée / mesurée, deux modes.
    R["latence"] = {}
    rng = np.random.default_rng(1)
    am = np.convolve(rng.standard_normal(int(2.0 * SR)), np.ones(400) / 400, mode="same")
    am = 0.5 + 0.5 * am / np.abs(am).max()
    for mode in [False, True]:
        apply(retune_speed_ms=20.0, latency_removal=mode)
        x = vowel_track(const(57.0, 2.0)) * am.astype(np.float32)
        pl.run(x[:SR // 2])          # le plugin annonce sa nouvelle latence après un premier traitement
        lat = pl.latency()
        y = pl.run(x)
        # y est déjà amputé de la latence ANNONCÉE (comme pedalboard) : le reste = écart réel.
        resid = latency_by_xcorr(x, y)
        R["latence"]["low_latency" if mode else "normal"] = {"annoncee_ech": lat, "residu_ech": round(float(resid), 2),
                              "reelle_ms": round((lat + resid) / SR * 1000, 3) if lat is not None else None}
        log("latence", mode, R["latence"]["low_latency" if mode else "normal"])
    apply(latency_removal=False)
    lat0 = 0  # sortie déjà recalée sur la latence annoncée

    # T1 : vitesse — note tenue 40 cents trop haut dès le début.
    R["vitesse"] = []
    for ms in [0, 5, 10, 20, 25, 50, 75, 100, 150, 200, 300, 400]:
        apply(retune_speed_ms=float(ms))
        x = vowel_track(const(57.4, 2.0))
        y = pl.run(x)
        t, d = deviation(y, lat0, 57.0)
        fin = float(np.median(d[(t > 1.5) & (t < 1.9)])) if np.any((t > 1.5) & (t < 1.9)) else None
        dd = d - (fin or 0)
        tau = fit_tau(t, dd, lo=2.0, hi=30.0)
        r = {"retune_ms": ms, "ecart_final_cents": fin, "tau_ms": tau,
             "t50_ms": t_reach(t, dd, 0.5, 40), "t63_ms": t_reach(t, dd, 1 / np.e, 40), "t90_ms": t_reach(t, dd, 0.1, 40),
             "courbe": [[round(float(a), 3), round(float(b), 2)] for a, b in zip(t[:120:2], d[:120:2])]}
        R["vitesse"].append(r)
        log("vitesse", ms, {k: r[k] for k in r if k != "courbe"})
        if ms in (0, 25, 100):
            write_wav(os.path.join(out, f"vitesse_{ms}ms.wav"), y)
    write_wav(os.path.join(out, "entree_la3_plus40c.wav"), vowel_track(const(57.4, 2.0)))
    R["vitesse_classic"] = []
    for ms in [0, 20, 50, 100]:
        apply(retune_speed_ms=float(ms), use_classic_mode_dsp=1.0)
        y = pl.run(vowel_track(const(57.4, 2.0)))
        t, d = deviation(y, lat0, 57.0)
        fin = float(np.median(d[(t > 1.5) & (t < 1.9)])) if np.any((t > 1.5) & (t < 1.9)) else 0.0
        dd = d - fin
        R["vitesse_classic"].append({"retune_ms": ms, "ecart_final_cents": fin, "tau_ms": fit_tau(t, dd, 2.0, 30.0),
                                     "t63_ms": t_reach(t, dd, 1 / np.e, 40), "t90_ms": t_reach(t, dd, 0.1, 40)})
        log("classic", R["vitesse_classic"][-1])
    apply(use_classic_mode_dsp=0.0)

    # T2 : saut de note (57,4 → 59,4 au milieu) : transition.
    R["saut"] = []
    m = np.concatenate([const(57.4, 1.0), const(59.4, 1.0)])
    for ms in [0, 20, 50, 100]:
        apply(retune_speed_ms=float(ms))
        y = pl.run(vowel_track(m))
        t, mm = pitch_track(y)
        sel = (t > 0.95) & (t < 1.4)
        R["saut"].append({"retune_ms": ms, "courbe": [[round(float(a), 3), round(float(b), 2)] for a, b in zip(t[sel], mm[sel])]})
    log("saut ok")

    # T3 : vibrato ±40 cents à 5,5 Hz autour d'une note juste.
    R["vibrato"] = []
    tt = np.arange(int(2.5 * SR)) / SR
    vib = 57.0 + 0.4 * np.sin(2 * np.pi * 5.5 * tt)
    xin = vowel_track(vib)
    tin, min_ = pitch_track(xin)
    dep_in = float(np.std(min_[(tin > 0.5) & (tin < 2.3)] - 57) * np.sqrt(2) * 100)
    for ms in [0, 10, 25, 50, 100, 200]:
        for hum in [0.0, 50.0, 100.0]:
            apply(retune_speed_ms=float(ms), humanize=hum)
            y = pl.run(xin)
            t, mm = pitch_track(y)
            s = (t > 0.5) & (t < 2.3) & (mm > 0)
            dep = float(np.std(mm[s] - np.mean(mm[s])) * np.sqrt(2) * 100)
            R["vibrato"].append({"retune_ms": ms, "humanize": hum, "profondeur_entree_cents": dep_in, "profondeur_sortie_cents": dep,
                                 "centre_cents": float((np.mean(mm[s]) - 57) * 100)})
            if ms == 0 and hum == 0:
                write_wav(os.path.join(out, "vibrato_robot.wav"), y)
    apply(humanize=0.0)
    for nv in [-12.0, -6.0, 0.0, 6.0, 12.0]:
        apply(retune_speed_ms=25.0, natural_vibrato=nv)
        y = pl.run(xin)
        t, mm = pitch_track(y)
        s = (t > 0.5) & (t < 2.3) & (mm > 0)
        R["vibrato"].append({"retune_ms": 25, "natural_vibrato": nv, "profondeur_sortie_cents": float(np.std(mm[s] - np.mean(mm[s])) * np.sqrt(2) * 100)})
    apply(natural_vibrato=0.0)
    write_wav(os.path.join(out, "entree_vibrato.wav"), xin)
    log("vibrato ok")

    # T4 : Flex-Tune — écart de 15 / 30 / 45 cents.
    R["flex"] = []
    for fl in [0.0, 10.0, 25.0, 50.0, 100.0]:
        for off in [15, 30, 45]:
            apply(retune_speed_ms=10.0, flex_tune=fl)
            y = pl.run(vowel_track(const(57 + off / 100, 1.5)))
            t, d = deviation(y, 0, 57.0)
            s = (t > 0.8) & (t < 1.4)
            R["flex"].append({"flex": fl, "ecart_entree": off, "ecart_sortie": float(np.median(d[s])) if s.any() else None})
    apply(flex_tune=0.0)
    log("flex ok")

    # T5 : humanize sur note tenue (vitesse 20 ms).
    R["humanize"] = []
    for hum in [0.0, 25.0, 50.0, 100.0]:
        apply(retune_speed_ms=20.0, humanize=hum)
        y = pl.run(vowel_track(const(57.4, 2.0)))
        t, d = deviation(y, 0, 57.0)
        R["humanize"].append({"humanize": hum, "tau_ms": fit_tau(t, d, 2.0, 30.0), "t90_ms": t_reach(t, d, 0.1, 40),
                              "courbe": [[round(float(a), 3), round(float(b), 2)] for a, b in zip(t[:160:2], d[:160:2])]})
    apply(humanize=0.0)
    log("humanize ok")

    # T6 : glissando 1 octave en 3 s (escalier).
    R["glissando"] = []
    g = np.linspace(50, 62, int(3 * SR))
    xg = vowel_track(g)
    for ms in [0, 20, 75]:
        apply(retune_speed_ms=float(ms))
        y = pl.run(xg)
        t, mm = pitch_track(y)
        s = (t > 0.3) & (t < 2.7) & (mm > 0)
        on_note = np.abs(mm[s] - np.round(mm[s])) < 0.1
        R["glissando"].append({"retune_ms": ms, "part_sur_note": float(on_note.mean()),
                               "courbe": [[round(float(a), 3), round(float(b), 3)] for a, b in zip(t[s][::4], mm[s][::4])]})
        if ms == 0:
            write_wav(os.path.join(out, "glissando_robot.wav"), y)
    write_wav(os.path.join(out, "entree_glissando.wav"), xg)
    log("glissando ok")

    # T7 : formants — note corrigée de +100 cents (transpose) et throat.
    R["formants"] = {"entree": spectral_peaks(vowel_track(const(57.0, 1.0))[SR // 4:])}
    for k, v in [("transpose", 0), ("transpose", 5), ("transpose", -5)]:
        apply(retune_speed_ms=0.0, transpose=float(v))
        y = pl.run(vowel_track(const(57.0, 1.0)))
        t, mm = pitch_track(y)
        s = (t > 0.3) & (t < 0.9) & (mm > 0)
        R["formants"][f"{k}{v:+d}"] = {"spectre": spectral_peaks(y[SR // 4:]), "hauteur_midi": float(np.median(mm[s])) if s.any() else None}
    apply(transpose=0.0)
    for th in [50.0, 80.0, 100.0, 120.0, 180.0]:
        try:
            apply(retune_speed_ms=0.0, throat_length=th, formant_correction=True)
        except Exception:  # noqa: BLE001
            pass
        y = pl.run(vowel_track(const(57.0, 1.0)))
        R["formants"][f"throat{th:g}"] = spectral_peaks(y[SR // 4:])
    apply(throat_length=100.0)
    for fc in [False, True]:
        apply(retune_speed_ms=0.0, transpose=5.0, formant_correction=fc)
        y = pl.run(vowel_track(const(57.0, 1.0)))
        R["formants"][f"transpose+5_formant_correction_{fc}"] = spectral_peaks(y[SR // 4:])
    apply(transpose=0.0, formant_correction=True)
    log("formants ok", R["formants"])

    json.dump(R, open(os.path.join(out, "mesures.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log("FINI")


def mesure2(pl, out):
    """Compléments : transitions réalistes, Flex-Tune fin, faible latence, robot sur voix qui dérive."""
    R = {"sr": SR}
    base = dict(correction_mode="Auto mode", master_bypass=False, key="C", modern_scale="Chromatic",
                humanize=0.0, flex_tune=0.0, wet_dry_mix=100.0, latency_removal=False, transpose=0.0)

    def apply(**kw):
        for k, v in {**base, **kw}.items():
            try:
                setattr(pl.p, k, v)
            except Exception as e:  # noqa: BLE001
                log("réglage", k, v, "refusé :", e)

    # a) Note A chantée +40 cents, glissé de 80 ms vers B juste (2 demi-tons plus haut).
    R["transition"] = []
    n1, ng, n2 = int(0.8 * SR), int(0.08 * SR), int(0.8 * SR)
    m = np.concatenate([np.full(n1, 57.4), 57.4 + (59.0 - 57.4) * (0.5 - 0.5 * np.cos(np.pi * np.arange(ng) / ng)), np.full(n2, 59.0)])
    x = vowel_track(m)
    write_wav(os.path.join(out, "entree_transition.wav"), x)
    for ms in [0, 20, 50, 100]:
        apply(retune_speed_ms=float(ms))
        y = pl.run(x)
        t, mm = pitch_track(y)
        sel = (t > 0.7) & (t < 1.3)
        R["transition"].append({"retune_ms": ms, "courbe": [[round(float(a), 3), round(float(b), 3)] for a, b in zip(t[sel], mm[sel])]})
    log("transition ok")

    # b) Flex-Tune : grille fine.
    R["flex"] = []
    for fl in [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]:
        for off in [5, 10, 15, 20, 25, 30, 35, 40, 45]:
            apply(retune_speed_ms=10.0, flex_tune=float(fl))
            y = pl.run(vowel_track(const(57 + off / 100, 1.2)))
            t, d = deviation(y, 0, 57.0)
            s = (t > 0.7) & (t < 1.1)
            R["flex"].append({"flex": fl, "ecart_entree": off, "ecart_sortie": round(float(np.median(d[s])), 3) if s.any() else None})
    log("flex ok")

    # c) Faible latence : vitesse et formants.
    R["faible_latence"] = {}
    for ms in [0, 20, 100]:
        apply(retune_speed_ms=float(ms), latency_removal=True)
        pl.run(vowel_track(const(57.0, 0.3)))
        y = pl.run(vowel_track(const(57.4, 2.0)))
        t, d = deviation(y, 0, 57.0)
        R["faible_latence"][f"vitesse_{ms}"] = {"t50_ms": t_reach(t, d, 0.5, 40), "t90_ms": t_reach(t, d, 0.1, 40),
                                                "ecart_final": float(np.median(d[(t > 1.5) & (t < 1.9)]))}
    apply(retune_speed_ms=0.0, latency_removal=True, transpose=5.0)
    y = pl.run(vowel_track(const(57.0, 1.0)))
    R["faible_latence"]["transpose+5"] = spectral_peaks(y[SR // 4:])
    log("faible latence", R["faible_latence"])

    # d) Robot (vitesse 0) sur une voix qui dérive lentement (±30 cents, 0,7 Hz) : propreté.
    tt = np.arange(int(2.0 * SR)) / SR
    x = vowel_track(57.0 + 0.3 * np.sin(2 * np.pi * 0.7 * tt))
    apply(retune_speed_ms=0.0)
    y = pl.run(x)
    t, mm = pitch_track(y)
    s = (t > 0.2) & (t < 1.8) & (mm > 0)
    R["robot_derive"] = {"ecart_max_cents": float(np.max(np.abs(mm[s] - 57)) * 100), "ecart_rms_cents": float(np.sqrt(np.mean((mm[s] - 57) ** 2)) * 100)}
    write_wav(os.path.join(out, "robot_derive.wav"), y)
    log("robot", R["robot_derive"])

    json.dump(R, open(os.path.join(out, "mesures2.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log("FINI")


def ecoute(pl, out, voix):
    """Rendus d'écoute de la référence sur une vraie voix (mêmes réglages que le banc de Nova Tune)."""
    import soundfile as sf
    x, sr = sf.read(voix, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    os.makedirs(out, exist_ok=True)
    base = dict(correction_mode="Auto mode", master_bypass=False, key="C", modern_scale="Chromatic",
                flex_tune=0.0, wet_dry_mix=100.0, latency_removal=False, transpose=0.0, natural_vibrato=0.0)
    for name, kw in [("robot_0ms", dict(retune_speed_ms=0.0, humanize=0.0)),
                     ("naturel_20ms", dict(retune_speed_ms=20.0, humanize=20.0)),
                     ("doux_50ms", dict(retune_speed_ms=50.0, humanize=40.0)),
                     ("naturel_20ms_flex50", dict(retune_speed_ms=20.0, humanize=20.0, flex_tune=50.0))]:
        for k, v in {**base, **kw}.items():
            setattr(pl.p, k, v)
        x2 = np.stack([x, x]).astype(np.float32)
        y = pl.p.process(np.concatenate([x2, np.zeros((2, sr), np.float32)], axis=1), sr, buffer_size=512, reset=True)[0][:len(x)]
        sf.write(os.path.join(out, f"reference_{name}.wav"), y, sr, subtype="FLOAT")
        log("écoute", name)
    log("FINI")


def main():
    path, out = sys.argv[1], sys.argv[2]
    what = sys.argv[3] if len(sys.argv) > 3 else "probe"
    os.makedirs(out, exist_ok=True)
    log("bureau :", os.environ.get("NOVA_BUREAU_CACHE"), "fenêtres au départ :", len(garde_fenetres.windows()))
    if not os.environ.get("NOVA_BUREAU_CACHE"):
        log("Refus : à lancer via bureau_cache.py (aucune fenêtre visible).")
        return 2
    try:
        pl = Plugin(path)
    except Exception as e:  # noqa: BLE001
        log("CHARGEMENT IMPOSSIBLE :", e)
        return 3
    log("chargé :", pl.p.name, "latence", pl.latency())
    try:
        if what == "probe":
            probe(pl, out)
        elif what == "mesure2":
            mesure2(pl, out)
        elif what == "ecoute":
            ecoute(pl, out, sys.argv[4])
        else:
            mesure(pl, out)
    except Exception:  # noqa: BLE001
        log(traceback.format_exc())
    finally:
        vues = [{k: w.get(k) for k in ("title", "class", "texte")} for w in pl.garde.vues]
        log("fenêtres vues (bureau invisible) :", json.dumps(vues, ensure_ascii=False))
        try:
            pl.p._host.close()
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
