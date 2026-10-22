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
    "pc1366": {"width": 1366, "height": 768},
    "tel": {"width": 432, "height": 768},
    # Téléphone courant (iPhone 12 à 15) : 390 × 844, au doigt.
    "tel390": {"width": 390, "height": 844},
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


SORTIE_AUDIO_INIT = r"""(() => { const label = %s; const md = navigator.mediaDevices; if (!md || !md.enumerateDevices) return;
  const orig = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => { const l = await orig();
    return [...l.filter(d => d.kind !== 'audiooutput'), { deviceId: 'default', kind: 'audiooutput', label: 'Par défaut - ' + label, groupId: 'qa', toJSON() { return this; } }]; }; })();"""


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
    is_touch = (vp in ("tel", "tel390", "tab")) if touch is None else touch
    ctx = browser.new_context(
        viewport=size,
        permissions=["microphone"],
        has_touch=is_touch,
        is_mobile=(vp in ("tel", "tel390")),
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
    # Manifeste de mise à jour de l'appli Windows (1.5.3) : vide par défaut (« {} », ignoré par la
    # page, sans erreur console), pour que la carte « nouvelle version disponible » n'apparaisse pas
    # au hasard d'une construction dans les scénarios qui simulent une ancienne appli.
    # qa/desktop_maj_auto.py sert le sien.
    ctx.route("**/downloads/nova-studio-latest.json*", lambda route, request: route.fulfill(
        status=200, content_type="application/json", body="{}"))
    qa_hors_prod.install(ctx, log)
    # QA_CHORD_LANE=1 : couloir d'accords affiché (sous la règle) dans tous les modes,
    # pour rejouer les gestes de l'arrangement avec le couloir.
    if os.environ.get("QA_CHORD_LANE") == "1":
        ctx.add_init_script("try { localStorage.setItem('nova_chord_lane', '1'); } catch (e) {}")
    ctx.add_init_script(APP_MODULE_INIT)
    # QA_THEME=light|dark : rejoue n'importe quel scénario dans ce thème (qa/theme_clair.py).
    if os.environ.get("QA_THEME") in ("light", "dark"):
        ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{os.environ['QA_THEME']}'); }} catch (e) {{}}")
    # Sortie audio nommée, comme Chrome la donne sur un vrai PC une fois le micro autorisé
    # (headless : aucune sortie nommée, la question « Tu as un casque ? » bloquait les séances).
    # Le VRAI chemin de l'appli est suivi (utils/headphoneDetect lit le nom de la sortie) : rien
    # n'est pré-répondu dans le stockage. QA_SORTIE_AUDIO=aucune : pas de sortie simulée (la
    # question revient, comme sur un navigateur muet) ; qa/casque_rec.py simule ses propres sorties.
    sortie = os.environ.get("QA_SORTIE_AUDIO", "Casque (Realtek(R) Audio)")
    if sortie and sortie.lower() != "aucune":
        ctx.add_init_script(SORTIE_AUDIO_INIT % json.dumps(sortie))
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


def ouvrir_plus_accueil(page, touch=False):
    """Accueil en mode simple (15/10/2026) : fréquence, « Depuis un modèle », « Masteriser un morceau »,
    « Ouvrir Audio » et l'appli Windows sont rangés sous « Plus d'options ». L'ouvre s'il est fermé ;
    renvoie True si un geste a été fait (mode avancé ou déjà ouvert : rien à faire)."""
    b = page.locator("[data-testid=landing-plus][aria-expanded=false]").locator("visible=true")
    try:
        b.first.wait_for(timeout=1500)
    except Exception:
        return False
    (b.first.tap if touch else b.first.click)()
    page.wait_for_timeout(200)
    return True


# Balayage de chevauchement (15/10/2026) : aucun élément cliquable de l'écran ne doit être recouvert par un
# autre élément (pastille, badge, bouton posé en absolu…). Pour chaque bouton visible : on prend la partie
# réellement visible (coupée par les zones qui défilent), puis on sonde sa ligne médiane (centre et quarts) ;
# recouvert si au moins 2 sondes sur 3 tombent sur un élément étranger. Ne comptent pas : une fenêtre modale
# (elle recouvre légitimement le fond), un en-tête collant de la même zone qui défile (défilement normal),
# et un élément à peine visible (< 30 % de sa surface : il est hors de la zone qui défile).
BALAYAGE_CHEVAUCHEMENT_JS = r"""(scope) => {
  const W = innerWidth, H = innerHeight;
  const sel = 'button, [role=button], a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=switch], [role=slider], [role=menuitem], [role=radio], [role=checkbox]';
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return { erreur: 'zone introuvable : ' + scope };
  const label = el => ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-testid'))) || el.innerText || el.title || el.tagName || '').toString().trim().replace(/\s+/g, ' ').slice(0, 50);
  const clips = el => { const out = []; for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) out.push(p); } return out; };
  const stickyOf = el => { for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'sticky') return p; return null; };
  const scroller = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY + s.overflowX)) return p; } return null; };
  const res = []; let n = 0;
  for (const el of root.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || cs.pointerEvents === 'none') continue;
    if (el.parentElement && el.parentElement.closest(sel) && !el.matches('input, select, textarea')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
    let L = Math.max(r.left, 0), T = Math.max(r.top, 0), R = Math.min(r.right, W), B = Math.min(r.bottom, H);
    for (const c of clips(el)) { const q = c.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); }
    if (R - L < 2 || B - T < 2 || (R - L) * (B - T) < 0.3 * r.width * r.height) continue;
    n++;
    // Sondes sur la ligne médiane (centre, quart gauche, quart droit) : les coins d'une pastille arrondie sont
    // hors de sa forme (Chrome en tient compte), ils tomberaient sur ce qu'il y a dessous.
    const ym = (T + B) / 2;
    const pts = [[(L + R) / 2, ym], [L + (R - L) / 4, ym], [R - (R - L) / 4, ym]];
    let bad = 0, par = null;
    for (const [x, y] of pts) {
      const h = document.elementFromPoint(x, y);
      if (!h || el.contains(h) || h.contains(el)) continue;
      if (h.closest('[aria-modal=true], [role=dialog], [role=alertdialog]') && !el.closest('[aria-modal=true], [role=dialog], [role=alertdialog]')) continue;
      const st = stickyOf(h); if (st && !st.contains(el) && scroller(st) && scroller(st).contains(el)) continue;
      bad++; if (!par) par = h;
    }
    if (bad >= 2) {
      const chaine = []; for (let p = par, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) chaine.push(p.tagName.toLowerCase() + (p.getAttribute('data-testid') ? '[' + p.getAttribute('data-testid') + ']' : '') + '.' + String(p.className || '').split(' ').slice(0, 3).join('.'));
      const pile = document.elementsFromPoint((L + R) / 2, (T + B) / 2).slice(0, 5).map(e => { const s = getComputedStyle(e); return e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ').slice(0, 2).join('.') + ' z=' + s.zIndex + ' ' + s.position + (s.pointerEvents === 'none' ? ' pe:none' : ''); });
      res.push({ el: label(el), par: label(par.closest(sel) || par), chaine, pile, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return { boutons: n, recouverts: res };
}"""


def balayage_chevauchement(page, scope=None):
    """Boutons recouverts par un autre élément sur l'écran (ou dans `scope`) : {'boutons': n, 'recouverts': [...]}."""
    return page.evaluate(BALAYAGE_CHEVAUCHEMENT_JS, scope)


# ── Barre allégée (22/10/2026, « trop de boutons ») ─────────────────────────────
# Les commandes rares sont rangées dans des menus montés seulement à l'ouverture.
# `ouvrir_menu_range(page, sélecteur)` : si le sélecteur n'est pas dans la page, ouvre le
# menu qui le contient (« Outils ▾ », « Édition ▾ », « Options ▾ », « Vue ▾ », « Session ▾ »,
# « ⋯ » d'une piste, « Ø · Trim ▾ » d'une tranche). Renvoie True si un menu a été ouvert.
MENUS_RANGES = [
    (("tool-scrub", "tool-zoom", "tool-pencil", "pencil-shape", "toggle-gain-line", "toggle-gain-info", "toggle-loop-trim", "trim-tce"), "tools-more"),
    (("data-edit-mode", "data-grid-option", "nova-nudge", "automation-follows", "Pas du décalage", "Courbe des fondus"), "grid-value"),
    (("open-metronome", "open-warmup", "monitor-panel", "monitor-matrix", "monitor-dim", "monitor-cut", "monitor-volume", "solo-listen",
      "practice-speed-panel", "practice-preset", "practice-speed-slider", 'data-nova-target="punch"', "Réglages du punch"), "transport-options"),
    (("chord-lane-toggle", "Afficher le navigateur", "Masquer le navigateur"), "view-menu"),
    (("dock-track-list", "dock-groups", "dock-time", "dock-session", "dock-reviews"), "dock-session-menu"),
]


def ouvrir_menu_range(page, sel, tap=False, piste=None, tranche=None):
    try:
        if page.locator(sel).locator("visible=true").count():
            return False
    except Exception:
        pass
    trig = None
    if piste:
        trig = f'track-more-{piste}'
    elif tranche:
        trig = f'strip-more-{tranche}'
    else:
        for keys, t in MENUS_RANGES:
            if any(k in sel for k in keys):
                trig = t
                break
    if not trig:
        return False
    loc = page.locator(f'[data-testid="{trig}"]').locator("visible=true")
    if not loc.count():
        return False
    (loc.first.tap() if tap else loc.first.click())
    page.wait_for_timeout(350)
    return True


def ouvrir_master_nova(page):
    """Master Nova : bouton de la barre s'il existe (mode avancé : rangé dans le menu ☰ depuis le 22/10/2026)."""
    b = page.locator("[data-nova-open-master]").locator("visible=true")
    if b.count():
        b.first.click(); return
    page.locator("[data-testid=transport-menu]").locator("visible=true").first.click(); page.wait_for_timeout(350)
    page.locator("[data-testid=menu-master-nova]").locator("visible=true").first.click()

# Piano roll pratique (22/10/2026) : la barre ne montre que l'outil actif, la grille et la gamme ;
# les autres commandes sont rangées dans « Outil ▾ », « Outils ▾ », « Notes ▾ », « Vue ▾ ».
ROLL_MENUS = ("outil", "outils", "notes", "vue")


def roll_reveal(page, sel):
    """Rend visible une commande du piano roll (ouvre le menu qui la range) et renvoie son localisateur."""
    vis = page.locator(sel).locator("visible=true")
    if vis.count():
        return vis.first
    for m in ROLL_MENUS:
        btn = page.locator(f"[data-nova-roll-menu-btn={m}]")
        if not btn.count():
            break
        btn.first.click(); page.wait_for_timeout(150)
        loc = page.locator(f"[data-nova-roll-menu=liste-{m}] {sel}")
        if loc.count():
            return loc.first
        page.keyboard.press("Escape"); page.wait_for_timeout(120)
    return page.locator(sel).first


# ── Sons des projets sans perte (audit de nuit, 22/10/2026) ─────────────────────
# Le .zip garde chaque son à l'identique : 16 bits, 24 bits ou FLOTTANT 32 bits (format 3), que le module
# `wave` de Python refuse (« unknown format: 3 »). wav_compat(raw) s'utilise comme wave.open(io.BytesIO(raw)) :
# même interface, et un WAV flottant est rendu en échantillons '<f4' avec getsampwidth() == 4.
class _WavFloat:
    def __init__(self, raw):
        import io as _io
        import soundfile as _sf
        data, sr = _sf.read(_io.BytesIO(raw), dtype="float32", always_2d=True)
        self._sr, self._ch, self._n = sr, data.shape[1], data.shape[0]
        self._bytes = data.astype("<f4").tobytes()

    def __enter__(self): return self
    def __exit__(self, *a): return False
    def getframerate(self): return self._sr
    def getnchannels(self): return self._ch
    def getnframes(self): return self._n
    def getsampwidth(self): return 4
    def readframes(self, n): return self._bytes[: n * self._ch * 4]
    def close(self): pass


def wav_compat(raw):
    import io as _io
    import wave as _wave
    try:
        return _wave.open(_io.BytesIO(raw))
    except _wave.Error:
        return _WavFloat(raw)
