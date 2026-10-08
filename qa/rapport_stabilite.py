"""Rapport de stabilité NOVA (HTML + courbes SVG + capture PNG) à partir des mesures.

Lit dans D:\\1 WORK\\CONTENU\\nova-stabilite\\ : endurance_avant.json, endurance_apres.json,
fuites_effets_avant.json, fuites_effets_apres.json, charge_dsp.json (facultatif),
recuperation_plantage.json, pannes_injectees.json, pannes_pont.json, pannes_pont_avant.json,
reparation_projets.json, collab_coupure_30s.json, surcharge_cpu.json.

  PYTHONIOENCODING=utf-8 python qa/rapport_stabilite.py
"""
import html, json, os
from pathlib import Path

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite"))
AVANT, APRES = "#e25555", "#2fbf71"


def load(name):
    p = OUT / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def esc(x):
    return html.escape(str(x))


def series(rows, key):
    out = []
    for r in rows:
        v = r
        for k in key.split("."):
            v = (v or {}).get(k) if isinstance(v, dict) else None
        if v is not None:
            out.append((r["minute"], float(v)))
    return out


def per_minute(points):
    """Cumul -> par minute."""
    out = []
    for (m0, v0), (m1, v1) in zip(points, points[1:]):
        if m1 > m0:
            out.append((m1, max(0.0, (v1 - v0) / (m1 - m0))))
    return out


def chart(title, unit, lines, w=560, h=230, marks=None, fname=None):
    """lines: [(label, color, [(x, y)])]  -> SVG (et fichier .svg si fname)."""
    pad_l, pad_r, pad_t, pad_b = 56, 12, 30, 34
    xs = [x for _, _, pts in lines for x, _ in pts] or [0, 1]
    ys = [y for _, _, pts in lines for _, y in pts] or [0, 1]
    x0, x1 = 0, max(max(xs), 1)
    y0, y1 = 0, max(max(ys) * 1.1, 1e-9)
    sx = lambda x: pad_l + (x - x0) / (x1 - x0) * (w - pad_l - pad_r)
    sy = lambda y: h - pad_b - (y - y0) / (y1 - y0) * (h - pad_t - pad_b)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="Segoe UI, Arial" font-size="11">',
             f'<rect width="{w}" height="{h}" fill="#ffffff"/>',
             f'<text x="{pad_l}" y="18" font-size="13" font-weight="700" fill="#111">{esc(title)}</text>']
    for i in range(5):
        yv = y0 + (y1 - y0) * i / 4
        yy = sy(yv)
        parts.append(f'<line x1="{pad_l}" x2="{w - pad_r}" y1="{yy:.1f}" y2="{yy:.1f}" stroke="#e5e7eb"/>')
        lab = f"{yv:.0f}" if y1 >= 20 else f"{yv:.1f}"
        parts.append(f'<text x="{pad_l - 6}" y="{yy + 4:.1f}" text-anchor="end" fill="#555">{lab}</text>')
    for i in range(7):
        xv = x0 + (x1 - x0) * i / 6
        parts.append(f'<text x="{sx(xv):.1f}" y="{h - pad_b + 16}" text-anchor="middle" fill="#555">{xv:.0f}</text>')
    parts.append(f'<text x="{(pad_l + w - pad_r) / 2}" y="{h - 4}" text-anchor="middle" fill="#555">minutes de soak</text>')
    parts.append(f'<text x="12" y="{(pad_t + h - pad_b) / 2}" transform="rotate(-90 12 {(pad_t + h - pad_b) / 2})" text-anchor="middle" fill="#555">{esc(unit)}</text>')
    for (mx, mlabel, mcolor) in (marks or []):
        parts.append(f'<line x1="{sx(mx):.1f}" x2="{sx(mx):.1f}" y1="{pad_t}" y2="{h - pad_b}" stroke="{mcolor}" stroke-dasharray="4 3"/>')
        parts.append(f'<text x="{sx(mx) + 4:.1f}" y="{pad_t + 12}" fill="{mcolor}" font-weight="700">{esc(mlabel)}</text>')
    lx = w - pad_r - 150
    for i, (label, color, pts) in enumerate(lines):
        if pts:
            d = " ".join(f"{'M' if j == 0 else 'L'}{sx(x):.1f},{sy(y):.1f}" for j, (x, y) in enumerate(pts))
            parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2"/>')
        parts.append(f'<rect x="{lx}" y="{pad_t + 4 + i * 16}" width="12" height="3" fill="{color}"/>')
        parts.append(f'<text x="{lx + 16}" y="{pad_t + 9 + i * 16}" fill="#222">{esc(label)}</text>')
    parts.append("</svg>")
    svg = "".join(parts)
    if fname:
        (OUT / fname).write_text(svg, encoding="utf-8")
    return svg


