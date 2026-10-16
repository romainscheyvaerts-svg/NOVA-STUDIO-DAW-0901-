"""🎲 Sons et beat (lots 5 et 10 BandLab, 16/10/2026) : navigateur de sons, Palette, « Démarrer un beat »,
« Prolonger / Varier », de bout en bout et 100 % hors production (qa_hors_prod), navigateur headless.

Bureau 1366 × 768 (sombre puis clair) :
  1. mode simple : rien de nouveau à l'écran (pas d'onglet « Sons »), mais Ctrl+K connaît les 4 commandes ;
  2. Ctrl+K « démarrer un beat » → fenêtre : genre Drill UK, tonique Fa, dé, variante B, écoute ;
     « Poser le squelette » → batterie + 808 + accords + piste d'accords, 142 BPM, Fa mineur ; Ctrl+Z = UNE étape ;
  3. Ctrl+K « sons » → navigateur : filtre 808, écoute d'un son de kit (servi brouillé, ni FLAC ni WAV),
     « Sur un pad » ; boucles filtrées sur mon tempo et ma tonalité, pose d'une boucle d'accords ;
     Palette : 2 à 5 boucles toutes dans la tonalité, « Tout poser » puis Ctrl+Z = une étape ;
     aucun bouton / lien de téléchargement, aucune adresse de fichier affichée ;
  4. « Prolonger / Varier » sur le clip d'accords : inversion (variante B) puis prolonger de 2 mesures ;
  5. mode avancé : onglet « Sons » du panneau de gauche ; aucun bouton recouvert (balayage) ;
  6. thème clair : audit (aucune zone très sombre, textes lisibles) sur chaque fenêtre ; aucune erreur console.
Téléphone 390 × 844 (au doigt, sombre puis clair) : palette → Démarrer un beat (fenêtre posée en bas, rien de
recouvert), pose ; page « Sons » du navigateur (mode avancé) ; Palette.

NOVA_URL=http://127.0.0.1:3424/ PYTHONIOENCODING=utf-8 python qa/sons_beat.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-151\\sons-beat\\qa) : sons_beat.json + captures.
"""
import json
import os
import re
import sys
import zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3424/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-151\sons-beat\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, balayage_chevauchement, launch  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

_tc = (Path(__file__).parent / "theme_clair.py").read_text(encoding="utf-8")
AUDIT_JS = re.search(r'AUDIT_JS = r"""(.*?)"""', _tc, re.S).group(1)
_AUDIT_OPTS = {"voulues": re.search(r'ZONES_VOULUES = "([^"]+)"', _tc).group(1), "pixelsVoulus": re.search(r'PIXELS_VOULUS = "([^"]+)"', _tc).group(1),
               "aireMin": float(re.search(r"AIRE_MIN = ([\d.]+)", _tc).group(1)), "lumSombre": float(re.search(r"LUM_SOMBRE = ([\d.]+)", _tc).group(1)),
               "contrasteMin": float(re.search(r"CONTRASTE_MIN = ([\d.]+)", _tc).group(1))}

checks = []
res = {"bureau": {}, "telephone": {}}
PAL = "[data-testid=command-palette]"
SET_SIMPLE = """async (on) => { const { simpleModeStore } = await window.__novaAppModule('/utils/simpleMode.ts'); simpleModeStore.setPref(on); return simpleModeStore.get().simple; }"""
SET_THEME = """async (t) => { const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts'); themeStore.setPref(t); }"""
ST = """() => { const s = window.DAW_CONTROL.getState(); return { bpm: s.bpm, key: s.projectKey, scale: s.projectScale, chords: (s.chords || []).length,
  tracks: s.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, inst: t.melodicSampler && t.melodicSampler.instrument, kit: t.drumMachine && t.drumMachine.kitId,
    pads: t.drumMachine ? t.drumMachine.rows.length : 0, clips: t.clips.map(c => ({ id: c.id, start: +c.start.toFixed(3), dur: +c.duration.toFixed(3), n: (c.notes || []).length, p: (c.notes || []).slice(0, 6).map(n => n.pitch) })) })) }; }"""
