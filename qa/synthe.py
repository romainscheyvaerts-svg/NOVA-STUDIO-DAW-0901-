"""Synthé NOVA : piste en un clic, sons, façade, clavier (headless, aucune fenêtre, hors production).

Bureau (1600 × 900) et téléphone (390 × 844), thèmes sombre et clair :
  1. projet en mode instru → bouton « 🎹 Synthé NOVA » visible sans défiler ;
  2. un clic : piste MIDI jouée par le synthé NOVA, écran des sons ouvert, piano roll dessous ;
  3. catégorie « Afro & Amapiano » → « Log drum amapiano » choisi ; écoute rapide d'un autre son
     sans le choisir ; précédent / suivant ; favori ; « Nouveautés » ; recherche ;
  4. façade : modules (repliables au téléphone), bouton rotatif tourné à la souris ;
  5. mini-clavier : une touche tenue fait sonner une voix du moteur, relâchée elle se tait ;
  6. Échap ferme l'écran, le piano roll attend les notes ; Ctrl+K propose « Synthé NOVA » ;
  7. aucun défilement horizontal, cibles d'au moins 44 px au téléphone (touches noires du
     clavier exceptées), aucune erreur dans la console.

NOVA_URL=http://127.0.0.1:3449/ python qa/synthe.py   (captures : QA_OUT ou D:\\1 WORK\\CONTENU\\nova-synthe\\captures\\apres)
"""
import json, os, sys, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3449/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-synthe\captures\apres")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, BASE, Log, new_page, shot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROJ = OUT / "projet_synthe.zip"
RUNS = [("pc", "dark"), ("tel390", "dark"), ("pc", "light"), ("tel390", "light")]
KO = []


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:400]}"))
    if not cond:
        KO.append(name)


def make_project():
    notes = [{"id": f"n{i}", "pitch": p, "start": 0.0, "duration": 1.5, "velocity": 0.8} for i, p in enumerate([48, 55, 58, 62, 65])]
    track = {"id": "melodie", "name": "Mélodie", "type": "MIDI", "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
             "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [], "clips": [{"id": "c1", "name": "Accord", "start": 0, "duration": 2, "offset": 0,
             "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee", "type": "MIDI", "notes": notes, "gain": 1}], "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {"id": "proj-synthe", "name": "Synthé NOVA", "bpm": 140, "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False, "isRecording": False,
             "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": "melodie",
             "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False,
             "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(PROJ, "w") as z:
        z.writestr("project.json", json.dumps(state))


def open_project(page):
    page.add_init_script("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); localStorage.removeItem('nova.synth.favoris'); } catch (e) {}")
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=30000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(PROJ))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)


def synth_tracks(page):
    return page.evaluate("() => window.__novaEdit.getState().tracks.filter(t => t.type === 'MIDI').map(t => ({ id: t.id, name: t.name, preset: t.novaSynth ? t.novaSynth.presetId : null }))")


def preset_of(page, tid):
    return page.evaluate("(tid) => { const t = window.__novaEdit.getState().tracks.find(x => x.id === tid); return t && t.novaSynth ? t.novaSynth.presetId : null; }", tid)


VOICES = """async (tid) => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const s = audioEngine.tracksDSP.get(tid)?.synth; return s && s.activeVoiceCount ? s.activeVoiceCount() : -1; }"""

METRICS = """(phone) => {
  const p = document.querySelector('[data-testid=synth-panel]'); if (!p) return null;
  const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]'); };
  const targets = Array.from(p.querySelectorAll('button, [role=slider], input:not(.hw-sr-only), select')).filter(vis)
    .filter(e => !e.classList.contains('syn-key-b'));
  const small = targets.map(e => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.innerText || e.className).toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => Math.min(x.w, x.h) < 44);
  // Élément coupé par un parent qui défile ou masque (rangée de catégories qui défile au doigt) : pas un débordement de la page.
  const clipped = e => { for (let a = e.parentElement; a && a !== p; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox !== 'visible' && a.getBoundingClientRect().right <= innerWidth + 1) return true; } return false; };
  const over = Array.from(p.querySelectorAll('*')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && vis(e) && !clipped(e); })
    .map(e => e.className.toString().slice(0, 40)).slice(0, 8);
  return { panneau: [Math.round(p.firstElementChild.getBoundingClientRect().width), Math.round(p.firstElementChild.getBoundingClientRect().height)],
    defilement_horizontal: document.documentElement.scrollWidth > innerWidth + 1, hors_ecran: over, cibles: targets.length, petites: small.slice(0, 12), n_petites: small.length };
}"""


