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
P_DRIVE = 52       # gain avant l'étage de sortie (0 = 1) ; P_MAKEUP s'applique après
P_IN_BIAS = 53     # asymétrie des saturations (tanh(y/sat + biais) - tanh(biais))
P_OUT_BIAS = 54
P_FAST_ATT = 55    # cellule rapide en parallèle (mode deux temps) : coefficient de montée (0 = absente)
P_FAST_REL = 56    # cellule rapide : pente de relâchement (A par échantillon)
P_FAST_DET_REL = 57  # cellule rapide : descente de son détecteur crête
P_FET_A2 = 58      # distorsion de l'élément de gain (FET) : H2 proportionnel à la réduction
P_FINAL_SAT = 59   # étage final (après le gain de sortie) : saturation douce (0 = aucune)
P_FINAL_BIAS = 60
P_SLOW_FRAC = 61   # part de la réduction portée par une cellule lente EN SÉRIE (0 = aucune)
P_SLOW_ATT = 62    # cellule lente en série : coefficient de charge
P_SLOW_REL = 63    # cellule lente en série : coefficient de relâchement (exponentiel)
P_OUT_AB = 64      # étage de sortie : terme x|x| (H3, H5 qui montent de 1 dB par dB, comme un FET)
P_IN_AB = 65       # étage d'entrée : terme x|x|
P_SC2 = 66         # 2e filtre du sidechain (biquad b0,b1,b2,a1,a2 : 66..70) ; b0 = 0 -> ignoré
P_OUT_KNEE = 71    # étage de sortie : dureté du coude de saturation (0 = tanh ; k > 0 : u/(1+|u|^k)^(1/k))
P_XF_K = 72        # transformateur : saturation du fer dans le grave (y = x + k·x·φ², φ = flux intégré) ; 0 = aucun
P_XF_A = 73        # transformateur : coefficient de l'intégrateur (fréquence de coin du flux)
P_XF_MODE = 74     # 0 : y = x + k·x·φ² ; 1 : y = x + k·φ·|φ| (H3 relative en 1 dB/dB et 12 dB/oct, mesuré sur le Vox Strip) ;
                   # 2 : même loi k·φ·|φ| mais à l'ENTRÉE (avant la compression : la distorsion suit le niveau d'entrée)
P_EQ2 = 80         # 4 biquads de couleur supplémentaires (80..99)
# ── Tour 2 : cellule « multi-composantes » en dB (remplace la cellule A si P_C3 > 0) ──
# La réduction totale g (dB) est la somme de 3 composantes g_k qui suivent chacune
# la part f_k de la cible T (dB, loi statique) :
#   montée   : g_k += min((f_k T - g_k) * a_k * exp(alpha_k T), s_k)   (vitesse selon la « lumière », bornée à s_k dB/éch.)
#   descente : g_k -= h * exp(beta_k g) * ((g_k - f_k T) * r_k + f_k l_k)   (bornée à la cible ;
#              beta = -0,115 : pente constante dans le domaine linéaire, comme une cellule optique)
#              h : rampe 0 -> 1 depuis la dernière montée (cellule qui « tient » avant de relâcher)
# -> mémoire de programme (les composantes lentes se chargent avec la durée) et
#    temps qui dépendent du niveau, comme une cellule optique ou un FET réels.
P_C3 = 100         # 1 = cellule multi-composantes en dB
P_C3_K = 101       # 3 composantes x 8 : f, a, alpha, r, beta, l, s (vitesse max de montée, dB/éch.), (réservé)  -> 101..124
P_C3_MAX = 108     # (case réservée de la 1re composante) 1 = la réduction suit la PLUS FORTE des composantes
                   # (cellules en parallèle, mode F/M de l'Opto Vintage) au lieu de leur somme
