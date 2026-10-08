"""Console de 40 pistes : temps d'affichage (rendu natif), mètres et réduction de gain.

Projet de mix de 40 pistes (projet_mix.py) avec un compresseur qui travaille sur la 1re et
la dernière piste. Mesures (build de production de préférence, médiane de N essais) :
- Ctrl+= → console affichée : temps jusqu'à l'image peinte (dans la page) ;
- rendu natif : durées de style + mise en page (Chrome, Performance.getMetrics) pendant
  l'ouverture, et JS ; tranches réellement montées ; nœuds du DOM ;
- mètres : en lecture, les tranches visibles affichent une crête (≠ −∞) et la réduction de
  gain de la piste compressée ; après défilement jusqu'au bout, la dernière piste (montée
  à ce moment) affiche aussi sa crête et sa réduction de gain.
Chrome headless (aucune fenêtre), compte simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3493/ QA_TAG=apres PYTHONIOENCODING=utf-8 python qa/console_40.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro2\\point3\\console_40_<tag>.json
"""
import json, os, re, statistics, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3493/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro2\point3")
TAG = os.environ.get("QA_TAG", "apres")
RUNS = int(os.environ.get("PERF_RUNS", "3"))
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from projet_mix import make_mix_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

COMP = {"type": "COMPRESSOR", "name": "Compresseur", "isEnabled": True,
        "params": {"threshold": -40, "ratio": 8, "knee": 0, "attack": 0.002, "release": 0.1, "makeupGain": 1, "isEnabled": True}}


def project(path):
    make_mix_project(path, 40, name="Console 40")
    with zipfile.ZipFile(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    st = json.loads(files["project.json"])
    audio = [t for t in st["tracks"] if t["type"] == "AUDIO"]
    for t in (audio[0], audio[-1]):
        t["plugins"] = [dict(COMP, id=f"comp-{t['id']}")]
    files["project.json"] = json.dumps(st).encode()
    with zipfile.ZipFile(path, "w") as z:
        for n, v in files.items(): z.writestr(n, v)
    return audio[0]["id"], audio[-1]["id"], audio[-1]["name"]


OPEN_MIXER = r"""async () => {
  const t0 = performance.now();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true, cancelable: true }));
  const ready = () => document.querySelectorAll('[data-strip-id]').length > 10 && !document.querySelector('.nova-grille canvas');
  while (!ready()) { await new Promise(r => requestAnimationFrame(r)); if (performance.now() - t0 > 20000) return null; }
  const tCommit = performance.now();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { commit_ms: Math.round(tCommit - t0), peinte_ms: Math.round(performance.now() - t0),
    tranches: document.querySelectorAll('[data-strip-id]').length,
    montees: document.querySelectorAll('[data-strip-id]:not([data-strip-mounted="0"])').length,
    metres: document.querySelectorAll('[data-meter]').length, dom: document.getElementsByTagName('*').length };
}"""

METER_TEXT = r"""(id) => { const m = document.querySelector(`[data-meter="${id}"]`); if (!m) return null;
  const spans = [...m.querySelectorAll('span, button')].map(e => (e.textContent || '').trim()); return spans; }"""


def metrics(cdp):
    return {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}


def open_project(page, z):
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=90000); nouveau.click()
    page.wait_for_timeout(300); close_welcome(page)
    page.wait_for_function("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", timeout=60000)
    page.keyboard.press("Escape")
    b_open = page.locator("button[aria-label='Ouvrir un projet']").locator("visible=true")
    if b_open.count(): b_open.first.click()
    else:
        page.locator("button[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(300)
        page.locator("[role=dialog][aria-label=Menu] button", has_text=re.compile("Ouvrir un projet")).first.click()
    page.get_by_role("button", name=re.compile("Fichier sur l.ordinateur")).first.click()
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(z))
    page.wait_for_function("() => window.__novaEdit && window.__novaEdit.getState().tracks.length >= 45", timeout=90000)
    page.get_by_text("Projet chargé").first.wait_for(timeout=60000)
    page.wait_for_timeout(1500)
    page.mouse.click(5, 300); page.keyboard.press("Escape")


