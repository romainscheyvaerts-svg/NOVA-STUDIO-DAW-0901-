"""
Portage Python (numba) du cœur DSP NOVA « compresseur analogique » — MÊME
algorithme, ligne à ligne, que engine/analogCompCore.ts. Sert à caler les
modèles vite (moindres carrés) ; la preuve finale passe par le vrai moteur.

Chaîne, par canal (ou couplée en stéréo) :
  entrée × gain d'entrée -> étage d'entrée (saturation polynomiale douce)
  -> détecteur (sidechain : avant ou après l'élément de gain, passe-haut,
     accentuation des aigus, redressement simple ou double alternance,
     lissage) -> loi statique tabulée G(L) (genou, taux, saturation de la
     cellule) -> cellule (attaque exponentielle bornée par une vitesse max,
     relâchement : pente + exponentielle, deuxième temps « mémoire » des optos)
  -> gain = 1/A -> étage de sortie (saturation) -> gain de sortie -> mélange.
"""
from __future__ import annotations

import math

import numpy as np
from numba import njit

# Indices du vecteur de paramètres internes (P)
P_PRE = 0          # gain d'entrée (linéaire)
P_THR = 1          # seuil linéaire du détecteur (niveau L = 0 dB)
P_FB = 2           # 0 = feedforward, 1 = feedback (détecte la sortie de la cellule)
P_RECT = 3         # 0 = double alternance, 1 = simple alternance
P_DET_ATT = 4      # détecteur crête : coefficient de montée (0 = instantané)
P_ATT = 5          # coefficient d'attaque exponentielle (domaine A)
P_ATT_SLEW = 6     # vitesse max d'attaque (A par échantillon, 0 = illimitée)
P_REL_SLEW = 7     # pente de relâchement (A par échantillon)
P_REL_EXP = 8      # coefficient de relâchement exponentiel
P_REL2_SLEW = 9    # 2e relâchement (rapide) : pente
P_HOLD = 10        # durée (éch.) au-delà de laquelle le relâchement lent s'applique (F/M) ; <0 = toujours lent
P_MEM = 11         # mémoire opto : poids de l'état lent (0 = pas de mémoire)
P_MEM_CH = 12      # coefficient de charge de la mémoire
P_MEM_DIS = 13     # coefficient de décharge de la mémoire
P_IN_A2 = 14       # étage d'entrée : coefficient H2
P_IN_A3 = 15       # étage d'entrée : coefficient H3
P_OUT_A2 = 16
P_OUT_A3 = 17
P_MAKEUP = 18      # gain de sortie (linéaire)
P_MIX = 19         # 0..1 (traité)
P_HP_B0 = 20       # passe-haut du sidechain (biquad b0,b1,b2,a1,a2) ; b0=0 -> pas de filtre
P_HP_B1 = 21
P_HP_B2 = 22
P_HP_A1 = 23
P_HP_A2 = 24
P_LINK = 25        # 1 = détection couplée (max des deux canaux)
P_REL_DUCK = 26    # 0..1 : la pente de relâchement est multipliée par (1/A)^P_REL_DUCK
P_IN_SAT = 27      # niveau de saturation douce de l'étage d'entrée (0 = aucun)
P_OUT_SAT = 28
P_DET_REL = 29     # détecteur crête : coefficient de descente (0 = instantané)
P_ATT2 = 30        # 2e étage de la cellule : coefficient (0 = un seul étage)
P_REL2_FOLLOW = 31 # 2e étage : coefficient en descente (0 = même que P_ATT2)
P_EQ = 32          # 4 biquads de couleur en sortie : (b0,b1,b2,a1,a2) x 4 ; b0 = 0 -> biquad ignoré
N_EQ = 4
NP = 56


@njit(cache=True)
def _shape(x, a2, a3, sat):
    y = x + a2 * x * x + a3 * x * x * x
    if sat > 0.0:
        y = sat * math.tanh(y / sat)
    return y


@njit(cache=True)
def _table(L, l0, dl, tab):
    """Interpolation linéaire dans la table G(L) (L en dB, pas dl, départ l0)."""
    f = (L - l0) / dl
    n = tab.shape[0]
    if f <= 0.0:
        return tab[0]
    if f >= n - 1:
        return tab[n - 1]
    i = int(f)
    t = f - i
    return tab[i] + (tab[i + 1] - tab[i]) * t