NO_DL_JS = """(sel) => { const r = document.querySelector(sel); if (!r) return { absent: true };
  const links = r.querySelectorAll('a[href], [download]').length;
  const dlBtns = [...r.querySelectorAll('button, [role=button]')].filter(b => /t[ée]l[ée]charg|download|enregistrer sous/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.title || ''))).map(b => b.innerText.slice(0, 40));
  const urls = (r.innerText.match(/\\/(drums|instruments)\\/|\\.(wav|nks|ogg|flac)\\b|https?:\\/\\//gi) || []);
  const drag = [...r.querySelectorAll('[draggable=true]')].length;
  return { links, dlBtns, urls, drag }; }"""


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def make_project(path: Path):
    track = {"id": "track-rec-main", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
             "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
             "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {
        "id": "proj-sons-beat", "name": "Sons et beat", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": "track-rec-main", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


INIT = """try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}"""


def open_project(page, f: Path, touch=False):
    page.add_init_script(INIT)
    # Facturation simulée (comme les autres scénarios) : le simulateur générique répond 400.
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
               body=json.dumps({"plans": [], "admin": False, "unlocked": False, "free_exports_left": 0})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    b = page.get_by_text("Charger Projet").first
    b.tap() if touch else b.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        c = page.get_by_text("Charger depuis l'ordinateur").first
        c.tap() if touch else c.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(4000)
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    page.keyboard.press("Escape")


def kit_spy(page, store):
    def on_resp(r):
        if "/drums/kits/" in r.url and r.url.endswith(".nks"):
            try: head = r.body()[:4]
            except Exception: head = b""
            store.append({"status": r.status, "head": head.decode("latin1")})
    page.on("response", on_resp)


def palette_run(page, query, want, touch=False):
    if touch:
        btn = page.locator("[data-testid=open-palette]").locator("visible=true")
        if btn.count():
            btn.first.tap()
        else:
            # Téléphone : menu ☰ → « Chercher une action… » (sous « Plus d'outils » en mode simple).
            page.locator("[data-testid=transport-menu]").locator("visible=true").first.tap(); page.wait_for_timeout(400)
            mp = page.locator("[data-testid=menu-palette]").locator("visible=true")
            if not mp.count():
                plus = page.locator("[data-testid=menu-plus-toggle]").locator("visible=true")
                if plus.count(): plus.first.tap(); page.wait_for_timeout(300)
            page.locator("[data-testid=menu-palette]").locator("visible=true").first.tap()
    else:
        page.keyboard.press("Control+k")
    page.locator(PAL).wait_for(timeout=5000)
    page.keyboard.type(query, delay=10)
    page.wait_for_timeout(250)
    first = page.locator(f"{PAL} [role=option]").first.get_attribute("data-palette-id")
    ids = page.evaluate(f"() => [...document.querySelectorAll('{PAL} [role=option]')].map(o => o.getAttribute('data-palette-id')).slice(0, 6)")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    return first == want, {"premier": first, "liste": ids}


def audit_clair(page, ou):
    a = page.evaluate(AUDIT_JS, _AUDIT_OPTS)
    check(f"{ou} (clair) : aucune grande zone très sombre, textes lisibles", a["theme"] == "light" and not a["zones"] and not a["nTextes"],
          {"zones": a["zones"][:3], "textes": [(t["texte"], t["contraste"]) for t in a["textes"][:6]]})


def couverture(page, ou, scope, sous_barre_ok=False):
    b = balayage_chevauchement(page, scope)
    if sous_barre_ok and b.get("recouverts"):
        # Téléphone : une ligne de liste passée SOUS la barre d'onglets du bas (fixe) en défilant n'est pas
        # recouverte « pour de vrai » : on la ramène en faisant défiler (vérifié à part, voir fin_atteignable).
        b["sous_la_barre"] = [r for r in b["recouverts"] if any("fixed.bottom-0" in c or "div.fixed.bottom-0" in c for c in r.get("pile", []))]
        b["recouverts"] = [r for r in b["recouverts"] if r not in b["sous_la_barre"]]
    check(f"{ou} : aucun bouton recouvert ({b.get('boutons')} boutons)", not b.get("erreur") and b.get("boutons", 0) > 3 and not b["recouverts"], b.get("recouverts") or b.get("erreur"))
    return b


def undo(page):
    page.mouse.click(5, 300)  # le focus quitte les champs
    page.keyboard.press("Control+z"); page.wait_for_timeout(700)


def desktop(b, f: Path, theme):
    R = res["bureau"].setdefault(theme, {})
    log = Log(f"sons_beat_pc_{theme}")
    ctx, page = new_page(b, "pc1366", log=log, touch=False)
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    kits = []
    kit_spy(page, kits)
    open_project(page, f)
    page.evaluate(SET_SIMPLE, True); page.wait_for_timeout(400)
    shot(page, f"pc_{theme}_00_simple")
    check(f"bureau {theme} : mode simple sans onglet « Sons » ni bouton nouveau à l'écran",
          page.locator("[data-testid=browser-tab-sons]").locator("visible=true").count() == 0 and page.locator("[data-testid=sound-library]").count() == 0)

    # --- Démarrer un beat (Ctrl+K, même en mode simple)
    ok, d = palette_run(page, "démarrer un beat", "pal.startBeat")
    check(f"bureau {theme} : Ctrl+K « démarrer un beat » → 1re commande, la fenêtre s'ouvre", ok and page.locator("[data-testid=beat-starter]").is_visible(), d)
    shot(page, f"pc_{theme}_01_demarrer_beat")
    page.locator("[data-testid=beat-genre-drill-uk]").click()
    page.locator("[data-testid=beat-root]").select_option("5")
    v0 = page.locator("[data-testid=beat-variant]").all_inner_texts()
    page.locator("[data-testid=beat-dice]").click(); page.wait_for_timeout(200)
    v1 = page.locator("[data-testid=beat-variant]").all_inner_texts()
    check(f"bureau {theme} : 3 variantes, le dé en tire 3 autres", len(v0) == 3 and len(v1) == 3 and v0 != v1, {"avant": v0, "apres": v1})
    page.locator("[data-testid=beat-variant-1]").click()
    page.locator("[data-testid=beat-listen-1]").click(); page.wait_for_timeout(2500)
    lab = page.locator("[data-testid=beat-listen-1]").inner_text()
    check(f"bureau {theme} : « Écouter » une variante rend et joue le squelette (bouton Stop)", "Stop" in lab, lab)
    shot(page, f"pc_{theme}_02_variante_ecoute")
    couverture(page, f"bureau {theme} · Démarrer un beat", "[data-testid=beat-starter]")
    if theme == "light": audit_clair(page, "bureau · Démarrer un beat")
    summary = page.locator("[data-testid=beat-summary]").inner_text()
    before = page.evaluate(ST)
    page.locator("[data-testid=beat-apply]").click(); page.wait_for_timeout(1500)
    after = page.evaluate(ST)
    ids = [t["id"] for t in after["tracks"]]
    R["squelette"] = {"resume": summary, "etat": after}
    check(f"bureau {theme} : squelette posé (batterie, 808, accords, piste d'accords), 142 BPM, Fa mineur",
          {"track-drums", "track-808", "track-beat-accords"} <= set(ids) and after["bpm"] == 142 and after["key"] == 5 and after["chords"] > 0, after)
    shot(page, f"pc_{theme}_03_squelette_pose")
    undo(page)
    back = page.evaluate(ST)
    check(f"bureau {theme} : Ctrl+Z annule le squelette en UNE étape (pistes, tempo, tonalité)",
          [t["id"] for t in back["tracks"]] == [t["id"] for t in before["tracks"]] and back["bpm"] == 120 and back["key"] == before["key"], back)
    page.keyboard.press("Control+y"); page.wait_for_timeout(700)
    redo = page.evaluate(ST)
    check(f"bureau {theme} : Ctrl+Y le remet", redo["bpm"] == 142 and "track-808" in [t["id"] for t in redo["tracks"]], redo["bpm"])

    # --- Navigateur de sons
    ok, d = palette_run(page, "sons et boucles", "pal.sounds")
    lib = page.locator("[data-testid=sound-library]")
    check(f"bureau {theme} : Ctrl+K « sons et boucles » ouvre le navigateur", ok and lib.is_visible(), d)
    page.wait_for_timeout(1200)
    n_all = page.locator("[data-testid=sounds-count]").inner_text()
    page.locator("[data-testid=sounds-type-808]").click(); page.wait_for_timeout(300)
    n808 = page.locator("[data-testid=sounds-count]").inner_text()
    check(f"bureau {theme} : filtre « 808 » ({n808} sur {n_all})", n808 != n_all and "résultat" in n808, [n_all, n808])
    nk = len(kits)
    page.locator("[data-testid=sound-play]").first.click(); page.wait_for_timeout(1500)
    served = kits[nk:]
    check(f"bureau {theme} : écoute d'un son de kit : servi brouillé (NVK1), ni FLAC ni WAV", served and all(k["head"] == "NVK1" for k in served), served[:3])
    shot(page, f"pc_{theme}_04_sons_808")
    nd = page.evaluate(NO_DL_JS, "[data-testid=sound-library]")
    R["protection"] = nd
    check(f"bureau {theme} : aucun lien ni bouton de téléchargement, aucune adresse de fichier affichée", nd["links"] == 0 and not nd["dlBtns"] and not nd["urls"], nd)
    pads0 = next((t["pads"] for t in page.evaluate(ST)["tracks"] if t["id"] == "track-drums"), 0)
    page.locator("[data-testid=sound-place]").first.click(); page.wait_for_timeout(1500)
    pads1 = next((t["pads"] for t in page.evaluate(ST)["tracks"] if t["id"] == "track-drums"), 0)
    check(f"bureau {theme} : « Sur un pad » ajoute le son sur un nouveau pad de la batterie", pads1 == pads0 + 1, [pads0, pads1])
    if page.locator("[data-testid=sound-library]").count() == 0:
        palette_run(page, "sons et boucles", "pal.sounds"); page.wait_for_timeout(800)
    page.locator("[data-testid=sounds-tab-boucles]").click(); page.wait_for_timeout(300)
    page.locator("[data-testid=sounds-type-chords]").click(); page.wait_for_timeout(300)
    rows = page.locator("[data-testid=sound-row]")
    texts = rows.all_inner_texts()[:40]
    check(f"bureau {theme} : boucles d'accords filtrées sur mon tempo et Fa mineur (ou La♭ majeur)",
          texts and all(("Fa mineur" in t) or ("La♭ majeur" in t) for t in texts), texts[:4])
    rows.first.locator("[data-testid=sound-play]").click(); page.wait_for_timeout(2500)
    check(f"bureau {theme} : pré-écoute d'une boucle (rendue au tempo du projet)", "Arrêter" in (rows.first.locator("[data-testid=sound-play]").get_attribute("aria-label") or ""))
    shot(page, f"pc_{theme}_05_boucles")
    couverture(page, f"bureau {theme} · Sons", "[data-testid=sound-library]")
    if theme == "light": audit_clair(page, "bureau · Sons")
    t0 = page.evaluate(ST)
    page.locator("[data-testid=sound-row]").first.locator("[data-testid=sound-place]").click(); page.wait_for_timeout(1500)
    t1 = page.evaluate(ST)
    new = [t for t in t1["tracks"] if t["id"].startswith("track-boucle-")]
    check(f"bureau {theme} : boucle d'accords posée sur une nouvelle piste, calée sur la mesure", len(new) == 1 and abs(new[0]["clips"][0]["start"] / (4 * 60 / 142) - round(new[0]["clips"][0]["start"] / (4 * 60 / 142))) < 1e-3, new)

    # --- Palette
    palette_run(page, "palette boucles", "pal.palette"); page.wait_for_timeout(600)
    items = page.locator("[data-testid=palette-list] [data-testid=sound-row]")
    txt = items.all_inner_texts()
    check(f"bureau {theme} : Palette de 4 boucles, toutes en Fa mineur / La♭ majeur ou sans tonalité (batterie)",
          items.count() == 4 and all(("Fa mineur" in t) or ("La♭ majeur" in t) or ("Batterie" in t) for t in txt), txt)
    page.locator("[data-testid=palette-count]").select_option("2"); page.wait_for_timeout(200)
    c2 = items.count()
    page.locator("[data-testid=palette-count]").select_option("5"); page.wait_for_timeout(200)
    c5 = items.count()
    check(f"bureau {theme} : Palette de 2 à 5 boucles", c2 == 2 and c5 == 5, [c2, c5])
    shot(page, f"pc_{theme}_06_palette")
    couverture(page, f"bureau {theme} · Palette", "[data-testid=sound-library]")
    if theme == "light": audit_clair(page, "bureau · Palette")
    p0 = page.evaluate(ST)
    page.locator("[data-testid=palette-place]").click(); page.wait_for_timeout(1800)
    p1 = page.evaluate(ST)
    check(f"bureau {theme} : « Tout poser » ajoute les boucles d'un coup", len(p1["tracks"]) > len(p0["tracks"]), [len(p0["tracks"]), len(p1["tracks"])])
    undo(page)
    p2 = page.evaluate(ST)
    check(f"bureau {theme} : Ctrl+Z retire toute la Palette en une étape", [t["id"] for t in p2["tracks"]] == [t["id"] for t in p0["tracks"]], [len(p0["tracks"]), len(p2["tracks"])])

    # --- Prolonger / Varier sur le clip d'accords du squelette
    acc = next(t for t in p2["tracks"] if t["id"] == "track-beat-accords")
    page.evaluate("""async (id) => { const { editSelectionStore } = await window.__novaAppModule('/utils/editSelection.ts'); editSelectionStore.set({ clipIds: [id] }); }""", acc["clips"][0]["id"])
    ok, d = palette_run(page, "varier", "pal.varyMidi")
    check(f"bureau {theme} : Ctrl+K « varier » ouvre Prolonger / Varier sur le clip sélectionné", ok and page.locator("[data-testid=pattern-vary]").is_visible(), d)
    page.locator("[data-testid=vary-rule-inversion]").click(); page.wait_for_timeout(200)
    nv = page.locator("[data-testid^=vary-variant-]").count()
    page.locator("[data-testid=vary-variant-1]").click()
    shot(page, f"pc_{theme}_07_varier")
    couverture(page, f"bureau {theme} · Varier", "[data-testid=pattern-vary]")
    if theme == "light": audit_clair(page, "bureau · Varier")
    page.locator("[data-testid=vary-apply]").click(); page.wait_for_timeout(800)
    v = next(t for t in page.evaluate(ST)["tracks"] if t["id"] == "track-beat-accords")
    check(f"bureau {theme} : inversion (3 variantes, B appliquée) : mêmes notes, autres octaves", nv == 3 and v["clips"][0]["p"] != acc["clips"][0]["p"] and v["clips"][0]["n"] == acc["clips"][0]["n"], {"avant": acc["clips"][0], "apres": v["clips"][0]})
    palette_run(page, "prolonger", "pal.varyMidi")
    page.locator("[data-testid=vary-mode-prolonger]").click()
    page.locator("[data-testid=vary-bars-2]").click(); page.wait_for_timeout(200)
    shot(page, f"pc_{theme}_08_prolonger")
    page.locator("[data-testid=vary-apply]").click(); page.wait_for_timeout(800)
    e = next(t for t in page.evaluate(ST)["tracks"] if t["id"] == "track-beat-accords")
    bar = 4 * 60 / 142
    check(f"bureau {theme} : prolonger de 2 mesures (8 → 10 mesures)", abs(e["clips"][0]["dur"] - 10 * bar) < 0.01, e["clips"][0])

    # --- Mode avancé : onglet « Sons » du panneau de gauche (la batterie ouverte par « Sur un pad » est refermée)
    for sel in ('[aria-label="Fermer la batterie"]', '[aria-label="Fermer Prolonger ou varier"]', '[aria-label="Fermer les sons"]'):
        x = page.locator(sel).locator("visible=true")
        if x.count(): x.first.click(); page.wait_for_timeout(300)
    page.evaluate(SET_SIMPLE, False); page.wait_for_timeout(600)
    tab = page.locator("[data-testid=browser-tab-sons]").locator("visible=true")
    if tab.count() == 0:
        nav = page.locator('[data-bar-item="navigateur"]').locator("visible=true")
        if nav.count(): nav.first.click(); page.wait_for_timeout(500)
        else:
            # 1366 px : le bouton est rangé dans le menu ☰ (« Afficher le navigateur »).
            page.locator("[data-testid=transport-menu]").locator("visible=true").first.click(); page.wait_for_timeout(400)
            page.get_by_text("Afficher le navigateur").locator("visible=true").first.click(); page.wait_for_timeout(600)
    tab = page.locator("[data-testid=browser-tab-sons]").locator("visible=true")
    if tab.count(): tab.first.click(); page.wait_for_timeout(800)
    check(f"bureau {theme} : mode avancé, onglet « Sons » du navigateur de gauche", tab.count() == 1 and page.locator("[data-testid=sound-library]").locator("visible=true").count() == 1)
    shot(page, f"pc_{theme}_09_panneau_sons")
    page.mouse.move(2, 2)
    couverture(page, f"bureau {theme} · écran entier (mode avancé, panneau Sons)", None)
    if theme == "light": audit_clair(page, "bureau · panneau Sons")
    errs = [e for e in log.errors() if "favicon" not in e["text"]]
    R["erreurs_console"] = errs[:10]
    check(f"bureau {theme} : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path, theme):
    R = res["telephone"].setdefault(theme, {})
    log = Log(f"sons_beat_tel_{theme}")
    ctx, page = new_page(b, "tel390", log=log, touch=True)
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    open_project(page, f, touch=True)
    page.wait_for_timeout(800)
    ok, d = palette_run(page, "démarrer un beat", "pal.startBeat", touch=True)
    dlg = page.locator("[data-testid=beat-starter]")
    check(f"téléphone {theme} : palette « démarrer un beat » ouvre la fenêtre", ok and dlg.is_visible(), d)
    box = dlg.bounding_box()
    check(f"téléphone {theme} : fenêtre posée dans la largeur de l'écran (pas de débordement)", box and box["x"] >= -1 and box["x"] + box["width"] <= 391, box)
    page.locator("[data-testid=beat-genre-afro]").tap()
    shot(page, f"tel_{theme}_01_demarrer_beat")
    couverture(page, f"téléphone {theme} · Démarrer un beat", "[data-testid=beat-starter]")
    if theme == "light": audit_clair(page, "téléphone · Démarrer un beat")
    small = page.evaluate("""() => [...document.querySelectorAll('[data-testid=beat-starter] button, [data-testid=beat-starter] select')].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.height), (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 24)]; }).filter(x => x[0] < 40)""")
    check(f"téléphone {theme} : boutons au doigt (≥ 40 px)", not small, small)
    page.locator("[data-testid=beat-apply]").scroll_into_view_if_needed()
    page.locator("[data-testid=beat-apply]").tap(); page.wait_for_timeout(1500)
    s = page.evaluate(ST)
    check(f"téléphone {theme} : squelette Afro posé (106 BPM, majeur)", s["bpm"] == 106 and s["scale"] == "MAJOR" and any(t["id"] == "track-beat-accords" for t in s["tracks"]), {"bpm": s["bpm"], "scale": s["scale"]})
    shot(page, f"tel_{theme}_02_squelette")
    # Page « Sons » du navigateur (mode avancé)
    page.evaluate(SET_SIMPLE, False); page.wait_for_timeout(500)
    tabb = page.locator('[data-nova-target="tab-BROWSER"]').locator("visible=true")
    if tabb.count(): tabb.first.tap(); page.wait_for_timeout(800)
    st = page.locator("[data-testid=mobile-tab-sons]").locator("visible=true")
    if st.count(): st.first.tap(); page.wait_for_timeout(1200)
    lib = page.locator("[data-testid=sound-library]").locator("visible=true")
    check(f"téléphone {theme} : page Navigateur, onglet « Sons » (mode avancé)", st.count() == 1 and lib.count() == 1)
    shot(page, f"tel_{theme}_03_page_sons")
    if lib.count():
        couverture(page, f"téléphone {theme} · page Sons", "[data-testid=sound-library]", sous_barre_ok=True)
        fin = page.evaluate("""async () => { const rows = [...document.querySelectorAll('[data-testid=sound-library] [data-testid=sound-row]')].filter(r => r.offsetParent);
          const last = rows[rows.length - 1]; if (!last) return null; last.scrollIntoView({ block: 'end' }); await new Promise(r => setTimeout(r, 400));
          const nav = [...document.querySelectorAll('div.fixed.bottom-0')].filter(n => n.offsetParent || getComputedStyle(n).position === 'fixed').map(n => n.getBoundingClientRect().top).filter(t => t > innerHeight / 2);
          const top = nav.length ? Math.min(...nav) : innerHeight; let b = last.getBoundingClientRect().bottom;
          if (b > top) { const sc = (function f(e) { for (let p = e.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p; } return null; })(last);
            if (sc) { sc.scrollTop = sc.scrollHeight; await new Promise(r => setTimeout(r, 300)); b = last.getBoundingClientRect().bottom; } }
          return { bas: Math.round(b), barre: Math.round(top) }; }""")
        check(f"téléphone {theme} : la dernière ligne se ramène au-dessus de la barre du bas en défilant", fin and fin["bas"] <= fin["barre"] + 1, fin)
        page.evaluate("() => { const l = document.querySelector('[data-testid=sound-library]'); l && l.scrollIntoView({ block: 'start' }); }"); page.wait_for_timeout(300)
        if theme == "light": audit_clair(page, "téléphone · page Sons")
        page.locator("[data-testid=sounds-tab-palette]").locator("visible=true").first.tap(); page.wait_for_timeout(600)
        n = page.locator("[data-testid=palette-list] [data-testid=sound-row]").locator("visible=true").count()
        check(f"téléphone {theme} : Palette au doigt (4 boucles)", n == 4, n)
        shot(page, f"tel_{theme}_04_palette")
        nd = page.evaluate(NO_DL_JS, "[data-testid=sound-library]")
        check(f"téléphone {theme} : rien à télécharger, aucun glisser (téléphone)", nd["links"] == 0 and not nd["dlBtns"] and not nd["urls"] and nd["drag"] == 0, nd)
    page.evaluate(SET_SIMPLE, True); page.wait_for_timeout(300)
    errs = [e for e in log.errors() if "favicon" not in e["text"]]
    check(f"téléphone {theme} : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


f = OUT / "seance_sons_beat.zip"
make_project(f)
with sync_playwright() as p:
    b = launch(p)
    try:
        for th in ("dark", "light"):
            desktop(b, f, th)
        for th in ("dark", "light"):
            phone(b, f, th)
    finally:
        b.close()

res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "sons_beat.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
