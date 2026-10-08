"""Profil de performance du studio (build de production, Chrome headless, aucune fenêtre).

Mesures (médiane de N essais, machine chargée : on relance avant de conclure) :
- démarrage : page → accueil interactif → « Nouveau projet » → studio prêt ; JS chargé (Ko) ;
- ouverture d'un projet de 40 pistes (.zip) ; mémoire JS (usedJSHeapSize) après ouverture ;
- arrangement de 40 pistes : défilement vertical (molette ×20) et zoom (Ctrl+] / Ctrl+[ ×6) :
  images par seconde, pire image, tâches longues (> 50 ms) ;
- lecture 4 s : tâches longues, images par seconde ;
- console de mixage (Ctrl+=) avec 40 pistes : temps d'affichage ;
- fenêtres : Exporter, Tempo, Master Nova, palette (Ctrl+K) : temps d'ouverture.

NOVA_URL=http://127.0.0.1:3492/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/perf_studio.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\perf\\perf_studio.json
"""
import json, os, re, statistics, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3492/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\perf")
RUNS = int(os.environ.get("PERF_RUNS", "3"))
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from projet_mix import make_mix_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

INIT = r"""
window.__perf = { long: [], frames: [] };
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
"""
FRAMES_START = r"""() => { const P = window.__perf; P.frames = []; P.long = []; P.on = true; let last = performance.now();
  const tick = (t) => { if (!P.on) return; P.frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; }"""
