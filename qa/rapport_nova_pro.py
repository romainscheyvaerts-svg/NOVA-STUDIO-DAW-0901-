"""Tableau avant / après des sessions chronométrées (voix, mix, beat), des fenêtres et du profil.

Lit D:\\1 WORK\\CONTENU\\nova-pro\\{avant,apres}\\… (JSON écrits par qa/session_*.py,
qa/fenetres_echap.py, qa/barre_bas_debordement.py, qa/palette_commandes.py, qa/perf_studio.py)
et écrit D:\\1 WORK\\CONTENU\\nova-pro\\TABLEAU_AVANT_APRES.md.

PYTHONIOENCODING=utf-8 python qa/rapport_nova_pro.py
"""
import json
from pathlib import Path

ROOT = Path(r"D:\1 WORK\CONTENU\nova-pro")


def load(phase, rel):
    p = ROOT / phase / rel
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def sec(ms):
    return "—" if ms is None else f"{ms / 1000:.1f} s"


def session_table(name, title):
    a = load("avant", f"{name}/{name}.json")
    b = load("apres", f"{name}/{name}.json")
    out = [f"## {title}", ""]
    if not a or not b:
        out.append(f"_Mesure manquante ({'avant' if not a else 'après'})._\n")
        return out
    out += ["| Étape | Avant : gestes · temps · état | Après : gestes · temps · état | Pro Tools | Frictions avant → après |",
            "|---|---|---|---|---|"]
    bi = {s["etape"]: s for s in b["etapes"]}
    seen = set()
    for s in a["etapes"]:
        t = bi.get(s["etape"])
        seen.add(s["etape"])
        clean = lambda xs: "; ".join(dict.fromkeys(" ".join(x.split())[:160] for x in xs)) or "—"
        fa = clean(s["frictions"])
        fb = clean(t["frictions"]) if t else "(étape absente)"
        g = lambda x: f"{x['clics']} clic(s) + {x['touches']} touche(s) · {sec(x['ms'])} · {'✅' if x['ok'] else '❌'}"
        out.append(f"| {s['tache']} · {s['etape']} | {g(s)} | {g(t) if t else '—'} | {s.get('protools') or '—'} | {fa} → {fb or '—'} |")
    for s in b["etapes"]:
        if s["etape"] not in seen:
            out.append(f"| {s['tache']} · {s['etape']} | (non atteinte) | {s['clics']} clic(s) + {s['touches']} touche(s) · {sec(s['ms'])} · {'✅' if s['ok'] else '❌'} | {s.get('protools') or '—'} | — |")
    ta, tb = a["total"], b["total"]
    out += ["", f"**Total avant** : {ta['clics']} clics, {ta['touches']} touches, {sec(ta['ms'])}, {ta['etapes_ko']} étape(s) en échec, {ta['frictions']} friction(s) ; "
            f"**après** : {tb['clics']} clics, {tb['touches']} touches, {sec(tb['ms'])}, {tb['etapes_ko']} étape(s) en échec, {tb['frictions']} friction(s). "
            f"Erreurs de console (hors pont VST absent) : {len(a.get('erreurs_console', []))} → {len(b.get('erreurs_console', []))}.", ""]
    if ta["etapes_ko"]:
        out.append("_Avant, une étape en échec rend les suivantes moins comparables (le test continue par un détour quand il le peut)._\n")
    return out


