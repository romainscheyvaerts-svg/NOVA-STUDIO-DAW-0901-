"""
Tour 2 : étage de sortie TABULÉ — caractéristique de transfert y = f(u) mesurée
directement sur le VST d'origine (régime sans compression), là où le polynôme +
tanh du tour 1 ratait les harmoniques (Leveler 2A, Vox Strip).

Méthode (boîte noire) : sinus 1 kHz dont l'amplitude monte lentement de -50 à
0 dBFS (l'étage est sans mémoire à 1 kHz : mêmes harmoniques de 50 Hz à 5 kHz),
pour deux réglages de gain ; u = signal vu par l'étage dans le modèle NOVA ;
moindres carrés linéaires sur une table en v = asinh(u), lissée.

Usage :
  pythonw -m tour2.ws measure <banc>   -> <labo>/<id>/tour2/ws_vst.npz
  python  -m tour2.ws fit <banc>       -> fit["ws"] dans le *_fit.json
"""
import importlib, math, os, sys
import numpy as np
from scipy import signal as sps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402
from tour2.common import banc_mod, LABO, SR  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402

SETS = {"la2a": [{"peak_reduct": "0", "gain": "50"}, {"peak_reduct": "0", "gain": "100"}],
        "voxbox": [{}, {"input": 10.0}],
        "fet76": [{"ratio": "None"}, {"ratio": "None", "output": 0.0, "input": 0.0}],
        "cl1b": [{"threshold_db": "Off"}, {"threshold_db": "Off", "output_volume_db": 10.0}]}
PROF = {"cl1b": "modeles.cl1b_profil", "fet76": "modeles.fet76_profil", "la2a": "modeles.la2a_profil", "voxbox": "modeles.voxbox_profil"}
F0 = 1000.0
DUR = 8.0


def stimulus():
    n = int(DUR * SR)
    t = np.arange(n) / SR
    lev = -50.0 + 50.0 * t / DUR
    x = 10 ** (lev / 20) * np.sin(2 * np.pi * F0 * t)
    return x


def measure(bn):
    import host, procs  # noqa
    host.hide_console()
    banc = banc_mod(bn)
    proc = procs.VstProc(banc.PLUGIN, banc.BASE)
    x = stimulus()
    ys = []
    for st in SETS[bn]:
        proc.configure(st)
        ys.append(proc.run(np.vstack([x, x]))[0])
    np.savez(os.path.join(LABO, banc.ID, "tour2", "ws_vst.npz"), x=x, y=np.array(ys))


def _frac_shift(u, d):
    """Retarde u de d échantillons (fractionnaire, par FFT)."""
    n = len(u)
    N = 1 << (n - 1).bit_length()
    U = np.fft.rfft(u, N)
    f = np.fft.rfftfreq(N)
    return np.fft.irfft(U * np.exp(-2j * np.pi * f * d), N)[:n]


def _post_gain(P):
    """Gain linéaire après l'étage (gain de sortie + biquads) à 1 kHz."""
    g = P[ac.P_MAKEUP]
    w = 2 * np.pi * F0 / SR
    z = np.exp(-1j * w)
    for q in range(2 * ac.N_EQ):
        o = ac.P_EQ + 5 * q if q < ac.N_EQ else ac.P_EQ2 + 5 * (q - ac.N_EQ)
        if P[o] != 0.0:
            b0, b1, b2, a1, a2 = P[o:o + 5]
            g = g * (b0 + b1 * z + b2 * z * z) / (1 + a1 * z + a2 * z * z)
    return g