P_DET_SQ = 125     # 1 = détecteur RMS (carré lissé par P_DET_ATT / P_DET_REL, puis racine)
P_C3_ATT_DB = 126  # montée : la cible vue par la cellule est T + k (T - g) (anticipation) ; 0 = aucune
P_C3_HOLD = 127    # relâchement retardé : la vitesse de descente monte de 0 à 1 (coefficient par éch.) ; 0 = immédiate
P_LAT = 128        # latence DÉCLARÉE au PDC (échantillons entiers) : le passe-tout fractionnaire + cette latence
                   # reproduisent l'avance de phase mesurée du plugin d'origine (le cœur ne retarde rien lui-même)
P_WS_MAX = 129     # étage de sortie TABULÉ (mesuré) : v = asinh(u) dans [-max, +max] ; 0 = étage polynomial / tanh habituel
P_WS = 130         # table du GAIN de l'étage y = u * h(v), N_WS points régulièrement espacés en v = asinh(u)
                   # (fin près de zéro, large dans la saturation)
N_WS = 257
# ── Tour 3 : DÉTECTEUR À DEUX VOIES avant la loi statique (charge / décharge d'un condensateur) ──
# u = (|s| / seuil)^p ; chaque voie d suit u : montée e += (u - e)·a_d, descente e -= (e - u)·r_d + l_d
# (bornée à u) ; niveau L_d = (20/p)·log10(e_d) + décalage_d (dB). Chaque composante k de la cellule
# prend sa cible dans la voie choisie (P_D3_SEL + k) : en F/M, voie rapide fixe + voie manuelle.
# Une salve courte ne charge qu'à peine la voie lente -> relâchement court ; un son tenu la charge
# -> relâchement long ; un train de salves l'accumule (comportement de programme mesuré).
P_D3 = 387          # 1 = détecteur à deux voies actif (avec la cellule multi-composantes)
P_D3_POW = 388      # exposant p du domaine du détecteur (1 = tension, 2 = puissance, petit = quasi log)
P_D3_DET = 389      # 2 voies x 4 : coefficient de montée, coefficient de descente, pente de descente (u/éch.), décalage (dB)
P_D3_SEL = 397      # voie (0 / 1) de chacune des 3 composantes
P_D3_CAP = 400      # 2 voies : plafond de la charge (u ; 0 = aucun) — la cellule sature, le condensateur aussi
NP = 410            # (400..409 réservés)


@njit(cache=True)
def _clip_k(u, k):
    return u / (1.0 + abs(u) ** k) ** (1.0 / k)


@njit(cache=True)
def _shape_k(x, a2, a3, sat, bias, ab, k):
    """Étage à coude réglable (k grand = coude dur), gain unité en petit signal."""
    y = x + a2 * x * x + a3 * x * x * x + ab * x * abs(x)
    if sat > 0.0:
        fb = _clip_k(bias, k)
        d = (1.0 + abs(bias) ** k) ** (-1.0 / k - 1.0)
        y = sat * (_clip_k(y / sat + bias, k) - fb) / d
    return y


@njit(cache=True)
def _shape(x, a2, a3, sat, bias, ab):
    y = x + a2 * x * x + a3 * x * x * x + ab * x * abs(x)
    if sat > 0.0:
        tb = math.tanh(bias)
        y = sat * (math.tanh(y / sat + bias) - tb) / (1.0 - tb * tb)
    return y


