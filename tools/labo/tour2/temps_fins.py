"""
Tour 2 : résolution de la mesure des temps COURTS (sous la milliseconde).

Le banc du tour 1 estime le gain par moindres carrés sur un quart de période
d'un sinus 1 kHz à 48 kHz (fenêtre 0,25 ms) : trop grossier pour l'attaque d'un
FET (20 à 800 µs). Ici, trois mesures du même saut de niveau :
  A. 48 kHz, porteuse 1 kHz, fenêtre 1/4 de période (méthode du tour 1) ;
  B. 192 kHz, porteuse 10 kHz, fenêtre 1/4 de période (≈ 26 µs) ;
  C. 192 kHz, porteuse 10 kHz, ajustement d'une exponentielle (montée) par
     moindres carrés sur la courbe de gain (« corrélation ») : t63 sous-échantillon.
Usage : pythonw -m tour2.temps_fins <banc>   -> <labo>/<id>/tour2/temps_fins.json
"""
import json, math, os, sys
import numpy as np
from scipy.optimize import least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import host  # noqa: E402
from tour2.common import banc_mod, LABO  # noqa: E402

CASES = {
    "fet76": [("att_1.0", {"ratio": "4:1", "input": -24.0, "attack": 1.0, "release": 4.0}),
              ("att_4.0", {"ratio": "4:1", "input": -24.0, "attack": 4.0, "release": 4.0}),
              ("att_7.0", {"ratio": "4:1", "input": -24.0, "attack": 7.0, "release": 4.0})],
    "cl1b": [("att_0", {"threshold_db": -30.0, "ratio": "4:1", "attack": 0.0, "release": 5.0}),
             ("att_2", {"threshold_db": -30.0, "ratio": "4:1", "attack": 2.0, "release": 5.0})],
    "la2a": [("pr80", {"peak_reduct": "80"})],
}


def gain_curve(y, x, w):
    k = np.ones(int(w))
    num = np.convolve(y * x, k, mode="same")
    den = np.convolve(x * x, k, mode="same")
    return 20 * np.log10(np.maximum(np.abs(num / np.maximum(den, 1e-30)), 1e-9))


def run_step(plugin, sr, f0, base_db=-45.0, step_db=30.0, pre=0.5, hold=0.3):
    n0, n1 = int(pre * sr), int(hold * sr)
    n = n0 + n1 + int(0.1 * sr)
    t = np.arange(n) / sr
    amp = np.full(n, 10 ** (base_db / 20))
    amp[n0:n0 + n1] = 10 ** ((base_db + step_db) / 20)
    x = amp * np.sin(2 * np.pi * f0 * t)
    pad = int(0.05 * sr)
    xx = np.concatenate([np.zeros(pad), x])
    y = plugin.process(np.vstack([xx, xx]).astype(np.float32), float(sr), buffer_size=512, reset=True)
    y = np.asarray(y, float)[0, pad:pad + n]
    w = max(3, int(round(sr / f0 / 4)))
    g = gain_curve(y, x, w)
    gb = float(np.median(g[n0 - int(0.1 * sr):n0 - int(0.01 * sr)]))
    gr = gb - g
    seg = gr[n0:n0 + n1]
    ta = np.arange(n1) / sr
    end = float(np.median(seg[-int(0.03 * sr):]))
    idx = np.where(seg >= 0.632 * end)[0]
    t63 = float(ta[idx[0]] * 1000) if len(idx) else None
    # C : exponentielle ajustée (gr = end (1 - exp(-(t - t0)/tau)), t0 libre)
    m = (ta < 0.08)
    def res(p):
        t0, tau = p
        mdl = np.where(ta[m] > t0, end * (1 - np.exp(-(ta[m] - t0) / max(tau, 1e-6))), 0.0)
        return mdl - seg[m]
    r = least_squares(res, [0.0, max((t63 or 1.0) / 1000, 1e-5)], bounds=([-0.001, 1e-6], [0.01, 0.5]))
    return {"t63_ms": t63, "tau_fit_ms": float(r.x[1] * 1000), "t0_ms": float(r.x[0] * 1000), "gr_end_db": end,
            "fenetre_us": w / sr * 1e6}


def main(bn):
    host.hide_console()
    banc = banc_mod(bn)
    plugin = host.open_plugin(banc.PLUGIN)
    host.set_params(plugin, banc.BASE)
    out = {}
    for name, st in CASES[bn]:
        host.set_params(plugin, dict(banc.BASE, **st))
        out[name] = {"A_48k_1kHz": run_step(plugin, 48000, 1000.0), "B_192k_10kHz": run_step(plugin, 192000, 10000.0),
                     "A2_48k_10kHz": run_step(plugin, 48000, 10000.0)}
        with open(os.path.join(LABO, banc.ID, "tour2", "temps_fins.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
