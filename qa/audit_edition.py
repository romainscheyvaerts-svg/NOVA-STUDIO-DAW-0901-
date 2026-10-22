"""Tour « édition et navigation » (22/10/2026) : chaque défaut corrigé, rejoué en vrai (headless, hors production).

Projets de banc (qa/audit_edition_lib) : 8 × 4, 6 × 3, 20 × 10 et 60 × 10 clips (600 clips), Supabase simulé,
bureau 1600 × 900, mode avancé. Vérifie :
  1. annuler : un glisser avec une pause = 1 étape ; deux commandes tapées en 60 ms = 2 étapes ;
  2. zoom : Z sans sélection = tout le morceau (et toutes les pistes) à l'écran, Z encore = retour ;
     Ctrl+molette jusqu'à l'échantillon (≥ 40 000 px/s) et jusqu'à 1 px/s ; Ctrl+← / Ctrl+→ zooment en
     gardant la tête de lecture au même pixel ; curseur de zoom nommé avec infobulle ;
  3. sélection de clips glissée vers la piste du dessous (un Ctrl+Z) ; S sans clip sélectionné coupe ;
  4. 60 pistes : Z = au moins 25 pistes entières à l'écran, aucun bouton d'en-tête recouvert ;
  5. suivi : 0 image de lecture avec la tête hors de l'écran ; Entrée / Fin / mesure suivante ramènent
     la vue ; ↓ ×15 garde la piste choisie à l'écran ;
  6. Ctrl+D ×3 = copies à la suite sans trou ; Ctrl+V sur la piste choisie ; Échap ferme le renommage ;
  7. clip tiré contre le bord droit : la vue défile ;
  8. couper / coller 3 clips : 18 → 15 → 18 ;
  9. Maj+clic étend la plage de temps sur les pistes traversées ;
 10. temps d'image en glissant un clip et en défilant sur 60 pistes / 600 clips (relevé).

NOVA_URL=http://127.0.0.1:3533/ python qa/audit_edition.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-audit-edition\\qa) : audit_edition.json + captures.
"""
import json, os, sys
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-audit-edition\qa")
sys.path.insert(0, str(Path(__file__).parent))
from audit_edition_lib import make_bench_project, open_project, st, GEO, FRAMES_START, FRAMES_STOP  # noqa: E402
from qalib import launch, new_page, Log, OUT, shot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

checks, mesures = [], {}
CAPTURE_ERREURS = r"""() => { const o = console.error; window.__novaErrs = []; console.error = (...a) => {
  window.__novaErrs.push(String(a[0]).slice(0, 160) + ' @@ ' + (new Error().stack || '').split('\n').slice(2, 14).join(' | ').slice(0, 1200)); o(...a); }; }"""


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


class Session:
    def __init__(self, browser, proj, label):
        self.log = Log(label)
        self.ctx, self.page = new_page(browser, "pc", self.log)
        open_project(self.page, proj)
        self.box = self.page.locator("[data-arrange-scroll]").first.bounding_box()
        self.hw = self.page.evaluate("() => document.querySelector('[data-track-header]').getBoundingClientRect().width")
        self.page.keyboard.press("1")
        # Pile d'appel des erreurs console (diagnostic en cas d'échec).
        self.page.evaluate(CAPTURE_ERREURS)

    def geo(self): return self.page.evaluate(GEO)
    def clips(self, tid): return st(self.page, f"s => s.tracks.find(t=>t.id==='{tid}').clips.map(c=>[c.id, +c.start.toFixed(3)]).sort((a,b)=>a[1]-b[1])")
    def ncl(self): return st(self.page, "s => s.tracks.reduce((a,t)=>a+t.clips.length,0)")
    def ph(self): return self.page.evaluate("async () => (await window.__novaAppModule('/utils/playheadStore.ts')).playheadStore.get()")
    def sel(self): return self.page.evaluate("async () => { const s = (await window.__novaAppModule('/utils/editSelection.ts')).editSelectionStore.get(); return { time: s.time && [+s.time.start.toFixed(2), +s.time.end.toFixed(2), s.time.trackIds], clips: s.clipIds }; }")
    def run(self, cmd, arg=None): return self.page.evaluate("async ([c,a]) => (await window.__novaAppModule('/utils/editCommands.ts')).runEditCommand(c, a)", [cmd, arg])

    def xy(self, tid, t, yf=0.75):
        g = self.geo(); h = self.page.locator(f'[data-track-header="{tid}"]').first.bounding_box()
        return self.box["x"] + self.hw + t * g["zoomH"] - g["scrollLeft"], h["y"] + h["height"] * yf

    def deselect(self, tid="t0", t=15):
        x, y = self.xy(tid, t); self.page.mouse.click(x, y); self.page.wait_for_timeout(150)

    def close(self):
        errs = self.log.errors()
        piles = self.page.evaluate("() => window.__novaErrs || []") if errs else []
        check(f"aucune erreur console ({self.log.name})", not errs, {"erreurs": errs[:3], "piles": piles[:2]})
        self.ctx.close()