def main():
    md = ["# NOVA « utilisable et pro » : avant / après (08/10/2026)", "",
          "Sessions rejouées en Chrome headless dans Nova Studio simulé (compte simulé, aucune écriture externe), PC 1600 × 900.",
          "Avant = commit ee6c412 (intégration), après = branche utilisable-pro-2026-10-08. Temps mesurés sur une machine chargée (dev server).",
          "Gestes : clics (ou toucher) + touches du clavier (une saisie de texte compte une touche par caractère).", ""]
    md += session_table("session_voix", "1. Session d'enregistrement voix")
    md += session_table("session_mix", "2. Session de mix (20 pistes)")
    md += session_table("session_beat", "3. Session beatmaker")

    fa, fb = load("avant", "fenetres/fenetres_echap.json"), load("apres", "fenetres/fenetres_echap.json")
    md += ["## Fenêtres : ouverture et Échap", ""]
    if fa and fb:
        bi = {f["fenetre"]: f for f in fb["fenetres"]}
        md += ["| Fenêtre | Avant : ms · Échap | Après : ms · Échap |", "|---|---|---|"]
        for f in fa["fenetres"]:
            g = bi.get(f["fenetre"], {})
            fmt = lambda x: ("pas ouverte" if not x.get("ouverte") else f"{x['ms']} ms · {'ferme' if x['echap_ferme'] else '**ne ferme pas**'}") if x else "—"
            md.append(f"| {f['fenetre']} | {fmt(f)} | {fmt(g)} |")
        md += ["", f"Échap ferme : {fa['bilan']['echap_ferme']} / {fa['bilan']['ouvertes']} avant → {fb['bilan']['echap_ferme']} / {fb['bilan']['ouvertes']} après.", ""]
    bb_a, bb_b = load("avant", "barre_bas/barre_bas_debordement.json"), load("apres", "barre_bas/barre_bas_debordement.json")
    if bb_a and bb_b:
        md += ["## Bandeau du bas (Piste voix, Paroles, Mix auto…)", "",
               f"Cas sans défaut : {len(bb_a['cas']) - len(bb_a['echecs'])} / {len(bb_a['cas'])} avant → {len(bb_b['cas']) - len(bb_b['echecs'])} / {len(bb_b['cas'])} après "
               "(1024 → 1920 px, navigateur ouvert / fermé, projet voix / beat, thème sombre / clair).", ""]
    pal = load("apres", "palette/palette_commandes.json")
    if pal:
        ok = sum(1 for c in pal["cas"] if c.get("ok"))
        ms = sorted(c["ms_ouverture"] for c in pal["cas"] if c.get("ms_ouverture"))
        md += ["## Palette de commandes (Ctrl+K)", "",
               f"N'existait pas avant. Après : {ok} / {len(pal['cas'])} recherches donnent la bonne action en premier et l'exécutent "
               f"(PC clavier sombre + clair, tablette au doigt) ; ouverture médiane {ms[len(ms) // 2] if ms else '—'} ms.", ""]
    pa, pb = load("avant", "perf/perf_studio.json"), load("apres", "perf/perf_studio.json")
    if pa and pb:
        md += ["## Performance (build de production, médiane de 3 essais)", "", "| Mesure | Avant | Après |", "|---|---|---|"]
        for k, lab in (("accueil_ms", "Accueil interactif (ms)"), ("studio_ms", "Nouveau projet → studio prêt (ms)"), ("projet40_ms", "Ouvrir un projet de 40 pistes (ms)"),
                       ("tas_40_mo", "Mémoire JS avec 40 pistes (Mo)"), ("console_ms", "Console de mixage, 40 pistes (ms)"), ("js_ko", "JavaScript chargé (Ko)")):
            md.append(f"| {lab} | {pa.get(k)} | {pb.get(k)} |")
        for grp, lab in (("defilement", "Défilement 40 pistes"), ("zoom", "Zoom"), ("lecture", "Lecture 4 s")):
            md.append(f"| {lab} : images/s · pire image · tâches longues | {pa[grp]['fps']} · {pa[grp]['pire_image_ms']} ms · {pa[grp]['taches_longues']} | {pb[grp]['fps']} · {pb[grp]['pire_image_ms']} ms · {pb[grp]['taches_longues']} |")
        for k in pb["fenetres_ms"]:
            md.append(f"| Ouverture « {k} » (ms) | {pa['fenetres_ms'].get(k) if pa['fenetres_ms'].get(k) is not None else '— (n’existe pas)'} | {pb['fenetres_ms'][k]} |")
        md.append("")
    (ROOT / "TABLEAU_AVANT_APRES.md").write_text("\n".join(md), encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
