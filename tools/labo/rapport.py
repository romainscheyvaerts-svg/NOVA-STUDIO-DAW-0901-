"""
Rapport du labo : tableaux d'écarts NOVA / original, graphiques superposés et
fichiers d'écoute (WAV avant / après) -> D:/1 WORK/CONTENU/nova-labo/RESULTATS.md

Usage : python rapport.py [mode]   (mode = chrome (défaut, vrai moteur NOVA), node ou py)
"""
from __future__ import annotations

import importlib
import json
import os
import sys

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo"
DEVICES = [
    ("cl1b", "Opto Vintage", "Tube-Tech CL 1B mk II (Softube)"),
    ("fet76", "FET 76", "UADx 1176AE"),
    ("la2a", "Leveler 2A", "UADx LA-2A Silver"),
    ("voxbox", "Vox Strip", "UADx Manley VOXBOX"),
]
TARGETS = {"statique": 0.5, "fr": 0.3, "temps": 10.0, "harm": 3.0}


def load(path):
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else None


def fmt(x, d=2):
    return "–" if x is None else f"{x:.{d}f}".replace(".", ",")


def summarize(ec):
    stat, fr, times, harm, nulls, temps_rows = [], [], [], [], [], []
    for case, tests in ec.items():
        for name, v in tests.items():
            t = v.get("type")
            if t == "statique":
                if name.startswith("stat") or case.startswith("stat"):
                    stat.append((case, v["max_abs_db"]))
                if name.startswith("thd") and case in ("lineaire",):
                    hs = [abs(h["ecart"]) for h in v.get("harmoniques", []) if max(h["vst"], h["nova"]) > -80]
                    if hs:
                        harm.append((f"{case}/{name}", max(hs), float(np.median(hs))))
            elif t == "fr" and case.startswith("lineaire") and name.startswith("fr"):
                fr.append((f"{case}/{name}", v["max_abs_db"]))
            elif t == "temps":
                for ph in ("attaque", "relachement"):
                    e = v.get(f"{ph}_ecart_pct")
                    ta = v.get(f"{ph}_t63_vst_ms")
                    if e is not None and ta and ta > 1.0:
                        times.append((f"{case}/{name}/{ph}", e))
                temps_rows.append((case, name, v))
            elif t == "null":
                nulls.append((f"{case}/{name}", v["null_db"], v["null_db_gain_egalise"], v["ecart_gain_db"]))
    return stat, fr, times, harm, nulls, temps_rows


