"""Outils communs aux scénarios QA de NOVA (Playwright headless, aucune fenêtre).

- QA 100 % hors production (qa_hors_prod) : toute requête *.supabase.co est servie
  par un catalogue SIMULÉ (beats, pochettes, fonctions, écritures) ; une requête non
  simulée est bloquée et fait échouer le test. Aucune requête ne part vers la prod.
- Bloque toute écriture vers les autres services externes (POST, PATCH, PUT, DELETE).
- Journalise erreurs console, exceptions de page et requêtes en échec.
"""
import json, os, sys, time, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_hors_prod  # noqa: E402  (avant tout navigateur : Supabase simulé, production bloquée)
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = os.environ.get("NOVA_URL", "http://127.0.0.1:3300/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\qa-nova-2026-10-04"))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
FAKE_WAV = r"D:\1 WORK\CONTENU\nova-promo-2026-10-04\micro_fake.wav"

VIEWPORTS = {
    "pc": {"width": 1600, "height": 900},
    "tel": {"width": 432, "height": 768},
    "tab": {"width": 1024, "height": 768},
}

WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}

# Module de l'APPLI, pas une 2e copie. Quand le serveur Vite a vu des fichiers modifiés,
# il sert le moteur sous « /engine/AudioEngine.ts?t=… » : un import('/engine/AudioEngine.ts')
# nu crée alors une AUTRE instance (sans contexte audio, sans pistes), et les scénarios qui
# écoutent le master (v15_master…) échouaient. `await window.__novaAppModule(chemin)` importe
# l'URL réellement chargée par l'appli (la plus récente), sinon le chemin nu.
APP_MODULE_INIT = r"""
try { performance.setResourceTimingBufferSize(50000); } catch (e) {}
window.__novaAppModule = async (path) => {
  let best = null, bestT = -1;
  for (const e of performance.getEntriesByType('resource')) {
    let u; try { u = new URL(e.name); } catch (_) { continue; }
    if (u.origin !== location.origin || u.pathname !== path) continue;
    const t = +(u.searchParams.get('t') || 0);
    if (t >= bestT) { bestT = t; best = u.pathname + u.search; }
  }
  return import(/* @vite-ignore */ best || path);
};
"""


class Log:
    def __init__(self, name):
        self.name = name
        self.entries = []

    def add(self, kind, text):
        self.entries.append({"t": round(time.time(), 2), "kind": kind, "text": str(text)[:600]})

    def errors(self):
        return [e for e in self.entries if e["kind"] in ("console.error", "pageerror")]


def launch(p):
    return p.chromium.launch(
        headless=True,
        executable_path=CHROME,
        args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={FAKE_WAV}",
            "--autoplay-policy=no-user-gesture-required",
            # Serveur joint par l'adresse du réseau local (127.0.0.1 déjà pris par un autre
            # serveur) : contexte sûr quand même (micro, AudioWorklet), comme sur 127.0.0.1.
            *([f"--unsafely-treat-insecure-origin-as-secure={BASE.rstrip('/')}"] if not re.match(r"https?://(127\.0\.0\.1|localhost|[\w-]+\.localhost)", BASE) else []),
            # QA_RESOLVE="nova.localhost=192.168.0.14" : un nom en .localhost (contexte sûr pour
            # Chrome : micro, AudioWorklet) qui pointe vers le serveur de test.
            *([f"--host-resolver-rules=MAP {os.environ['QA_RESOLVE'].split('=')[0]} {os.environ['QA_RESOLVE'].split('=')[1]}"] if os.environ.get("QA_RESOLVE") else []),
        ],
    )


