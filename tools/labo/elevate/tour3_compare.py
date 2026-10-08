"""Tour 3 : null tests NOVA / original (vraie batterie, vrai mix) pour le limiteur et la chaîne de Romain.
Usage : python elevate/tour3_compare.py [etiquette] [--ecoute] [--profil fichier.json]
Écrit <labo>/elevate/tour3/compare_<etiquette>.json (et les fichiers d'écoute avec --ecoute)."""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import nova  # noqa: E402
from bancs import elevate as banc  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
AUD = os.path.join(OUT, "audio_vst")
T3 = os.path.join(OUT, "tour3")
RB = banc.romain_band_transient()
LIM = dict(nova.transient_params(0), limiterOn=True, ceilingDb=-0.1, truePeak=True, transientOn=False)
CASES = [
    ("lim_g8_noadapt", "in16", dict(LIM, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0)),
    ("lim_g8_s5", "in16", dict(LIM, limitGainDb=8.0, speedMs=5.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0)),
    ("lim_g4_noadapt", "in16", dict(LIM, limitGainDb=4.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0)),
    ("lim_g8_a6_s0", "in16", dict(LIM, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=6.0, adaptiveSpeed=0.0)),
    ("lim_g8_a0_s100", "in16", dict(LIM, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=100.0)),
    ("lim_romain", "in16", dict(LIM, limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=6.0, adaptiveSpeed=100.0)),
    ("t27a50r", "in", nova.transient_params(27, 50, RB)),
    ("romain", "in16", nova.romain_params()),
]


def null(a, b):
    return float(10 * np.log10(np.sum((a - b) ** 2) / np.sum(a ** 2)))


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "actuel"
    prof = None
    if "--profil" in sys.argv:
        prof = json.load(open(sys.argv[sys.argv.index("--profil") + 1]))
    os.makedirs(T3, exist_ok=True)
    m = nova.MasterTransient()
    res = {}
    for name in ("batterie", "mix"):
        for t, inp, prm in CASES:
            x = np.load(os.path.join(AUD, f"{inp}_{name}.npy")).astype(np.float64)
            yv = np.load(os.path.join(AUD, f"{t}_{name}.npy")).astype(np.float64)
            yn = m.run(x, prm, prof)
            g = float(np.sum(yv * yn) / np.sum(yn * yn))
            r = {"null": null(yv, yn), "null_gain_egalise": null(yv, g * yn), "ecart_niveau_db": float(-20 * np.log10(g)),
                 "rms_orig": float(20 * np.log10(np.std(yv))), "rms_nova": float(20 * np.log10(np.std(yn)))}
            res[f"{t}_{name}"] = r
            print(f"{t:16s} {name:9s} null {r['null']:6.1f} (gain égalisé {r['null_gain_egalise']:6.1f}) rms {r['rms_orig']:6.2f}/{r['rms_nova']:6.2f}", flush=True)
            if "--ecoute" in sys.argv and t in ("lim_romain", "romain"):
                import soundfile as sf
                eco = os.path.join(T3, "ecoute")
                os.makedirs(eco, exist_ok=True)
                for k, y in (("1_avant", x), ("2_original", yv), ("3_nova", yn), ("4_difference", yv - yn)):
                    sf.write(os.path.join(eco, f"{t}__{name}__{k}.wav"), np.clip(y.T, -1, 1).astype(np.float32), 48000, subtype="FLOAT")
    m.close()
    json.dump(res, open(os.path.join(T3, f"compare_{tag}.json"), "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
