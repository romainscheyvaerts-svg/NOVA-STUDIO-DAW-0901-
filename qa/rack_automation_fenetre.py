"""Rack parallèle : écrire l'automation en touchant un bouton dans la fenêtre d'un effet d'une branche
(modes Latch / Touch, 22/10/2026), comme pour les autres effets — par la vraie application.

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le lancement).
Studio réel (beat de démo), mode complet :

  - « Ajouter un effet » → Rack parallèle sur la 1re piste ; « + Effet » branche 1 → Compresseur (sa fenêtre
    s'ouvre dans le rack) ;
  - piste en Latch : pendant la lecture, « Gain de compensation » monté au clavier dans la fenêtre de l'effet
    → voie « plugin::<rack>::<compresseur>/makeupGain » écrite (valeur d'avant puis valeur touchée, gardée
    jusqu'à l'arrêt), libellé « Rack parallèle · Branche 1 · Compresseur · Gain de compensation » ;
  - piste en Touch : « Seuil » tiré à la souris, tenu, relâché → la voie suit le geste puis revient à la
    valeur d'avant ; le moteur joue la valeur écrite pendant le geste ;
  - une passe = une étape d'annulation (Ctrl+Z retire la voie) ; aucune clé parasite dans les réglages du rack.

NOVA_URL=http://127.0.0.1:3526/ python qa/rack_automation_fenetre.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\rack_automation_fenetre")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from qalib import APP_MODULE_INIT, OUT, launch, new_page, Log, ouvrir_menu_range  # noqa: E402
from scenarios import open_studio, close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(OUT)
OUT.mkdir(parents=True, exist_ok=True)
checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:900]}"), flush=True)


def open_mixer(pg):
    for label in ("Console", "Mixage", "Mixer"):
        t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
        if t.count() and t.first.is_visible():
            t.first.click(); pg.wait_for_timeout(1000); return True
    return False


def add_rack(pg):
    open_mixer(pg)
    add = pg.locator("button[aria-label^='Ajouter un effet sur']")
    if not add.count():
        return None, "bouton « Ajouter un effet » introuvable"
    add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(600)
    search = pg.locator("input[aria-label='Chercher un effet']")
    if search.count():
        search.first.fill("rack"); pg.wait_for_timeout(400)
    item = pg.locator("[data-testid='add-effect-menu'] [data-fx-id='FXRACK']")
    if not item.count():
        pg.keyboard.press("Escape"); return None, "« rack » absent du menu"
    item.first.click(); pg.wait_for_timeout(1500)
    win = pg.locator("[data-nova-plugin='FXRACK']")
    if not win.count():
        return None, "fenêtre non ouverte"
    win.first.wait_for(timeout=10000); pg.wait_for_timeout(600)
    return win.first, add.first.get_attribute("aria-label")


STATE = """() => { const st = window.DAW_CONTROL.getState(); const out = [];
  for (const t of st.tracks) for (const p of (t.plugins || [])) if (p.type === 'FXRACK') out.push({ trackId: t.id, track: t.name, mode: t.automationMode || 'read',
    rackId: p.id, params: p.params, lanes: (t.automationLanes || []).map(l => ({ name: l.parameterName, points: (l.points || []).map(x => [x.time, x.value]) })) });
  return out[0] || null; }"""

LABEL = """async (a) => { const L = await window.__novaAppModule('/utils/automationLabels.ts');
  return L.automationParamLabel(a.param, window.DAW_CONTROL.getState().tracks); }"""

ENGINE_VALUE = """async (a) => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const n = e.getPluginNodeInstance(a.t, a.r); const c = n && n.childNode ? n.childNode(a.c) : null;
  if (!c) return null; let ap = null; try { ap = typeof c.automationParam === 'function' ? c.automationParam(a.k) : null; } catch (err) { ap = null; }
  if (ap && typeof ap.value === 'number') return ap.value;
  const p = typeof c.getParams === 'function' ? c.getParams() : c.params; return p ? p[a.k] : null; }"""


def set_mode(pg, track_id, label):
    ouvrir_menu_range(pg, f"[data-testid='automation-mode-{track_id}']", piste=track_id)  # « ⋯ » (barre allégée)
    btn = pg.locator(f"[data-testid='automation-mode-{track_id}']").locator("visible=true").first
    btn.scroll_into_view_if_needed(); btn.click(); pg.wait_for_timeout(300)
    pg.locator("[role=menu] [role=menuitemradio]").filter(has_text=re.compile(label, re.I)).first.click()
    pg.wait_for_timeout(300)


def at(points, t):
    """Valeur d'une voie à l'instant t (paliers / rampes linéaires, comme valueAtPoints)."""
    pts = sorted(points)
    if not pts:
        return None
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return v0 if t1 == t0 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return pts[-1][1]


def play(pg, on):
    playing = pg.evaluate("() => !!window.DAW_CONTROL.getState().isPlaying")
    if playing != on:
        pg.evaluate("() => window.DAW_CONTROL.togglePlay()")
    pg.wait_for_timeout(300)


def main():
    res = {}
    log = Log("rack_automation_fenetre")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "pc", log)
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', 'dark'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        r = {"name": "rack_automation_fenetre"}
        open_studio(pg, r, vp="pc")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        win, where = add_rack(pg)
        check("rack ajouté par « Ajouter un effet »", win is not None, where)
        if not win:
            b.close(); return finish(res, log)
        win.locator("[data-nova-rack-add-fx='1']").click(); pg.wait_for_timeout(300)
        win.locator(".hw-rack-menu [data-fx-id='COMPRESSOR']").click(); pg.wait_for_timeout(1500)
        child = win.locator("[data-nova-rack-child='COMPRESSOR']")
        st = pg.evaluate(STATE)
        comp = (st["params"]["branches"][0]["plugins"] or [{}])[0] if st else {}
        check("Compresseur dans la branche 1, sa fenêtre ouverte dans le rack", child.count() == 1 and comp.get("type") == "COMPRESSOR", {"fenetre": child.count(), "branche1": comp.get("type")})
        tid, rid, cid = st["trackId"], st["rackId"], comp.get("id")
        lane_mk = f"plugin::{rid}::{cid}/makeupGain"
        lane_th = f"plugin::{rid}::{cid}/threshold"
        mk0 = comp.get("params", {}).get("makeupGain")
        th0 = comp.get("params", {}).get("threshold")
        res["depart"] = {"piste": st["track"], "makeupGain": mk0, "threshold": th0}

        # ── Latch : « Gain de compensation » monté au clavier pendant la lecture ──
        set_mode(pg, tid, "Latch")
        st = pg.evaluate(STATE)
        check("piste en Latch", st["mode"] == "latch", st["mode"])
        play(pg, True)
        pg.wait_for_timeout(700)
        t_geste = pg.evaluate("() => window.DAW_CONTROL.getState().currentTime")
        k = child.locator("[data-nova-param='makeupGain'] [role=slider]").first
        k.scroll_into_view_if_needed(); k.focus()
        for _ in range(8):
            pg.keyboard.press("PageUp"); pg.wait_for_timeout(40)
        mk1 = float(k.get_attribute("aria-valuenow"))
        pg.wait_for_timeout(300)
        moteur = pg.evaluate(ENGINE_VALUE, {"t": tid, "r": rid, "c": cid, "k": "makeupGain"})
        pg.wait_for_timeout(900)
        t_stop = pg.evaluate("() => window.DAW_CONTROL.getState().currentTime")
        play(pg, False)
        pg.wait_for_timeout(800)
        st = pg.evaluate(STATE)
        lane = next((l for l in st["lanes"] if l["name"] == lane_mk), None)
        pts = lane["points"] if lane else []
        res["latch"] = {"geste_s": t_geste, "arret_s": t_stop, "valeur_touchee": mk1, "voie": lane_mk, "points": pts[:12], "nb_points": len(pts), "moteur_pendant": moteur}
        check("Latch : la voie « <rack>::<effet>/makeupGain » est écrite depuis la fenêtre de l'effet de la branche", lane is not None and len(pts) >= 2, res["latch"])
        if pts:
            check("Latch : avant le geste = valeur d'avant, après = valeur touchée gardée jusqu'à l'arrêt",
                  abs(at(pts, max(0.0, t_geste - 0.3)) - mk0) < 1e-6 and abs(at(pts, t_stop - 0.05) - mk1) < 1e-6 and mk1 != mk0, res["latch"])
        check("Latch : le moteur joue la valeur touchée dans l'effet de la branche pendant le geste",
              moteur is not None and abs(float(moteur) - mk1) < 1e-3, {"moteur": moteur, "touchee": mk1})
        lab = pg.evaluate(LABEL, {"param": lane_mk})
        res["libelle"] = lab
        check("libellé de la voie : « Rack parallèle · Branche 1 · Compresseur · Gain de compensation »",
              "Branche 1" in lab and "Compresseur" in lab and "Gain de compensation" in lab, lab)
        flat = [k2 for k2 in (st["params"] or {}) if "/" in k2]
        check("aucune clé « <effet>/<réglage> » à plat dans les réglages du rack", not flat, flat)

        # ── Une passe = une étape d'annulation ──
        pg.mouse.click(5, 300); pg.wait_for_timeout(200)
        pg.keyboard.press("Control+z"); pg.wait_for_timeout(700)
        st_u = pg.evaluate(STATE)
        gone = not any(l["name"] == lane_mk and l["points"] for l in st_u["lanes"])
        check("Ctrl+Z : la passe Latch s'annule en une étape (voie retirée)", gone, [l["name"] for l in st_u["lanes"]])
        pg.keyboard.press("Control+y"); pg.wait_for_timeout(700)
        st_r = pg.evaluate(STATE)
        check("Ctrl+Y : la passe revient", any(l["name"] == lane_mk and len(l["points"]) >= 2 for l in st_r["lanes"]), [l["name"] for l in st_r["lanes"]])

        # ── Touch : « Seuil » tiré à la souris, tenu, relâché ──
        set_mode(pg, tid, "Touch")
        if not pg.locator("[data-nova-rack-child='COMPRESSOR']").count():
            fx = pg.locator("[data-nova-plugin='FXRACK'] [data-nova-rack-fx='COMPRESSOR'] .hw-rack-fx-name").first
            if fx.count():
                fx.click(); pg.wait_for_timeout(800)
        child = pg.locator("[data-nova-rack-child='COMPRESSOR']")
        kt = child.locator("[data-nova-param='threshold'] [role=slider]").first
        kt.scroll_into_view_if_needed()
        box = kt.bounding_box()
        play(pg, True)
        pg.wait_for_timeout(600)
        t0 = pg.evaluate("() => window.DAW_CONTROL.getState().currentTime")
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pg.mouse.move(x, y); pg.mouse.down()
        for i in range(1, 11):
            pg.mouse.move(x, y - 6 * i); pg.wait_for_timeout(30)
        th1 = float(kt.get_attribute("aria-valuenow"))
        pg.wait_for_timeout(600)
        t_rel = pg.evaluate("() => window.DAW_CONTROL.getState().currentTime")
        pg.mouse.up()
        pg.wait_for_timeout(900)
        play(pg, False)
        pg.wait_for_timeout(800)
        st = pg.evaluate(STATE)
        lane = next((l for l in st["lanes"] if l["name"] == lane_th), None)
        pts = lane["points"] if lane else []
        res["touch"] = {"geste_s": t0, "relache_s": t_rel, "valeur_tenue": th1, "points": pts[:16], "nb_points": len(pts)}
        check("Touch : la voie « <rack>::<effet>/threshold » est écrite pendant le geste à la souris", lane is not None and len(pts) >= 2 and th1 != th0, res["touch"])
        if pts:
            check("Touch : pendant l'appui = valeur tenue ; avant et après le relâchement = valeur d'avant",
                  abs(at(pts, t_rel - 0.1) - th1) < 0.05 and abs(at(pts, max(0.0, t0 - 0.3)) - th0) < 1e-6 and abs(pts[-1][1] - th0) < 1e-6, res["touch"])
        st = pg.evaluate(STATE)
        comp = st["params"]["branches"][0]["plugins"][0]
        res["fin"] = {"mode": st["mode"], "reglages_effet": {k2: comp["params"].get(k2) for k2 in ("makeupGain", "threshold")}}
        flat = [k2 for k2 in (st["params"] or {}) if "/" in k2]
        check("toujours aucune clé parasite dans le rack après les passes", not flat, flat)
        pg.screenshot(path=str(OUT / "rack_automation_fenetre.png"))
        # Erreurs de la page (exceptions) et toute erreur liée au rack ou à l'automation.
        res["erreurs_page"] = [e["text"] for e in log.errors() if e["kind"] == "pageerror" or re.search(r"rack|automation", e["text"], re.I)][:5]
        check("aucune erreur de page liée au rack ou à l'automation", not res["erreurs_page"], res["erreurs_page"])
        b.close()
    return finish(res, log)


def finish(res, log):
    res["checks"] = checks
    res["ok"] = bool(checks) and all(c["ok"] for c in checks)
    (OUT / "rack_automation_fenetre.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", f"{sum(c['ok'] for c in checks)}/{len(checks)}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
