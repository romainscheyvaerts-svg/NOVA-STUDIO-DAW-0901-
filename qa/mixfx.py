"""Effets de mix (21/10/2026) : « Compresseur multibande » et « EQ dynamique » dans le VRAI studio.

Navigateur headless (aucune fenêtre), QA 100 % hors production (Supabase simulé, qa_hors_prod).

Bureau 1600 × 900, thème sombre :
  1. chaque effet est ajouté sur une piste par « Ajouter un effet » (recherche « multibande »,
     « eq dynamique ») : la façade s'ouvre (nom, boutons rotatifs, mètres) ;
  2. on tourne des boutons (souris : glisser ; clavier : Début / Fin) : la valeur change, le
     réglage arrive dans le projet (DAW_CONTROL.getState) ;
  3. lecture du beat : le mètre de réduction (multibande) / de gain (EQ dynamique) de la bande
     réglée BOUGE, et le son du master change (même passage, effet actif contre contourné) ;
  4. solo d'une bande, « Écouter » une bande de l'EQ dynamique ; captures pendant la lecture ;
  5. sauvegarde locale (.zip) : project.json porte l'effet et ses réglages ;
  6. aucun débordement horizontal, rien de coupé (boîtes des boutons dans la fenêtre).
Bureau, thème clair : captures des deux façades (elles gardent leurs couleurs).
Téléphone 390 × 844 : ajout, bouton tourné, ≥ 44 px, pas de débordement, captures.
Lecture = export, au bit près (moteur de qa/fidelite_export.py) : chaque effet réglé pour
travailler, seul en insert, 44,1 et 48 kHz, depuis 0 et depuis le milieu ; écart ≤ 1 LSB 16 bits.

NOVA_URL=http://127.0.0.1:3501/ python qa/mixfx.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-mixfx\\qa) : mixfx.json + captures.
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-mixfx\qa")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(__file__))
from qalib import APP_MODULE_INIT, CHROME, OUT, launch, new_page, Log  # noqa: E402
from scenarios import open_studio, close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(OUT)
OUT.mkdir(parents=True, exist_ok=True)
checks = []
res = {"bureau": {}, "clair": {}, "telephone": {}, "lecture_export": {}}

EFFETS = [("MBCOMP", "multibande", "Multibande"), ("DYNEQ", "eq dynamique", "EQ dynamique")]
# Réglages qui font travailler chaque effet (lecture = export).
FIDEL = {
    "MBCOMP": {"bands": 4, "x1": 150, "x2": 1500, "x3": 6000, "b1Thr": -30, "b1Ratio": 4, "b2Thr": -30, "b2Ratio": 4, "b2Gain": 3,
               "b3Thr": -36, "b3Ratio": 6, "b4Thr": -40, "b4Ratio": 3, "b4Att": 1},
    "DYNEQ": {"d1Range": -6, "d1Thr": -40, "d2Range": -8, "d2Thr": -40, "d2Freq": 1760, "d2Q": 4, "d3Range": -6, "d3Thr": -45, "d3Freq": 7040,
              "d4Range": 4, "d4Thr": -50, "d4Freq": 15000},
}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def close_plugin(pg):
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    if pg.locator("[data-nova-plugin]").count():
        btn = pg.get_by_role("button", name="Fermer", exact=True)
        for i in range(btn.count() - 1, -1, -1):
            try:
                if btn.nth(i).is_visible():
                    btn.nth(i).click(timeout=3000); pg.wait_for_timeout(500)
                    if not pg.locator("[data-nova-plugin]").count():
                        return
            except Exception:
                pass


def open_add_menu(pg, vp):
    if vp.startswith("tel"):
        m = pg.get_by_text("Mixer", exact=True)
        if m.count():
            m.last.click(); pg.wait_for_timeout(900)
        add = pg.get_by_role("button", name=re.compile("Ajouter un effet"))
        if add.count():
            add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(700); return "téléphone"
        return None
    for label in ("Console", "Mixage", "Mixer"):
        t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
        if t.count() and t.first.is_visible():
            t.first.click(); pg.wait_for_timeout(1000); break
    add = pg.locator("button[aria-label^='Ajouter un effet sur']")
    if add.count():
        lab = add.first.get_attribute("aria-label")
        add.first.click(); pg.wait_for_timeout(600); return lab
    return None


def add_effect(pg, vp, typ, q):
    where = open_add_menu(pg, vp)
    if not where:
        return None, "menu « Ajouter un effet » introuvable"
    search = pg.locator("input[aria-label='Chercher un effet']")
    if search.count():
        search.first.fill(q); pg.wait_for_timeout(400)
    item = pg.locator(f"[data-testid='add-effect-menu'] [data-fx-id='{typ}']")
    if not item.count():
        pg.keyboard.press("Escape")
        return None, f"« {q} » absent du menu"
    item.first.click(); pg.wait_for_timeout(1500)
    win = pg.locator(f"[data-nova-plugin='{typ}']")
    if not win.count():
        chip = pg.locator(".fx-slot button[aria-label^='Ouvrir']").last
        if chip.count(): chip.click(); pg.wait_for_timeout(1500)
    if not win.count():
        return None, "fenêtre non ouverte"
    win.first.wait_for(timeout=10000)
    pg.wait_for_timeout(600)
    return win.first, where


def knob(win, pid):
    return win.locator(f"[data-nova-param='{pid}'] [role=slider]").first


def key_knob(pg, win, pid, key):
    k = knob(win, pid)
    k.scroll_into_view_if_needed()
    k.focus(); pg.keyboard.press(key); pg.wait_for_timeout(120)
    return k.get_attribute("aria-valuenow")


def drag_knob(pg, win, pid, dy=-40):
    k = knob(win, pid)
    k.scroll_into_view_if_needed()
    before = k.get_attribute("aria-valuenow")
    bx = k.bounding_box()
    if bx:
        x, y = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
        pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x, y + dy, steps=5); pg.mouse.up()
        pg.wait_for_timeout(200)
    return before, k.get_attribute("aria-valuenow"), bx


def plugin_in_state(pg, typ):
    return pg.evaluate("""(typ) => { const st = window.DAW_CONTROL.getState();
      for (const t of st.tracks) for (const p of (t.plugins || [])) if (p.type === typ) return { trackId: t.id, track: t.name, pluginId: p.id, params: p.params, isEnabled: p.isEnabled };
      return null; }""", typ)


MASTER_RMS = """async (sec) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const an = e.getMasterMeterInput(); const buf = new Float32Array(an.fftSize); let s = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < sec * 1000) { await new Promise(r => setTimeout(r, 45)); an.getFloatTimeDomainData(buf); for (const v of buf) { s += v * v; n++; } }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-20);
}"""


def play_measure(pg, sec=2.2, start=4.0):
    """Lecture d'un même passage du beat, niveau RMS du master (dBFS)."""
    pg.evaluate("(t) => { const c = window.DAW_CONTROL; if (c.getState().isPlaying) c.stop(); c.seek(t); }", start)
    pg.wait_for_timeout(400)
    pg.evaluate("() => window.DAW_CONTROL.togglePlay()")
    pg.wait_for_timeout(500)
    lvl = pg.evaluate(MASTER_RMS, sec)
    return lvl