@njit(cache=True)
def _ws(u, P):
    """Caractéristique de transfert mesurée (interpolation cubique, écrêtée aux bornes)."""
    m = P[P_WS_MAX]
    f = (math.asinh(u) + m) / (2.0 * m) * (N_WS - 1)
    if f <= 0.0:
        return u * P[P_WS]
    if f >= N_WS - 1:
        return u * P[P_WS + N_WS - 1]
    i = int(f)
    t = f - i
    # interpolation cubique (Catmull-Rom) : pente continue -> aucune harmonique parasite des nœuds
    i0 = i - 1 if i > 0 else 0
    i3 = i + 2 if i + 2 < N_WS else N_WS - 1
    p0 = P[P_WS + i0]
    p1 = P[P_WS + i]
    p2 = P[P_WS + i + 1]
    p3 = P[P_WS + i3]
    return u * (p1 + 0.5 * t * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0))))


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
    """x : (nch, n) float64 (nch = 1 ou 2) -> (y (nch, n), A (n) du canal 0)."""
    nch = x.shape[0]
    n = x.shape[1]
    y = np.zeros((nch, n))
    atrace = np.zeros(n)
    A = np.ones(2)
    A2 = np.ones(2)
    sm = np.zeros(2)
    mem = np.zeros(2)
    yprev = np.zeros(2)
    hp = np.zeros((2, 4))  # x1, x2, y1, y2
    hp2 = np.zeros((2, 4))
    eqs = np.zeros((2, 2 * N_EQ, 4))
    flux = np.zeros(2)
    above = np.zeros(2)
    slow_ok = np.zeros(2)
    envf = np.zeros(2)
    As = np.ones(2)
    Af = np.ones(2)
    lvf = np.zeros(2)
    gk = np.zeros((2, 3))
    hm = np.ones(2)
    lv = np.zeros(2)
    xin = np.zeros(2)
    fluxi = np.zeros(2)
    xf_in = P[P_XF_K] != 0.0 and P[P_XF_MODE] > 1.5
    c3 = P[P_C3] > 0.5
    d3 = P[P_D3] > 0.5
    pw = P[P_D3_POW] if P[P_D3_POW] > 0.0 else 1.0
    ed = np.zeros((2, 2))
    gd = np.zeros(2)
    sq = P[P_DET_SQ] > 0.5
    thr2 = P[P_THR] * P[P_THR]
    drv = P[P_DRIVE] if P[P_DRIVE] != 0.0 else 1.0
    for i in range(n):
        for c in range(nch):
            xi = _shape(x[c, i] * P[P_PRE], P[P_IN_A2], P[P_IN_A3], P[P_IN_SAT], P[P_IN_BIAS], P[P_IN_AB])
            if xf_in:
                fluxi[c] += (xi - fluxi[c]) * P[P_XF_A]
                xi = xi + P[P_XF_K] * fluxi[c] * abs(fluxi[c])
            xin[c] = xi
            s = yprev[c] if P[P_FB] > 0.5 else xi
            if P[P_HP_B0] != 0.0:
                o = P[P_HP_B0] * s + P[P_HP_B1] * hp[c, 0] + P[P_HP_B2] * hp[c, 1] - P[P_HP_A1] * hp[c, 2] - P[P_HP_A2] * hp[c, 3]
                hp[c, 1] = hp[c, 0]
                hp[c, 0] = s
                hp[c, 3] = hp[c, 2]
                hp[c, 2] = o
                s = o
            if P[P_SC2] != 0.0:
                o = P[P_SC2] * s + P[P_SC2 + 1] * hp2[c, 0] + P[P_SC2 + 2] * hp2[c, 1] - P[P_SC2 + 3] * hp2[c, 2] - P[P_SC2 + 4] * hp2[c, 3]
                hp2[c, 1] = hp2[c, 0]
                hp2[c, 0] = s
                hp2[c, 3] = hp2[c, 2]
                hp2[c, 2] = o
                s = o
            if d3:
                if P[P_RECT] > 0.5:
                    r = s if s > 0.0 else 0.0
                else:
                    r = s if s > 0.0 else -s
                r = r / P[P_THR]
                if pw == 1.0:
                    u = r
                elif pw == 2.0:
                    u = r * r
                else:
                    u = r ** pw if r > 0.0 else 0.0
                for d in range(2):
                    o = P_D3_DET + 4 * d
                    e = ed[c, d]
                    if u > e:
                        e += (u - e) * P[o]
                    else:
                        e -= (e - u) * P[o + 1] + P[o + 2]
                        if e < u:
                            e = u
                    if P[P_D3_CAP + d] > 0.0 and e > P[P_D3_CAP + d]:
                        e = P[P_D3_CAP + d]
                    ed[c, d] = e
                lv[c] = ed[c, 0]
                continue
            if sq:
                r = s * s / thr2
            else:
                if P[P_RECT] > 0.5:
                    r = s if s > 0.0 else 0.0
                else:
                    r = s if s > 0.0 else -s
                r = r / P[P_THR]
            # détecteur (montée / descente exponentielles)
            e = sm[c]
            if r > e:
                e = r if P[P_DET_ATT] <= 0.0 else e + (r - e) * P[P_DET_ATT]
            else:
                e = r if P[P_DET_REL] <= 0.0 else e + (r - e) * P[P_DET_REL]
            sm[c] = e
            if P[P_FAST_ATT] > 0.0:
                ef = envf[c]
                if r > ef:
                    ef = r
                else:
                    ef = ef + (r - ef) * P[P_FAST_DET_REL]
                envf[c] = ef
                lvf[c] = ef
            lv[c] = e
        if d3 and P[P_LINK] > 0.5 and nch == 2:
            for d in range(2):
                m = ed[0, d] if ed[0, d] > ed[1, d] else ed[1, d]
                ed[0, d] = m
                ed[1, d] = m
        if P[P_LINK] > 0.5 and nch == 2:
            m = lv[0] if lv[0] > lv[1] else lv[1]
            lv[0] = m
            lv[1] = m
            m = lvf[0] if lvf[0] > lvf[1] else lvf[1]
            lvf[0] = m
            lvf[1] = m
        for c in range(nch):
            r = lv[c]
            if d3:
                for d in range(2):
                    e = ed[c, d]
                    gd[d] = _table(20.0 / pw * math.log10(e if e > 1e-30 else 1e-30) + P[P_D3_DET + 4 * d + 3], l0, dl, tab)
                Gt = gd[0] if gd[0] > gd[1] else gd[1]
            elif sq:
                L = 10.0 * math.log10(r if r > 1e-18 else 1e-18)
                Gt = _table(L, l0, dl, tab)
            else:
                L = 20.0 * math.log10(r if r > 1e-9 else 1e-9)
                Gt = _table(L, l0, dl, tab)
            if c3:
                # cellule multi-composantes (dB)
                cmax = P[P_C3_MAX] > 0.5
                if cmax:
                    gtot = max(gk[c, 0], max(gk[c, 1], gk[c, 2]))
                else:
                    gtot = gk[c, 0] + gk[c, 1] + gk[c, 2]
                T = Gt
                if P[P_C3_HOLD] > 0.0:
                    if T > gtot:
                        hm[c] = 0.0
                    else:
                        hm[c] += (1.0 - hm[c]) * P[P_C3_HOLD]
                if P[P_C3_ATT_DB] != 0.0 and T > gtot and not d3:
                    T = T + P[P_C3_ATT_DB] * (T - gtot)
                for k in range(3):
                    o0 = P_C3_K + 8 * k
                    f = P[o0]
                    if f <= 0.0:
                        continue
                    if d3:
                        T = gd[1] if P[P_D3_SEL + k] > 0.5 else gd[0]
                        if P[P_C3_ATT_DB] != 0.0 and T > gtot:
                            T = T + P[P_C3_ATT_DB] * (T - gtot)
                    tk = f * T
                    g = gk[c, k]
                    if tk > g:
                        ca = P[o0 + 1] * math.exp(P[o0 + 2] * T)
                        if ca > 1.0:
                            ca = 1.0
                        dg = (tk - g) * ca
                        if P[o0 + 6] > 0.0 and dg > P[o0 + 6]:
                            dg = P[o0 + 6]
                        g += dg
                    else:
                        mb = math.exp(P[o0 + 4] * gtot)
                        rr = P[o0 + 3] * mb
                        if rr > 1.0:
                            rr = 1.0
                        dd = ((g - tk) * rr + f * P[o0 + 5] * mb) * hm[c]
                        if dd > g - tk:
                            dd = g - tk
                        g -= dd
                    gk[c, k] = g
                if cmax:
                    ae = 10.0 ** (max(gk[c, 0], max(gk[c, 1], gk[c, 2])) / 20.0)
                else:
                    ae = 10.0 ** ((gk[c, 0] + gk[c, 1] + gk[c, 2]) / 20.0)
            else:
                if P[P_SLOW_FRAC] > 0.0:
                    Gs = Gt * P[P_SLOW_FRAC]
                    Gt = Gt - Gs
                    Ats = 10.0 ** (Gs / 20.0)
                    s_ = As[c]
                    if Ats > s_:
                        s_ += (Ats - s_) * P[P_SLOW_ATT]
                    else:
                        s_ -= (s_ - Ats) * P[P_SLOW_REL]
                    As[c] = s_
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
                # cellule rapide en parallèle : la réduction suit la plus forte des deux
                if P[P_FAST_ATT] > 0.0:
                    rf = lvf[c]
                    Atf = 10.0 ** (_table(20.0 * math.log10(rf if rf > 1e-9 else 1e-9), l0, dl, tab) / 20.0)
                    f = Af[c]
                    if Atf > f:
                        f += (Atf - f) * P[P_FAST_ATT]
                    else:
                        df = P[P_FAST_REL]
                        if df > f - Atf:
                            df = f - Atf
                        f -= df
                    Af[c] = f
                    if f > a:
                        a = f
                # mémoire opto (état lent qui retient la réduction)
                if P[P_MEM] > 0.0:
                    if a > mem[c]:
                        mem[c] += (a - mem[c]) * P[P_MEM_CH]
                    else:
                        mem[c] += (a - mem[c]) * P[P_MEM_DIS]
                    ae = a + P[P_MEM] * (mem[c] - a) if mem[c] > a else a
                else:
                    ae = a
                if P[P_SLOW_FRAC] > 0.0:
                    ae = ae * As[c]
            g = 1.0 / ae
            xv = xin[c]
            if P[P_FET_A2] != 0.0:
                xv = xv + P[P_FET_A2] * (1.0 - g) * xv * xv
            yc = xv * g
            yprev[c] = yc
            if P[P_WS_MAX] > 0.0:
                yo = _ws(yc * drv, P) * P[P_MAKEUP]
            elif P[P_OUT_KNEE] > 0.0:
                yo = _shape_k(yc * drv, P[P_OUT_A2], P[P_OUT_A3], P[P_OUT_SAT], P[P_OUT_BIAS], P[P_OUT_AB], P[P_OUT_KNEE]) * P[P_MAKEUP]
            else:
                yo = _shape(yc * drv, P[P_OUT_A2], P[P_OUT_A3], P[P_OUT_SAT], P[P_OUT_BIAS], P[P_OUT_AB]) * P[P_MAKEUP]
            if P[P_XF_K] != 0.0 and not xf_in:
                flux[c] += (yo - flux[c]) * P[P_XF_A]
                if P[P_XF_MODE] > 0.5:
                    yo = yo + P[P_XF_K] * flux[c] * abs(flux[c])
                else:
                    yo = yo + P[P_XF_K] * yo * flux[c] * flux[c]
            if P[P_FINAL_SAT] > 0.0:
                yo = _shape(yo, 0.0, 0.0, P[P_FINAL_SAT], P[P_FINAL_BIAS], 0.0)
            for q in range(2 * N_EQ):
                o0 = P_EQ + 5 * q if q < N_EQ else P_EQ2 + 5 * (q - N_EQ)
                if P[o0] != 0.0:
                    o = P[o0] * yo + P[o0 + 1] * eqs[c, q, 0] + P[o0 + 2] * eqs[c, q, 1] - P[o0 + 3] * eqs[c, q, 2] - P[o0 + 4] * eqs[c, q, 3]
                    eqs[c, q, 1] = eqs[c, q, 0]
                    eqs[c, q, 0] = yo
                    eqs[c, q, 3] = eqs[c, q, 2]
                    eqs[c, q, 2] = o
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
    elif kind == "ap2":
        # passe-tout du 2e ordre (phase seule : filtres de suréchantillonnage, transformateurs)
        b = [1 - al, -2 * cw, 1 + al]; a = [1 + al, -2 * cw, 1 - al]
    elif kind == "ap1":
        # passe-tout du 1er ordre (Thiran) : retard fractionnaire de fc échantillons (à 48 kHz)
        d = min(1.9, max(0.0, fc * sr / 48000.0))
        a = (1.0 - d) / (1.0 + d)
        return [a, 1.0, 0.0, a, 0.0]
    elif kind == "hp1":
        w = math.tan(math.pi * fc / sr)
        h0 = 1.0 / (1.0 + w)
        return [h0, -h0, 0.0, (w - 1.0) / (w + 1.0), 0.0]
    else:
        raise ValueError(kind)
    return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]]


