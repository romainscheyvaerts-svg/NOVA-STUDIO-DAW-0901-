"""
Tour 2 : réponse COMPLEXE (module + phase) du VST d'origine et du modèle, en
régime linéaire, puis calage d'une correction : retard fractionnaire (passe-tout
du 1er ordre de Thiran) + cloches / plateaux (biquads), par moindres carrés
complexes. Le null test exige la phase, pas seulement le module.

Usage :
  pythonw -m tour2.lti measure <banc>     -> <labo>/<id>/tour2/lti_vst.npz (VST, sweep)
  python  -m tour2.lti fit <banc>         -> correction écrite dans le *_fit.json ("lti")
"""
import importlib, json, math, os, sys
import numpy as np
from scipy import signal as sps
from scipy.optimize import least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402
from tour2.common import banc_mod, LABO, SR  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402

LIN = {"cl1b": {"threshold_db": "Off"}, "fet76": {"ratio": "None"}, "la2a": {"peak_reduct": "0"}, "voxbox": {}}
PROF = {"cl1b": "modeles.cl1b_profil", "fet76": "modeles.fet76_profil", "la2a": "modeles.la2a_profil", "voxbox": "modeles.voxbox_profil"}
NF = 1 << 16
FREQS = np.geomspace(20, 20000, 400)