def crash_minute(rows):
    """Minute où l'écran d'erreur global a remplacé le studio (nœuds DOM qui s'effondrent)."""
    for a, b in zip(rows, rows[1:]):
        if a.get("domNodes") and b.get("domNodes") and b["domNodes"] < a["domNodes"] * 0.3:
            return b["minute"]
    return None


def stats(rows):
    if not rows:
        return {}
    first, last = rows[0], rows[-1]
    und = per_minute(series(rows, "playback.underrunEvents"))
    ctx = series(rows, "playback.ctxTime")
    wall = [(r["minute"], r["wall_s"]) for r in rows]
    ratio = None
    if len(ctx) > 2:
        ratio = round((ctx[-1][1] - ctx[1][1]) / max(1, (wall[-1][1] - wall[1][1])), 3)
    return {
        "minutes": last["minute"],
        "heap_debut": first.get("heapUsedMB"), "heap_fin": last.get("heapUsedMB"),
        "noeuds_debut": first.get("audioLive"), "noeuds_fin": last.get("audioLive"),
        "worklets_fin": (last.get("liveByType") or {}).get("AudioWorklet"),
        "son_debut_s": (first.get("diag") or {}).get("bufferSeconds"), "son_fin_s": (last.get("diag") or {}).get("bufferSeconds"),
        "dom_debut": first.get("domNodes"), "dom_fin": last.get("domNodes"),
        "ecouteurs_fin": last.get("jsEventListeners"), "intervalles_fin": last.get("intervals"),
        "erreurs": last.get("consoleErrors"),
        "sous_regimes_par_min": round(sum(v for _, v in und) / len(und)) if und else None,
        "horloge_audio_sur_temps_reel": ratio,
        "studio_tombe_a_la_minute": crash_minute(rows),
        "prises_ok": None,
    }