FRAMES_STOP = r"""() => { const P = window.__perf; P.on = false; const f = P.frames.slice(2); const tot = f.reduce((a, b) => a + b, 0);
  return { images: f.length, fps: f.length ? Math.round(1000 * f.length / tot) : null, pire_image_ms: f.length ? Math.round(Math.max(...f)) : null,
           images_lentes: f.filter(x => x > 50).length, taches_longues: P.long.length, taches_longues_ms: Math.round(P.long.reduce((a, b) => a + b, 0)) }; }"""


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def one_run(b, zpath, k):
    log = Log("perf")
    ctx, page = new_page(b, "pc", log=log)
    page.set_default_timeout(60000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    page.add_init_script(INIT)
    install_mocks(page, "romain", SUPERADMIN, {})
    r = {}
    t = time.time()
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=90000)
    r["accueil_ms"] = round((time.time() - t) * 1000)
    r["js_ko"] = page.evaluate("() => Math.round(performance.getEntriesByType('resource').filter(e => /\\.js(\\?|$)/.test(e.name)).reduce((a, e) => a + (e.decodedBodySize || 0), 0) / 1024)")
    t = time.time()
    nouveau.click()
    page.wait_for_timeout(300); close_welcome(page)
    page.wait_for_function("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", timeout=60000)
    r["studio_ms"] = round((time.time() - t) * 1000)
    r["tas_studio_mo"] = page.evaluate("() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null")
    page.keyboard.press("Escape")
    # Projet de 40 pistes
    t = time.time()
    b_open = page.locator("button[aria-label='Ouvrir un projet']").locator("visible=true")
    if b_open.count(): b_open.first.click()
    else:
        page.locator("button[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(300)
        page.locator("[role=dialog][aria-label=Menu] button", has_text=re.compile("Ouvrir un projet")).first.click()
    page.get_by_role("button", name=re.compile("Fichier sur l.ordinateur")).first.click()
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    page.wait_for_function("() => window.__novaEdit && window.__novaEdit.getState().tracks.length >= 45", timeout=90000)
    page.get_by_text("Projet chargé").first.wait_for(timeout=60000)
    r["projet40_ms"] = round((time.time() - t) * 1000)
    page.wait_for_timeout(1500)
    page.evaluate("() => { try { window.gc && window.gc(); } catch (e) {} }")
    r["tas_40_mo"] = page.evaluate("() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null")
    r["dom_noeuds"] = page.evaluate("() => document.getElementsByTagName('*').length")
    page.mouse.click(5, 300); page.keyboard.press("Escape")
    # Défilement vertical
    grid = page.evaluate("() => { const r = document.querySelector('.nova-grille').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
    page.mouse.move(*grid)
    page.evaluate(FRAMES_START)
    for i in range(20):
        page.mouse.wheel(0, 240 if i < 10 else -240); page.wait_for_timeout(60)
    page.wait_for_timeout(300)
    r["defilement"] = page.evaluate(FRAMES_STOP)
    # Zoom
    page.evaluate(FRAMES_START)
    for key in ["Control+BracketRight"] * 3 + ["Control+BracketLeft"] * 3:
        page.keyboard.press(key); page.wait_for_timeout(120)
    page.wait_for_timeout(300)
    r["zoom"] = page.evaluate(FRAMES_STOP)
    # Lecture
    page.evaluate(FRAMES_START)
    page.keyboard.press("Space"); page.wait_for_timeout(4000); page.keyboard.press("Space")
    page.wait_for_timeout(200)
    r["lecture"] = page.evaluate(FRAMES_STOP)
    # Console
    t = time.time()
    page.keyboard.press("Control+Equal")
    page.wait_for_function("() => document.querySelectorAll('[data-mixer-strip], [data-testid^=mixer-strip], [data-strip-id]').length > 10 || /Bus Voix/.test(document.querySelector('main')?.innerText || '') && !document.querySelector('.nova-grille canvas')", timeout=30000)
    r["console_ms"] = round((time.time() - t) * 1000)
    page.wait_for_timeout(400)
    page.keyboard.press("Control+Equal"); page.wait_for_timeout(800)
    # Fenêtres
    def win(name, act, sel):
        t0 = time.time(); act()
        try: page.locator(sel).first.wait_for(timeout=15000); ms = round((time.time() - t0) * 1000)
        except Exception: ms = None
        for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(200)
        return ms
    r["fenetres_ms"] = {
        "Exporter": win("export", lambda: page.keyboard.press("Control+Shift+E"), "[role=dialog][aria-labelledby=export-title]"),
        "Tempo": win("tempo", lambda: page.locator("[data-testid=open-tempo]").first.click(), "input[aria-label='Tempo en BPM']"),
        "Master Nova": win("master", lambda: page.locator("[data-nova-open-master]").first.click(), "[data-nova-master]"),
        "Palette": win("palette", lambda: page.keyboard.press("Control+k"), "[data-testid=command-palette]"),
    }
    r["erreurs"] = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:5]
    ctx.close()
    print(f"  essai {k + 1} :", json.dumps({x: r[x] for x in ('accueil_ms', 'studio_ms', 'projet40_ms', 'tas_40_mo', 'console_ms')}, ensure_ascii=False),
          "| défilement", r["defilement"], "| lecture", r["lecture"])
    return r


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=__import__("qalib").CHROME,
                          args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
                                "--enable-precise-memory-info", "--js-flags=--expose-gc"])
    z = OUT / "mix40.zip"; make_mix_project(z, 40, "Charge 40 pistes")
    runs = [one_run(b, z, k) for k in range(RUNS)]
    b.close()

agg = {"phase": PHASE, "essais": len(runs), "url": BASE}
for key in ("accueil_ms", "studio_ms", "projet40_ms", "tas_studio_mo", "tas_40_mo", "dom_noeuds", "console_ms", "js_ko"):
    agg[key] = med([r.get(key) for r in runs])
for grp in ("defilement", "zoom", "lecture"):
    agg[grp] = {k: med([r[grp].get(k) for r in runs]) for k in runs[0][grp]}
agg["fenetres_ms"] = {k: med([r["fenetres_ms"].get(k) for r in runs]) for k in runs[0]["fenetres_ms"]}
agg["erreurs"] = sum((r["erreurs"] for r in runs), [])[:8]
agg["detail"] = runs
(OUT / "perf_studio.json").write_text(json.dumps(agg, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nMÉDIANES :", json.dumps({k: v for k, v in agg.items() if k not in ("detail",)}, ensure_ascii=False))
