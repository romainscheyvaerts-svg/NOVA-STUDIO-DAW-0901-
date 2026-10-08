"""Tour 3 : égaliseur par bande de NOVA aligné sur l'original.
Mesure (tour3_mesure_eq2.py) : l'original combine les bandes en GAIN LINÉAIRE avec des poids w_b(f)
qui somment exactement à 1 (comme NOVA), mais ses formes sont plus arrondies que nos triangles et,
dans le grave, plus étroites que ce que la STFT 512 rend avec des triangles.
On cherche la matrice M (26 x 257 cases) telle que la réponse EFFECTIVE de la STFT (lissage par
la fenêtre compris) avec g_k = Σ_b M[b,k] G_b reproduise Σ_b w_b(f) G_b : moindres carrés
régularisés (le problème est linéaire en M). Sortie : elevate/eq_shapes.json (creux : début + valeurs)."""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tour3_eq_formes import eff_response, NH, FB  # noqa: E402

T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"


def kernels(fgrid):
    """Réponse (linéaire, réelle) ajoutée par +1 sur la seule case k, pour chaque k : (NH, len(fgrid))."""
    K = np.zeros((NH, len(fgrid)))
    for k in range(NH):
        g = np.ones(NH)
        g[k] = 2.0
        f, Hf = eff_response(g)
        K[k] = np.interp(fgrid, f, np.real(Hf)) - 1.0
    return K


def main():
    d = json.load(open(os.path.join(T3, "eq_formes.json")))
    fq = np.array(d["freq"])
    sel = fq < 23000
    fgrid = fq[sel]
    g6 = 10 ** (6 / 20)
    Wl = np.array([((10 ** (np.array(d[f"b{b}_+6"]) / 20) - 1) / (g6 - 1))[sel] for b in range(1, 27)])
    kf = os.path.join(T3, "eq_kernels.npy")
    if os.path.exists(kf):
        K = np.load(kf)
    else:
        K = kernels(fgrid)
        np.save(kf, K)
    # poids des fréquences : grille déjà plus dense dans le grave (5 Hz jusqu'à 2 kHz)
    lam = 1e-3
    A = K.T  # (nf, NH)
    M = np.zeros((26, NH))
    for b in range(26):
        # moindres carrés régularisés vers les triangles actuels (stabilité hors des points mesurés)
        x0 = np.interp(FB, fgrid, Wl[b])
        lhs = A.T @ A + lam * np.eye(NH)
        rhs = A.T @ Wl[b] + lam * x0
        M[b] = np.linalg.solve(lhs, rhs)
    M /= M.sum(0, keepdims=True)  # partition de l'unité exacte : réglages égaux -> plat
    # contrôle
    for b in (0, 1, 2, 7, 19):
        g = np.ones(26)
        g[b] = g6
        f, Hf = eff_response(g @ M)
        a = np.interp(fgrid, f, 20 * np.log10(np.abs(Hf)))
        print(f"bande {b + 1:2d} +6 : écart max {np.max(np.abs(a - np.array(d[f'b{b + 1}_+6'])[sel])):.3f} dB")
    sparse = []
    for b in range(26):
        nz = np.where(np.abs(M[b]) > 2e-4)[0]
        s, e = int(nz[0]), int(nz[-1]) + 1
        sparse.append([s, [round(float(v), 5) for v in M[b, s:e]]])
    json.dump({"eqShapes": sparse}, open(os.path.join(HERE, "eq_shapes.json"), "w"))
    print("écrit eq_shapes.json", sum(len(v) for _, v in sparse), "valeurs")


if __name__ == "__main__":
    main()