def complex_response(proc, level_db=-30.0, T=3.0):
    x, inv, L = bench.ess(T=T)
    A = bench.dbfs_amp(level_db)
    xin = np.concatenate([x * A, np.zeros(int(0.5 * SR))])
    y = proc.run(bench.stereo(xin))[0]
    ref = bench._deconv(xin, inv)
    ir = bench._deconv(y, inv)
    k0 = int(np.argmax(np.abs(ref)))
    pre, post = int(0.01 * SR), int(0.2 * SR)
    win = np.ones(pre + post)
    win[:pre // 2] = 0.5 - 0.5 * np.cos(np.pi * np.arange(pre // 2) / (pre // 2))
    tl = int(0.04 * SR)
    win[-tl:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(tl) / tl)
    R = np.fft.rfft(ref[k0 - pre:k0 + post] * win, NF)
    Y = np.fft.rfft(ir[k0 - pre:k0 + post] * win, NF)
    f = np.fft.rfftfreq(NF, 1 / SR)
    H = Y / np.where(np.abs(R) > 1e-12, R, 1e-12)
    Hr = np.interp(FREQS, f, H.real) + 1j * np.interp(FREQS, f, H.imag)
    return Hr


def measure(bn):
    import host, procs  # noqa
    host.hide_console()
    banc = banc_mod(bn)
    proc = procs.VstProc(banc.PLUGIN, banc.BASE)
    proc.configure(LIN[bn])
    H30 = complex_response(proc, -30.0)
    H45 = complex_response(proc, -45.0)
    out = os.path.join(LABO, banc.ID, "tour2")
    os.makedirs(out, exist_ok=True)
    np.savez(os.path.join(out, "lti_vst.npz"), f=FREQS, H30=H30, H45=H45)


class _Mono:
    def __init__(self, cfg):
        self.cfg = cfg

    def run(self, x):
        P, l0, dl, tab = self.cfg
        y, _ = ac.process(np.ascontiguousarray(x[:1], dtype=np.float64), P, float(l0), float(dl), np.ascontiguousarray(tab, dtype=np.float64))
        return np.vstack([y[0], y[0]])


def model_response(bn, fit, level_db=-30.0):
    prof = importlib.import_module(PROF[bn])
    banc = banc_mod(bn)
    f2 = dict(fit)
    f2["lti"] = None
    f2["lat"] = 0
    if "eq" in fit and not fit.get("eq"):
        f2["eq"] = []
    cfg = prof.builder(f2, banc.to_nova)(LIN[bn])
    return complex_response(_Mono(cfg), level_db)


def bq_resp(b, f):
    _, h = sps.freqz([b[0], b[1], b[2]], [1, b[3], b[4]], worN=f, fs=SR)
    return h


NPAR = {"ap1": 1, "ap2": 2, "hp": 2, "hp1": 1, "peak": 3, "lowshelf": 3, "highshelf": 3}
BOUNDS = {"ap1": ([0.0], [1.9]), "hp": ([3.0, 0.3], [200.0, 2.0]), "hp1": ([2.0], [200.0]), "ap2": ([15.0, 0.15], [23000.0, 5.0]),
          "peak": ([25.0, 0.2, -2.0], [20000.0, 4.0, 2.0]), "lowshelf": ([25.0, 0.2, -2.0], [20000.0, 2.0, 2.0]),
          "highshelf": ([25.0, 0.2, -2.0], [20000.0, 2.0, 2.0])}


def _split(params, kinds):
    out, i = [], 0
    for k in kinds:
        n = NPAR[k]
        out.append(list(params[i:i + n]))
        i += n
    return out


def corr_resp(params, kinds, f):
    h = np.ones(len(f), complex)
    for k, pp in zip(kinds, _split(params, kinds)):
        if k == "ap1":
            b = ac.biquad("ap1", pp[0], 0.7, 0.0, SR)
        elif k == "ap2":
            b = ac.biquad("ap2", pp[0], pp[1], 0.0, SR)
        elif k == "hp":
            b = ac.biquad("hp", pp[0], pp[1], 0.0, SR)
        elif k == "hp1":
            b = ac.biquad("hp1", pp[0], 0.7, 0.0, SR)
        else:
            b = ac.biquad(k, pp[0], pp[1], pp[2], SR)
        h = h * bq_resp(b, f)
    return h


def lti_list(params, kinds):
    out = []
    for k, pp in zip(kinds, _split(params, kinds)):
        if k == "ap1":
            out.append(["ap1", float(pp[0]), 0.7, 0.0])
        elif k == "ap2":
            out.append(["ap2", float(pp[0]), float(pp[1]), 0.0])
        elif k == "hp":
            out.append(["hp", float(pp[0]), float(pp[1]), 0.0])
        elif k == "hp1":
            out.append(["hp1", float(pp[0]), 0.7, 0.0])
        else:
            out.append([k, float(pp[0]), float(pp[1]), float(pp[2])])
    return out


def _x0(kinds, rng):
    x = []
    for k in kinds:
        lo, hi = BOUNDS[k]
        if k == "ap1":
            x.append(rng.uniform(0.05, 1.5))
        elif k == "ap2":
            x += [float(np.exp(rng.uniform(np.log(20), np.log(20000)))), rng.uniform(0.3, 1.5)]
        elif k == "hp":
            x += [float(np.exp(rng.uniform(np.log(5), np.log(60)))), rng.uniform(0.5, 1.0)]
        elif k == "hp1":
            x += [float(np.exp(rng.uniform(np.log(3), np.log(40))))]
        else:
            x += [float(np.exp(rng.uniform(np.log(30), np.log(18000)))), rng.uniform(0.4, 2.0), 0.0]
    return x


def fit(bn, max_slots=6, replace_eq=False):
    prof = importlib.import_module(PROF[bn])
    banc = banc_mod(bn)
    F = prof.load_fit()
    if replace_eq:
        F["eq"] = []
    m = np.load(os.path.join(LABO, banc.ID, "tour2", "lti_vst.npz"))
    f, Hv = m["f"], m["H30"]
    Hm = model_response(bn, F)
    C0 = Hv / Hm
    sel = (f >= 25) & (f <= 17000)
    if replace_eq:
        sel = (f >= 30) & (f <= 17000)
    # pondération « voix » : le null test se joue entre 100 Hz et 8 kHz
    w = np.where(f < 80, 0.4, 1.0) * np.where(f > 10000, 0.5, 1.0)
    print("écart avant :", "module max %.3f dB, phase max %.1f°" % (np.max(np.abs(20 * np.log10(np.abs(C0[sel])))), np.max(np.abs(np.degrees(np.angle(C0[sel]))))))
    rng = np.random.default_rng(3)
    best = None
    kind_sets = ([["ap1", "hp", "peak", "peak"], ["ap1", "hp", "peak", "highshelf"], ["ap1", "hp", "ap2", "peak", "peak"],
                  ["ap1", "hp", "hp1", "peak", "peak", "highshelf"], ["ap1", "hp", "lowshelf", "peak", "highshelf"],
                  ["ap1", "hp1", "peak", "peak", "highshelf"]] if replace_eq else []) + [["ap1"], ["ap1", "ap2"], ["ap1", "ap2", "ap2"], ["ap1", "ap2", "peak", "peak"], ["ap1", "ap2", "ap2", "peak", "peak"],
                 ["ap1", "ap2", "ap2", "peak", "lowshelf", "highshelf"], ["ap2", "peak", "peak"], ["peak", "peak"]]
    for lat in (0, 1):
        C = C0 * np.exp(-2j * np.pi * f * lat / SR)
        for kinds in kind_sets:
            if len(kinds) > max_slots:
                continue
            lo = sum([BOUNDS[k][0] for k in kinds], [])
            hi = sum([BOUNDS[k][1] for k in kinds], [])
            for trial in range(10):
                x0 = np.clip(_x0(kinds, rng), lo, hi)

                def res(p):
                    e = (corr_resp(p, kinds, f[sel]) - C[sel]) * w[sel]
                    return np.concatenate([e.real, e.imag])
                try:
                    r = least_squares(res, x0, bounds=(lo, hi), max_nfev=400)
                except Exception:
                    continue
                score = r.cost * (1 + 0.01 * len(kinds))
                if best is None or score < best[0]:
                    best = (score, r.x, kinds, lat)
    _, x, kinds, lat = best
    C = C0 * np.exp(-2j * np.pi * f * lat / SR)
    Ce = corr_resp(x, kinds, f) / C
    print("écart après :", "module max %.3f dB, phase max %.1f° (latence %d éch.)" % (
        np.max(np.abs(20 * np.log10(np.abs(Ce[sel])))), np.max(np.abs(np.degrees(np.angle(Ce[sel])))), lat))
    F["lti"] = lti_list(x, kinds)
    F["lat"] = int(lat)
    prof.save_fit(F)
    print(bn, "lti", F["lti"], "lat", lat)


def floor(bn):
    """Plancher du null test sur une voix dû au seul linéaire (avant / après correction)."""
    from tour2.sets import SIG
    prof = importlib.import_module(PROF[bn])
    banc = banc_mod(bn)
    F = prof.load_fit()
    m = np.load(os.path.join(LABO, banc.ID, "tour2", "lti_vst.npz"))
    f, Hv = m["f"], m["H30"]
    F0 = dict(F)
    Hm0 = model_response(bn, F0)        # modèle sans correction
    lti, lat = F.get("lti"), F.get("lat", 0)
    Hm1 = Hm0 * (corr_resp_list(lti, f) if lti else 1.0) * np.exp(2j * np.pi * f * lat / SR)
    x = bench.load_audio(SIG["V1"][0], SIG["V1"][2], 0.0, -20)[0]
    X = np.fft.rfft(x)
    fx = np.fft.rfftfreq(len(x), 1 / SR)
    out = []
    for Hm in (Hm0, Hm1):
        C = Hv / Hm
        Ci = np.interp(fx, f, C.real) + 1j * np.interp(fx, f, C.imag)
        Ci[fx > 20000] = 1.0
        e = np.fft.irfft(X * (Ci - 1), len(x))
        out.append(round(10 * np.log10(np.sum(e ** 2) / np.sum(x ** 2)), 1))
    print(bn, "plancher LTI voix : avant", out[0], "dB, après", out[1], "dB")


def corr_resp_list(lti, f):
    h = np.ones(len(f), complex)
    for k, fc, q, g in lti:
        h = h * bq_resp(ac.biquad(k, fc, q, g, SR), f)
    return h


if __name__ == "__main__":
    if sys.argv[1] == "floor":
        floor(sys.argv[2])
        sys.exit(0)
    cmd, bn = sys.argv[1], sys.argv[2]
    if cmd == "measure":
        measure(bn)
    else:
        fit(bn, int(sys.argv[3]) if len(sys.argv) > 3 else 6, "--replace-eq" in sys.argv)