def main():
    av, ap = load("endurance_avant.json"), load("endurance_apres.json")
    ra, rp = (av or {}).get("rows", []), (ap or {}).get("rows", [])
    sa, sp = stats(ra), stats(rp)
    for s, d in ((sa, av), (sp, ap)):
        if d:
            edits = d.get("edits", [])
            s["prises_ok"] = f"{sum(1 for e in edits if e['edit'].startswith('prise') and '(ok)' in e['edit'])} / {sum(1 for e in edits if e['edit'].startswith('prise'))}"
            s["editions_echouees"] = sum(1 for e in edits if "ÉCHEC" in e["edit"])
            s["editions"] = len(edits)
    cm = sa.get("studio_tombe_a_la_minute")
    marks = [(cm, "avant : studio tombé (fenêtre d'effet)", AVANT)] if cm else []
    charts = [
        chart("Mémoire JS (tas après ramasse-miettes)", "Mo", [("avant", AVANT, series(ra, "heapUsedMB")), ("après", APRES, series(rp, "heapUsedMB"))], marks=marks, fname="courbe_memoire_js.svg"),
        chart("Nœuds audio vivants", "nœuds", [("avant", AVANT, series(ra, "audioLive")), ("après", APRES, series(rp, "audioLive"))], marks=marks, fname="courbe_noeuds_audio.svg"),
        chart("Son gardé en mémoire", "secondes-canal", [("avant", AVANT, series(ra, "diag.bufferSeconds")), ("après", APRES, series(rp, "diag.bufferSeconds"))], marks=marks, fname="courbe_son_en_memoire.svg"),
        chart("Décrochages audio (sous-régimes du contexte)", "par minute", [("avant", AVANT, per_minute(series(ra, "playback.underrunEvents"))), ("après", APRES, per_minute(series(rp, "playback.underrunEvents")))], marks=marks, fname="courbe_decrochages.svg"),
        chart("Nœuds DOM (studio affiché)", "nœuds", [("avant", AVANT, series(ra, "domNodes")), ("après", APRES, series(rp, "domNodes"))], marks=marks, fname="courbe_dom.svg"),
        chart("Erreurs de console (cumul)", "erreurs", [("avant", AVANT, series(ra, "consoleErrors")), ("après", APRES, series(rp, "consoleErrors"))], marks=marks, fname="courbe_erreurs.svg"),
    ]
    fa, fp = load("fuites_effets_avant.json"), load("fuites_effets_apres.json")
    rec = load("recuperation_plantage.json")
    pan = load("pannes_injectees.json")
    pont, pont_av = load("pannes_pont.json"), load("pannes_pont_avant.json")
    rep = load("reparation_projets.json")
    col = load("collab_coupure_30s.json")
    cpu = load("surcharge_cpu.json")
    dsp = load("charge_dsp.json")

    def row(label, a, b, better=None):
        return f"<tr><td>{esc(label)}</td><td>{esc(a if a is not None else '—')}</td><td>{esc(b if b is not None else '—')}</td></tr>"

    h = ["""<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>NOVA stabilité</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px auto;max-width:1180px;color:#111;background:#f7f7f8;padding:0 16px}
h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:2px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;margin:8px 0;background:#fff}td,th{border:1px solid #ddd;padding:6px 10px;font-size:13px;text-align:left;vertical-align:top}
th{background:#f0f0f2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:12px}.ok{color:#178a4c;font-weight:700}.ko{color:#c62828;font-weight:700}
.note{font-size:12px;color:#555}</style></head><body>
<h1>NOVA — audit et durcissement de la stabilité</h1>
<p class="note">Mesures en navigateur sans fenêtre (Chromium headless 153), worktree stabilite-2026-10-08. « Avant » = build de la branche au départ (accès de diagnostic seulement) ; « après » = build avec les correctifs.</p>"""]

    h.append("<h2>1. Endurance (soak) : session de 40 pistes, 3 effets par piste, 60 min</h2>")
    h.append("<table><tr><th>Mesure</th><th>Avant</th><th>Après</th></tr>")
    for label, k in (("Durée mesurée (min)", "minutes"), ("Studio tombé (écran d'erreur global) à la minute", "studio_tombe_a_la_minute"),
                     ("Tas JS début → fin (Mo)", None), ("Nœuds audio vivants début → fin", None), ("Worklets vivants à la fin", "worklets_fin"),
                     ("Son en mémoire début → fin (s-canal)", None), ("Nœuds DOM début → fin", None), ("Intervalles actifs à la fin", "intervalles_fin"),
                     ("Décrochages audio par minute (moyenne)", "sous_regimes_par_min"), ("Horloge audio / temps réel", "horloge_audio_sur_temps_reel"),
                     ("Erreurs de console", "erreurs"), ("Prises démarrées", "prises_ok"), ("Éditions (dont échouées)", None)):
        if k:
            h.append(row(label, sa.get(k), sp.get(k)))
        elif label.startswith("Tas"):
            h.append(row(label, f"{sa.get('heap_debut')} → {sa.get('heap_fin')}", f"{sp.get('heap_debut')} → {sp.get('heap_fin')}"))
        elif label.startswith("Nœuds audio"):
            h.append(row(label, f"{sa.get('noeuds_debut')} → {sa.get('noeuds_fin')}", f"{sp.get('noeuds_debut')} → {sp.get('noeuds_fin')}"))
        elif label.startswith("Son"):
            h.append(row(label, f"{sa.get('son_debut_s')} → {sa.get('son_fin_s')}", f"{sp.get('son_debut_s')} → {sp.get('son_fin_s')}"))
        elif label.startswith("Nœuds DOM"):
            h.append(row(label, f"{sa.get('dom_debut')} → {sa.get('dom_fin')}", f"{sp.get('dom_debut')} → {sp.get('dom_fin')}"))
        else:
            h.append(row(label, f"{sa.get('editions')} ({sa.get('editions_echouees')})", f"{sp.get('editions')} ({sp.get('editions_echouees')})"))
    h.append("</table>")
    h.append('<div class="grid">' + "".join(f"<div>{c}</div>" for c in charts) + "</div>")
    if av and av.get("errors"):
        h.append("<p class='note'>Erreurs « avant » (extrait) : " + esc(" | ".join(e.split("\n")[0][:140] for e in av["errors"][:4])) + "</p>")

    if fa or fp:
        h.append("<h2>2. Fuites : 120 changements d'effet puis 6 prises (projet de 3 pistes)</h2><table><tr><th>Étape</th><th>Avant (nœuds / worklets)</th><th>Après</th></tr>")
        for k, lab in (("depart", "Projet ouvert"), ("apres_120_changements_effet", "Après 120 changements d'effet"), ("apres_6_prises", "Après 6 prises")):
            a = (fa or {}).get(k) or {}
            b = (fp or {}).get(k) or {}
            h.append(row(lab, f"{a.get('vivants')} / {(a.get('par_type') or {}).get('AudioWorklet', 0)}", f"{b.get('vivants')} / {(b.get('par_type') or {}).get('AudioWorklet', 0)}"))
        h.append("</table>")

    if dsp:
        h.append("<h2>3. Charge DSP par effet (ms de calcul par seconde de son, rendu hors ligne)</h2><table><tr><th>Effet</th><th>Avant</th><th>Après</th></tr>")
        for k, v in dsp.get("effets", {}).items():
            h.append(row(k, v.get("avant"), v.get("apres")))
        h.append("</table>")
        if dsp.get("lecture"):
            h.append("<table><tr><th>Lecture seule de la session de 40 pistes (3 min)</th><th>Avant</th><th>Après</th></tr>")
            for k, v in dsp["lecture"].items():
                h.append(row(k, v.get("avant"), v.get("apres")))
            h.append("</table>")

    if rec:
        h.append("<h2>4. Récupération après plantage (navigateur réellement tué au milieu d'une prise)</h2><table><tr><th>Scénario</th><th>Capté jusqu'à la mise à mort</th><th>Prise récupérée</th><th>Perte</th><th>Projet revenu</th><th>Résultat</th></tr>")
        for s in rec.get("scenarios", []):
            if s.get("scenario") == "historique_versions":
                h.append(f"<tr><td>historique des versions ({esc(s.get('versions'))} versions, restauration de la plus ancienne)</td><td colspan='3'>tempo {esc(s.get('tempo_avant_restauration'))} → {esc(s.get('tempo_apres_restauration'))} après restauration ; la version d'avant gardée ({esc(', '.join(s.get('raisons') or []))})</td><td>—</td><td class='{'ok' if s.get('ok') else 'ko'}'>{'OK' if s.get('ok') else 'ÉCHEC'}</td></tr>")
                continue
            h.append(f"<tr><td>{esc(s['scenario'].replace('_', ' '))} ({esc(s.get('processus_tues'))} processus tués)</td><td>{esc(s.get('capte_jusqu_a_la_mise_a_mort_s'))} s</td><td>{esc(s.get('prise_recuperee_s'))} s</td><td>{esc(s.get('perte_s'))} s</td><td>{'oui' if s.get('projet_revenu') else 'non'}</td><td class='{'ok' if s.get('ok') else 'ko'}'>{'OK' if s.get('ok') else 'ÉCHEC'}</td></tr>")
        h.append("</table><p class='note'>Avant : sauvegarde automatique seulement à l'arrêt (zip complet), jamais pendant une prise : une prise en cours était perdue en entier.</p>")

    if pan:
        h.append("<h2>5. Pannes injectées dans l'interface et dans un worklet</h2><table><tr><th>Panneau en panne pendant la lecture</th><th>Master avant / pendant / après (dB)</th><th>Transport répond</th><th>Lecture continue</th><th>Relancer ce panneau</th></tr>")
        for name, r in (pan.get("panneaux") or {}).items():
            m = r.get("master_dB", {})
            h.append(f"<tr><td>{esc(name)}</td><td>{m.get('avant')} / {m.get('pendant')} / {m.get('apres')}</td><td>{'oui' if r.get('transport_repond') else 'non'}</td><td>{'oui' if r.get('position_avance') else 'non'}</td><td>{'oui' if r.get('relance_ok') else 'non'}</td></tr>")
        h.append("</table>")
        w = pan.get("worklet") or {}
        if w:
            h.append("<pre style='white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:8px;font-size:12px'>" + esc(json.dumps(w, ensure_ascii=False, indent=1)[:1500]) + "</pre>")

    if pont:
        h.append("<h2>6. Pont VST : plugins en panne (vrai serveur, plugins simulés, 6 s de lecture)</h2><table><tr><th>Effet</th><th>Avant (pont v9)</th><th>Après (pont v10)</th></tr>")
        for slot in ("sain", "plante", "fige"):
            a = ((pont_av or {}).get("slots") or {}).get(slot, {})
            b = (pont.get("slots") or {}).get(slot, {})
            fa_ = f"silences {a.get('silences_rendus')}, perdus {a.get('blocs_perdus')}, plus long trou {a.get('plus_long_trou_de_retour_ms')} ms"
            fb_ = f"silences {b.get('silences_rendus')}, perdus {b.get('blocs_perdus')}, plus long trou {b.get('plus_long_trou_de_retour_ms')} ms"
            h.append(row(slot, fa_, fb_))
        h.append("</table>")

    if rep:
        h.append("<h2>7. Projets abîmés : ouverts et réparés</h2><table><tr><th>Cas</th><th>Ouvert</th><th>Rapport</th></tr>")
        for c in rep.get("cas", []):
            h.append(f"<tr><td>{esc(c.get('cas'))}</td><td class='{'ok' if c.get('ouvert') else 'ko'}'>{'oui' if c.get('ouvert') else 'non'}</td><td>{esc(' · '.join(c.get('rapport') or []) or c.get('erreur') or '')}</td></tr>")
        h.append("</table>")

    if col:
        h.append("<h2>8. Collaboration : coupure réseau de 30 s à deux</h2><table>")
        for k, v in col.items():
            h.append(f"<tr><td>{esc(k.replace('_', ' '))}</td><td>{esc(v)}</td></tr>")
        h.append("</table>")

    if cpu:
        h.append("<h2>9. Surcharge processeur : compteur, alerte, mode sécurité</h2><table><tr><th>Vérification</th><th>Résultat</th><th>Détail</th></tr>")
        for v in cpu.get("verifs", []):
            h.append(f"<tr><td>{esc(v.get('verif'))}</td><td class='{'ok' if v.get('ok') else 'ko'}'>{'OK' if v.get('ok') else 'ÉCHEC'}</td><td>{esc(str(v.get('detail'))[:220])}</td></tr>")
        h.append("</table>")

    h.append("</body></html>")
    page = OUT / "rapport_stabilite.html"
    page.write_text("\n".join(h), encoding="utf-8")
    try:
        from playwright.sync_api import sync_playwright
        exe = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=exe)
            pg = b.new_page(viewport={"width": 1240, "height": 900})
            pg.goto(page.as_uri())
            pg.screenshot(path=str(OUT / "rapport_stabilite.png"), full_page=True)
            for i, name in enumerate(("courbe_memoire_js", "courbe_noeuds_audio", "courbe_son_en_memoire", "courbe_decrochages")):
                pg.locator(".grid > div").nth(i).screenshot(path=str(OUT / f"{name}.png"))
            b.close()
    except Exception as e:  # noqa
        print("capture impossible :", e)
    print("→", page)
    print(json.dumps({"avant": sa, "apres": sp}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
