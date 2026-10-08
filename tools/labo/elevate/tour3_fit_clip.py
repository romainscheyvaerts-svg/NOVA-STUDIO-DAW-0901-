"""Tour 3 : calage du clipper NOVA (saturation mesurée, avant le plafond crête vraie) sur l'original :
pour chaque (poussée, forme) mesurée, ln k qui reproduit le gain RMS du sinus 1 kHz de −24 à 0 dBFS ;
puis null tests batterie / mix contre les rendus de l'original (tour3/audio_clip).
Usage : python elevate/tour3_fit_clip.py <profil_base.json>  -> elevate/clip_fit.json + tour3/clip_resultats.json"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nova  # noqa: E402
from tour3_mesure_lim import sine, SR  # noqa: E402

T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"
CONF = [("d3_s0_det100", 3.0, 0.0), ("d6_s0_det100", 6.0, 0.0), ("d12_s0_det100", 12.0, 0.0), ("d6_s50_det100", 6.0, 50.0),
        ("d6_s100_det100", 6.0, 100.0), ("d12_s100_det0", 12.0, 100.0)]


def prm(D, s):
    return dict(nova.transient_params(0), transientOn=False, limiterOn=True, limitGainDb=0.0, speedMs=1.0, ceilingDb=-0.1,
                truePeak=True, clipperOn=True, clipDriveDb=D, clipShape=s)


def curve(m, prof, D, s, Ls):
    out, h3 = [], []
    for L in Ls:
        x = sine(L, 1000, 0.3)
        y = m.run(np.vstack([x, x]), prm(D, s), prof)[0][-SR // 10:]
        out.append(20 * np.log10(np.std(y) / np.std(x[-SR // 10:])))
        Y = np.abs(np.fft.rfft(y * np.hanning(len(y))))
        h3.append(20 * np.log10(Y[300] / Y[100] + 1e-12))
    return np.array(out), np.array(h3)


def main():
    import ctypes
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    base = json.load(open(sys.argv[1]))
    M = json.load(open(os.path.join(T3, "mesures_clip.json")))
    m = nova.MasterTransient()
    best = {}
    res = {}
    for key, D, s in CONF:
        rows = M[key]["sin1000"][::2]
        Ls = [r[0] for r in rows]
        gv = np.array([r[1] for r in rows])
        hv = np.array([r[3][1] for r in rows])
        # tableau minimal pour forcer k : un seul point (D, s)
        sc = []
        for lk in np.linspace(0.3, 5.5, 14):
            p = dict(base, clipDrives=[D - 1, D + 1], clipShapes=[s - 1, s + 1], clipLogK=[[lk, lk], [lk, lk]])
            g, _ = curve(m, p, D, s, Ls)
            sc.append((float(np.sqrt(np.mean((g - gv) ** 2))), lk))
        sc.sort()
        lk0 = sc[0][1]
        fine = []
        for lk in np.linspace(lk0 - 0.3, lk0 + 0.3, 7):
            p = dict(base, clipDrives=[D - 1, D + 1], clipShapes=[s - 1, s + 1], clipLogK=[[lk, lk], [lk, lk]])
            g, h = curve(m, p, D, s, Ls)
            fine.append((float(np.sqrt(np.mean((g - gv) ** 2))), lk, float(np.max(np.abs(g - gv))), h))
        fine.sort(key=lambda t: t[0])
        e, lk, emax, h = fine[0]
        best[key] = lk
        # avant (clipper du tour 2)
        g2, h2 = curve(m, dict(base, clipLogK=None, clipDrives=None, clipShapes=None), D, s, Ls)
        res[key] = {"lnk": lk, "apres_rms": e, "apres_max": emax, "avant_rms": float(np.sqrt(np.mean((g2 - gv) ** 2))),
                    "avant_max": float(np.max(np.abs(g2 - gv))), "h3_orig": hv.round(1).tolist(), "h3_apres": np.round(h, 1).tolist(),
                    "h3_avant": np.round(h2, 1).tolist()}
        print(key, "ln k", round(lk, 2), "écart gain rms avant/après", round(res[key]["avant_rms"], 2), round(e, 2),
              "max", round(res[key]["avant_max"], 2), round(emax, 2), flush=True)
    # table (poussée x forme)
    drives, shapes = [3.0, 6.0, 12.0], [0.0, 50.0, 100.0]
    lk6 = {0.0: best["d6_s0_det100"], 50.0: best["d6_s50_det100"], 100.0: best["d6_s100_det100"]}
    lk0 = {3.0: best["d3_s0_det100"], 6.0: best["d6_s0_det100"], 12.0: best["d12_s0_det100"]}
    tab = [[lk0[D] + (lk6[s] - lk6[0.0]) for s in shapes] for D in drives]
    tab[2][2] = best["d12_s100_det0"]
    tab[2][1] = 0.5 * (tab[2][0] + tab[2][2])
    clip = {"clipDrives": drives, "clipShapes": shapes, "clipLogK": [[round(v, 4) for v in r] for r in tab]}
    json.dump(clip, open(os.path.join(HERE, "clip_fit.json"), "w"), indent=1)
    # null tests réels
    for key, D, s in CONF:
        fn = os.path.join(T3, "audio_clip", f"{key}_batterie.npy")
        for nm in ("batterie", "mix"):
            x = np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64)
            yv = np.load(os.path.join(T3, "audio_clip", f"{key}_{nm}.npy")).astype(np.float64)
            for tag, pr in (("avant", dict(base, clipLogK=None, clipDrives=None, clipShapes=None)), ("apres", dict(base, **clip))):
                yn = m.run(x, prm(D, s), pr)
                res[key][f"null_{nm}_{tag}"] = float(10 * np.log10(np.sum((yv - yn) ** 2) / np.sum(yv ** 2)))
        print(key, {k2: round(v, 1) for k2, v in res[key].items() if k2.startswith("null")}, flush=True)
    json.dump(res, open(os.path.join(T3, "clip_resultats.json"), "w"), indent=1)
    m.close()


if __name__ == "__main__":
    main()