def coef_from_ms(ms, sr=48000.0):
    """Coefficient d'un lissage exponentiel de constante de temps `ms`."""
    if ms <= 0:
        return 1.0
    return 1.0 - math.exp(-1.0 / (ms * 0.001 * sr))


def interp_log(xs, ys, x):
    import numpy as _np
    return float(_np.exp(_np.interp(x, xs, _np.log(_np.maximum(_np.asarray(ys, float), 1e-12)))))


def apply_dyn2(P, d, sa=1.0, sr=1.0, SR=48000.0):
    """Tour 2 : branche la cellule multi-composantes (dB) décrite par `d` :
    d = {"comps": [[f, att_ms, alpha, rel_ms, beta, lin_db_s, e_att, e_rel], ...],
         "ant": k, "thr_db": décalage du seuil, "det": [rms, att_ms, rel_ms, rect_half] (optionnel)}
    sa / sr : multiplicateurs de vitesse donnés par les boutons ATTACK / RELEASE
    (composante k : vitesse × s**e_k)."""
    P[P_C3] = 1.0
    for k in range(3):
        o = P_C3_K + 8 * k
        P[o:o + 8] = 0.0
    for k, cp in enumerate(d["comps"][:3]):
        f, att_ms, alpha, rel_ms, beta, lin = cp[:6]
        ea = cp[6] if len(cp) > 6 else 1.0
        er = cp[7] if len(cp) > 7 else 1.0
        ka, kr = sa ** ea, sr ** er
        o = P_C3_K + 8 * k
        P[o] = f
        P[o + 1] = coef_from_ms(att_ms / ka, SR)
        P[o + 2] = alpha
        P[o + 3] = coef_from_ms(rel_ms / kr, SR) if rel_ms > 0 else 0.0
        P[o + 4] = beta
        P[o + 5] = lin * kr / SR
        sl = cp[8] if len(cp) > 8 else 0.0
        P[o + 6] = sl * ka * 1000.0 / SR if sl > 0 else 0.0   # dB/ms -> dB/éch.
    P[P_C3_ATT_DB] = d.get("ant", 0.0)
    P[P_C3_MAX] = 1.0 if d.get("max") else 0.0
    P[P_C3_HOLD] = coef_from_ms(d["hold_ms"], SR) if d.get("hold_ms", 0.0) > 0 else 0.0
    if d.get("thr_db"):
        P[P_THR] *= 10 ** (d["thr_db"] / 20.0)
    if d.get("trim_db"):
        # tour 3 : petit écart de gain linéaire mesuré (sortie), calé avec la dynamique
        P[P_MAKEUP] *= 10 ** (d["trim_db"] / 20.0)
    dets = d.get("dets")
    if dets:
        # tour 3 : détecteur à deux voies [montée ms, descente ms, pente u/s, décalage dB, e_att, e_rel]
        P[P_D3] = 1.0
        P[P_D3_POW] = float(d.get("pow", 1.0))
        for k, dv in enumerate(dets[:2]):
            ka = sa ** (dv[4] if len(dv) > 4 else 0.0)
            kr = sr ** (dv[5] if len(dv) > 5 else 0.0)
            o = P_D3_DET + 4 * k
            P[o] = coef_from_ms(dv[0] / ka, SR) if dv[0] > 0 else 1.0
            P[o + 1] = coef_from_ms(dv[1] / kr, SR) if dv[1] > 0 else 0.0
            P[o + 2] = dv[2] * kr / SR
            P[o + 3] = dv[3]
            P[P_D3_CAP + k] = 10 ** (dv[6] * P[P_D3_POW] / 20.0) if len(dv) > 6 and dv[6] > 0 else 0.0
        sel = d.get("sel", [0, 1, 1])
        for k in range(3):
            P[P_D3_SEL + k] = float(sel[k]) if k < len(sel) else 0.0
        if "rect" in d:
            P[P_RECT] = float(d["rect"])
    det = d.get("det")
    if det and not dets:
        P[P_DET_SQ] = float(det[0])
        P[P_DET_ATT] = coef_from_ms(det[1], SR) if det[1] > 0 else 0.0
        P[P_DET_REL] = coef_from_ms(det[2], SR) if det[2] > 0 else 0.0
        P[P_RECT] = float(det[3])
    # l'ancienne cellule ne sert plus
    P[P_SLOW_FRAC] = 0.0
    P[P_FAST_ATT] = 0.0
    P[P_MEM] = 0.0
    return P