def partie_8x4(b):
    s = Session(b, make_bench_project(OUT / "banc_8x4.zip", n_tracks=8, n_clips=10), "banc_8x10")
    p = s.page
    # 1. Annuler : glisser avec pause
    x, y = s.xy("t1", 3)
    p.mouse.move(x, y); p.mouse.down()
    for i in range(10): p.mouse.move(x + i * 8, y); p.wait_for_timeout(16)
    p.wait_for_timeout(600)
    for i in range(10, 20): p.mouse.move(x + i * 8, y); p.wait_for_timeout(16)
    p.mouse.up(); p.wait_for_timeout(300)
    moved = s.clips("t1")[0]
    s.deselect("t1", 15)
    p.keyboard.press("Control+z"); p.wait_for_timeout(300)
    check("annuler : glisser avec une pause de 600 ms = 1 Ctrl+Z", moved[1] > 0 and s.clips("t1")[0] == ["c1_0", 0], {"apres": moved, "ctrlz": s.clips("t1")[0]})
    # deux commandes rapides
    p.evaluate("() => window.DAW_CONTROL.seek(5)"); p.wait_for_timeout(150)
    x, y = s.xy("t2", 2); p.mouse.click(x, y); p.wait_for_timeout(200)
    n0 = len(s.clips("t2"))
    p.keyboard.press("s"); p.wait_for_timeout(60); p.keyboard.press("Control+d"); p.wait_for_timeout(300)
    n1 = len(s.clips("t2"))
    p.keyboard.press("Control+z"); p.wait_for_timeout(300)
    check("annuler : S puis Ctrl+D en 60 ms = 2 étapes", n1 == n0 + 2 and len(s.clips("t2")) == n0 + 1, [n0, n1, len(s.clips("t2"))])
    p.keyboard.press("Control+z"); p.wait_for_timeout(200)
    # 2. Zoom : Z sans sélection, retour
    s.deselect("t0", 15)
    g0 = s.geo()
    song = st(p, "s => Math.max(...s.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)))")
    p.keyboard.press("z"); p.wait_for_timeout(400)
    g = s.geo(); vw = s.box["width"] - s.hw
    check("Z sans sélection : tout le morceau à l'écran", song * g["zoomH"] - g["scrollLeft"] <= vw and g["scrollLeft"] == 0, {"fin_px": song * g["zoomH"], "vue": vw})
    shot(p, "audit_z_tout")
    p.keyboard.press("z"); p.wait_for_timeout(400)
    check("Z une 2e fois : retour à la vue d'avant", abs(s.geo()["zoomH"] - g0["zoomH"]) < 1e-6 and s.geo()["zoomV"] == g0["zoomV"], [g0, s.geo()])
    # Ctrl+molette aux bornes
    p.mouse.move(s.box["x"] + s.hw + 300, s.box["y"] + 200)
    p.keyboard.down("Control")
    for _ in range(80): p.mouse.wheel(0, -400); p.wait_for_timeout(12)
    p.keyboard.up("Control"); p.wait_for_timeout(400)
    zmax = s.geo()["zoomH"]
    shot(p, "audit_zoom_echantillon")
    p.keyboard.down("Control")
    for _ in range(120): p.mouse.wheel(0, 400); p.wait_for_timeout(12)
    p.keyboard.up("Control"); p.wait_for_timeout(400)
    zmin = s.geo()["zoomH"]
    mesures["zoom_bornes_px_s"] = [zmin, zmax]
    check("Ctrl+molette : jusqu'à l'échantillon (≥ 40 000 px/s) et jusqu'à ≤ 2 px/s", zmax >= 40000 and zmin <= 2, [zmin, zmax])
    # Ctrl+← / Ctrl+→ ancrés sur la tête de lecture
    p.evaluate("() => window.DAW_CONTROL.seek(40)"); p.wait_for_timeout(150)
    s.run("zoomPreset", 3); p.wait_for_timeout(300)
    g = s.geo(); p.evaluate("(x) => { document.querySelector('[data-arrange-scroll]').scrollLeft = x; }", 36 * g["zoomH"]); p.wait_for_timeout(300)
    g1 = s.geo(); p.keyboard.press("Control+ArrowLeft"); p.wait_for_timeout(300)
    g2 = s.geo(); p.keyboard.press("Control+ArrowRight"); p.keyboard.press("Control+ArrowRight"); p.wait_for_timeout(300)
    g3 = s.geo()
    xs = [round(40 * gg["zoomH"] - gg["scrollLeft"]) for gg in (g1, g2, g3)]
    mesures["zoom_clavier_tete_px"] = xs
    check("Ctrl+← / Ctrl+→ zooment et gardent la tête de lecture au même pixel", g2["zoomH"] < g1["zoomH"] < g3["zoomH"] and max(xs) - min(xs) <= 2, {"zooms": [g1["zoomH"], g2["zoomH"], g3["zoomH"]], "x": xs})
    sl = p.evaluate("() => { const s = document.querySelector('[data-testid=zoom-slider]'); return s && { title: s.title, aria: s.getAttribute('aria-label') }; }")
    check("curseur de zoom : nom et infobulle", bool(sl and sl["title"] and sl["aria"]), sl)
    # 3. Sélection multiple glissée vers la piste du dessous
    s.run("zoomPreset", 1); p.wait_for_timeout(300)
    p.evaluate("() => { const e = document.querySelector('[data-arrange-scroll]'); e.scrollLeft = 0; e.scrollTop = 0; }"); p.wait_for_timeout(200)
    x1, y1 = s.xy("t1", 2); x2, y2 = s.xy("t2", 22)
    p.mouse.click(x1, y1); p.keyboard.down("Shift"); p.mouse.click(x2, y2); p.keyboard.up("Shift"); p.wait_for_timeout(200)
    h6 = p.locator('[data-track-header="t3"]').first.bounding_box()
    p.mouse.move(x2, y2); p.mouse.down()
    for i in range(1, 15): p.mouse.move(x2 + i * 0.2, y2 + (h6["y"] + h6["height"] * 0.75 - y2) * i / 14); p.wait_for_timeout(16)
    p.mouse.up(); p.wait_for_timeout(300)
    on = lambda tid, cid: any(c[0] == cid for c in s.clips(tid))
    ok_move = on("t2", "c1_0") and on("t3", "c2_1") and not on("t1", "c1_0")
    s.deselect("t0", 15)
    p.keyboard.press("Control+z"); p.wait_for_timeout(300)
    check("sélection de 2 clips glissée d'une piste vers le bas (un Ctrl+Z la ramène)", ok_move and on("t1", "c1_0") and on("t2", "c2_1"), {"t1": s.clips("t1")[:3], "t2": s.clips("t2")[:3]})
    # S sans clip sélectionné
    p.locator('[data-track-header="t3"]').first.click(position={"x": 100, "y": 10}); p.wait_for_timeout(150)
    s.deselect("t3", 15)
    p.evaluate("() => window.DAW_CONTROL.seek(5)"); p.wait_for_timeout(200)
    n0 = len(s.clips("t3")); p.keyboard.press("s"); p.wait_for_timeout(300)
    check("S sans clip sélectionné : coupe le clip de la piste choisie sous la tête", len(s.clips("t3")) == n0 + 1, [n0, len(s.clips("t3"))])
    s.close()


