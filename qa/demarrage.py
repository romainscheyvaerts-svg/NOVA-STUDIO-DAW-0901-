"""Temps de démarrage sur un build de production (PC et téléphone), avant / après.

Pour chaque essai (contexte neuf, cache vide) : page → accueil interactif (« Nouveau Projet »)
→ studio prêt ; JS téléchargé au démarrage (Ko décompressés), nombre de fichiers JS ; puis
la fenêtre « Justesse » (chargée à la demande) et la boîte à rythmes s'ouvrent-elles toujours ?
Médiane de N essais. Chrome headless (aucune fenêtre), compte simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3494/ QA_TAG=apres PYTHONIOENCODING=utf-8 python qa/demarrage.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro2\\point4\\demarrage_<tag>.json
"""
import json, os, re, statistics, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3494/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro2\point4")
TAG = os.environ.get("QA_TAG", "apres")
RUNS = int(os.environ.get("PERF_RUNS", "5"))
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

JS = """() => { const js = performance.getEntriesByType('resource').filter(e => /\\.js(\\?|$)/.test(e.name));
  return { ko: Math.round(js.reduce((a, e) => a + (e.decodedBodySize || 0), 0) / 1024), fichiers: js.length,
           transfert_ko: Math.round(js.reduce((a, e) => a + (e.transferSize || e.encodedBodySize || 0), 0) / 1024) }; }"""


def one(b, vp):
    log = Log("demarrage")
    ctx, page = new_page(b, vp, log=log)
    if vp == "tel": page.set_viewport_size({"width": 390, "height": 844})
    page.set_default_timeout(90000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    r = {}
    t = time.time()
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=90000)
    r["accueil_ms"] = round((time.time() - t) * 1000)
    r["js_accueil"] = page.evaluate(JS)
    t = time.time()
    nouveau.click()
    page.wait_for_timeout(200); close_welcome(page)
    page.wait_for_function("() => !!window.__novaEdit && (!!document.querySelector('.nova-grille canvas') || !!document.querySelector('nav, [data-mobile-nav], main'))", timeout=90000)
    r["studio_ms"] = round((time.time() - t) * 1000)
    r["total_ms"] = r["accueil_ms"] + r["studio_ms"]
    page.wait_for_timeout(500)
    r["js_studio"] = page.evaluate(JS)
    r["erreurs"] = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:5]
    ctx.close()
    return r


with sync_playwright() as p:
    b = launch(p)
    res = {"tag": TAG, "url": BASE, "essais": RUNS}
    for vp in ("pc", "tel"):
        runs = [one(b, vp) for _ in range(RUNS)]
        med = lambda f: round(statistics.median([f(r) for r in runs]))
        res[vp] = {"accueil_ms": med(lambda r: r["accueil_ms"]), "studio_ms": med(lambda r: r["studio_ms"]), "total_ms": med(lambda r: r["total_ms"]),
                   "js_accueil_ko": med(lambda r: r["js_accueil"]["ko"]), "js_accueil_transfert_ko": med(lambda r: r["js_accueil"]["transfert_ko"]),
                   "js_studio_ko": med(lambda r: r["js_studio"]["ko"]), "fichiers_js_studio": med(lambda r: r["js_studio"]["fichiers"]),
                   "erreurs": runs[-1]["erreurs"], "detail": runs}
        print(vp, json.dumps({k: v for k, v in res[vp].items() if k != "detail"}, ensure_ascii=False))
    b.close()
(OUT / f"demarrage_{TAG}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