def warp_table(tab, l0, dl, w):
    """Tour 3 : loi statique INTERNE = loi mesurée relue en L' = L + w0 + w1·L + w2·L²/100, réduction × (1 + w3).
    (Le détecteur à deux voies lisse avant la loi : la loi mesurée, composite, est recalée par le calage.)"""
    tab = np.asarray(tab, float)
    n = len(tab)
    w = list(w) + [0.0] * (4 - len(w))
    out = np.empty(n)
    for i in range(n):
        L = l0 + dl * i
        f = (L + w[0] + w[1] * L + w[2] * L * L / 100.0 - l0) / dl
        if f <= 0.0:
            v = tab[0]
        elif f >= n - 1:
            v = tab[n - 1]
        else:
            j = int(f)
            v = tab[j] + (tab[j + 1] - tab[j]) * (f - j)
        out[i] = v * (1.0 + w[3])
    return out


def apply_ws(P, ws):
    """Tour 2 : étage de sortie tabulé (caractéristique de transfert mesurée)."""
    if ws and len(ws.get("table", [])) == N_WS:
        P[P_WS_MAX] = float(ws["max"])
        P[P_WS:P_WS + N_WS] = ws["table"]
    return P


def apply_lti(P, lti, SR=48000.0, lat=0):
    """Tour 2 : correction linéaire mesurée (module + phase) placée dans les
    emplacements de biquads libres (retard fractionnaire 'ap1' + cloches)."""
    P[P_LAT] = float(int(round(lat * SR / 48000.0)))
    if not lti:
        return P
    slots = [P_EQ + 5 * q for q in range(N_EQ)] + [P_EQ2 + 5 * q for q in range(N_EQ)]
    free = [o for o in slots if P[o] == 0.0]
    for (kind, fc, q, g), o in zip(lti, free):
        P[o:o + 5] = biquad(kind, fc, q, g, SR)
    return P


def compensate(y, P):
    """Compensation de la latence déclarée (comme le PDC de NOVA) : sortie avancée de P_LAT éch."""
    L = int(P[P_LAT])
    if L <= 0:
        return y
    out = np.zeros_like(y)
    out[..., :-L] = y[..., L:]
    return out


def ff_to_fb(tab, l0, dl):
    """Loi statique d'un compresseur en CONTRE-RÉACTION (détecteur après l'élément
    de gain) équivalente à la loi en anticipation G(L) : G_fb(L - G(L)) = G(L)."""
    import numpy as _np
    tab = _np.asarray(tab, float)
    L = l0 + dl * _np.arange(len(tab))
    Lo = L - tab
    # Lo doit croître : on garde l'enveloppe croissante
    Lo = _np.maximum.accumulate(Lo + 1e-9 * _np.arange(len(tab)))
    out = _np.interp(L, Lo, tab, left=0.0, right=tab[-1] + (L[-1] - Lo[-1]) * 50.0)
    return _np.maximum(out, 0.0)
