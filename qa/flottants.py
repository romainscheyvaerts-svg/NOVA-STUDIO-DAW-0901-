"""Éléments flottants du bureau et de la tablette : plus jamais posés sur la zone de travail.

Chrome headless (aucune fenêtre), 100 % hors production. Bureau 1366 × 768, 1600 × 900, 1920 × 1080 (souris),
tablette 1024 × 768, iPad 820 × 1180 et 1180 × 820 (au doigt), thème sombre ; mode avancé.
Parcours : accueil → instru → piste REC armée → une prise (touche R) → la carte « Et maintenant ? », la
pastille des conseils de Nova, « Filmer la prise » et le bouton Nova sont là. Puis la console (Mix).

Sur chaque écran (arrangement après la prise, console) : tout élément en position fixe (hors fenêtres, menus,
info-bulles) qui chevauche la zone de travail — entre la barre du haut et le bandeau du bas, à droite du
navigateur — est un défaut (il recouvre la timeline, les clips, les faders ou la console). Le bandeau du bas
et la barre du haut sont les zones réservées.

  NOVA_URL=http://127.0.0.1:3545/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/flottants.py [cas ...]
Sorties : D:\\1 WORK\\CONTENU\\nova-tactile\\flottants\\<phase>\\ (flottants.json + captures). Code 1 au moindre chevauchement.
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3545/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-tactile\flottants\{PHASE}")
sys.path.insert(0, str(Path(__file__).parent))
import qa_hors_prod  # noqa: E402,F401
from qalib import launch, OUT, Log, BASE, APP_MODULE_INIT, SORTIE_AUDIO_INIT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CAS = {
    "pc1366": dict(w=1366, h=768, touch=False),
    "pc1600": dict(w=1600, h=900, touch=False),
    "pc1920": dict(w=1920, h=1080, touch=False),
    "tab1024": dict(w=1024, h=768, touch=True),
    "ipad": dict(w=820, h=1180, touch=True),
    "ipad_pay": dict(w=1180, h=820, touch=True),
}
WANT = [a for a in sys.argv[1:] if a in CAS] or list(CAS)

CHEVAUCHE = r"""() => {
  const W = innerWidth, H = innerHeight;
  const vis = el => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const bar = document.querySelector('[data-testid=transport-bar]');
  const dock = document.querySelector('[data-nova-dock]');
  const top = bar ? bar.getBoundingClientRect().bottom : 64;
  const bottom = dock ? dock.getBoundingClientRect().top : H;
  // Navigateur (barre latérale gauche) ouvert : la zone de travail commence à sa droite.
  let left = 0;
  const work = document.querySelector('[data-arrange-scroll]') || document.querySelector('[data-testid=mixer-loudness]');
  const zone = { l: left, t: top, r: W, b: bottom };
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('data-testid') || (el.innerText || '').trim().replace(/\s+/g, ' ') || String(el.className)).slice(0, 60);
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' || !vis(el)) continue;
    if (el.closest('[role=dialog], [aria-modal=true], [role=alertdialog], [role=menu], [role=tooltip], [role=listbox]')) continue;
    if (bar && (bar.contains(el) || el.contains(bar))) continue;
    if (dock && (dock.contains(el) || el.contains(dock))) continue;
    // Un parent déjà en position fixe : on ne compte que le premier niveau.
    let p = el.parentElement, nested = false; for (; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') { nested = true; break; }
    if (nested) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.width >= W * 0.95 && r.height >= H * 0.9) continue;      // calque plein écran (fond d'une fenêtre)
    if (s.pointerEvents === 'none' && !(el.innerText || '').trim()) continue;
    if (!el.querySelector('button, a, [role=button], input') && !(el.innerText || '').trim()) continue;
    const ix = Math.min(r.right, zone.r) - Math.max(r.left, zone.l), iy = Math.min(r.bottom, zone.b) - Math.max(r.top, zone.t);
    if (ix > 4 && iy > 4) out.push({ el: label(el), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), sur: Math.round(ix) + '×' + Math.round(iy) });
  }
  return { zone: { t: Math.round(top), b: Math.round(bottom) }, chevauchements: out, travail: !!work };
}"""

PRESENTS = r"""() => ({
  carte: !!document.querySelector('[data-testid=next-step-card]'),
  conseils: !!document.querySelector('[data-testid=nova-tip-pill]'),
  camera: !!document.querySelector('[data-testid=video-take-pill]'),
  nova: !!document.querySelector('[data-testid=nova-open]'),
})"""


def run(p, nom, cfg, res):
    log = Log(f"flottants_{nom}")
    b = launch(p)
    ctx = b.new_context(viewport={"width": cfg["w"], "height": cfg["h"]}, has_touch=cfg["touch"], is_mobile=False,
                        device_scale_factor=1, permissions=["microphone"], locale="fr-BE")
    ctx.route("**/downloads/nova-studio-latest.json*", lambda route, request: route.fulfill(status=200, content_type="application/json", body="{}"))
    qa_hors_prod.install(ctx, log)
    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script("try { localStorage.setItem('nova_theme', 'dark'); } catch (e) {}")
    ctx.add_init_script(SORTIE_AUDIO_INIT % json.dumps("Casque (Realtek(R) Audio)"))
    page = ctx.new_page()
    page.set_default_timeout(20000)
    page.on("pageerror", lambda e: log.add("pageerror", e))
    r = {"cas": nom, **cfg}
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.locator("[aria-label^='Poser ma voix sur']").first.wait_for(timeout=60000)
        page.locator("[aria-label^='Poser ma voix sur']").first.click()
        page.wait_for_timeout(800)
        for n in ("C'est parti", "Plus tard", "Oui, j'ai un casque"):
            bt = page.get_by_role("button", name=n).locator("visible=true")
            if bt.count(): bt.first.click(); page.wait_for_timeout(300)
        page.wait_for_function("() => !!window.__novaEdit && window.__novaEdit.getState().tracks.some(t => t.id === 'instrumental' && t.clips.length) && !/Chargement\\s*:/.test(document.body.innerText)", timeout=60000)
        page.keyboard.press("Home"); page.keyboard.press("r")
        page.wait_for_function("() => window.__novaEdit.getState().isRecording", timeout=20000)
        page.wait_for_timeout(3500)
        page.keyboard.press("r")
        page.wait_for_function("() => !window.__novaEdit.getState().isRecording", timeout=20000)
        page.wait_for_timeout(4500)
        # La carte « Et maintenant ? » arrive après la 1re prise du mode simple ; puis le mode avancé (console, pastilles).
        r["carte_apres_prise"] = page.evaluate("() => !!document.querySelector('[data-testid=next-step-card]')")
        page.evaluate("async () => (await window.__novaAppModule('/utils/simpleMode.ts')).simpleModeStore.setPref(false)")
        page.wait_for_timeout(800)
        page.mouse.move(2, 300)
        r["presents_arrangement"] = page.evaluate(PRESENTS)
        page.screenshot(path=str(OUT / f"{nom}_01_arrangement.png"))
        r["arrangement"] = page.evaluate(CHEVAUCHE)
        # Console (Mix)
        page.mouse.click(5, cfg['h'] // 2)  # focus de la page (pas un champ)
        page.keyboard.press("Control+Equal")
        page.wait_for_timeout(1200)
        r["vue"] = page.evaluate("() => window.__novaEdit.getState().currentView")
        r["presents_console"] = page.evaluate(PRESENTS)
        page.screenshot(path=str(OUT / f"{nom}_02_console.png"))
        r["console"] = page.evaluate(CHEVAUCHE)
    except Exception as e:  # noqa
        r["arret"] = f"{type(e).__name__}: {str(e)[:300]}"
        try: page.screenshot(path=str(OUT / f"{nom}_arret.png"))
        except Exception: pass
    r["erreurs"] = [e["text"][:200] for e in log.errors()][:5]
    ctx.close(); b.close()
    res[nom] = r
    n = len((r.get("arrangement") or {}).get("chevauchements", [])) + len((r.get("console") or {}).get("chevauchements", []))
    print(f"== {nom} : vue={r.get('vue')} présents={r.get('presents_arrangement')} chevauchements={n}", flush=True)
    for k in ("arrangement", "console"):
        for c in (r.get(k) or {}).get("chevauchements", []):
            print(f"   {k} : {c}", flush=True)
    return n


def main():
    res = {}
    ko = []
    with sync_playwright() as p:
        for nom in WANT:
            n = run(p, nom, CAS[nom], res)
            if n: ko.append(f"{nom} : {n} élément(s) flottant(s) sur la zone de travail")
            if res[nom].get("arret"): ko.append(f"{nom} : arrêt {res[nom]['arret']}")
            if res[nom].get("vue") not in (None, "MIXER"): ko.append(f"{nom} : la console ne s'est pas ouverte ({res[nom].get('vue')})")
    (OUT / "flottants.json").write_text(json.dumps({"phase": PHASE, "date": time.strftime("%Y-%m-%d %H:%M"), "cas": res}, ensure_ascii=False, indent=1), encoding="utf-8")
    for k in ko: print("KO", k)
    sys.exit(1 if ko else 0)


if __name__ == "__main__":
    main()