def partie_suivi(b):
    s = Session(b, make_bench_project(OUT / "banc_20x10.zip", n_tracks=20, n_clips=10), "banc_20x10")
    p = s.page
    vw = s.box["width"] - s.hw
    phx = lambda: round(s.ph() * s.geo()["zoomH"] - s.geo()["scrollLeft"])
    p.evaluate("() => { document.querySelector('[data-arrange-scroll]').scrollLeft = 5000; }"); p.wait_for_timeout(200)
    s.deselect("t0", 135)
    p.keyboard.press("Enter"); p.wait_for_timeout(300)
    a = phx()
    p.keyboard.press("End"); p.wait_for_timeout(300)
    b2 = phx()
    p.keyboard.press("Home")
    for _ in range(30): p.keyboard.press(".")
    p.wait_for_timeout(300)
    c = phx()
    mesures["tete_x_apres_entree_fin_mesures"] = [a, b2, c]
    check("Entrée / Fin / mesure suivante : la tête de lecture reste à l'écran", all(0 <= v <= vw for v in (a, b2, c)), [a, b2, c, vw])
    p.locator('[data-track-header="t0"]').first.click(position={"x": 100, "y": 10}); p.wait_for_timeout(150)
    for _ in range(15): p.keyboard.press("ArrowDown"); p.wait_for_timeout(25)
    p.wait_for_timeout(300)
    vis = p.evaluate("""() => { const id = window.DAW_CONTROL.getState().selectedTrackId; const h = document.querySelector(`[data-track-header="${id}"]`);
      const sc = document.querySelector('[data-arrange-scroll]').getBoundingClientRect(); const r = h.getBoundingClientRect(); return { id, ok: r.top >= sc.top && r.bottom <= sc.bottom }; }""")
    check("↓ ×15 : la piste choisie reste à l'écran", vis["id"] == "t15" and vis["ok"], vis)
    # Lecture : tête jamais hors de l'écran
    p.evaluate("() => window.DAW_CONTROL.seek(28)"); p.wait_for_timeout(300)
    p.keyboard.press("Space")
    r = p.evaluate("""async (ms) => { const P = (await window.__novaAppModule('/utils/playheadStore.ts')).playheadStore;
      const sc = document.querySelector('[data-arrange-scroll]'); const hw = document.querySelector('[data-track-header]').getBoundingClientRect().width;
      const vis = sc.clientWidth - hw; const out = []; const t0 = performance.now();
      await new Promise(res => { const f = () => { out.push(P.get() * (+sc.dataset.zoomH) - sc.scrollLeft); if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      return { images: out.length, hors_ecran: out.filter(x => x > vis || x < 0).length }; }""", 9000)
    p.keyboard.press("Space"); p.wait_for_timeout(300)
    mesures["lecture_9s_images_tete_hors_ecran"] = r
    check("lecture 9 s : la tête de lecture ne sort jamais de l'écran", r["images"] > 100 and r["hors_ecran"] == 0, r)
    s.close()