def fit(bn, lam=3e-3, only=None):
    prof = importlib.import_module(PROF[bn])
    banc = banc_mod(bn)
    F = prof.load_fit()
    F.pop("ws", None)
    d = np.load(os.path.join(LABO, banc.ID, "tour2", "ws_vst.npz"))
    x, Y = d["x"], d["y"]
    rows_u, rows_y = [], []
    for k_, (st, yv) in enumerate(zip(SETS[bn], Y)):
        if only is not None and k_ not in only:
            continue
        P, l0, dl, tab = prof.builder(F, banc.to_nova)(st)
        drv = P[ac.P_DRIVE] if P[ac.P_DRIVE] != 0 else 1.0
        xi = np.array([ac._shape(v * P[ac.P_PRE], P[ac.P_IN_A2], P[ac.P_IN_A3], P[ac.P_IN_SAT], P[ac.P_IN_BIAS], P[ac.P_IN_AB]) for v in x])
        u = drv * xi
        gp = _post_gain(P)
        # alignement : retard fractionnaire estimé sur la partie basse (linéaire)
        n0 = int(1.0 * SR)
        n1 = int(3.0 * SR)
        best = (0.0, -1)
        for dd in np.linspace(-3, 3, 241):
            us = _frac_shift(u[:n1], dd)
            c = np.dot(us[n0:n1], yv[n0:n1]) / math.sqrt(np.dot(us[n0:n1], us[n0:n1]) * np.dot(yv[n0:n1], yv[n0:n1]) + 1e-30)
            if c > best[1]:
                best = (dd, c)
        us = _frac_shift(u, best[0])
        print("réglage", st, "retard", round(best[0], 3), "corrélation", round(best[1], 6), "gain post", round(abs(gp), 4))
        sel = slice(int(0.5 * SR), len(x) - int(0.05 * SR))
        rows_u.append(us[sel])
        rows_y.append(yv[sel] / abs(gp))
    u = np.concatenate(rows_u)
    y = np.concatenate(rows_y)
    umax = float(np.max(np.abs(u)))
    vmax = math.asinh(4.0 * umax)
    N = ac.N_WS
    v = np.arcsinh(u)
    fidx = (v + vmax) / (2 * vmax) * (N - 1)
    i = np.clip(np.floor(fidx).astype(int), 0, N - 2)
    t = fidx - i
    from scipy.sparse import csr_matrix, vstack, diags
    from scipy.sparse.linalg import lsqr
    m = len(u)
    # base de Catmull-Rom (même interpolation que le cœur)
    w0 = 0.5 * (-t + 2 * t ** 2 - t ** 3)
    w1 = 0.5 * (2 - 5 * t ** 2 + 3 * t ** 3)
    w2 = 0.5 * (t + 4 * t ** 2 - 3 * t ** 3)
    w3 = 0.5 * (-t ** 2 + t ** 3)
    i0 = np.maximum(i - 1, 0)
    i3 = np.minimum(i + 2, N - 1)
    rows = np.tile(np.arange(m), 4)
    # y = u * h(v) ; moindres carrés RELATIFS (poids 1/|u|) : la petite amplitude compte autant que la grande
    wr = 1.0 / (np.abs(u) + 0.003 * umax)
    A = csr_matrix((np.concatenate([w0, w1, w2, w3]) * np.tile(u * wr, 4), (rows, np.concatenate([i0, i, i + 1, i3]))), shape=(m, N))
    A_plain = csr_matrix((np.concatenate([w0, w1, w2, w3]) * np.tile(u, 4), (rows, np.concatenate([i0, i, i + 1, i3]))), shape=(m, N))
    D = diags([-np.ones(N - 3), 3 * np.ones(N - 3), -3 * np.ones(N - 3), np.ones(N - 3)], [0, 1, 2, 3], shape=(N - 3, N))
    # point central : f(0) = 0
    scale = math.sqrt(m) * lam
    # près de zéro, y = u.h(v) ne renseigne pas h : h y est tenu PLAT (étage linéaire en petit signal,
    # comme l'original : aucune harmonique mesurable sous -30 dBFS)
    vv0 = np.linspace(-vmax, vmax, N)
    flat = np.where(np.abs(np.sinh(vv0[:-1])) < 0.06 * umax)[0]
    D1 = csr_matrix((np.concatenate([-np.ones(len(flat)), np.ones(len(flat))]),
                     (np.concatenate([np.arange(len(flat))] * 2), np.concatenate([flat, flat + 1]))), shape=(len(flat), N))
    keep = np.abs(u) > 0.01 * umax
    A = A[np.where(keep)[0]]
    A_fit_rhs = (y * wr)[keep]
    M = vstack([A, D * scale, D1 * math.sqrt(m) * 10.0])
    rhs = np.concatenate([A_fit_rhs, np.zeros(N - 3), np.zeros(len(flat))])
    sol = lsqr(M, rhs, atol=1e-12, btol=1e-12, iter_lim=20000)[0]
    # hors de la zone mesurée (au-delà de 0 dBFS) : prolonge avec la pente de la fin de mesure (en u)
    vv = np.linspace(-vmax, vmax, N)
    uu = np.sinh(vv)
    inside = np.abs(uu) <= umax * 0.98
    lo, hi = np.argmax(inside), N - 1 - np.argmax(inside[::-1])
    # gain h : au-delà de la mesure, la sortie garde la pente de fin de mesure (y = y_fin + s (u - u_fin))
    for k in range(hi + 1, N):
        yk = uu[hi] * sol[hi] + max(0.0, (uu[hi] * sol[hi] - uu[hi - 3] * sol[hi - 3]) / (uu[hi] - uu[hi - 3])) * (uu[k] - uu[hi])
        sol[k] = yk / uu[k]
    for k in range(0, lo):
        yk = uu[lo] * sol[lo] + max(0.0, (uu[lo + 3] * sol[lo + 3] - uu[lo] * sol[lo]) / (uu[lo + 3] - uu[lo])) * (uu[k] - uu[lo])
        sol[k] = yk / uu[k]
    for k_ in range(len(rows_u)):
        a_ = sum(len(r) for r in rows_u[:k_])
        b_ = a_ + len(rows_u[k_])
        rr = y[a_:b_] - (A_plain @ sol)[a_:b_]
        print("  résidu réglage", k_, "%.1f dB" % (10 * np.log10(np.sum(rr ** 2) / np.sum(y[a_:b_] ** 2))))
    res = y - A_plain @ sol
    print("résidu RMS relatif : %.1f dB" % (10 * np.log10(np.sum(res ** 2) / np.sum(y ** 2))))
    k0 = N // 2
    slope0 = sol[k0]
    print("pente en petit signal %.4f (%.2f dB)" % (slope0, 20 * np.log10(abs(slope0))))
    F["ws"] = {"max": float(vmax), "table": [float(q) for q in sol]}
    prof.save_fit(F)