def overlay_plots(dev_id, banc, meas, nova, out_dir):
    """Superpositions : courbes statiques, réponse en fréquence, courbes de réduction, harmoniques."""
    os.makedirs(out_dir, exist_ok=True)
    files = []
    # 1. courbes statiques
    cases = [c for c in meas if not c.startswith("_") and any("static" in v for v in meas[c]["tests"].values()) and c in nova]
    cases = [c for c in cases if c.startswith("stat")][:8] or cases[:8]
    if cases:
        fig, ax = plt.subplots(figsize=(8, 5.5))
        for k, c in enumerate(cases):
            tn = [n for n, v in meas[c]["tests"].items() if "static" in v][0]
            a, b = meas[c]["tests"][tn]["static"], nova[c]["tests"].get(tn, {}).get("static")
            if not b:
                continue
            col = plt.cm.viridis(k / max(1, len(cases) - 1))
            ax.plot(a["in_db"], a["out_db"], "-", color=col, lw=2, label=f"{c} (original)")
            ax.plot(b["in_db"], b["out_db"], "--", color="k", lw=1)
        ax.set_xlabel("entrée (dBFS crête)")
        ax.set_ylabel("sortie (dBFS crête)")
        ax.set_title(f"{dev_id} : courbes statiques — couleur = original, tirets = NOVA")
        ax.grid(alpha=.3)
        ax.legend(fontsize=6, loc="upper left")
        fn = os.path.join(out_dir, "statique.png")
        plt.tight_layout(); plt.savefig(fn, dpi=80); plt.close(fig)
        files.append(fn)
    # 2. réponse en fréquence (linéaire)
    if "lineaire" in meas and "lineaire" in nova:
        fig, ax = plt.subplots(figsize=(8, 4))
        for n, v in meas["lineaire"]["tests"].items():
            if n.startswith("fr") and n in nova["lineaire"]["tests"] and "channels" in nova["lineaire"]["tests"][n]:
                f = np.array(v["freqs"])
                ax.semilogx(f, v["channels"][0]["mag_db"], lw=2, label=f"{n} original")
                ax.semilogx(f, nova["lineaire"]["tests"][n]["channels"][0]["mag_db"], "k--", lw=1)
        ax.set_xlim(20, 20000)
        ax.set_xlabel("Hz"); ax.set_ylabel("dB"); ax.grid(alpha=.3, which="both")
        ax.set_title(f"{dev_id} : réponse en fréquence (tirets = NOVA)")
        ax.legend(fontsize=7)
        fn = os.path.join(out_dir, "frequence.png")
        plt.tight_layout(); plt.savefig(fn, dpi=80); plt.close(fig)
        files.append(fn)
    # 3. courbes de réduction (sauts)
    steps = []
    for c in meas:
        if c.startswith("_") or c not in nova:
            continue
        for n, v in meas[c]["tests"].items():
            if "gr_curve_ms" in v and n in nova[c]["tests"] and "gr_curve_ms" in nova[c]["tests"][n]:
                steps.append((c, n))
    steps = steps[:: max(1, len(steps) // 6)][:6]
    if steps:
        fig, axs = plt.subplots(len(steps), 1, figsize=(9, 2.2 * len(steps)))
        for ax, (c, n) in zip(np.atleast_1d(axs), steps):
            a = np.array(meas[c]["tests"][n]["gr_curve_ms"])
            b = np.array(nova[c]["tests"][n]["gr_curve_ms"])
            x = np.arange(len(a)) - 50
            ax.plot(x, a, lw=2, label="original")
            ax.plot(x[:len(b)], b[:len(a)], "k--", lw=1, label="NOVA")
            ax.set_xscale("symlog", linthresh=10)
            ax.set_title(f"{c} / {n} : réduction de gain (dB) dans le temps (ms)", fontsize=8)
            ax.grid(alpha=.3)
            ax.legend(fontsize=6)
        fn = os.path.join(out_dir, "temps.png")
        plt.tight_layout(); plt.savefig(fn, dpi=75); plt.close(fig)
        files.append(fn)
    # 4. harmoniques (linéaire, 1 kHz)
    if "lineaire" in meas and "lineaire" in nova and "thd_1k" in meas["lineaire"]["tests"]:
        ra = meas["lineaire"]["tests"]["thd_1k"]["rows"]
        rb = nova["lineaire"]["tests"].get("thd_1k", {}).get("rows")
        if rb:
            fig, ax = plt.subplots(figsize=(8, 4))
            lv = [r["in_db"] for r in ra]
            for h, col in ((0, "tab:blue"), (1, "tab:orange"), (2, "tab:green"), (3, "tab:red")):
                ax.plot(lv, [r["ch0"]["harm_rel_db"][h] for r in ra], "-o", color=col, label=f"H{h + 2} original")
                ax.plot(lv, [r["ch0"]["harm_rel_db"][h] for r in rb], "--", color=col)
            ax.set_ylim(-130, 0)
            ax.set_xlabel("entrée (dBFS)"); ax.set_ylabel("dB sous le fondamental")
            ax.set_title(f"{dev_id} : harmoniques à 1 kHz (tirets = NOVA)")
            ax.grid(alpha=.3); ax.legend(fontsize=7)
            fn = os.path.join(out_dir, "harmoniques.png")
            plt.tight_layout(); plt.savefig(fn, dpi=80); plt.close(fig)
            files.append(fn)
    return files


def write_wavs(dev_dir, mode):
    import soundfile as sf
    src_v = os.path.join(dev_dir, "audio_vst")
    src_n = os.path.join(dev_dir, f"audio_nova_{mode}")
    out = os.path.join(dev_dir, "ecoute")
    os.makedirs(out, exist_ok=True)
    made = []
    if not os.path.isdir(src_v) or not os.path.isdir(src_n):
        return made
    for fn in sorted(os.listdir(src_n)):
        if not fn.endswith(".npy") or not os.path.exists(os.path.join(src_v, fn)):
            continue
        a = np.load(os.path.join(src_v, fn)).astype(np.float32)
        b = np.load(os.path.join(src_n, fn)).astype(np.float32)
        base = fn[:-4]
        sf.write(os.path.join(out, f"{base}__original.wav"), a.T, 48000, subtype="FLOAT")
        sf.write(os.path.join(out, f"{base}__nova.wav"), b.T, 48000, subtype="FLOAT")
        n = min(a.shape[1], b.shape[1])
        sf.write(os.path.join(out, f"{base}__difference.wav"), (a[:, :n] - b[:, :n]).T, 48000, subtype="FLOAT")
        made.append(base)
    return made


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "chrome"
    lines = ["# Labo NOVA — modèles « vintage » : écarts mesurés NOVA / original", "",
             f"Mesures du {__import__('time').strftime('%d/%m/%Y %H:%M')} — moteur NOVA : **{mode}**"
             + (" (vrai moteur : AudioWorklet dans Chrome headless, OfflineAudioContext)" if mode == "chrome" else ""), "",
             "Cibles : courbe statique ±0,5 dB · réponse en fréquence ±0,3 dB · constantes de temps ±10 % · "
             "harmoniques principales ±3 dB · null test sur la voix le plus bas possible.", "",
             "Méthode : boîte noire. Les plugins d'origine sont chargés HORS LIGNE et SANS fenêtre (pedalboard) ; "
             "stimuli = sinus glissant (Farina), bruit rose, sinus par paliers, sauts de niveau, salves, vraie voix "
             "et vraie batterie. Le même banc passe ensuite sur l'effet NOVA. Sources techniques : SOURCES.md de chaque dossier.", ""]
    for banc_name, nova_name, orig in DEVICES:
        banc = importlib.import_module(f"bancs.{banc_name}")
        dev_dir = os.path.join(LABO, banc.ID)
        ec = load(os.path.join(dev_dir, f"ecarts_{mode}.json"))
        meas = load(os.path.join(dev_dir, "mesures.json"))
        nova = load(os.path.join(dev_dir, f"mesures_nova_{mode}.json"))
        lines += [f"## {nova_name} — modèle de {orig}", ""]
        if not ec or not meas or not nova:
            lines += ["_Pas encore de comparaison pour ce moteur._", ""]
            continue
        stat, fr, times, harm, nulls, _ = summarize(ec)
        def verdict(ok):
            return "✅" if ok else "❌"
        smax = max((s for _, s in stat), default=None)
        fmax = max((f for _, f in fr), default=None)
        tabs = [abs(e) for _, e in times]
        hmax = max((h for _, h, _ in harm), default=None)
        lines += ["| Mesure | Écart NOVA / original | Cible | |", "|---|---|---|---|",
                  f"| Courbe statique (max sur {len(stat)} courbes) | {fmt(smax)} dB | ±0,5 dB | {verdict(smax is not None and smax <= TARGETS['statique'])} |",
                  f"| Réponse en fréquence (linéaire, 30 Hz–16 kHz, max) | {fmt(fmax)} dB | ±0,3 dB | {verdict(fmax is not None and fmax <= TARGETS['fr'])} |",
                  f"| Constantes de temps t63 (médiane / max sur {len(tabs)}) | {fmt(float(np.median(tabs)) if tabs else None, 0)} % / {fmt(max(tabs) if tabs else None, 0)} % | ±10 % | {verdict(bool(tabs) and float(np.median(tabs)) <= TARGETS['temps'])} (médiane) |",
                  f"| Harmoniques H2–H5 (linéaire, max) | {fmt(hmax, 1)} dB | ±3 dB | {verdict(hmax is not None and hmax <= TARGETS['harm'])} |"]
        for nm, nd, ng, eg in nulls:
            lines.append(f"| Null test {nm} | {fmt(nd, 1)} dB RMS (gain égalisé : {fmt(ng, 1)} dB ; écart de gain {fmt(eg, 2)} dB) | le plus bas possible | |")
        lines.append("")
        bad = [(c, s) for c, s in stat if s > TARGETS["statique"]]
        if bad:
            lines.append("Courbes statiques hors cible : " + ", ".join(f"{c} ({fmt(s)} dB)" for c, s in bad[:12]) + ".")
        badt = sorted(times, key=lambda x: -abs(x[1]))[:8]
        if badt:
            lines.append("Plus gros écarts de temps : " + ", ".join(f"{n} ({e:+.0f} %)" for n, e in badt) + ".")
        lines.append("")
        imgs = overlay_plots(banc.ID, banc, meas, nova, os.path.join(dev_dir, f"graphiques_{mode}"))
        for im in imgs:
            rel = os.path.relpath(im, LABO).replace("\\", "/")
            lines.append(f"![{os.path.basename(im)}]({rel})")
        wavs = write_wavs(dev_dir, mode)
        if wavs:
            lines += ["", "Écoute (original / NOVA / différence) : " + ", ".join(
                f"`{banc.ID}/ecoute/{w}__*.wav`" for w in wavs)]
        lines.append("")
    dest = os.path.join(LABO, "RESULTATS.md" if mode == "chrome" else f"RESULTATS_{mode}.md")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("écrit", dest)


if __name__ == "__main__":
    main()