@njit(cache=True)
def process(x, P, l0, dl, tab):
    """x : (2, n) float64 -> (y (2, n), A (n) du canal 0)."""
    n = x.shape[1]
    y = np.zeros((2, n))
    atrace = np.zeros(n)
    A = np.ones(2)
    A2 = np.ones(2)
    sm = np.zeros(2)
    mem = np.zeros(2)
    yprev = np.zeros(2)
    hp = np.zeros((2, 4))  # x1, x2, y1, y2
    eqs = np.zeros((2, N_EQ, 4))
    above = np.zeros(2)
    slow_ok = np.zeros(2)
    for i in range(n):
        lv = np.zeros(2)
        xin = np.zeros(2)
        for c in range(2):
            xi = _shape(x[c, i] * P[P_PRE], P[P_IN_A2], P[P_IN_A3], P[P_IN_SAT])
            xin[c] = xi
            s = yprev[c] if P[P_FB] > 0.5 else xi
            if P[P_HP_B0] != 0.0:
                h = hp[c]
                o = P[P_HP_B0] * s + P[P_HP_B1] * h[0] + P[P_HP_B2] * h[1] - P[P_HP_A1] * h[2] - P[P_HP_A2] * h[3]
                h[1] = h[0]
                h[0] = s
                h[3] = h[2]
                h[2] = o
                s = o
            if P[P_RECT] > 0.5:
                r = s if s > 0.0 else 0.0
            else:
                r = s if s > 0.0 else -s
            r = r / P[P_THR]
            # détecteur crête (montée / descente exponentielles)
            e = sm[c]
            if r > e:
                e = r if P[P_DET_ATT] <= 0.0 else e + (r - e) * P[P_DET_ATT]
            else:
                e = r if P[P_DET_REL] <= 0.0 else e + (r - e) * P[P_DET_REL]
            sm[c] = e
            r = e
            lv[c] = r
        if P[P_LINK] > 0.5:
            m = lv[0] if lv[0] > lv[1] else lv[1]
            lv[0] = m
            lv[1] = m
        for c in range(2):
            r = lv[c]
            L = 20.0 * math.log10(r if r > 1e-9 else 1e-9)
            Gt = _table(L, l0, dl, tab)
            At = 10.0 ** (Gt / 20.0)
            a = A[c]
            if Gt > 0.05:
                above[c] += 1.0
            if At > a:
                d = (At - a) * P[P_ATT]
                if P[P_ATT2] <= 0.0 and P[P_ATT_SLEW] > 0.0 and d > P[P_ATT_SLEW]:
                    d = P[P_ATT_SLEW]
                a += d
                if P[P_HOLD] >= 0.0 and above[c] > P[P_HOLD]:
                    slow_ok[c] = 1.0
            else:
                # Relâchement : deux temps (F/M) -> rapide si la crête a été brève
                if P[P_HOLD] >= 0.0 and slow_ok[c] < 0.5:
                    sl = P[P_REL2_SLEW]
                else:
                    sl = P[P_REL_SLEW]
                if P[P_REL_DUCK] != 0.0:
                    sl *= (1.0 / a) ** P[P_REL_DUCK]
                d = sl + (a - At) * P[P_REL_EXP]
                if d > a - At:
                    d = a - At
                a -= d
                if At <= 1.0000001:
                    above[c] = 0.0
                    if a <= 1.0000001:
                        slow_ok[c] = 0.0
            A[c] = a
            # 2e étage (cellule) : suit le 1er, montée bornée en vitesse
            if P[P_ATT2] > 0.0:
                b = A2[c]
                if a > b:
                    d = (a - b) * P[P_ATT2]
                    if P[P_ATT_SLEW] > 0.0 and d > P[P_ATT_SLEW]:
                        d = P[P_ATT_SLEW]
                    b += d
                else:
                    b += (a - b) * (P[P_REL2_FOLLOW] if P[P_REL2_FOLLOW] > 0.0 else P[P_ATT2])
                A2[c] = b
                a = b
            # mémoire opto (état lent qui retient la réduction)
            if P[P_MEM] > 0.0:
                if a > mem[c]:
                    mem[c] += (a - mem[c]) * P[P_MEM_CH]
                else:
                    mem[c] += (a - mem[c]) * P[P_MEM_DIS]
                ae = a + P[P_MEM] * (mem[c] - a) if mem[c] > a else a
            else:
                ae = a
            g = 1.0 / ae
            yc = xin[c] * g
            yprev[c] = yc
            yo = _shape(yc, P[P_OUT_A2], P[P_OUT_A3], P[P_OUT_SAT]) * P[P_MAKEUP]
            for q in range(N_EQ):
                o0 = P_EQ + 5 * q
                if P[o0] != 0.0:
                    h = eqs[c, q]
                    o = P[o0] * yo + P[o0 + 1] * h[0] + P[o0 + 2] * h[1] - P[o0 + 3] * h[2] - P[o0 + 4] * h[3]
                    h[1] = h[0]
                    h[0] = yo
                    h[3] = h[2]
                    h[2] = o
                    yo = o
            y[c, i] = P[P_MIX] * yo + (1.0 - P[P_MIX]) * x[c, i]
            if c == 0:
                atrace[i] = ae
    return y, atrace


def hpf_coefs(fc, sr=48000.0, q=0.7071):
    if not fc:
        return [0.0, 0.0, 0.0, 0.0, 0.0]
    w0 = 2 * math.pi * fc / sr
    al = math.sin(w0) / (2 * q)
    cw = math.cos(w0)
    a0 = 1 + al
    return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0]


def biquad(kind, fc, q=0.7071, gain_db=0.0, sr=48000.0):
    """Biquad RBJ : 'hp', 'lp', 'peak', 'lowshelf', 'highshelf' -> [b0,b1,b2,a1,a2]."""
    w0 = 2 * math.pi * fc / sr
    cw, sw = math.cos(w0), math.sin(w0)
    al = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + al, -2 * cw, 1 - al]
    elif kind == "lp":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + al, -2 * cw, 1 - al]
    elif kind == "peak":
        b = [1 + al * A, -2 * cw, 1 - al * A]; a = [1 + al / A, -2 * cw, 1 - al / A]
    elif kind == "lowshelf":
        sa = 2 * math.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
        a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
    elif kind == "highshelf":
        sa = 2 * math.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
        a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    else:
        raise ValueError(kind)
    return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]]


def coef_from_ms(ms, sr=48000.0):
    """Coefficient d'un lissage exponentiel de constante de temps `ms`."""
    if ms <= 0:
        return 1.0
    return 1.0 - math.exp(-1.0 / (ms * 0.001 * sr))