def fit_h(bn, only=(0,), nh=7, lam=1e-3):
    """Calage de la table sur les HARMONIQUES (amplitude et signe de H1..H7 par
    fenêtre de 20 ms le long de la rampe) : les harmoniques sont des fonctionnelles
    LINÉAIRES de la table (f(A cos t) développée en série de Fourier)."""
    prof = importlib.import_module(PROF[bn])
    banc = banc_mod(bn)
    F = prof.load_fit()
    F.pop("ws", None)
    d = np.load(os.path.join(LABO, banc.ID, "tour2", "ws_vst.npz"))
    x, Y = d["x"], d["y"]
    N = ac.N_WS
    rowsA, rowsB, wts = [], [], []
    umax = 0.0
    data = []
    for k_, (st, yv) in enumerate(zip(SETS[bn], Y)):
        if k_ not in only:
            continue
        P, l0, dl, tab = prof.builder(F, banc.to_nova)(st)
        drv = P[ac.P_DRIVE] if P[ac.P_DRIVE] != 0 else 1.0
        gp = abs(_post_gain(P))
        W = int(0.02 * SR)
        n = len(x)
        t = np.arange(W) / SR
        win = np.hanning(W)
        for s0 in range(int(0.3 * SR), n - W, W):
            seg_x = x[s0:s0 + W]
            seg_y = yv[s0:s0 + W] / gp
            # phase et amplitude de l'entrée (fondamental)
            E = np.exp(-2j * np.pi * F0 * t)
            cx = 2 * np.sum(seg_x * win * E) / np.sum(win)
            A = abs(cx) * drv * P[ac.P_PRE]
            ph = np.angle(cx)
            hk = []
            for k in range(1, nh + 1):
                ck = 2 * np.sum(seg_y * win * np.exp(-2j * np.pi * k * F0 * t)) / np.sum(win)
                hk.append((ck * np.exp(-1j * k * ph)).real)  # f(A cos) -> harmoniques réelles
            data.append((A, np.array(hk)))
            umax = max(umax, A)
    vmax = math.asinh(4.0 * umax)
    th = np.linspace(0, 2 * np.pi, 512, endpoint=False)
    rows, rhs, ws_ = [], [], []
    for A, hk in data:
        u = A * np.cos(th)
        v = np.arcsinh(u)
        fidx = (v + vmax) / (2 * vmax) * (N - 1)
        i = np.clip(np.floor(fidx).astype(int), 0, N - 2)
        tt = fidx - i
        w0 = 0.5 * (-tt + 2 * tt ** 2 - tt ** 3)
        w1 = 0.5 * (2 - 5 * tt ** 2 + 3 * tt ** 3)
        w2 = 0.5 * (tt + 4 * tt ** 2 - 3 * tt ** 3)
        w3 = 0.5 * (-tt ** 2 + tt ** 3)
        B = np.zeros((len(th), N))
        np.add.at(B, (np.arange(len(th)), np.maximum(i - 1, 0)), w0 * u)
        np.add.at(B, (np.arange(len(th)), i), w1 * u)
        np.add.at(B, (np.arange(len(th)), i + 1), w2 * u)
        np.add.at(B, (np.arange(len(th)), np.minimum(i + 2, N - 1)), w3 * u)
        for k in range(1, nh + 1):
            ck = 2 * np.cos(k * th) / len(th)
            row = ck @ B
            # erreur RELATIVE (≈ dB) : chaque harmonique compte, même à -80 dB
            wk = 1.0 / (abs(hk[k - 1]) + A * 10 ** (-90 / 20))
            if k == 1:
                wk *= 3.0
            rows.append(row * wk)
            rhs.append(hk[k - 1] * wk)
    Amat = np.array(rows)
    b = np.array(rhs)
    D = np.zeros((N - 3, N))
    for r in range(N - 3):
        D[r, r:r + 4] = [-1, 3, -3, 1]
    vv = np.linspace(-vmax, vmax, N)
    flat = np.where(np.abs(np.sinh(vv[:-1])) < 0.03 * umax)[0]
    D1 = np.zeros((len(flat), N))
    for r, j in enumerate(flat):
        D1[r, j], D1[r, j + 1] = -1, 1
    scale = math.sqrt(len(b)) * lam
    M = np.vstack([Amat, D * scale, D1 * math.sqrt(len(b))])
    rr = np.concatenate([b, np.zeros(N - 3), np.zeros(len(flat))])
    sol = np.linalg.lstsq(M, rr, rcond=None)[0]
    # au-delà de la mesure : pente de fin conservée
    uu = np.sinh(vv)
    inside = np.abs(uu) <= umax * 0.98
    lo, hi = np.argmax(inside), N - 1 - np.argmax(inside[::-1])
    for k in range(hi + 1, N):
        yk = uu[hi] * sol[hi] + max(0.0, (uu[hi] * sol[hi] - uu[hi - 3] * sol[hi - 3]) / (uu[hi] - uu[hi - 3])) * (uu[k] - uu[hi])
        sol[k] = yk / uu[k]
    for k in range(0, lo):
        yk = uu[lo] * sol[lo] + max(0.0, (uu[lo + 3] * sol[lo + 3] - uu[lo] * sol[lo]) / (uu[lo + 3] - uu[lo])) * (uu[k] - uu[lo])
        sol[k] = yk / uu[k]
    e = (Amat @ sol - b)
    print("écart relatif RMS des harmoniques (≈ dB) : %.2f" % (20 * np.log10(1 + np.sqrt(np.mean(e ** 2)))), "points", len(data))
    F["ws"] = {"max": float(vmax), "table": [float(q) for q in sol]}
    prof.save_fit(F)


if __name__ == "__main__":
    if sys.argv[1] == "measure":
        measure(sys.argv[2])
    elif sys.argv[1] == "fith":
        fit_h(sys.argv[2], tuple(int(v) for v in sys.argv[3].split(",")) if len(sys.argv) > 3 else (0,))
    else:
        only = [int(v) for v in sys.argv[3].split(",")] if len(sys.argv) > 3 else None
        fit(sys.argv[2], only=only)