def new_page(browser, vp="pc", log=None, touch=None, storage=None):
    size = VIEWPORTS[vp]
    is_touch = (vp in ("tel", "tab")) if touch is None else touch
    ctx = browser.new_context(
        viewport=size,
        permissions=["microphone"],
        has_touch=is_touch,
        is_mobile=(vp == "tel"),
        device_scale_factor=1,
        accept_downloads=True,
        locale="fr-BE",
        storage_state=storage,
    )
    blocked = []

    def guard(route, request):
        url = request.url
        if qa_hors_prod.is_supabase(url):
            return route.fallback()  # le simulateur répond (écritures comprises), jamais la production
        external = not url.startswith(BASE.rstrip("/")) and not url.startswith("data:") and not url.startswith("blob:")
        if request.method in WRITE_METHODS and external:
            blocked.append(f"{request.method} {url[:140]}")
            if log: log.add("blocked-write", f"{request.method} {url[:200]}")
            return route.abort()
        return route.continue_()

    ctx.route("**/*", guard)
    qa_hors_prod.install(ctx, log)
    # QA_CHORD_LANE=1 : couloir d'accords affiché (sous la règle) dans tous les modes,
    # pour rejouer les gestes de l'arrangement avec le couloir.
    if os.environ.get("QA_CHORD_LANE") == "1":
        ctx.add_init_script("try { localStorage.setItem('nova_chord_lane', '1'); } catch (e) {}")
    ctx.add_init_script(APP_MODULE_INIT)
    page = ctx.new_page()
    page.set_default_timeout(15000)
    if log is not None:
        page.on("console", lambda m: log.add(f"console.{m.type}", m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: log.add("pageerror", e))
        page.on("requestfailed", lambda r: log.add("requestfailed", f"{r.method} {r.url[:160]} {r.failure}"))
        page.on("response", lambda r: log.add("http", f"{r.status} {r.url[:160]}") if r.status >= 400 else None)
    page._blocked = blocked
    return ctx, page


def shot(page, name):
    path = OUT / f"{name}.png"
    page.screenshot(path=str(path))
    return path


def visible_buttons(page):
    return page.evaluate("""() => Array.from(document.querySelectorAll('button, [role=button], a'))
      .filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden')
      .map(b => { const r = b.getBoundingClientRect(); return {t: (b.innerText||b.getAttribute('aria-label')||b.title||'').trim().slice(0,60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)} })""")


def overflow_report(page):
    """Textes tronqués / débordements horizontaux visibles."""
    return page.evaluate("""() => {
      const out = [];
      const vw = window.innerWidth;
      if (document.documentElement.scrollWidth > vw + 1) out.push({kind:'page-hscroll', w: document.documentElement.scrollWidth, vw});
      for (const el of document.querySelectorAll('button, h1, h2, h3, p, span, label')) {
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const txt = (el.innerText || '').trim();
        if (!txt) continue;
        if (r.right > vw + 2 && r.left < vw) out.push({kind:'off-right', t: txt.slice(0,50), right: Math.round(r.right)});
        if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis'))
          out.push({kind:'clipped', t: txt.slice(0,50), sw: el.scrollWidth, cw: el.clientWidth});
      }
      return out.slice(0, 40);
    }""")


def click_text(page, text, exact=False, timeout=6000, role="button"):
    loc = page.get_by_role(role, name=text, exact=exact) if role else page.get_by_text(text, exact=exact)
    loc.first.click(timeout=timeout)


def save_log(log, extra=None):
    path = OUT / f"log_{log.name}.json"
    data = {"name": log.name, "entries": log.entries}
    if extra: data.update(extra)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def run_one(fn, vp="pc", name=None, **kw):
    name = name or f"{fn.__name__}_{vp}"
    log = Log(name)
    result = {"name": name, "ok": True, "notes": []}
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        ctx, page = new_page(b, vp, log, **kw)
        try:
            fn(page, log, result, vp)
        except Exception as e:  # noqa
            result["ok"] = False
            result["notes"].append(f"EXCEPTION: {type(e).__name__}: {str(e)[:400]}")
            try: shot(page, f"{name}__FAIL")
            except Exception: pass
        finally:
            result["secs"] = round(time.time() - t0, 1)
            result["blocked_writes"] = page._blocked[:20]
            result["errors"] = [e["text"][:300] for e in log.errors()][:25]
            save_log(log, {"result": result})
            ctx.close(); b.close()
    return result


# -- Menu contextuel à sous-menus (menu du clip regroupé : Édition, Gain et fondus, Hauteur et
#    temps, Voix, Traitement, MIDI). Une entrée rangée dans un sous-menu n'est pas affichée tant
#    que son sous-menu est fermé : on ouvre d'abord le sous-menu qui la contient (son bouton
#    porte data-submenu = libellés de ses entrées), comme le ferait un utilisateur.
def menu_open_for(page, text, exact=False, tap=False):
    """Ouvre le sous-menu qui contient `text` (chaîne ou motif re). True si l'entrée est visible ensuite."""
    import re as _re
    pat = text.pattern if hasattr(text, "pattern") else (("^" + _re.escape(text) + "$") if exact else _re.escape(text))
    vis = page.evaluate("""(p) => { const rx = new RegExp(p);
      return [...document.querySelectorAll('[role=menu] button')].some(b => b.getClientRects().length && rx.test((b.innerText || '').trim())); }""", pat)
    if vis:
        return True
    idx = page.evaluate("""(p) => { const rx = new RegExp(p);
      const t = [...document.querySelectorAll('[role=menu] [data-submenu]')].find(b => (b.dataset.submenu || '').split(String.fromCharCode(10)).some(l => rx.test(l)));
      return t ? t.dataset.menuIndex : null; }""", pat)
    if idx is None:
        return False
    trig = page.locator(f"[role=menu] [data-menu-index='{idx}']").first
    if tap: trig.tap()
    else: trig.click()
    page.wait_for_timeout(250)
    return True


def menu_pick(page, text, exact=False, tap=False):
    """Clique l'entrée `text` du menu contextuel ouvert, dans son sous-menu s'il le faut."""
    import re as _re
    if not menu_open_for(page, text, exact=exact, tap=tap):
        raise RuntimeError(f"entrée de menu introuvable : {text}")
    rx = text if hasattr(text, "pattern") else (_re.compile("^" + _re.escape(text) + "$") if exact else _re.compile(_re.escape(text)))
    it = page.locator("[role=menu] button", has_text=rx).locator("visible=true").first
    if tap: it.tap()
    else: it.click()