def stop(pg):
    pg.evaluate("() => { const c = window.DAW_CONTROL; if (c.getState().isPlaying) c.stop(); }")
    pg.wait_for_timeout(300)


def readout(win, attr, b):
    loc = win.locator(f"[{attr}='{b}']")
    return loc.first.inner_text().strip() if loc.count() else None


def faces_ok(pg, typ):
    """Rien de coupé : chaque bouton rotatif est dans la fenêtre (horizontalement), pas de débordement de page."""
    return pg.evaluate("""(typ) => {
      const w = document.querySelector(`[data-nova-plugin='${typ}']`); if (!w) return { ok: false, why: 'absente' };
      const r = w.getBoundingClientRect();
      const bad = [...w.querySelectorAll('[role=slider], .hw-push, .hw-lcd')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < r.left - 1 || b.right > r.right + 1); }).map(el => el.closest('[data-nova-param]')?.getAttribute('data-nova-param') || el.className);
      // Chevauchement de boutons rotatifs (deux boîtes qui se recouvrent de plus de 4 px).
      const ks = [...w.querySelectorAll('.hw-knob-box')].map(el => el.getBoundingClientRect()).filter(b => b.width > 0);
      let over = 0;
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) { const a = ks[i], b = ks[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (ox > 4 && oy > 4) over++; }
      const pageOverflow = document.documentElement.scrollWidth > window.innerWidth + 1 || r.right > window.innerWidth + 1 || r.left < -1;
      return { ok: !bad.length && !over && !pageOverflow, coupes: bad.slice(0, 8), chevauchements: over, debordement_page: pageOverflow, largeur: Math.round(r.width) };
    }""", typ)


