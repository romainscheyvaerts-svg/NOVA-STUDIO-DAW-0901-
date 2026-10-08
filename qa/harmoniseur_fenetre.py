"""Fenêtre de l'Harmoniseur avec la piste d'accords (headless, aucune fenêtre à l'écran).

Projet : une voix + Am → F → C → G dans le couloir d'accords (sous la règle).
On ajoute l'Harmoniseur depuis la console, on vérifie « Suivre la piste
d'accords » (coché par défaut), puis on lance la lecture : la fenêtre montre
l'accord en cours et la note de chaque voix. Captures dans
D:\\1 WORK\\CONTENU\\nova-finitions-accords\\harmoniseur_fenetre\\.

NOVA_URL=http://127.0.0.1:3437/ PYTHONIOENCODING=utf-8 python qa/harmoniseur_fenetre.py
"""
import json, os, sys
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3437/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-finitions-accords\harmoniseur_fenetre"
sys.path.insert(0, str(Path(__file__).parent))
from qalib import OUT, Log, new_page, shot, save_log, launch, overflow_report  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from v20_preuves import make_project, wav_bytes  # noqa
from v21_fenetres import open_add_menu  # noqa
from playwright.sync_api import sync_playwright


def vowel(f0, sec, sr=44100):
    n = int(sec * sr)
    ph = (np.arange(n) * f0 / sr) % 1.0
    src = np.where(ph < 0.4, 0.5 * (1 - np.cos(np.pi * ph / 0.4)), np.where(ph < 0.6, np.cos(np.pi * (ph - 0.4) / 0.4), 0.0))
    d = np.diff(src, prepend=0.0)
    out = np.zeros(n)
    for k, fc in enumerate((700, 1220, 2600)):
        bw = 130 + 60 * k; r = np.exp(-np.pi * bw / sr); th = 2 * np.pi * fc / sr
        a1, a2, g = -2 * r * np.cos(th), r * r, (1, 0.6, 0.3)[k]
        y1 = y2 = 0.0
        y = np.zeros(n)
        for i in range(n):
            v = d[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = v; y[i] = v
        out += g * y
    return (0.5 * out / np.max(np.abs(out))).astype(np.float32)


def main():
    res = {}
    log = Log("harmoniseur_fenetre")
    v = vowel(261.63, 10.0)   # Do3 tenu
    chords = [{"id": f"ch{k}", "start": 2.0 + 2 * k, "end": 4.0 + 2 * k, "root": r, "quality": q} for k, (r, q) in enumerate([(9, "min"), (5, "maj"), (0, "maj"), (7, "maj")])]
    proj = OUT / "projet_harmoniseur_accords.zip"
    make_project(proj, "Harmoniseur et accords", [("voix", "Voix", wav_bytes(np.stack([v, v])), 10.0, 0)], key=(9, "MINOR"), bpm=120, chords=chords)
    with sync_playwright() as p:
        b = launch(p)
        ctx, page = new_page(b, "pc", log)
        page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_chord_lane', '1'); } catch (e) {}")
        prepare(page)
        open_project_file(page, proj, res, "01_projet_accords_sous_la_regle")
        page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
        res["couloir"] = page.evaluate("""() => { const l = document.querySelector('[data-testid=chord-lane]'); const c = (document.querySelector('.nova-grille canvas[data-tracks-top]') || document.querySelectorAll('.nova-grille canvas')[1]);
          if (!l || !c) return null; const a = l.getBoundingClientRect(), r = c.getBoundingClientRect();
          return { haut_couloir: Math.round(a.top - r.top), hauteur: Math.round(a.height), haut_pistes: +c.dataset.tracksTop, accords: [...document.querySelectorAll('[data-chord-event]')].map(e => e.dataset.chordEvent) }; }""")
        if not open_add_menu(page, "pc"):
            res["erreur"] = "menu « Ajouter un effet » introuvable"
        else:
            page.get_by_text("Harmoniseur", exact=True).first.click(); page.wait_for_timeout(1500)
            win = page.locator("[data-nova-plugin='HARMONIZER']")
            res["fenetre"] = win.count() > 0
            cb = page.locator("[data-nova-harmonizer='follow-chords']")
            res["case_suivre_accords"] = cb.count() > 0
            res["cochee_par_defaut"] = cb.is_checked() if cb.count() else None
            shot(page, "02_harmoniseur_suivre_accords")
            # Lecture depuis 2 s : l'accord en cours s'affiche (Am, puis F…).
            page.evaluate("() => document.querySelector('button[aria-label=Lecture]').click()"); page.wait_for_timeout(3000)
            res["pendant_lecture"] = win.inner_text()[:600] if win.count() else None
            res["accord_affiche"] = page.locator("[data-nova-harmonizer='chord']").all_inner_texts()
            shot(page, "03_harmoniseur_accord_en_cours")
            page.wait_for_timeout(2200)
            res["accord_affiche_2"] = page.locator("[data-nova-harmonizer='chord']").all_inner_texts()
            shot(page, "04_harmoniseur_accord_suivant")
            page.evaluate("() => document.querySelector('button[aria-label=Pause]')?.click()"); page.wait_for_timeout(300)
            if cb.count():
                cb.uncheck(); page.wait_for_timeout(300)
                res["decochee_projet"] = page.evaluate("() => { const s = window.__novaEdit.getState(); const t = s.tracks.find(x => x.id === 'voix'); const p = t.plugins.find(x => x.type === 'HARMONIZER'); return p ? p.params.followChords : null; }")
                shot(page, "05_harmoniseur_decoche")
        res["debordements"] = [d for d in overflow_report(page) if d.get("kind") != "clipped"][:5]
        res["erreurs_page"] = [e["text"][:200] for e in log.errors()][:8]
        b.close()
    save_log(log, {"result": res})
    (OUT / "mesures.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