def one_run(b, z, ids, k):
    first, last, last_name = ids
    log = Log("console40")
    ctx, page = new_page(b, "pc", log=log)
    page.set_default_timeout(60000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    open_project(page, z)
    cdp = ctx.new_cdp_session(page); cdp.send("Performance.enable")
    page.wait_for_timeout(800)
    m0 = metrics(cdp)
    r = page.evaluate(OPEN_MIXER) or {}
    m1 = metrics(cdp)
    r["style_ms"] = round((m1["RecalcStyleDuration"] - m0["RecalcStyleDuration"]) * 1000)
    r["mise_en_page_ms"] = round((m1["LayoutDuration"] - m0["LayoutDuration"]) * 1000)
    r["natif_ms"] = r["style_ms"] + r["mise_en_page_ms"]
    r["js_ms"] = round((m1["ScriptDuration"] - m0["ScriptDuration"]) * 1000)
    r["taches_ms"] = round((m1["TaskDuration"] - m0["TaskDuration"]) * 1000)
    if k == 0: page.screenshot(path=str(OUT / f"console40_{TAG}_01_ouverte.png"))
    # Mètres et réduction de gain en lecture (tranches visibles).
    page.keyboard.press("Space"); page.wait_for_timeout(2500)
    r["metre_1re_piste"] = page.evaluate(METER_TEXT, first)
    r["metre_master"] = page.evaluate(METER_TEXT, "__master_out__") or page.evaluate("() => [...document.querySelectorAll('[data-strip-id=master] [data-meter] button')].map(b => b.textContent.trim())")
    # Défilement jusqu'au bout : la dernière piste se monte et mesure aussi.
    page.evaluate("() => { const s = document.querySelector('[data-strip-id]').parentElement; s.scrollTo({ left: s.scrollWidth }); }")
    page.wait_for_timeout(1500)
    r["metre_derniere_piste"] = page.evaluate(METER_TEXT, last)
    r["derniere_montee"] = page.evaluate("(id) => document.querySelector(`[data-strip-id='${id}']`)?.dataset.stripMounted !== '0'", last)
    if k == 0: page.screenshot(path=str(OUT / f"console40_{TAG}_02_fin_lecture.png"))
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    # Défilement continu de toute la console : images par seconde.
    page.evaluate("() => { window.__fr = []; let l = performance.now(); window.__frOn = true; const f = (t) => { if (!window.__frOn) return; window.__fr.push(t - l); l = t; requestAnimationFrame(f); }; requestAnimationFrame(f); }")
    page.evaluate("async () => { const s = document.querySelector('[data-strip-id]').parentElement; s.style.scrollSnapType = 'none'; for (let x = s.scrollWidth; x >= 0; x -= 120) { s.scrollLeft = x; await new Promise(r => requestAnimationFrame(r)); } s.style.scrollSnapType = ''; }")
    fr = page.evaluate("() => { window.__frOn = false; return window.__fr.slice(2); }")
    r["defilement"] = {"images": len(fr), "pire_image_ms": round(max(fr)) if fr else None, "images_lentes": sum(1 for x in fr if x > 50)}
    r["erreurs"] = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:5]
    ctx.close()
    print(f"  essai {k + 1} :", json.dumps({x: r.get(x) for x in ("peinte_ms", "natif_ms", "style_ms", "mise_en_page_ms", "js_ms", "montees", "tranches", "dom")}, ensure_ascii=False))
    return r


def gr_of(spans):
    return next((s for s in (spans or []) if s.startswith("−") and "," in s and len(s) < 7 and not s.startswith("−∞")), None)


def peak_of(spans):
    return next((s for s in (spans or []) if re.match(r"^[−-]?\d", s) and s not in ("",)), None)


with sync_playwright() as p:
    b = launch(p)
    z = OUT / "console40.zip"
    ids = project(z)
    runs = [one_run(b, z, ids, k) for k in range(RUNS)]
    b.close()

med = lambda key: round(statistics.median([r[key] for r in runs if r.get(key) is not None]), 1)
last = runs[-1]
res = {"tag": TAG, "url": BASE, "essais": RUNS, **{k: med(k) for k in ("commit_ms", "peinte_ms", "natif_ms", "style_ms", "mise_en_page_ms", "js_ms", "taches_ms", "montees", "tranches", "metres", "dom")},
       "metres": {"1re_piste": last.get("metre_1re_piste"), "derniere_piste": last.get("metre_derniere_piste"), "derniere_montee_apres_defilement": last.get("derniere_montee")},
       "verifs": {
           "crete_1re_piste": bool(peak_of(last.get("metre_1re_piste"))),
           "reduction_gain_1re_piste": gr_of(last.get("metre_1re_piste")),
           "crete_derniere_piste": bool(peak_of(last.get("metre_derniere_piste"))),
           "reduction_gain_derniere_piste": gr_of(last.get("metre_derniere_piste")),
       },
       "defilement": last.get("defilement"), "erreurs": last.get("erreurs"), "detail": runs}
(OUT / f"console_40_{TAG}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nMÉDIANE :", json.dumps({k: res[k] for k in ("peinte_ms", "natif_ms", "style_ms", "mise_en_page_ms", "js_ms", "montees", "dom")}, ensure_ascii=False))
print("VÉRIFS :", json.dumps(res["verifs"], ensure_ascii=False), "| défilement", res["defilement"], "| erreurs", res["erreurs"])