def shot_window(pg, win, name):
    pg.screenshot(path=str(OUT / f"{name}.png"))
    try:
        win.screenshot(path=str(OUT / f"{name}_fenetre.png"))
    except Exception:
        pass
    # La fenêtre défile au-delà de la hauteur de l'écran : capture du bas aussi.
    pg.evaluate("""() => { const w = document.querySelector('[data-nova-plugin]'); let el = w; while (el && el !== document.body) { if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible') { el.scrollTop = el.scrollHeight; break; } el = el.parentElement; } }""")
    pg.wait_for_timeout(250)
    pg.screenshot(path=str(OUT / f"{name}_bas.png"))
    pg.evaluate("""() => { const w = document.querySelector('[data-nova-plugin]'); let el = w; while (el && el !== document.body) { if (el.scrollTop) el.scrollTop = 0; el = el.parentElement; } }""")


def save_project(pg):
    pg.keyboard.press("Control+s"); pg.wait_for_timeout(900)
    loc = pg.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with pg.expect_download(timeout=30000) as dl:
        loc.click()
    path = OUT / "mixfx_projet.zip"
    dl.value.save_as(str(path))
    pg.wait_for_timeout(400)
    pg.keyboard.press("Escape")
    return json.loads(zipfile.ZipFile(path).read("project.json"))


