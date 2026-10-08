"""Diagnostic d'un null test : gain court terme (fenêtres de 10 ms) VST vs NOVA."""
import sys, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import bench

def st_gain(x, y, w=480):
    n = (min(x.shape[-1], y.shape[-1]) // w) * w
    xa = x[0, :n].reshape(-1, w); ya = y[0, :n].reshape(-1, w)
    ex = np.sqrt(np.mean(xa ** 2, 1)); ey = np.sqrt(np.mean(ya ** 2, 1))
    g = 20 * np.log10(np.maximum(ey, 1e-9) / np.maximum(ex, 1e-9))
    return g, 20 * np.log10(np.maximum(ex, 1e-9))

def main(src, seconds, rms_db, a_npy, b_npy, out):
    x = bench.load_audio(src, float(seconds), 0.0, float(rms_db))
    ya = np.load(a_npy).astype(float); yb = np.load(b_npy).astype(float)
    ga, lx = st_gain(x, ya); gb, _ = st_gain(x, yb)
    m = lx > -50
    print("écart gain court terme (dB) : moyenne %.2f, rms %.2f, p95 %.2f" % (np.mean((gb - ga)[m]), np.sqrt(np.mean(((gb - ga)[m]) ** 2)), np.percentile(np.abs(gb - ga)[m], 95)))
    fig, ax = plt.subplots(2, 1, figsize=(14, 7), sharex=True)
    t = np.arange(len(ga)) * 0.01
    ax[0].plot(t, lx, color="0.6", label="entrée (dBFS rms 10 ms)"); ax[0].legend(); ax[0].grid(alpha=.3)
    ax[1].plot(t, np.where(m, ga, np.nan), "k", label="gain VST"); ax[1].plot(t, np.where(m, gb, np.nan), "r", alpha=.7, label="gain NOVA")
    ax[1].legend(); ax[1].grid(alpha=.3)
    plt.tight_layout(); plt.savefig(out, dpi=60)

if __name__ == "__main__":
    main(*sys.argv[1:])
