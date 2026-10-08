"""Tour 3 : corpus de stimuli synthétiques (sauts et salves à plusieurs niveaux),
rendu UNE fois par le VST d'origine (hors ligne, sans fenêtre), puis comparé au
modèle échantillon par échantillon (null) et en trajectoire de gain.

Le corpus est une seule longue séquence mono (porteuse 1 kHz, plus quelques
segments en bruit rose et à 100 Hz pour le détecteur) :
  A. sauts depuis le silence vers 9 niveaux (−40 à 0 dBFS), tenue 0,5 s, relâchement observé 2 s ;
  B. sauts courts à −8 dBFS : tenues 1 ms … 500 ms (part rapide / part lente du F/M) ;
  C. pic court AU-DESSUS d'un niveau déjà comprimé (−24 dBFS tenu, pic à −4 dBFS de 5/20/100 ms) ;
  D. trains de salves (10 ms toutes les 100 ms ; 30 ms toutes les 300 ms) ;
  E. escalier montant puis descendant (−40 -> 0 -> −40 dBFS, 0,3 s par marche) ;
  F. bruit rose et 100 Hz (mêmes niveaux crête/RMS que le sinus : détecteur crête ou RMS ?).
Usage : python -m tour3.corpus render <banc> <nom> '<json réglages VST>'
"""
import json, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tour3 import lowprio  # noqa
SR = 48000
LABO = r"D:\1 WORK\CONTENU\nova-labo"


def _a(db):
    return 10 ** (db / 20.0)


PROBE = -70.0   # sonde sous le seuil entre les segments : le relâchement reste mesurable


def build(seed=3, shift_db=0.0, mini=False):
    if mini == "haut":
        return build_haut(shift_db)
    """-> x (n,), segments [(nom, début, fin)] ; shift_db décale tous les niveaux.
    mini=True : version courte (≈ 30 s) pour caler les vitesses par position de bouton."""
    if mini is True:
        return build_mini(shift_db)
    rng = np.random.default_rng(seed)
    env, carrier, segs = [], [], []
    pos = [0]

    def add(name, levels_db, durs_s, kind="sin"):
        n0 = pos[0]
        for L, d in zip(levels_db, durs_s):
            n = int(round(d * SR))
            env.append(np.full(n, _a(L + shift_db) if L > -150 else 0.0))
            carrier.append(np.full(n, {"sin": 0, "rose": 1, "s100": 2}[kind], dtype=np.int8))
            pos[0] += n
        segs.append((name, n0, pos[0]))

    S = PROBE
    add("pre", [S], [0.5])
    for L in (-40, -35, -30, -25, -20, -15, -10, -5, 0):
        add(f"A_saut{L}", [L, S], [1.0, 3.0])
    for h in (1, 2, 5, 10, 20, 50, 100, 200, 500):
        add(f"B_tenue{h}ms", [-8, S], [h / 1000.0, 2.5])
    for h in (5, 20, 100):
        add(f"C_pic{h}ms", [-24, -4, -24, S], [1.0, h / 1000.0, 1.0, 3.0])
    add("D_salves10", sum([[-6, S] for _ in range(10)], []) + [S], sum([[0.01, 0.09] for _ in range(10)], []) + [2.5])
    add("D_salves30", sum([[-6, S] for _ in range(6)], []) + [S], sum([[0.03, 0.27] for _ in range(6)], []) + [2.5])
    st = [-40, -30, -20, -10, 0, -10, -20, -30, -40]
    add("E_escalier", st + [S], [0.3] * len(st) + [3.0])
    for L in (-30, -15):
        add(f"F_rose{L}", [L, S], [0.6, 2.0], kind="rose")
        add(f"F_100Hz{L}", [L, S], [0.6, 2.0], kind="s100")
    env = np.concatenate(env)
    car = np.concatenate(carrier)
    n = len(env)
    t = np.arange(n) / SR
    s1k = np.sin(2 * np.pi * 1000 * t)
    s100 = np.sin(2 * np.pi * 100 * t)
    # bruit rose (filtre de Voss simplifié par FFT), normalisé : même CRÊTE que le sinus de même niveau
    w = rng.standard_normal(n)
    W = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1 / SR)
    W[1:] /= np.sqrt(f[1:])
    W[0] = 0
    W[f < 30] = 0
    pk = np.fft.irfft(W, n)
    pk /= np.sqrt(np.mean(pk ** 2)) * np.sqrt(2)     # RMS = celle d'un sinus d'amplitude 1
    x = np.where(car == 0, s1k, np.where(car == 1, pk, s100)) * env
    # petites rampes (0,2 ms) pour éviter les clics durs aux débuts de segments
    return x, segs


