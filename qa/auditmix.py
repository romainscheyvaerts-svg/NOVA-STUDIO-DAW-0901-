"""Audit mix (22/10/2026) : une vraie séance de mix de 60 pistes dans la console, mesurée geste par geste.

Navigateur headless (aucune fenêtre), QA 100 % hors production (Supabase simulé), bureau 1600 × 900 sombre.
Séance : 60 pistes audio (Égaliseur + Compresseur sur chacune), 2 bus, 2 retours, master.

  1. console (Ctrl+=) : temps d'ouverture ; hauteur du fader (avant : 57 px) ; nom de la piste entier à
     l'écran ; images pendant le défilement de toute la console ;
  2. fader : glisser 30 px, Ctrl+glisser 30 px (réglage fin = 10× moins), Alt+clic = 0 dB, clic sur la
     valeur + « -6 » + Entrée = −6 dB ; pan : clic sur la valeur + « G 30 » ;
  3. bouton d'une façade (Compresseur) : taper « -24 » + Entrée sur le Seuil, Ctrl+glisser fin,
     Alt+clic = valeur d'origine ;
  4. « Ajouter un effet » : chercher + Entrée (ajout et fenêtre), puis « Récents » (2 clics), étoile
     → « Favoris » ; VST du PC (pont simulé dans la page) proposés dans le même menu, rangés par éditeur ;
  5. 10 fenêtres d'effet : Maj+clic sur 10 inserts → 10 fenêtres en cascade, la dernière devant ;
     clic sur une fenêtre de derrière = devant ; Échap ferme celle de devant ; Maj+Échap toutes ;
     punaise « Garder ouverte » ; le bas de la façade de l'Égaliseur atteignable (défilement) ;
  6. menu d'un insert : « Copier sur les pistes vers « Bus Voix » » (copie sur 10 pistes, Ctrl+Z) ;
  7. latence des effets affichée sur la tranche (EQ en phase linéaire) ;
  8. aucune erreur de page.

NOVA_URL=http://127.0.0.1:3534/ PYTHONIOENCODING=utf-8 python qa/auditmix.py [--avant]
  --avant : mesures seules (build d'avant les corrections), sans échec.
Sortie : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-auditmix) : auditmix[_avant].json + captures.
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-auditmix")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(__file__))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from projet_mix import make_mix_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

AVANT = "--avant" in sys.argv
TAG = "avant" if AVANT else "apres"
OUT = Path(OUT)
OUT.mkdir(parents=True, exist_ok=True)
checks, mesures = [], {}
EQ = {"type": "PROEQ12", "name": "Égaliseur", "isEnabled": True, "params": {}}
COMP = {"type": "COMPRESSOR", "name": "Compresseur", "isEnabled": True,
        "params": {"threshold": -30, "ratio": 4, "knee": 0, "attack": 0.005, "release": 0.1, "makeupGain": 1, "isEnabled": True}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def mesure(k, v):
    mesures[k] = v
    print(f"   · {k} = {v}", flush=True)


def projet(path):
    make_mix_project(path, 60, name="Mix 60")
    with zipfile.ZipFile(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    st = json.loads(files["project.json"])
    for t in st["tracks"]:
        if t["type"] == "AUDIO":
            t["plugins"] = [dict(EQ, id=f"eq-{t['id']}"), dict(COMP, id=f"comp-{t['id']}")]
    files["project.json"] = json.dumps(st).encode()
    with zipfile.ZipFile(path, "w") as z:
        for n, v in files.items():
            z.writestr(n, v)


def open_project(page, z):
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=90000); nouveau.click()
    page.wait_for_timeout(300); close_welcome(page)
    page.wait_for_function("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", timeout=60000)
    page.keyboard.press("Escape")
    b_open = page.locator("button[aria-label='Ouvrir un projet']").locator("visible=true")
    if b_open.count():
        b_open.first.click()
    else:
        page.locator("button[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(300)
        page.locator("[role=dialog][aria-label=Menu] button", has_text=re.compile("Ouvrir un projet")).first.click()
    page.get_by_role("button", name=re.compile("Fichier sur l.ordinateur")).first.click()
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(z))
    page.wait_for_function("() => window.__novaEdit && window.__novaEdit.getState().tracks.length >= 60", timeout=90000)
    page.get_by_text("Projet chargé").first.wait_for(timeout=60000)
    page.wait_for_timeout(1500)
    page.mouse.click(5, 300); page.keyboard.press("Escape")


def st(page, js):
    return page.evaluate(f"() => {{ const s = DAW_CONTROL.getState(); return {js}; }}")


def track(page, tid, key):
    return page.evaluate("([id, k]) => DAW_CONTROL.getState().tracks.find(t => t.id === id)[k]", [tid, key])


def windows(page):
    return page.evaluate("""() => {
      const w = [...document.querySelectorAll('[data-plugin-window]')];
      if (w.length) return w.map(e => { const b = e.querySelector('.nova-hosted-plugin, [data-plugin-body]')?.getBoundingClientRect();
        return { key: e.dataset.pluginWindow, front: e.dataset.pluginFront === '1', z: +getComputedStyle(e).zIndex, x: b ? Math.round(b.left) : null, y: b ? Math.round(b.top) : null }; });
      return [...document.querySelectorAll('.nova-hosted-plugin')].map(e => ({ key: '?', front: true }));
    }""")


def close_all_plugins(page):
    for _ in range(14):
        if not page.locator(".nova-hosted-plugin").count() and not page.locator("[data-plugin-window]").count():
            return
        page.mouse.click(5, 120)
        page.keyboard.press("Escape"); page.wait_for_timeout(250)


def drag(page, box, dy, mods=None):
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    for m in mods or []:
        page.keyboard.down(m)
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx, cy - dy, steps=6); page.mouse.up()
    for m in reversed(mods or []):
        page.keyboard.up(m)
    page.wait_for_timeout(150)


def run():
    z = OUT / "auditmix60.zip"
    projet(z)
    with sync_playwright() as p:
        b = launch(p)
        log = Log("auditmix")
        ctx, page = new_page(b, "pc", log=log)
        page.set_default_timeout(30000)
        page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); localStorage.removeItem('nova_fx_favoris'); localStorage.removeItem('nova_fx_recents'); } catch (e) {}")
        install_mocks(page, "romain", SUPERADMIN, {})
        open_project(page, z)

        # ── 1. Console ──
        t0 = time.time()
        page.keyboard.press("Control+Equal")
        page.wait_for_selector('[role=slider][aria-label="Volume Kick"]')
        page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
        mesure("console_ouverture_ms", round((time.time() - t0) * 1000))
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT / f"auditmix_{TAG}_01_console.png"))
        geo = page.evaluate("""() => {
          const s = document.querySelector('[data-strip-id=t0]');
          const fader = s.querySelector('[role=slider][aria-label="Volume Kick"]').getBoundingClientRect();
          const scroller = document.querySelector('[data-strip-id=master]').parentElement.getBoundingClientRect();
          const name = [...s.querySelectorAll('span')].find(x => x.textContent.trim() === 'Kick').getBoundingClientRect();
          return { fader_h: Math.round(fader.height), nom_bas: Math.round(name.bottom), console_bas: Math.round(scroller.bottom),
                   montees: document.querySelectorAll('[data-strip-mounted="1"]').length };
        }""")
        mesure("fader_hauteur_px", geo["fader_h"])
        mesure("nom_piste_visible", geo["nom_bas"] <= geo["console_bas"])
        check("console : fader d'au moins 150 px sur un écran de 900 px (avant : 57 px)", geo["fader_h"] >= 150, geo)
        check("console : nom de la piste entier à l'écran", geo["nom_bas"] <= geo["console_bas"], geo)
        fr = page.evaluate("""async () => { const s = document.querySelector('[data-strip-id=master]').parentElement; s.style.scrollSnapType = 'none';
          const fr = []; let l = performance.now();
          for (let x = 0; x <= s.scrollWidth; x += 160) { s.scrollLeft = x; await new Promise(r => requestAnimationFrame(r)); const t = performance.now(); fr.push(t - l); l = t; }
          s.scrollLeft = 0; s.style.scrollSnapType = ''; return fr.slice(2); }""")
        mesure("defilement_pire_image_ms", round(max(fr)) if fr else None)
        page.wait_for_timeout(500)

        # ── 2. Fader et pan ──
        vol = page.locator('[role=slider][aria-label="Volume Kick"]')
        box = vol.bounding_box()
        page.evaluate("() => DAW_CONTROL.updateTrack({ ...DAW_CONTROL.getState().tracks.find(t => t.id === 't0'), volume: 0.5 })")
        page.wait_for_timeout(200)
        v0 = track(page, "t0", "volume"); drag(page, box, 20); v1 = track(page, "t0", "volume")
        drag(page, box, 20, ["Control"]); v2 = track(page, "t0", "volume")
        d_norm, d_fin = abs(v1 - v0), abs(v2 - v1)
        mesure("fader_glisser_20px", round(d_norm, 4)); mesure("fader_ctrl_glisser_20px", round(d_fin, 4))
        check("fader : Ctrl+glisser = réglage fin (≥ 5× moins que glisser)", d_fin > 0 and d_norm / max(d_fin, 1e-9) >= 5, [v0, v1, v2])
        page.keyboard.down("Alt"); page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); page.keyboard.up("Alt")
        page.wait_for_timeout(200)
        v3 = track(page, "t0", "volume")
        mesure("fader_alt_clic", round(v3, 4))
        check("fader : Alt+clic = 0 dB", abs(v3 - 1) < 1e-6, v3)
        dbb = page.locator("[data-testid=fader-db-t0]")
        if dbb.count():
            dbb.click(); page.keyboard.press("Control+A"); page.keyboard.type("-6"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
        v4 = track(page, "t0", "volume")
        mesure("fader_saisie_-6", round(v4, 4))
        check("fader : clic sur la valeur, « -6 », Entrée = −6 dB", abs(v4 - 10 ** (-6 / 20)) < 1e-3, v4)
        pv = page.locator('[data-testid="knob-value-t0-pan"]')
        if pv.count():
            pv.click(); page.keyboard.press("Control+A"); page.keyboard.type("G 30"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
        pan = track(page, "t0", "pan")
        mesure("pan_saisie_G30", pan)
        check("pan : clic sur la valeur, « G 30 », Entrée", abs(pan + 0.3) < 1e-6, pan)
        page.keyboard.press("Control+z"); page.wait_for_timeout(200)

        # ── 3. Bouton d'une façade (Compresseur de la Kick) ──
        page.locator('[data-strip-id=t0] [data-fx-id="comp-t0"] button').first.click()
        page.wait_for_selector("[data-nova-param=threshold] .hw-knob-box", timeout=15000)
        page.wait_for_timeout(500)
        knob = page.locator("[data-nova-param=threshold] .hw-knob-box").first
        thr = lambda: page.evaluate("() => DAW_CONTROL.getState().tracks.find(t => t.id === 't0').plugins.find(p => p.id === 'comp-t0').params.threshold")
        knob.focus(); page.keyboard.type("-24"); page.keyboard.press("Enter"); page.wait_for_timeout(300)
        t_saisie = thr()
        mesure("facade_saisie_-24", t_saisie)
        check("façade : taper « -24 » + Entrée sur le Seuil", abs((t_saisie or 0) + 24) < 0.06, t_saisie)
        kb = knob.bounding_box()
        a0 = thr(); drag(page, kb, 20); a1 = thr(); drag(page, kb, 20, ["Control"]); a2 = thr()
        mesure("facade_glisser_20px_dB", round(abs(a1 - a0), 3)); mesure("facade_ctrl_glisser_20px_dB", round(abs(a2 - a1), 3))
        check("façade : Ctrl+glisser = réglage fin", abs(a2 - a1) > 0 and abs(a1 - a0) / max(abs(a2 - a1), 1e-9) >= 5, [a0, a1, a2])
        page.keyboard.down("Alt"); page.mouse.click(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2); page.keyboard.up("Alt"); page.wait_for_timeout(300)
        a3 = thr()
        mesure("facade_alt_clic", a3)
        check("façade : Alt+clic = valeur d'origine (−18 dB)", abs(a3 + 18) < 1e-6, a3)
        close_all_plugins(page)

        # ── 4. Ajouter un effet : recherche, récents, favoris, VST du PC ──
        def open_menu(name):
            page.get_by_role("button", name=f"Ajouter un effet sur {name}").first.click()
            page.wait_for_selector("[data-testid=add-effect-menu]")
        t0 = time.time()
        open_menu("Kick")
        mesure("menu_effets_ouverture_ms", round((time.time() - t0) * 1000))
        page.keyboard.type("chorus"); page.keyboard.press("Enter")
        page.wait_for_function("() => DAW_CONTROL.getState().tracks.find(t => t.id === 't0').plugins.some(p => p.type === 'CHORUS')", timeout=10000)
        check("menu : « chorus » + Entrée ajoute l'effet (1 clic + Entrée)", True)
        page.wait_for_timeout(600); close_all_plugins(page)
        open_menu("Snare")
        groups = page.locator("[data-testid=add-effect-menu] [role=group]").evaluate_all("e => e.map(x => x.getAttribute('aria-label'))")
        mesure("menu_rubriques_haut", groups[:3])
        rec = page.locator("[data-testid=add-effect-menu] [data-fx-quick=CHORUS]")
        check("menu : rubrique « Récents » en tête avec le Chorus", groups[:1] == ["Récents"] and rec.count() == 1, groups[:3])
        if rec.count():
            rec.click()
            page.wait_for_function("() => DAW_CONTROL.getState().tracks.find(t => t.id === 't1').plugins.some(p => p.type === 'CHORUS')", timeout=10000)
            mesure("clics_effet_recent", 2)
            page.wait_for_timeout(600); close_all_plugins(page)
            open_menu("Hi-hats")
            page.locator("[data-testid=add-effect-menu] [data-fx-star=DEESSER]").first.click()
            page.wait_for_timeout(200)
            g2 = page.locator("[data-testid=add-effect-menu] [role=group]").evaluate_all("e => e.map(x => x.getAttribute('aria-label'))")
            check("menu : étoile → « Favoris » en tête", g2[:1] == ["Favoris"], g2[:3])
            page.screenshot(path=str(OUT / f"auditmix_{TAG}_02_menu_favoris.png"))
            page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # VST du PC : pont simulé dans la page (liste de plugins), jamais le vrai pont.
        page.evaluate("""async () => {
          const { novaBridge } = await import('/services/NovaBridge.ts');
          const P = (name, vendor, extra = {}) => ({ id: name, name, vendor, category: 'Effect', path: `C:/VST3/${name}.vst3`, uid: name, ...extra });
          window.__qaVst = [P('C6 Stereo', 'Waves', { shell: 'WaveShell1', pluginName: 'C6 Stereo' }), P('C6 Mono', 'Waves', { shell: 'WaveShell1', pluginName: 'C6 Mono' }),
            P('Pro-Q 3', 'FabFilter'), P('Pro-C 2', 'FabFilter'), P('Serum', 'Xfer', { category: 'Instrument' })];
          novaBridge.isConnected = () => true; novaBridge.getCachedPlugins = () => window.__qaVst;
        }""")
        open_menu("Perc")
        page.keyboard.type("pro-q")
        vst = page.locator("[data-testid=add-effect-menu] [role=group]").evaluate_all("e => e.map(x => x.getAttribute('aria-label'))")
        mesure("menu_vst_rubriques", vst)
        check("menu : VST du PC proposés, rangés par éditeur (« VST · FabFilter »)", "VST · FabFilter" in vst, vst)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        # ── 5. Dix fenêtres d'effet ──
        close_all_plugins(page)
        ids = [("t%d" % i, "eq-t%d" % i) for i in range(5)] + [("t%d" % i, "comp-t%d" % i) for i in range(5)]
        # Clic (Maj+clic à partir de la 2e) sur l'insert, même s'il est sous une fenêtre déjà ouverte ;
        # temps jusqu'à la façade affichée, fenêtre par fenêtre.
        t0 = time.time()
        par_fenetre = []
        for k, (tid, pid) in enumerate(ids):
            t1 = time.time()
            page.locator(f'[data-strip-id={tid}] [data-fx-id="{pid}"] button').first.dispatch_event("click", {"shiftKey": bool(k), "bubbles": True})
            try:
                page.wait_for_function("(n) => document.querySelectorAll('.nova-hosted-plugin').length >= n", arg=k + 1 if not AVANT else 1, timeout=10000)
            except Exception:
                pass
            par_fenetre.append(round((time.time() - t1) * 1000))
        page.wait_for_timeout(500)
        mesure("dix_fenetres_ms", round((time.time() - t0) * 1000))
        mesure("ouverture_par_fenetre_ms", par_fenetre)
        w = windows(page)
        mesure("fenetres_ouvertes", len(w))
        page.screenshot(path=str(OUT / f"auditmix_{TAG}_03_dix_fenetres.png"))
        check("10 fenêtres d'effet ouvertes (Maj+clic)", len(w) == 10, len(w))
        pos = {(x["x"], x["y"]) for x in w if x.get("x") is not None}
        check("fenêtres en cascade (positions différentes)", len(pos) >= 8, sorted(pos))
        front = [x for x in w if x["front"]]
        check("la dernière ouverte est devant", len(front) == 1 and front[0]["key"] == "t4:comp-t4", front)
        if len(w) >= 2:
            # Clic sur la barre d'une fenêtre de derrière : elle passe devant.
            # Un point VISIBLE de la fenêtre de derrière (les fenêtres se chevauchent) : sa barre ou son bord.
            pt = page.evaluate("""() => { const w = document.querySelector('[data-plugin-window="t0:eq-t0"] .nova-hosted-plugin'); if (!w) return null;
              const r = w.parentElement.getBoundingClientRect();
              for (let y = r.top - 50; y < r.bottom; y += 6) for (let x = r.left + 4; x < r.right; x += 6) {
                const e = document.elementFromPoint(x, y); if (e && e.closest('[data-plugin-window]')?.dataset.pluginWindow === 't0:eq-t0' && !e.closest('button, [role=slider], input, canvas')) return [x, y]; }
              return null; }""")
            mesure("point_visible_fenetre_derriere", pt)
            if pt:
                page.mouse.click(pt[0], pt[1]); page.wait_for_timeout(300)
            f2 = [x["key"] for x in windows(page) if x["front"]]
            check("clic sur une fenêtre de derrière : elle passe devant", f2 == ["t0:eq-t0"], f2)
            page.mouse.click(5, 120)
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
            w3 = windows(page)
            check("Échap ferme seulement la fenêtre de devant", len(w3) == 9 and all(x["key"] != "t0:eq-t0" for x in w3), [x["key"] for x in w3])
            page.keyboard.press("Shift+Escape"); page.wait_for_timeout(400)
            check("Maj+Échap ferme toutes les fenêtres d'effet", len(windows(page)) == 0, len(windows(page)))
        # Punaise : la fenêtre reste, le prochain effet s'ouvre à côté.
        page.locator('[data-strip-id=t5] [data-fx-id="eq-t5"] button').first.click(); page.wait_for_timeout(500)
        pin = page.locator("[data-plugin-front='1'] [data-testid=plugin-keep]")
        if pin.count():
            pin.first.click(); page.wait_for_timeout(200)
            page.locator('[data-strip-id=t6] [data-fx-id="comp-t6"] button').first.click(); page.wait_for_timeout(500)
        check("punaise : la fenêtre gardée reste ouverte à côté de la suivante", len(windows(page)) == 2, len(windows(page)))
        # Bas de la façade de l'Égaliseur atteignable (écran de 900 px).
        body = page.evaluate("""() => { const e = document.querySelector('[data-plugin-window="t5:eq-t5"] .nova-hosted-plugin') || document.querySelector('.nova-hosted-plugin');
          if (!e) return null; const r = e.getBoundingClientRect(); e.scrollTop = e.scrollHeight;
          return { bas: Math.round(r.bottom), haut: Math.round(r.top), vh: innerHeight, defile: e.scrollHeight > e.clientHeight, contenu: e.scrollHeight }; }""")
        mesure("egaliseur_fenetre", body)
        # Barre de transport libre pendant qu'une fenêtre d'effet est ouverte (avant : la barre de la
        # fenêtre recouvrait Lecture / Stop / Boucle sur un écran de 900 px).
        libre = page.evaluate("""() => { const b = [...document.querySelectorAll('button[aria-label=Lecture], button[aria-label=Pause]')].find(x => x.getClientRects().length);
          if (!b) return null; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { libre: !!e && b.contains(e), dessus: e ? (e.closest('[data-plugin-window]') ? 'fenêtre d’effet' : e.tagName) : null }; }""")
        mesure("bouton_lecture_libre_fenetre_ouverte", libre)
        check("fenêtre d'effet ouverte : le bouton Lecture reste cliquable (barre sous le transport)", bool(libre) and libre["libre"], libre)
        check("fenêtre de l'Égaliseur : tient dans l'écran (barre comprise), le bas se lit en défilant", bool(body) and body["bas"] <= body["vh"] and body["haut"] - 56 >= 64, body)
        page.screenshot(path=str(OUT / f"auditmix_{TAG}_04_punaise.png"))
        page.keyboard.press("Shift+Escape"); page.wait_for_timeout(300); close_all_plugins(page)

        # ── 6. Copier un insert sur les pistes du bus ──
        page.locator('[data-strip-id=t8] [data-fx-id="comp-t8"]').first.click(button="right")
        page.wait_for_timeout(300)
        item = page.get_by_role("button", name=re.compile("Copier sur les pistes vers « Bus Voix »")).or_(page.get_by_role("menuitem", name=re.compile("Copier sur les pistes vers « Bus Voix »")))
        n_av = st(page, "s.tracks.filter(t => t.outputTrackId === 'bus-voix').reduce((a, t) => a + t.plugins.length, 0)")
        if item.count():
            item.first.click(); page.wait_for_timeout(400)
        n_ap = st(page, "s.tracks.filter(t => t.outputTrackId === 'bus-voix').reduce((a, t) => a + t.plugins.length, 0)")
        mesure("copie_bus_voix_inserts_ajoutes", n_ap - n_av)
        check("menu de l'insert : copie sur les 9 autres pistes du Bus Voix en 2 clics", n_ap - n_av == 9, [n_av, n_ap])
        page.keyboard.press("Escape")
        page.keyboard.press("Control+z"); page.wait_for_timeout(400)
        n_un = st(page, "s.tracks.filter(t => t.outputTrackId === 'bus-voix').reduce((a, t) => a + t.plugins.length, 0)")
        check("Ctrl+Z annule la copie en une fois", n_un == n_av, [n_av, n_un])

        # ── 7. Latence affichée (EQ 12 en phase linéaire sur la Kick) ──
        page.evaluate("() => DAW_CONTROL.updatePluginParams('t0', 'eq-t0', { phase: 'linear' })")
        page.evaluate("() => DAW_CONTROL.togglePlay()")
        page.wait_for_timeout(3000)
        lat = page.evaluate("() => { const e = document.querySelector('[data-strip-latency=t0]'); return e ? { texte: e.textContent, ech: +e.dataset.latencySamples } : null; }")
        mesure("latence_affichee_kick", lat)
        check("latence des effets affichée sur la tranche", bool(lat) and lat["ech"] > 0, lat)
        page.screenshot(path=str(OUT / f"auditmix_{TAG}_05_latence_lecture.png"), clip={"x": 0, "y": 60, "width": 800, "height": 200})
        page.evaluate("() => DAW_CONTROL.stop()")

        errs = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|59999|favicon", e["text"])]
        check("aucune erreur de page", not errs, errs[:5])
        ctx.close(); b.close()


try:
    run()
except Exception as ex:  # noqa: BLE001
    check("scénario terminé sans exception", False, repr(ex)[:400])
res = {"tag": TAG, "url": BASE, "mesures": mesures, "verifs": checks}
(OUT / f"auditmix{'_avant' if AVANT else ''}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
ko = [c for c in checks if not c["ok"]]
print(f"\n{len(checks) - len(ko)}/{len(checks)} vérifications OK ({TAG})")
sys.exit(0 if AVANT or not ko else 1)