def partie_6x3(b):
    s = Session(b, make_bench_project(OUT / "banc_6x3.zip", n_tracks=6, n_clips=3, clip_s=4, gap_s=16), "banc_6x3")
    p = s.page
    # 6. Ctrl+D ×3
    x, y = s.xy("t0", 1); p.mouse.click(x, y); p.wait_for_timeout(150)
    for _ in range(3): p.keyboard.press("Control+d"); p.wait_for_timeout(200)
    starts = [c[1] for c in s.clips("t0")]
    check("Ctrl+D ×3 : copies à la suite, sans trou (0, 4, 8, 12 s)", starts[:4] == [0, 4, 8, 12], starts)
    # Coller sur la piste choisie
    x, y = s.xy("t1", 1); p.mouse.click(x, y); p.wait_for_timeout(150)
    p.keyboard.press("Control+c")
    p.locator('[data-track-header="t3"]').first.click(position={"x": 100, "y": 10}); p.wait_for_timeout(150)
    p.evaluate("() => window.DAW_CONTROL.seek(10)"); p.wait_for_timeout(150)
    p.keyboard.press("Control+v"); p.wait_for_timeout(300)
    check("Ctrl+V : sur la piste choisie (clic sur son nom)", [c[1] for c in s.clips("t3")] == [0, 10, 20, 40], s.clips("t3"))
    # Échap pendant le renommage
    p.locator('[data-track-header="t2"] span[title="Piste 3"]').first.dblclick(); p.wait_for_timeout(150)
    p.keyboard.press("Control+a"); p.keyboard.type("Voix lead"); p.keyboard.press("Escape"); p.wait_for_timeout(300)
    opened = p.evaluate("() => !!document.querySelector('[data-track-header=\"t2\"] input')")
    check("renommer une piste puis Échap : ancien nom, champ fermé", not opened and st(p, "s => s.tracks.find(t=>t.id==='t2').name") == "Piste 3", opened)
    # 8. Couper / coller 3 clips
    p.keyboard.press("Control+z"); p.wait_for_timeout(200)
    p.keyboard.press("Control+z"); p.wait_for_timeout(200)
    n0 = s.ncl()
    p.evaluate("() => { document.querySelector('[data-arrange-scroll]').scrollLeft = 0; }"); p.wait_for_timeout(200)
    x, y = s.xy("t0", 21); p.mouse.click(x, y)
    p.keyboard.down("Shift")
    x, y = s.xy("t1", 21); p.mouse.click(x, y)
    x, y = s.xy("t2", 1); p.mouse.click(x, y)
    p.keyboard.up("Shift"); p.wait_for_timeout(200)
    p.keyboard.press("Control+x"); p.wait_for_timeout(300)
    n1 = s.ncl()
    p.locator('[data-track-header="t4"]').first.click(position={"x": 100, "y": 10}); p.wait_for_timeout(150)
    p.evaluate("() => window.DAW_CONTROL.seek(60)"); p.wait_for_timeout(150)
    p.keyboard.press("Control+v"); p.wait_for_timeout(300)
    n2 = s.ncl()
    mesures["couper_coller_3_clips"] = [n0, n1, n2]
    # c0_1 (20 s), c1_1 (20 s), c2_0 (0 s) collés à 60 s sur la piste 5 : 80 s sur t4 et t5, 60 s sur t4 (pas de 7e piste).
    t4s = [c[1] for c in s.clips("t4")]; t5s = [c[1] for c in s.clips("t5")]
    check("couper / coller 3 clips : tous reviennent, écarts et pistes gardés", n1 == n0 - 3 and n2 == n0 and 60 in t4s and 80 in t4s and 80 in t5s, {"n": [n0, n1, n2], "t4": t4s, "t5": t5s})
    # 9. Maj+clic : plage étendue
    p.keyboard.press("4")
    p.evaluate("() => { document.querySelector('[data-arrange-scroll]').scrollLeft = 0; }"); p.wait_for_timeout(200)
    x, y = s.xy("t0", 10); p.mouse.click(x, y); p.wait_for_timeout(150)
    p.keyboard.down("Shift"); x, y = s.xy("t2", 25); p.mouse.click(x, y); p.keyboard.up("Shift"); p.wait_for_timeout(200)
    sel = s.sel()
    check("Maj+clic (Sélecteur) : plage du clic précédent au Maj+clic, sur les pistes traversées", bool(sel["time"]) and sel["time"][0] == 10 and abs(sel["time"][1] - 25) < 0.7 and sel["time"][2] == ["t0", "t1", "t2"], sel)
    # 7. Bord droit : défilement automatique
    p.keyboard.press("1")
    p.evaluate("() => { document.querySelector('[data-arrange-scroll]').scrollLeft = 0; }"); p.wait_for_timeout(200)
    x, y = s.xy("t3", 1)
    p.mouse.move(x, y); p.mouse.down()
    edge = s.box["x"] + s.box["width"] - 8
    for i in range(1, 11): p.mouse.move(x + (edge - x) * i / 10, y); p.wait_for_timeout(16)
    for _ in range(40): p.mouse.move(edge, y); p.wait_for_timeout(25)
    sc = s.geo()["scrollLeft"]
    p.mouse.up(); p.wait_for_timeout(300)
    mesures["bord_droit_defilement_px"] = sc
    check("clip tiré contre le bord droit : la vue défile", sc > 800, sc)
    s.close()


