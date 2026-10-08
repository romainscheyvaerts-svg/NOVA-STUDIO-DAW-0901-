"""Fichiers d'écoute + graphiques du banc de-esser.
Écrit D:/1 WORK/CONTENU/nova-labo/deesser/ecoute/<voix>__<version>.wav et graphiques/*.png"""
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import mesures as M  # noqa: E402
from bancs import deess as banc  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\deesser"
AUD = os.path.join(OUT, "audio")
EC = os.path.join(OUT, "ecoute")
GR = os.path.join(OUT, "graphiques")
os.makedirs(EC, exist_ok=True)
os.makedirs(GR, exist_ok=True)

VERSIONS = [
    ("1_avant", None),
    ("2_reference_deedger_profondeur20", "deedger__{v}__d20"),
    ("3_nova_avant_8k_seuil-35", "nova_avant__{v}__f8k_t35"),
    ("4_nova_apres_defaut", "nova_apres__{v}__defaut"),
    ("5_nova_apres_fort", "nova_apres__{v}__fort"),
    ("6_nova_apres_ecoute_bande", "nova_apres__{v}__bande"),
    ("7_nova_apres_ce_qui_est_retire", "nova_apres__{v}__retire"),
]
VOICES = ["voix_micro", "voix_douce", "strip_1306"]


def main():
    V = banc.load_voices()
    for v in VOICES:
        x = V[v]
        for name, pat in VERSIONS:
            if pat is None:
                y = x
            else:
                fn = os.path.join(AUD, pat.format(v=v) + ".npy")
                if not os.path.exists(fn):
                    continue
                y = np.load(fn).astype(np.float64)
            sf.write(os.path.join(EC, f"{v}__{name}.wav"), np.clip(y.T, -1, 1), 48000, subtype="PCM_24")
    # Forme de la réduction pendant les « s » (spectre sortie / entrée, trames « s » seulement)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from scipy import signal as sps
    fig, ax = plt.subplots(1, 2, figsize=(14, 5))
    for k, (title, mask_s) in enumerate((("Pendant les « s »", True), ("Hors « s »", False))):
        for lab, pat, col in (("DeEdger (profondeur 20)", "deedger__{v}__d20", "0.4"),
                              ("NOVA avant (8 kHz, seuil −35)", "nova_avant__{v}__f8k_t35", "tab:blue"),
                              ("NOVA après (défaut)", "nova_apres__{v}__defaut", "tab:red")):
            Hs = []
            for v in ["voix_micro", "lead_avant", "stem_voix", "voix_extrait", "vraie_voix"]:
                fn = os.path.join(AUD, pat.format(v=v) + ".npy")
                if not os.path.exists(fn):
                    continue
                x = V[v][0]
                y = np.load(fn)[0].astype(np.float64)
                s, vo = M.sibilant_mask(x)
                m = s if mask_s else vo
                w = 480
                idx = np.repeat(m, w)[:len(x)]
                xs, ys = x[:len(idx)][idx], y[:len(idx)][idx]
                f, px = sps.welch(xs, 48000, nperseg=2048)
                _, py = sps.welch(ys, 48000, nperseg=2048)
                Hs.append(10 * np.log10(py / np.maximum(px, 1e-30)))
            if Hs:
                ax[k].semilogx(f[1:], np.mean(Hs, 0)[1:], color=col, label=lab)
        ax[k].set_xlim(200, 20000); ax[k].set_ylim(-14, 2); ax[k].grid(alpha=.3)
        ax[k].set_title(title); ax[k].set_xlabel("Hz"); ax[k].set_ylabel("sortie / entrée (dB)")
        ax[k].legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(os.path.join(GR, "reduction_spectrale_voix.png"), dpi=70)
    print("ok")


if __name__ == "__main__":
    main()
