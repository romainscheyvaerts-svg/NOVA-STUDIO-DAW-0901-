"""
Tour 2 : assemble D:/1 WORK/CONTENU/nova-labo/RESULTATS.md
  1. synthèse AVANT (tour 1) / APRÈS (tour 2) par modèle, depuis les écarts du
     VRAI moteur (Chrome) : tour1/ecarts_chrome.json et ecarts_chrome.json ;
  2. null tests sur vraies voix (calage + VALIDATION) et batterie (tour2_nulls.md) ;
  3. mesures fines des temps courts, coût CPU ;
  4. le détail régénéré par rapport.py (graphiques, écoute) ;
  5. les sections Mastering Transient (Elevate) et de-esser.
Usage : python -m tour2.rapport_final
"""
import json, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LABO_TOOLS = os.path.dirname(HERE)
sys.path.insert(0, LABO_TOOLS)
import rapport  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo"
DEV = [("cl1b", "tubetech_cl1b", "Opto Vintage", "Tube-Tech CL 1B mk II (Softube)"),
       ("fet76", "ua_1176", "FET 76", "UADx 1176AE"),
       ("la2a", "ua_la2a", "Leveler 2A", "UADx LA-2A Silver"),
       ("voxbox", "manley_voxbox", "Vox Strip", "UADx Manley VOXBOX")]


def f(x, d=2):
    return "–" if x is None else f"{x:.{d}f}".replace(".", ",")


def synth(ec, bn):
    skip = rapport.HORS_MODELE.get(bn, {})
    stat, fr, times, harm, nulls, _ = rapport.summarize(ec, skip)
    st = max([v for _, v in stat], default=None)
    frm = max([v for _, v in fr], default=None)
    tl = [abs(e) for _, e in times if e is not None]
    tm = float(np.median(tl)) if tl else None
    hm = max([h[1] for h in harm], default=None)
    nv = [n for n in nulls if "voix" in n[0]]
    nb = [n for n in nulls if "batterie" in n[0]]
    return {"stat": st, "fr": frm, "temps_med": tm, "harm": hm,
            "null_voix": max([n[1] for n in nv], default=None), "null_voix_min": min([n[1] for n in nv], default=None),
            "null_batt": max([n[1] for n in nb], default=None)}


def ok(v, cible, inv=False):
    if v is None:
        return ""
    return "✅" if (v <= cible) else "❌"