def build_haut(shift_db=0.0):
    """Corpus « niveaux chauds » (crêtes au-dessus de 0 dBFS, comme une voix normalisée à fort facteur de crête) :
    saturation de la cellule à forte réduction."""
    env, segs = [], []
    pos = [0]

    def add(name, levels_db, durs_s):
        n0 = pos[0]
        for L, d in zip(levels_db, durs_s):
            n = int(round(d * SR))
            env.append(np.full(n, _a(L + shift_db)))
            pos[0] += n
        segs.append((name, n0, pos[0]))

    S = PROBE
    add("pre", [S], [0.3])
    for L in (3, 6, 10):
        add(f"H_saut+{L}", [L, S], [0.5, 3.0])
    for h in (5, 20, 100):
        add(f"H_tenue{h}ms", [6, S], [h / 1000.0, 2.0])
    add("H_pic", [-20, 6, -20, S], [0.8, 0.05, 0.8, 2.0])
    env = np.concatenate(env)
    t = np.arange(len(env)) / SR
    return np.sin(2 * np.pi * 1000 * t) * env, segs


def build_mini(shift_db=0.0):
    """Corpus court : 4 sauts (0,5 s, relâchement observé 4 s), 3 tenues brèves, un train de salves."""
    env, segs = [], []
    pos = [0]

    def add(name, levels_db, durs_s):
        n0 = pos[0]
        for L, d in zip(levels_db, durs_s):
            n = int(round(d * SR))
            env.append(np.full(n, _a(L + shift_db)))
            pos[0] += n
        segs.append((name, n0, pos[0]))

    S = PROBE
    add("pre", [S], [0.3])
    for L in (-30, -20, -10, 0):
        add(f"A_saut{L}", [L, S], [0.5, 4.0])
    for h in (2, 20, 200):
        add(f"B_tenue{h}ms", [-8, S], [h / 1000.0, 2.2])
    add("D_salves10", sum([[-6, S] for _ in range(10)], []) + [S], sum([[0.01, 0.09] for _ in range(10)], []) + [3.0])
    env = np.concatenate(env)
    t = np.arange(len(env)) / SR
    return np.sin(2 * np.pi * 1000 * t) * env, segs


def path(banc_id, name):
    return os.path.join(LABO, banc_id, "tour3", "corpus", f"{name}.npz")


def render(bn, name, settings, shift_db=0.0, mini=False):
    import procs, host
    from tour2.common import banc_mod
    host.hide_console()
    banc = banc_mod(bn)
    x, segs = build(shift_db=shift_db, mini=mini)
    proc = procs.VstProc(banc.PLUGIN, banc.BASE)
    applied = proc.configure(settings)
    t = time.time()
    y = proc.run(np.vstack([x, x]))
    fn = path(banc.ID, name)
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    np.savez_compressed(fn, x=x.astype(np.float32), y=y[0].astype(np.float32), settings=json.dumps(settings),
                        applied=json.dumps(applied), segs=json.dumps(segs), shift_db=shift_db)
    print(name, "rendu", round(time.time() - t, 1), "s", applied, flush=True)


def load(banc_id, name):
    d = np.load(path(banc_id, name))
    return {"x": d["x"].astype(np.float64), "y": d["y"].astype(np.float64), "settings": json.loads(str(d["settings"])),
            "segs": json.loads(str(d["segs"]))}


if __name__ == "__main__":
    lowprio()
    if sys.argv[1] == "render":
        sh = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
        render(sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sh)
    elif sys.argv[1] == "haut":
        render(sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), 0.0, mini="haut")
    elif sys.argv[1] == "mini":
        # python -m tour3.corpus mini <banc> '<json base>' '<json {nom: {réglages}}>' [décalage]
        sh = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
        base = json.loads(sys.argv[3])
        for nm, st in json.loads(sys.argv[4]).items():
            render(sys.argv[2], nm, dict(base, **st), sh, mini=True)