def run(vp, theme, res):
    os.environ["QA_THEME"] = theme
    tag = f"{vp}_{theme}"
    phone = vp.startswith("tel")
    log = Log(f"synthe_{tag}")
    r = {}
    with sync_playwright() as p:
        b = qalib.launch(p)
        ctx, page = new_page(b, vp, log)
        try:
            open_project(page)
            before = {t["id"] for t in synth_tracks(page)}
            btn = page.locator("[data-testid=new-synth-track]").first
            btn.wait_for(timeout=15000)
            box = btn.bounding_box()
            r["bouton"] = {"texte": btn.inner_text().strip(), "x": round(box["x"]), "droite": round(box["x"] + box["width"]), "largeur_ecran": page.viewport_size["width"]}
            ok(f"{tag} : « Synthé NOVA » visible sans défiler", box["x"] >= 0 and box["x"] + box["width"] <= page.viewport_size["width"] and "Synthé NOVA" in r["bouton"]["texte"], r["bouton"])
            shot(page, f"{tag}_01_barre")
            # 1 clic
            btn.click()
            page.locator("[data-testid=synth-panel]").wait_for(timeout=10000)
            page.wait_for_timeout(900)
            new = [t for t in synth_tracks(page) if t["id"] not in before]
            r["piste_creee"] = new
            tid = new[0]["id"] if new else None
            ok(f"{tag} : un clic crée une piste synthé NOVA et ouvre ses sons", bool(new) and new[0]["preset"] == "keys-rnb", new)
            r["piano_roll_dessous"] = page.locator("[data-nova-pianoroll]").count() > 0
            shot(page, f"{tag}_02_sons")
            r["mesures_sons"] = page.evaluate(METRICS, phone)
            # Catégorie + choix
            page.get_by_role("tab", name="Afro & Amapiano").click(); page.wait_for_timeout(300)
            page.locator("[data-preset=log-drum]").first.click(); page.wait_for_timeout(500)
            r["choisi"] = preset_of(page, tid)
            r["nom_affiche"] = page.locator("[data-testid=synth-preset-name]").inner_text()
            ok(f"{tag} : « Log drum amapiano » choisi", r["choisi"] == "log-drum" and "Log drum" in r["nom_affiche"], r)
            # Écoute rapide sans choisir
            page.get_by_role("button", name="Écouter Pluck afro").click(); page.wait_for_timeout(400)
            ok(f"{tag} : ▶ écoute un son sans le choisir", preset_of(page, tid) == "log-drum", preset_of(page, tid))
            # Suivant / précédent
            page.get_by_role("button", name="Son suivant").click(); page.wait_for_timeout(400)
            r["suivant"] = preset_of(page, tid)
            page.get_by_role("button", name="Son précédent").click(); page.wait_for_timeout(400)
            r["precedent"] = preset_of(page, tid)
            ok(f"{tag} : précédent / suivant", r["suivant"] not in (None, "log-drum") and r["precedent"] == "log-drum", r)
            # Favori
            page.get_by_role("button", name="Ajouter aux favoris").click(); page.wait_for_timeout(200)
            page.get_by_role("tab", name="★ Favoris (1)").click(); page.wait_for_timeout(300)
            r["favoris"] = page.locator("[data-testid=synth-presets] [data-preset]").count()
            page.get_by_role("tab", name="✨ Nouveautés (22)").click(); page.wait_for_timeout(300)
            r["nouveautes"] = page.locator("[data-testid=synth-presets] [data-preset]").count()
            shot(page, f"{tag}_03_nouveautes")
            page.get_by_label("Chercher un son").fill("drill"); page.wait_for_timeout(300)
            r["recherche_drill"] = page.locator("[data-testid=synth-presets] [data-preset]").count()
            page.get_by_label("Chercher un son").fill("")
            ok(f"{tag} : favoris, nouveautés, recherche", r["favoris"] == 1 and r["nouveautes"] == 22 and r["recherche_drill"] >= 3, r)
            # Façade
            tab = page.locator("[data-testid=synth-tab-reglages]")
            if tab.is_visible():
                tab.click(); page.wait_for_timeout(400)
            page.locator("[data-synth-facade]").wait_for(timeout=5000)
            shot(page, f"{tag}_04_facade")
            if phone:
                page.get_by_role("button", name="Déplier Enveloppes").click(); page.wait_for_timeout(300)
                r["enveloppes_depliees"] = page.locator("[data-synth-mod=env]").get_attribute("data-open")
                page.locator("[data-synth-mod=env]").scroll_into_view_if_needed()
                shot(page, f"{tag}_05_enveloppes")
                ok(f"{tag} : modules repliables", r["enveloppes_depliees"] == "true", r.get("enveloppes_depliees"))
            r["mesures_facade"] = page.evaluate(METRICS, phone)
            if not phone:
                page.evaluate("() => { const f = document.querySelector('[data-synth-facade]'); f.scrollTop = f.scrollHeight; }"); page.wait_for_timeout(300)
                shot(page, f"{tag}_05_facade_bas")
                page.evaluate("() => { document.querySelector('[data-synth-facade]').scrollTop = 0; }")
            # Bouton rotatif : glisser vers le haut ouvre le filtre
            knob = page.locator("[data-nova-param=filter-cutoff]").first
            knob.scroll_into_view_if_needed()
            cut0 = page.evaluate("(tid) => window.__novaEdit.getState().tracks.find(x => x.id === tid).novaSynth.filter.cutoff", tid)
            kb = knob.bounding_box()
            page.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2)
            page.mouse.down(); page.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2 - 60, steps=8); page.mouse.up()
            page.wait_for_timeout(500)
            cut1 = page.evaluate("(tid) => window.__novaEdit.getState().tracks.find(x => x.id === tid).novaSynth.filter.cutoff", tid)
            r["coupure"] = [round(cut0), round(cut1)]
            r["nom_apres_reglage"] = page.locator("[data-testid=synth-preset-name]").inner_text()
            ok(f"{tag} : le bouton rotatif ouvre le filtre (• modifié)", cut1 > cut0 * 1.2 and "modifié" in r["nom_apres_reglage"], r["coupure"])
            shot(page, f"{tag}_06_reglage")
            # Clavier : tenir une touche
            key = page.locator("[data-testid=synth-keyboard] [data-pitch='60']").first
            kbx = key.bounding_box()
            x, y = kbx["x"] + kbx["width"] / 2, kbx["y"] + kbx["height"] * 0.8
            if phone:
                key.dispatch_event("pointerdown", {"pointerId": 11, "pointerType": "touch", "isPrimary": True, "clientX": x, "clientY": y, "button": 0, "buttons": 1})
            else:
                page.mouse.move(x, y); page.mouse.down()
            page.wait_for_timeout(350)
            r["voix_touche_tenue"] = page.evaluate(VOICES, tid)
            r["touche_allumee"] = key.get_attribute("data-down")
            shot(page, f"{tag}_07_clavier")
            if phone:
                key.dispatch_event("pointerup", {"pointerId": 11, "pointerType": "touch", "isPrimary": True, "clientX": x, "clientY": y, "button": 0, "buttons": 0})
            else:
                page.mouse.up()
            page.wait_for_timeout(1500)
            r["voix_apres_relachement"] = page.evaluate(VOICES, tid)
            ok(f"{tag} : le clavier joue (voix tenue puis relâchée)", r["voix_touche_tenue"] >= 1 and r["touche_allumee"] == "true" and r["voix_apres_relachement"] == 0, r)
            # Échap : retour au piano roll
            page.keyboard.press("Escape"); page.wait_for_timeout(500)
            r["ferme"] = page.locator("[data-testid=synth-panel]").count() == 0
            r["piano_roll_apres"] = page.locator("[data-nova-pianoroll]").count() > 0
            ok(f"{tag} : Échap ferme, le piano roll attend les notes", r["ferme"] and r["piano_roll_apres"], r)
            shot(page, f"{tag}_08_piano_roll")
            if not phone:
                page.keyboard.press("Escape"); page.wait_for_timeout(400)
                page.keyboard.press("Control+k"); page.wait_for_timeout(500)
                page.keyboard.type("synthé", delay=30); page.wait_for_timeout(500)
                r["palette"] = page.get_by_text("Synthé NOVA : nouvelle piste", exact=False).count() > 0
                shot(page, f"{tag}_09_palette")
                ok(f"{tag} : Ctrl+K propose « Synthé NOVA »", r["palette"], r.get("palette"))
                page.keyboard.press("Escape")
            ms, mf = r["mesures_sons"] or {}, r["mesures_facade"] or {}
            ok(f"{tag} : aucun défilement horizontal", not ms.get("defilement_horizontal") and not mf.get("defilement_horizontal") and not ms.get("hors_ecran") and not mf.get("hors_ecran"), [ms.get("hors_ecran"), mf.get("hors_ecran")])
            if phone:
                ok(f"{tag} : cibles ≥ 44 px", ms.get("n_petites") == 0 and mf.get("n_petites") == 0, [ms.get("petites"), mf.get("petites")])
        except Exception as e:  # noqa
            r["ERREUR"] = f"{type(e).__name__}: {str(e)[:400]}"
            ok(f"{tag} : scénario complet", False, r["ERREUR"])
            try: shot(page, f"{tag}_ECHEC")
            except Exception: pass
        # « 400 (Bad Request) » : sonde de la grille de prix (nova-billing « pricing ») tant que le
        # serveur simulé est à l'ancienne grille ; le DAW se replie dessus, ce n'est pas une panne.
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()
                                if "status of 400" not in e["text"]][:8]
        ok(f"{tag} : aucune erreur dans la console", not r["erreurs_console"], r["erreurs_console"])
        ctx.close(); b.close()
    res[tag] = r


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    make_project()
    res = {}
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    for vp, theme in RUNS:
        if only and f"{vp}_{theme}" not in only:
            continue
        run(vp, theme, res)
    res["KO"] = KO
    (OUT / "synthe.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{'KO' if KO else 'OK'} : {len(KO)} échec(s)")
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