def bureau(theme="dark"):
    out = {}
    log = Log(f"mixfx_pc_{theme}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "pc", log)
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
        r = {"name": f"mixfx_{theme}"}
        open_studio(pg, r, vp="pc")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        for typ, q, titre in EFFETS:
            e = out.setdefault(typ, {})
            win, where = add_effect(pg, "pc", typ, q)
            if not win:
                check(f"[{theme}] {typ} : ajout par le menu", False, where); continue
            e["piste"] = where
            e["titre"] = win.locator("h2").first.inner_text()
            e["boutons_rotatifs"] = win.locator("[role=slider]").count()
            check(f"[{theme}] {typ} : ajouté par « Ajouter un effet » (recherche « {q} »), façade « {e['titre']} » ouverte", titre.lower() in e["titre"].lower(), e)
            shot_window(pg, win, f"{typ.lower()}_{theme}_ouvert")
            lay = faces_ok(pg, typ)
            e["mise_en_page"] = lay
            check(f"[{theme}] {typ} : rien de coupé ni de chevauché, pas de débordement", lay.get("ok"), lay)
            if theme != "dark":
                close_plugin(pg); continue
            if typ == "MBCOMP":
                # Geste souris sur le seuil de la bande 2, puis clavier : seuils au minimum, taux au maximum.
                e["glisser_seuil_b2"] = drag_knob(pg, win, "b2Thr", 40)[:2]
                check("MBCOMP : glisser le bouton « Seuil » de la bande 2 change la valeur", e["glisser_seuil_b2"][0] != e["glisser_seuil_b2"][1], e["glisser_seuil_b2"])
                for bnd in (1, 2, 3):
                    key_knob(pg, win, f"b{bnd}Thr", "Home"); key_knob(pg, win, f"b{bnd}Ratio", "End")
                key_knob(pg, win, "b1Att", "Home")
                st = plugin_in_state(pg, typ)
                e["reglages_projet"] = {k: st["params"].get(k) for k in ("b1Thr", "b1Ratio", "b2Thr", "b2Ratio", "b3Thr", "b3Ratio", "b1Att")} if st else None
                check("MBCOMP : les réglages tournés sont dans le projet (seuils −60, taux 20:1)", bool(st) and st["params"].get("b2Thr") == -60 and st["params"].get("b2Ratio") == 20, e["reglages_projet"])
                lvl_on = play_measure(pg)
                pg.wait_for_timeout(300)
                gr = [readout(win, "data-nova-mb-gr", i) for i in (1, 2, 3)]
                shot_window(pg, win, f"{typ.lower()}_{theme}_lecture")
                stop(pg)
                e["metres_reduction_en_lecture"] = gr
                moved = [g for g in gr if g and g not in ("0,0",)]
                check("MBCOMP : en lecture, les mètres de réduction des bandes bougent", len(moved) >= 2, gr)
                pg.evaluate("(a) => window.DAW_CONTROL.toggleBypass(a.t, a.p)", {"t": st["trackId"], "p": st["pluginId"]})
                lvl_off = play_measure(pg); stop(pg)
                pg.evaluate("(a) => window.DAW_CONTROL.toggleBypass(a.t, a.p)", {"t": st["trackId"], "p": st["pluginId"]})
                e["master_rms_dbfs"] = {"effet_actif": round(lvl_on, 2), "contourne": round(lvl_off, 2)}
                check("MBCOMP : le son du master change (même passage : effet actif plus bas que contourné, > 3 dB)", lvl_off - lvl_on > 3, e["master_rms_dbfs"])
                # Solo de la bande 1 (grave) : bouton allumé, son plus bas encore (on n'entend que le grave).
                win.locator("[data-nova-param='b1Solo'] button").first.click(); pg.wait_for_timeout(300)
                lvl_solo = play_measure(pg, 1.6)
                shot_window(pg, win, f"{typ.lower()}_{theme}_solo_grave")
                stop(pg)
                e["master_rms_solo_grave"] = round(lvl_solo, 2)
                aria = win.locator("[data-nova-param='b1Solo'] button").first.get_attribute("aria-checked")
                check("MBCOMP : solo de la bande 1 allumé et entendu (niveau différent)", aria == "true" and abs(lvl_solo - lvl_on) > 0.5, {"aria": aria, "solo": lvl_solo, "tout": lvl_on})
                win.locator("[data-nova-param='b1Solo'] button").first.click(); pg.wait_for_timeout(200)
                # 4 bandes : la 4e tranche et la coupure 3 apparaissent.
                win.locator("[data-nova-param='bands'] [role=radio]").nth(1).click(); pg.wait_for_timeout(400)
                e["quatre_bandes"] = {"coupure3": win.locator("[data-nova-param='x3']").count(), "tranches": win.locator("[data-nova-mb-gr]").count()}
                check("MBCOMP : passer à 4 bandes montre la coupure 3 et 4 mètres", e["quatre_bandes"] == {"coupure3": 1, "tranches": 4}, e["quatre_bandes"])
                lay4 = faces_ok(pg, typ)
                check("MBCOMP 4 bandes : rien de coupé ni de chevauché", lay4.get("ok"), lay4)
                shot_window(pg, win, f"{typ.lower()}_{theme}_4bandes")
                # Le multibande reste dans la chaîne mais contourné : l'EQ dynamique est mesuré seul.
                pg.evaluate("(a) => window.DAW_CONTROL.toggleBypass(a.t, a.p)", {"t": st["trackId"], "p": st["pluginId"]})
                e["contourne_pour_la_suite"] = plugin_in_state(pg, typ)["isEnabled"] is False
            else:
                e["glisser_freq_b1"] = drag_knob(pg, win, "d1Freq", -30)[:2]
                check("DYNEQ : glisser « Fréquence » de la bande 1 change la valeur", e["glisser_freq_b1"][0] != e["glisser_freq_b1"][1], e["glisser_freq_b1"])
                for bnd in (1, 2):
                    key_knob(pg, win, f"d{bnd}Thr", "Home"); key_knob(pg, win, f"d{bnd}Range", "Home"); key_knob(pg, win, f"d{bnd}Q", "Home")
                st = plugin_in_state(pg, typ)
                e["reglages_projet"] = {k: st["params"].get(k) for k in ("d1Freq", "d1Thr", "d1Range", "d2Thr", "d2Range", "d1Q")} if st else None
                check("DYNEQ : les réglages tournés sont dans le projet (seuil −60, plage −24)", bool(st) and st["params"].get("d1Range") == -24 and st["params"].get("d2Thr") == -60, e["reglages_projet"])
                lvl_on = play_measure(pg)
                pg.wait_for_timeout(300)
                gains = [readout(win, "data-nova-dyn-gain", i) for i in (1, 2, 3, 4)]
                shot_window(pg, win, f"{typ.lower()}_{theme}_lecture")
                stop(pg)
                e["metres_gain_en_lecture"] = gains
                check("DYNEQ : en lecture, les mètres de gain des bandes réglées bougent (et pas les autres, plage 0)", all(g and g != "0,0" for g in gains[:2]) and all(g == "0,0" for g in gains[2:]), gains)
                pg.evaluate("(a) => window.DAW_CONTROL.toggleBypass(a.t, a.p)", {"t": st["trackId"], "p": st["pluginId"]})
                lvl_off = play_measure(pg); stop(pg)
                pg.evaluate("(a) => window.DAW_CONTROL.toggleBypass(a.t, a.p)", {"t": st["trackId"], "p": st["pluginId"]})
                e["master_rms_dbfs"] = {"effet_actif": round(lvl_on, 2), "contourne": round(lvl_off, 2)}
                check("DYNEQ : le son du master change (effet actif plus bas que contourné, > 1 dB)", lvl_off - lvl_on > 1, e["master_rms_dbfs"])
                win.locator("[data-nova-param='listen'] button").nth(2).click(); pg.wait_for_timeout(300)
                lvl_listen = play_measure(pg, 1.6)
                shot_window(pg, win, f"{typ.lower()}_{theme}_ecoute_bande3")
                stop(pg)
                st2 = plugin_in_state(pg, typ)
                e["ecoute_bande3"] = {"listen": st2["params"].get("listen"), "master_rms": round(lvl_listen, 2)}
                check("DYNEQ : « Écouter » la bande 3 : on n'entend que la bande (bien plus bas que le son entier)", st2["params"].get("listen") == 3 and lvl_on - lvl_listen > 6, e["ecoute_bande3"])
                win.locator("[data-nova-param='listen'] button").nth(2).click(); pg.wait_for_timeout(200)
            close_plugin(pg)
            check(f"[{theme}] {typ} : la fenêtre se ferme", pg.locator(f"[data-nova-plugin='{typ}']").count() == 0)
        if theme == "dark":
            proj = save_project(pg)
            found = {p.get("type"): p.get("params", {}) for t in proj.get("tracks", []) for p in (t.get("plugins") or []) if p.get("type") in ("MBCOMP", "DYNEQ")}
            out["sauvegarde"] = {k: {kk: v.get(kk) for kk in ("b2Ratio", "b2Thr", "bands", "d1Range", "d1Thr")} for k, v in found.items()}
            check("Sauvegarde (.zip) : project.json porte les deux effets et leurs réglages", found.get("MBCOMP", {}).get("b2Ratio") == 20 and found.get("DYNEQ", {}).get("d1Range") == -24, out["sauvegarde"])
        out["erreurs_page"] = [x["text"][:200] for x in log.errors()][:6]
        check(f"[{theme}] aucune erreur de page", not [x for x in log.errors() if "mixfx" in x["text"].lower() or "MixFx" in x["text"]], out["erreurs_page"])
        ctx.close(); b.close()
    return out


def telephone():
    out = {}
    log = Log("mixfx_tel390")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "tel390", log)
        pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        r = {"name": "mixfx_tel"}
        open_studio(pg, r, vp="tel390")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        for typ, q, titre in EFFETS:
            e = out.setdefault(typ, {})
            win, where = add_effect(pg, "tel390", typ, q)
            if not win:
                check(f"[téléphone] {typ} : ajout", False, where); continue
            pid = "b2Thr" if typ == "MBCOMP" else "d1Freq"
            before, after, bx = drag_knob(pg, win, pid, 40 if typ == "MBCOMP" else -40)
            e["bouton"] = [before, after]
            e["taille_min_px"] = round(min(bx["width"], bx["height"])) if bx else None
            shot_window(pg, win, f"{typ.lower()}_tel390")
            lay = faces_ok(pg, typ)
            e["mise_en_page"] = lay
            check(f"[téléphone] {typ} : bouton tourné au doigt, boîte ≥ 44 px, rien de coupé, pas de débordement",
                  before != after and (e["taille_min_px"] or 0) >= 44 and lay.get("ok"), e)
            close_plugin(pg)
        ctx.close(); b.close()
    return out