def main(perf=None):
    lines = ["# Labo NOVA — modèles « vintage » : tour 2 (précision)", "",
             "Mesures du 08/10/2026 — moteur NOVA : **chrome** (vrai moteur : AudioWorklet dans Chrome headless, "
             "OfflineAudioContext) pour les tableaux de synthèse ; portage numba identique (vitest) pour les null tests "
             "étendus. Le rapport du tour 1 est conservé dans `RESULTATS_tour1.md`.", "",
             "Cibles : courbe statique ±0,5 dB · réponse en fréquence ±0,3 dB · temps ±10 % (médiane) · harmoniques ±3 dB · "
             "null test −30 dB sur la voix, −20 dB sur la batterie.", "",
             "## Ce qui a changé dans les modèles (tour 2)", "",
             "- **Cellule multi-composantes en dB** (`engine/analogCompCore.ts`, portage `tools/labo/modeles/analog_comp.py`) : "
             "trois parts de la réduction, chacune avec sa montée (vitesse selon la « lumière », bornée en dB/ms) et sa "
             "descente (exponentielle + pente, ralentie ou accélérée selon la réduction en cours, départ retardé) ; somme "
             "(cellule optique à mémoire de programme) ou maximum (cellules en parallèle, mode F/M de l'Opto Vintage). "
             "Détecteur crête ou RMS, lissé.",
             "- **Calage automatique (CMA-ES)** de la cellule sur de VRAIES voix et une vraie batterie rendues par le "
             "plugin d'origine, plus les sauts de niveau et les harmoniques en compression (`tools/labo/tour2/fitdyn.py`) ; "
             "les vitesses par position de bouton (attaque / relâchement) sont calées en même temps. Validation sur "
             "deux voix jamais vues pendant le calage.",
             "- **Réponse complexe (module + PHASE)** de l'original mesurée et reproduite (`tour2/lti.py`) : passe-tout "
             "fractionnaire + latence déclarée au PDC (l'original a une légère avance de phase), passe-tout du 2e ordre "
             "(filtres de suréchantillonnage), cloches.",
             "- **Étage de sortie tabulé** (`tour2/ws.py`) : caractéristique de transfert mesurée, calée directement sur les "
             "harmoniques H1..H7 (fonctionnelles linéaires de la table), interpolation cubique ; transformateur du Vox "
             "Strip en k·φ·|φ| à l'entrée (H3 en 1 dB/dB et 12 dB/octave, comme mesuré).",
             "- **Vox Strip** : coupe-bas à sa fréquence de coin réelle (« 80 Hz » = 1er ordre à ~108 Hz, « 120 Hz » à ~158 Hz).",
             ""]
    lines += ["## Synthèse avant / après (vrai moteur NOVA)", "",
              "| Modèle | Statique max (±0,5) | Fréquence max (±0,3) | Temps t63 médiane (±10 %) | Harmoniques max (±3) | Null voix (pire) | Null batterie |",
              "|---|---|---|---|---|---|---|"]
    for bn, did, nom, orig in DEV:
        a = rapport.load(os.path.join(LABO, did, "tour1", "ecarts_chrome.json"))
        b = rapport.load(os.path.join(LABO, did, "ecarts_chrome.json"))
        if not a or not b:
            continue
        sa, sb = synth(a, bn), synth(b, bn)
        lines.append(f"| **{nom}** ({orig}) | {f(sa['stat'])} → **{f(sb['stat'])}** dB {ok(sb['stat'], 0.5)} | "
                     f"{f(sa['fr'])} → **{f(sb['fr'])}** dB {ok(sb['fr'], 0.3)} | {f(sa['temps_med'], 0)} → **{f(sb['temps_med'], 0)}** % {ok(sb['temps_med'], 10)} | "
                     f"{f(sa['harm'], 1)} → **{f(sb['harm'], 1)}** dB {ok(sb['harm'], 3)} | {f(sa['null_voix'], 1)} → **{f(sb['null_voix'], 1)}** dB {ok(sb['null_voix'], -30)} | "
                     f"{f(sa['null_batt'], 1)} → **{f(sb['null_batt'], 1)}** dB {ok(sb['null_batt'], -20)} |")
    lines.append("")
    tn = os.path.join(LABO, "tour2_nulls.md")
    if os.path.exists(tn):
        lines += ["## Null tests sur vrais signaux : calage ET validation (voix jamais vues)", "",
                  "Null = énergie de (original − NOVA) / énergie de l'original, sans égalisation de gain. AVANT = profils du "
                  "tour 1, APRÈS = tour 2. Écoute : `<appareil>/tour2/ecoute/<cas>__<signal>__{1_original,2_nova_avant,"
                  "3_nova_apres,4_difference_apres}.wav`.", ""]
        lines += open(tn, encoding="utf-8").read().splitlines()
        lines.append("")
    tf = [(did, rapport.load(os.path.join(LABO, did, "tour2", "temps_fins.json"))) for _, did, _, _ in DEV]
    tf = [(d, j) for d, j in tf if j]
    if tf:
        lines += ["## Résolution de la mesure des temps courts", "",
                  "Même saut de niveau (+30 dB) mesuré trois fois : 48 kHz / porteuse 1 kHz (méthode du tour 1, fenêtre 250 µs), "
                  "48 kHz / 10 kHz (62 µs) et 192 kHz / 10 kHz (26 µs).", "",
                  "| Appareil / réglage | t63 48 kHz·1 kHz | t63 48 kHz·10 kHz | t63 192 kHz·10 kHz |", "|---|---|---|---|"]
        for d, j in tf:
            for k, v in j.items():
                lines.append(f"| {d} {k} | {f(v['A_48k_1kHz']['t63_ms'], 3)} ms | {f(v['A2_48k_10kHz']['t63_ms'], 3)} ms | "
                             f"{f(v['B_192k_10kHz']['t63_ms'], 3)} ms |")
        lines += ["", "Conclusion : au-dessus de ~1 ms la méthode du tour 1 est juste (±5 %) ; sous la milliseconde (attaque "
                  "du FET au maximum) elle surestime le temps de ~50 % : les cibles de temps courts du tour 2 utilisent la "
                  "mesure à 192 kHz.", ""]
    if perf:
        lines += ["## Coût CPU (cœur sous Node, temps CPU du processus, 20 s de bruit rose)", "",
                  "Mesuré pendant que la machine était chargée (Pro Tools ouvert) : les valeurs absolues sont gonflées ; le "
                  "cœur du tour 1 mesuré dans les mêmes conditions sert de référence. Une entrée mono (voix) n'est calculée "
                  "qu'une fois (nouveau chemin mono).", "",
                  "| Effet | Tour 1 (stéréo) | Tour 2 stéréo | Tour 2 mono (voix) |", "|---|---|---|---|"] + [
                  f"| {k} | {v[0]} % | {v[1]} % | {v[2]} % |" for k, v in perf.items()] + [""]
    # détail régénéré par rapport.py (le fichier RESULTATS_detail.md)
    det = os.path.join(LABO, "RESULTATS_detail.md")
    if os.path.exists(det):
        lines += ["## Détail par modèle (vrai moteur, tour 2)", ""]
        body = open(det, encoding="utf-8").read().splitlines()
        lines += [l if not l.startswith("# ") else "" for l in body]
    for sec in ("elevate/RESULTATS_elevate.md", "deesser/RESULTATS_deesser.md"):
        p = os.path.join(LABO, sec)
        if os.path.exists(p):
            lines += [""] + open(p, encoding="utf-8").read().splitlines()
    open(os.path.join(LABO, "RESULTATS.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("écrit RESULTATS.md", len(lines), "lignes")


if __name__ == "__main__":
    perf = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None
    main(perf)