def partie_60(b):
    s = Session(b, make_bench_project(OUT / "banc_60x10.zip"), "banc_60x10")
    p = s.page
    VIS = """() => { const sc = document.querySelector('[data-arrange-scroll]').getBoundingClientRect();
      const hs = [...document.querySelectorAll('[data-track-header]')].map(h => h.getBoundingClientRect());
      return hs.filter(r => r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1).length; }"""
    avant = p.evaluate(VIS)
    s.deselect("t0", 15)
    # Temps d'image (serveur de dev : relevé, pas de seuil)
    x, y = s.xy("t2", 2)
    p.mouse.move(x, y); p.mouse.down(); p.evaluate(FRAMES_START)
    for i in range(40): p.mouse.move(x + i * 3, y); p.wait_for_timeout(16)
    mesures["glisser_clip_60_pistes"] = p.evaluate(FRAMES_STOP)
    p.mouse.up(); p.wait_for_timeout(300); p.keyboard.press("Control+z"); p.wait_for_timeout(300)
    s.deselect("t0", 15)
    p.keyboard.press("z"); p.wait_for_timeout(500)
    apres = p.evaluate(VIS)
    mesures["pistes_entieres_a_l_ecran"] = [avant, apres]
    shot(p, "audit_60_pistes")
    check("60 pistes : Z montre au moins 25 pistes entières (avant : 5)", apres >= 25, [avant, apres])
    cover = p.evaluate("""() => [...document.querySelectorAll('[data-track-header] button')].filter(b => b.offsetParent !== null).map(b => {
      const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const sc = document.querySelector('[data-arrange-scroll]').getBoundingClientRect();
      if (y < sc.top || y > sc.bottom - 14) return null; const hit = document.elementFromPoint(x, y);
      return (hit === b || b.contains(hit)) ? null : (b.getAttribute('aria-label') || b.innerText); }).filter(Boolean)""")
    check("pistes Micro : aucun bouton d'en-tête recouvert", not cover, cover[:5])
    p.get_by_role("button", name="Muet : Piste 3").first.click(); p.wait_for_timeout(200)
    check("pistes Micro : M fonctionne", st(p, "s => s.tracks.find(t => t.id === 't2').isMuted"), None)
    p.evaluate(FRAMES_START)
    p.mouse.move(s.box["x"] + 900, s.box["y"] + 300)
    for _ in range(30): p.mouse.wheel(0, 120); p.wait_for_timeout(16)
    p.wait_for_timeout(200)
    mesures["defilement_60_pistes_micro"] = p.evaluate(FRAMES_STOP)
    s.close()


with sync_playwright() as pw:
    browser = launch(pw)
    for part in (partie_8x4, partie_suivi, partie_6x3, partie_60):
        try:
            part(browser)
        except Exception as ex:  # une partie qui casse ne cache pas les autres
            check(f"{part.__name__} sans exception", False, repr(ex)[:400])
    browser.close()

(OUT / "audit_edition.json").write_text(json.dumps({"verifs": checks, "mesures": mesures}, ensure_ascii=False, indent=1), encoding="utf-8")
ko = [c for c in checks if not c["ok"]]
print(f"\n{len(checks) - len(ko)}/{len(checks)} vérifications OK", flush=True)
print(json.dumps(mesures, ensure_ascii=False), flush=True)
sys.exit(1 if ko else 0)