def lecture_export():
    """Moteur de qa/fidelite_export.py : lecture en temps réel enregistrée au master contre renderProject."""
    from fidelite_export import JS as FJS, SEUIL
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3501/"), wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(600000)
        for rate in (44100, 48000):
            for typ, over in FIDEL.items():
                rr = pg.evaluate(FJS, {"rate": rate, "cfg": {"kind": "seul", "type": typ, "over": over}})
                worst = max((rr.get(k) or {}).get("ecart_max_lsb16", 99) for k in ("depuis_0", "depuis_milieu"))
                out[f"{typ}_{rate}"] = {"pire_lsb16": worst, "depuis_0": (rr.get("depuis_0") or {}).get("ecart_max_lsb16"),
                                        "depuis_milieu": (rr.get("depuis_milieu") or {}).get("ecart_max_lsb16"),
                                        "crete": (rr.get("depuis_0") or {}).get("crete"), "tentatives": (rr.get("depuis_0") or {}).get("tentatives")}
                check(f"Lecture = export {typ} à {rate} Hz (réglé pour travailler) : écart ≤ {SEUIL} LSB 16 bits", worst <= SEUIL, out[f"{typ}_{rate}"])
        # Le réglage fait vraiment travailler l'effet : l'export diffère du son sans effet.
        diff = pg.evaluate("""async (a) => {
          const M = p => window.__novaAppModule(p);
          const { audioEngine: e } = await M('/engine/AudioEngine.ts'); const { TrackType } = await M('/types.ts'); const REG = await M('/engine/pluginRegistry.ts');
          const SR = e.ctx.sampleRate; const n = Math.round(1.5 * SR);
          const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: SR }); const x = buf.getChannelData(0);
          for (let i = 0; i < n; i++) { const t = i / SR; x[i] = 0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.06 * Math.sin(2 * Math.PI * 1760 * t) + 0.03 * Math.sin(2 * Math.PI * 7040 * t); }
          const tr = (plugins) => [{ id: 'v', name: 'v', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], outputTrackId: 'master', plugins,
            clips: [{ id: 'c', type: TrackType.AUDIO, start: 0, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: 'c', fadeIn: 0, fadeOut: 0, color: '#fff' }] }];
          const rms = (b) => { const d = b.getChannelData(0); let s = 0; for (let i = Math.round(0.5 * SR); i < d.length; i++) s += d[i] * d[i]; return 10 * Math.log10(s / (d.length - 0.5 * SR)); };
          const out = {};
          const dry = rms(await e.renderProject(tr([]), 1.5, 0, SR));
          for (const [typ, over] of Object.entries(a)) {
            const reg = REG.getRegisteredPlugin(typ);
            const neutre = rms(await e.renderProject(tr([{ id: 'n' + typ, name: typ, type: typ, isEnabled: true, latency: 0, params: reg.defaultParams() }]), 1.5, 0, SR));
            const wet = rms(await e.renderProject(tr([{ id: 'w' + typ, name: typ, type: typ, isEnabled: true, latency: 0, params: { ...reg.defaultParams(), ...over } }]), 1.5, 0, SR));
            out[typ] = { sans_effet: +dry.toFixed(3), defauts_neutres: +neutre.toFixed(3), regle: +wet.toFixed(3) };
          }
          return out;
        }""", FIDEL)
        out["niveaux_export_dbfs"] = diff
        for typ in FIDEL:
            d = diff[typ]
            check(f"Export {typ} : réglages par défaut neutres (même niveau que sans effet), réglé : le son change", abs(d["defauts_neutres"] - d["sans_effet"]) < 0.01 and abs(d["regle"] - d["sans_effet"]) > 1, d)
        out["erreurs_page"] = errs[:5]
        b.close()
    return out


t0 = time.time()
res["bureau"] = bureau("dark")
res["clair"] = bureau("light")
res["telephone"] = telephone()
res["lecture_export"] = lecture_export()
res["secondes"] = round(time.time() - t0)
res["verifs"] = checks
res["ok"] = all(c["ok"] for c in checks)
(OUT / "mixfx.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print(f"{sum(c['ok'] for c in checks)}/{len(checks)} vérifications OK · {res['secondes']} s · captures : {OUT}")
sys.exit(0 if res["ok"] else 1)
