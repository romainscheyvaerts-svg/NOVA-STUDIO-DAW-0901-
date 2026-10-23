"""Audit tactile de NOVA : téléphones et tablettes au doigt (Chrome headless, aucune fenêtre).

Appareils émulés (écran tactile, `hasTouch`, `isMobile`, zones de sécurité de l'encoche / de la
barre d'accueil simulées par le DevTools : Emulation.setSafeAreaInsetsOverride) :
  iphone        390 × 844 portrait (iPhone 13 / 14), encoche 47 px, barre d'accueil 34 px ;
  iphone_pay    844 × 390 paysage, encoche à gauche (47 px), barre d'accueil 21 px ;
  android       360 × 800 (petit Android), barre d'état 24 px ;
  ipad          820 × 1180 portrait (iPad Air) ;
  ipad_pay      1180 × 820 paysage ;
  ipad_mini     744 × 1133 portrait.
Thème sombre partout, thème clair sur iphone_clair / ipad_clair.

Parcours au doigt (que des touchers, aucun clavier) : accueil → choisir une instru → REC → arrêter →
écouter → exporter (fenêtre d'export), avec le compte des gestes et le temps ; puis l'inventaire des
écrans du mode avancé (onglets du téléphone, console et arrangement de la tablette, menu ☰).

Sur chaque écran :
  - cibles tactiles visibles de moins de 44 px (zone invisible .nova-hit-tactile comprise) et de moins de 32 px ;
  - défilement horizontal parasite de la page, éléments qui sortent de l'écran ;
  - textes de moins de 12 px (et de moins de 10 px) ;
  - boutons sous l'encoche ou sous la barre d'accueil (zones de sécurité) ;
  - boutons recouverts (qalib.balayage_chevauchement).
Mesures de gestes : pincer à deux doigts sur la timeline (zoom), double-toucher (pas de zoom de la page),
glisser à un doigt (défilement), appui long (menu), fluidité (temps d'image en lecture, CPU ×4).

  NOVA_URL=http://127.0.0.1:3545/ QA_PHASE=avant PYTHONIOENCODING=utf-8 python qa/tactile_audit.py [appareil ...] [--strict]
Sorties : D:\\1 WORK\\CONTENU\\nova-tactile\\<phase>\\ (tactile_audit.json + captures)
--strict : code de sortie 1 si un seuil est dépassé (batterie).
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3545/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-tactile\{PHASE}")
sys.path.insert(0, str(Path(__file__).parent))
import qa_hors_prod  # noqa: E402,F401
from qalib import launch, OUT, Log, BASE, balayage_chevauchement, APP_MODULE_INIT, SORTIE_AUDIO_INIT  # noqa: E402
from nova_pro_lib import Chrono, app_state, save_json  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

APPAREILS = {
    "iphone": dict(w=390, h=844, mobile=True, dsf=2, insets=dict(top=47, bottom=34, left=0, right=0), theme="dark", tel=True),
    "iphone_clair": dict(w=390, h=844, mobile=True, dsf=2, insets=dict(top=47, bottom=34, left=0, right=0), theme="light", tel=True),
    "iphone_pay": dict(w=844, h=390, mobile=True, dsf=2, insets=dict(top=0, bottom=21, left=47, right=47), theme="dark", tel=True),
    "android": dict(w=360, h=800, mobile=True, dsf=2, insets=dict(top=24, bottom=0, left=0, right=0), theme="dark", tel=True),
    "ipad": dict(w=820, h=1180, mobile=True, dsf=1, insets=dict(top=24, bottom=20, left=0, right=0), theme="dark", tel=False),
    "ipad_clair": dict(w=820, h=1180, mobile=True, dsf=1, insets=dict(top=24, bottom=20, left=0, right=0), theme="light", tel=False),
    "ipad_pay": dict(w=1180, h=820, mobile=True, dsf=1, insets=dict(top=24, bottom=20, left=0, right=0), theme="dark", tel=False),
    "ipad_mini": dict(w=744, h=1133, mobile=True, dsf=1, insets=dict(top=24, bottom=20, left=0, right=0), theme="dark", tel=False),
}
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
STRICT = "--strict" in sys.argv
WANT = [a for a in ARGS if a in APPAREILS] or list(APPAREILS)
CHANT_S = 2

# ---------------------------------------------------------------------------------------- mesures
MESURE_JS = r"""(ins) => {
  const W = innerWidth, H = innerHeight;
  const sel = 'button, [role=button], a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=switch], [role=slider], [role=menuitem], [role=option], [role=checkbox], [role=radio], summary';
  const vis = el => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0 || s.pointerEvents === 'none') return false; return true; };
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.innerText || el.title || el.getAttribute('placeholder') || el.tagName || '').toString().trim().replace(/\s+/g, ' ').slice(0, 40);
  // Partie réellement visible (coupée par les conteneurs qui défilent / masquent).
  const visRect = el => { const r = el.getBoundingClientRect(); let L = Math.max(r.left, 0), T = Math.max(r.top, 0), R = Math.min(r.right, W), B = Math.min(r.bottom, H);
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) { const q = p.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); } }
    return { L, T, R, B, r }; };
  // Zone de toucher : la boîte, élargie par la zone invisible ::after (.nova-hit / .nova-hit-tactile) ;
  // un <input type=range> touché sur toute sa hauteur.
  const hit = el => { const r = el.getBoundingClientRect(); let w = r.width, h = r.height;
    const a = getComputedStyle(el, '::after'); if (a.content && a.content !== 'none' && a.position === 'absolute') {
      const t = parseFloat(a.top) || 0, b = parseFloat(a.bottom) || 0, l = parseFloat(a.left) || 0, rr = parseFloat(a.right) || 0;
      w = Math.max(w, r.width - l - rr); h = Math.max(h, r.height - t - b); }
    // Une étiquette <label> qui entoure une case à cocher : on touche toute l'étiquette.
    const lab = el.closest('label'); if (lab) { const q = lab.getBoundingClientRect(); w = Math.max(w, q.width); h = Math.max(h, q.height); }
    return { w: Math.round(w), h: Math.round(h) }; };
  const petits = [], minuscules = [], sousEncoche = [], hors = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    if (el.hasAttribute('data-no-hit')) continue;   // témoin (diode de saturation d'un vumètre), pas une commande
    if (el.parentElement && el.parentElement.closest(sel) && !el.matches('input, select, textarea')) continue;
    const { L, T, R, B, r } = visRect(el);
    if (r.width < 2 || r.height < 2) continue;
    if (R - L < 2 || B - T < 2) continue;   // hors de la zone visible (défile)
    // Ignoré : un élément « décoratif » rendu dans un canvas, et le lien d'évitement.
    n++;
    const z = hit(el), m = Math.min(z.w, z.h);
    const it = { t: label(el), w: z.w, h: z.h, x: Math.round(r.left), y: Math.round(r.top) };
    if (m < 44) petits.push(it);
    if (m < 32) minuscules.push(it);
    if (r.right > W + 1 || r.left < -1) hors.push(it);
    // Zones de sécurité : centre du bouton dans la bande de l'encoche / de la barre d'accueil.
    const cy = (T + B) / 2, cx = (L + R) / 2;
    if ((ins.top && cy < ins.top) || (ins.bottom && cy > H - ins.bottom) || (ins.left && cx < ins.left) || (ins.right && cx > W - ins.right)) sousEncoche.push(it);
  }
  // Textes trop petits (feuilles de texte visibles).
  const textes = [], tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let tn, nPetit = 0, nMini = 0; const vus = new Set();
  while ((tn = tw.nextNode())) {
    const s = (tn.nodeValue || '').trim(); if (s.length < 2) continue;
    const el = tn.parentElement; if (!el || vus.has(el)) continue; vus.add(el);
    if (!vis(el)) continue;
    const { L, T, R, B } = visRect(el); if (R - L < 2 || B - T < 2) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) { nPetit++; if (fs < 10) nMini++; if (textes.length < 25) textes.push({ t: s.slice(0, 30), px: fs }); }
  }
  const de = document.scrollingElement || document.documentElement;
  const hscroll = Math.max(de.scrollWidth, document.body.scrollWidth) - W;
  // Éléments (non interactifs compris) qui sortent à droite de l'écran sans être dans une zone qui défile.
  const sorties = [];
  for (const el of document.querySelectorAll('body *')) {
    if (sorties.length > 12) break;
    const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.right <= W + 2) continue;
    if (!vis(el)) continue;
    let clipped = false; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX) && p.getBoundingClientRect().right <= W + 2) { clipped = true; break; } }
    if (!clipped && r.left < W) sorties.push({ el: el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').slice(0, 3).join('.'), t: (el.innerText || '').trim().slice(0, 30), right: Math.round(r.right) });
  }
  return { cibles: n, petits_44: petits.length, petits_32: minuscules.length, liste_44: petits.slice(0, 40), liste_32: minuscules.slice(0, 25),
           texte_12: nPetit, texte_10: nMini, textes: textes, hscroll, hors_ecran: hors.slice(0, 15), sorties: sorties.slice(0, 12),
           sous_encoche: sousEncoche.slice(0, 15), n_sous_encoche: sousEncoche.length,
           touch_action_html: getComputedStyle(document.documentElement).touchAction, zoom: visualViewport ? visualViewport.scale : 1 };
}"""

FIND = r"""([src, flags]) => {
  const rx = new RegExp(src, flags);
  document.querySelectorAll('[data-qa-tt]').forEach(e => e.removeAttribute('data-qa-tt'));
  const sel = 'button, [role=button], [role=menuitem], [role=tab], [role=option], a';
  let best = null, score = -1;
  for (const el of document.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const st = getComputedStyle(el); if (st.visibility === 'hidden' || st.display === 'none') continue;
    const al = (el.getAttribute('aria-label') || '').trim(), tx = (el.innerText || '').trim().replace(/\s+/g, ' '), ti = (el.title || '').trim(), id = el.getAttribute('data-testid') || '';
    const s = rx.test(al) ? 4 : rx.test(tx) ? 3 : rx.test(id) ? 2 : rx.test(ti) ? 1 : 0;
    if (s > score) { score = s; best = el; }
  }
  if (!best || score <= 0) return null;
  best.setAttribute('data-qa-tt', '1');
  const r = best.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const off = cy > innerHeight - 1 || cx > innerWidth - 1 || cy < 0 || cx < 0;
  const h = off ? null : document.elementFromPoint(cx, cy);
  return { off, couvert: !off && !(h && (best.contains(h) || h.contains(best))), t: (best.getAttribute('aria-label') || best.innerText || '').trim().slice(0, 50) };
}"""

DIALOGUES = """() => [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true]')]
  .filter(d => d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden')
  .map(d => (d.getAttribute('aria-label') || d.querySelector('h1,h2,h3')?.innerText || d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90))"""


def new_ctx(browser, cfg, log):
    ctx = browser.new_context(viewport={"width": cfg["w"], "height": cfg["h"]}, has_touch=True, is_mobile=cfg["mobile"],
                              device_scale_factor=cfg["dsf"], permissions=["microphone"], accept_downloads=True, locale="fr-BE")
    ctx.route("**/downloads/nova-studio-latest.json*", lambda route, request: route.fulfill(status=200, content_type="application/json", body="{}"))
    qa_hors_prod.install(ctx, log)
    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script(LATENCE_INIT)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{cfg['theme']}'); }} catch (e) {{}}")
    ctx.add_init_script(SORTIE_AUDIO_INIT % json.dumps("Casque (Realtek(R) Audio)"))
    page = ctx.new_page()
    page.set_default_timeout(20000)
    page.on("console", lambda m: log.add(f"console.{m.type}", m.text) if m.type in ("error",) else None)
    page.on("pageerror", lambda e: log.add("pageerror", e))
    cdp = ctx.new_cdp_session(page)
    ins = cfg["insets"]
    try:
        cdp.send("Emulation.setSafeAreaInsetsOverride", {"insets": {k: ins[k] for k in ("top", "bottom", "left", "right")}})
        page._safe = True
    except Exception as e:  # noqa
        page._safe = False
        log.add("info", f"zones de sécurité non simulées : {e}")
    page._cdp = cdp
    return ctx, page


class Audit:
    def __init__(self, nom, cfg, page, log):
        self.nom, self.cfg, self.page, self.log = nom, cfg, page, log
        self.ch = Chrono(nom, page, log, OUT)
        self.ecrans = {}
        self.gestes = {}

    def find(self, rx, flags="i"):
        return self.page.evaluate(FIND, [rx, flags])

    def geste(self, rx, label, flags="i", scroll_ok=True):
        info = self.find(rx, flags)
        if not info:
            return False
        loc = self.page.locator("[data-qa-tt]").first
        if info["off"]:
            if not scroll_ok:
                return False
            self.ch.friction(f"« {label} » hors de l'écran")
            loc.scroll_into_view_if_needed()
            if self.ch.cur: self.ch.cur["clics"] += 1; self.ch.cur["chemin"].append(f"défiler jusqu'à {label}")
            self.page.wait_for_timeout(200)
            info = self.find(rx, flags); loc = self.page.locator("[data-qa-tt]").first
        if info and info.get("couvert"):
            self.ch.friction(f"« {label} » recouvert")
            loc.tap(force=True)
            if self.ch.cur: self.ch.cur["clics"] += 1; self.ch.cur["chemin"].append(f"doigt {label} (forcé)")
            self.page.wait_for_timeout(150)
            return True
        self.ch.tap(loc, label)
        return True

    def ecran(self, cle):
        self.page.wait_for_timeout(300)
        path = OUT / f"{self.nom}_{cle}.png"
        self.page.screenshot(path=str(path))
        m = self.page.evaluate(MESURE_JS, self.cfg["insets"])
        try:
            m["recouverts"] = balayage_chevauchement(self.page).get("recouverts", [])[:10]
        except Exception as e:  # noqa
            m["recouverts"] = [f"erreur {e}"]
        m["capture"] = str(path)
        self.ecrans[cle] = m
        print(f"   [{cle}] cibles={m['cibles']} <44px={m['petits_44']} <32px={m['petits_32']} texte<12={m['texte_12']} "
              f"hscroll={m['hscroll']} sous_encoche={m['n_sous_encoche']} recouverts={len(m['recouverts'])} sorties={len(m['sorties'])}", flush=True)
        return m

    def interpositions(self, contexte):
        for _ in range(5):
            dl = self.page.evaluate(DIALOGUES)
            if not dl: return
            txt = " | ".join(dl)
            if re.search(r"casque ou des écouteurs", txt):
                self.ch.friction(f"{contexte} : question « casque ? »")
                if not self.geste(r"^Oui, j'ai un casque", "Oui, casque"): return
            elif re.search(r"en 3 gestes|C'est parti", txt):
                self.ch.friction(f"{contexte} : fenêtre d'accueil")
                if not self.geste(r"^(C'est parti|Plus tard)$", "C'est parti"): return
            else:
                return
            self.page.wait_for_timeout(250)


def nb_prises(page):
    return app_state(page, "s => s.tracks.reduce((n, t) => n + (t.id === 'instrumental' ? 0 : t.clips.length), 0)") or 0


def set_simple(page, on):
    page.evaluate("async (on) => (await window.__novaAppModule('/utils/simpleMode.ts')).simpleModeStore.setPref(on)", on)
    page.wait_for_timeout(500)


def parcours(a: Audit):
    page, ch = a.page, a.ch
    # 1. accueil
    ch.start("Parcours", "Ouvrir le site")
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("[aria-label^='Poser ma voix sur']").first.wait_for(timeout=60000)
    page.wait_for_timeout(500)
    ch.end()
    a.ecran("01_accueil")
    # 2. instru
    ch.start("Parcours", "Choisir une instru")
    if not a.geste(r"^Poser ma voix sur", "Poser ma voix sur l'instru"):
        ch.fail("aucune instru")
    page.wait_for_timeout(500)
    a.interpositions("instru")
    ch.wait_js("() => !!window.__novaEdit && window.__novaEdit.getState().tracks.some(t => t.id === 'instrumental' && t.clips.length) && !/Chargement\\s*:/.test(document.body.innerText)", 60000, "beat chargé")
    page.wait_for_timeout(400)
    a.interpositions("beat chargé")
    ch.end()
    a.ecran("02_studio")
    # 3. prises (deux d'affilée)
    for k in (1, 2):
        ch.start("Parcours", f"Prise {k}")
        n0 = nb_prises(page)
        if not a.geste(r"^Enregistrer$", "REC"):
            ch.fail("REC introuvable")
        page.wait_for_timeout(300)
        a.interpositions("REC")
        ch.wait_js("() => window.__novaEdit.getState().isRecording", 20000, "enregistrement")
        page.wait_for_timeout(CHANT_S * 1000)
        if k == 1:
            a.ecran("03_pendant_prise")
        if not a.geste(r"^Arrêter l'enregistrement$", "Arrêter"):
            ch.fail("Arrêter introuvable")
        ch.wait_js(f"() => !window.__novaEdit.getState().isRecording && window.__novaEdit.getState().tracks.reduce((n, t) => n + (t.id === 'instrumental' ? 0 : t.clips.length), 0) > {n0}", 20000, "prise posée")
        ch.end()
        page.wait_for_timeout(2900)
    a.ecran("04_apres_prises")
    # 4. écouter
    ch.start("Parcours", "Écouter")
    if not a.geste(r"^Lecture$", "Lecture"):
        ch.fail("Lecture introuvable")
    ch.wait_js("() => window.__novaEdit.getState().isPlaying", 8000, "lecture")
    page.wait_for_timeout(1200)
    a.geste(r"^Pause$", "Pause")
    ch.end()
    # 5. exporter
    ch.start("Parcours", "Exporter (fenêtre d'export)")
    if not a.geste(r"^(Exporter le mix|Exporter|Exporter ma démo)$", "Exporter", scroll_ok=False):
        ch.friction("« Exporter » pas visible : menu ☰")
        if a.geste(r"^Ouvrir le menu$", "menu ☰"):
            page.wait_for_timeout(300)
            if not a.geste(r"Exporter", "Exporter (menu)"):
                ch.fail("Exporter introuvable dans le menu")
        else:
            ch.fail("ni Exporter ni menu")
    ch.wait_js("() => [...document.querySelectorAll('[role=dialog], [aria-modal=true]')].some(d => d.getClientRects().length && /export/i.test(d.innerText))", 10000, "fenêtre d'export")
    ch.end()
    a.ecran("05_export")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    for _ in range(2):
        if page.evaluate(DIALOGUES):
            a.geste(r"^(Fermer|Annuler|×|✕)$", "fermer")
            page.wait_for_timeout(300)


def ecrans_avances(a: Audit):
    page = a.page
    set_simple(page, False)
    page.wait_for_timeout(400)
    if a.cfg["tel"]:
        a.ecran("10_morceau_avance")
        for tab, cle in (("TRACKS", "11_pistes"), ("MIXER", "12_mixer"), ("PLUGINS", "13_fx"), ("BROWSER", "14_sons"), ("NOVA", "15_nova")):
            b = page.locator(f"[data-nova-target='tab-{tab}']").first
            try:
                b.tap(timeout=3000)
            except Exception:
                continue
            page.wait_for_timeout(600)
            a.ecran(cle)
        try:
            page.locator("[data-nova-target='tab-ARRANGEMENT']").first.tap(timeout=3000)
        except Exception as e:  # noqa
            print("   retour Morceau impossible :", str(e)[:120], flush=True)
        page.wait_for_timeout(500)
    else:
        a.ecran("10_arrangement_avance")
        # Console : bouton de la barre, sinon menu ☰ (barre repliée faute de place).
        ok = a.geste(r"^(Mixer|Console|Mix)$", "Console", scroll_ok=False)
        if not ok and a.geste(r"^Ouvrir le menu$", "menu ☰", scroll_ok=False):
            page.wait_for_timeout(300)
            ok = a.geste(r"^(Console|Mixer|Table de mixage)", "Console (menu)", scroll_ok=False)
        if ok:
            page.wait_for_timeout(900)
            a.ecran("12_console")
            ok2 = a.geste(r"^(Pistes|Arrangement)$", "Pistes", scroll_ok=False)
            if not ok2 and a.geste(r"^Ouvrir le menu$", "menu ☰", scroll_ok=False):
                page.wait_for_timeout(300)
                a.geste(r"^(Pistes|Arrangement)", "Pistes (menu)", scroll_ok=False)
            page.wait_for_timeout(600)
    # menu ☰
    if a.geste(r"^Ouvrir le menu$", "menu ☰", scroll_ok=False):
        page.wait_for_timeout(400)
        a.ecran("16_menu")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    set_simple(page, True)


# Zone de la timeline (téléphone : sous la règle de la page Morceau ; tablette / ordinateur : zone des
# pistes de l'arrangement, à droite des en-têtes) et zoom horizontal lu dans la page.
TIMELINE_JS = r"""() => {
  const ruler = document.querySelector('[data-testid=mobile-ruler]');
  let sc = null, x = 0, y = 0, hw = 0;
  if (ruler && ruler.getClientRects().length) {
    sc = ruler.parentElement; while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
    if (!sc) return null; const r = sc.getBoundingClientRect(), rr = ruler.getBoundingClientRect();
    x = r.left + r.width / 2; y = Math.min(r.bottom - 20, rr.bottom + 50, innerHeight - 140);
  } else {
    sc = document.querySelector('[data-arrange-scroll]'); if (!sc || !sc.getClientRects().length) return null;
    const r = sc.getBoundingClientRect();
    // Colonne des en-têtes de pistes (collée à gauche dans la zone qui défile).
    for (const el of sc.querySelectorAll('*')) { const s = getComputedStyle(el); if (s.position === 'sticky' && s.left === '0px') { const q = el.getBoundingClientRect(); if (q.width > 60 && q.width < r.width / 2) { hw = q.width; break; } } }
    x = r.left + hw + (r.width - hw) * 0.55; y = Math.min(r.bottom - 30, r.top + 200);
  }
  const r = sc.getBoundingClientRect();
  // Point « vide » (ni clip ni bouton) dans la zone des pistes, en partant du bas : pour glisser / double-toucher.
  let vy = null;
  for (let yy = Math.min(r.bottom, innerHeight - 130) - 12; yy > r.top + 50; yy -= 12) {
    const e = document.elementFromPoint(x, yy);
    if (e && sc.contains(e) && !e.closest('[data-clip-id], button, [role=button], input, [data-testid=mobile-ruler]')) { vy = Math.round(yy); break; }
  }
  const zoom = sc.getAttribute('data-zoom-h') ? +sc.getAttribute('data-zoom-h') : (ruler ? ruler.getBoundingClientRect().width : null);
  return { x: Math.round(x), y: Math.round(y), vy, left: Math.round(r.left), hw: Math.round(hw), zoom, sl: Math.round(sc.scrollLeft), st: Math.round(sc.scrollTop), sw: sc.scrollWidth };
}"""

LATENCE_INIT = r"""(() => { window.__lat = []; try { new PerformanceObserver(l => { for (const e of l.getEntries())
  if (/^(pointerup|pointerdown|click|touchend|touchstart|keydown)$/.test(e.name)) window.__lat.push({ n: e.name, d: Math.round(e.duration), t: Math.round(e.startTime) }); })
  .observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch (e) {} })();"""


def gestes(a: Audit):
    """Gestes au doigt sur la timeline : double-toucher (zoom de la page ?), pincer (zoom de la timeline,
    ancré sous les doigts ?), glisser à un doigt (défilement), temps d'image en lecture et latence au
    toucher avec un processeur 4 fois plus lent."""
    page, cdp = a.page, a.page._cdp
    r = {}

    def touch(t, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": t, "touchPoints": [{"x": x, "y": y, "id": i, "radiusX": 4, "radiusY": 4, "force": 1} for i, (x, y) in enumerate(pts)]})

    tl = page.evaluate(TIMELINE_JS)
    r["timeline"] = tl
    if not tl:
        a.gestes = r
        print("   gestes : timeline introuvable", flush=True)
        return
    cx, cy = tl["x"], tl["y"]
    vy = tl.get("vy")
    # Double-toucher sur une zone vide des pistes (s'il y en a une) : la page ne doit pas zoomer.
    if vy:
        for _ in range(2):
            touch("touchStart", [(cx, vy)]); touch("touchEnd", []); page.wait_for_timeout(80)
        page.wait_for_timeout(400)
    r["zoom_page_apres_double_toucher"] = page.evaluate("() => visualViewport ? visualViewport.scale : 1")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    # Barre du clip ouverte (clip touché) : on la ferme, puis on relit la place de la timeline.
    try:
        b = page.locator("button[aria-label=\"Fermer la barre d'édition du clip\"]").locator("visible=true")
        if b.count(): b.first.tap(); page.wait_for_timeout(300)
    except Exception:
        pass
    tl = page.evaluate(TIMELINE_JS) or tl
    cx, cy = tl["x"], tl["y"]
    # Pincer (écarter les doigts) : la timeline zoome ; l'instant sous les doigts reste sous les doigts.
    a0 = page.evaluate(TIMELINE_JS)
    touch("touchStart", [(cx - 40, cy), (cx + 40, cy)])
    for k in range(1, 11):
        touch("touchMove", [(cx - 40 - 8 * k, cy), (cx + 40 + 8 * k, cy)])
        page.wait_for_timeout(20)
    touch("touchEnd", [])
    page.wait_for_timeout(500)
    a1 = page.evaluate(TIMELINE_JS)
    p = {"zoom_avant": a0["zoom"], "zoom_apres": a1["zoom"], "defilement_avant": a0["sl"], "defilement_apres": a1["sl"],
         "zoom_page": page.evaluate("() => visualViewport ? visualViewport.scale : 1")}
    if a0["zoom"] and a1["zoom"]:
        f = a1["zoom"] / a0["zoom"]
        p["facteur"] = round(f, 2)
        # Écart à l'écran (px) de l'instant qui était sous le milieu des doigts : 0 = zoom ancré sous les doigts.
        hw, left = a0["hw"], a0["left"]
        p["derive_px"] = round(abs((a0["sl"] + cx - left - hw) * f + hw - a1["sl"] + left - cx), 1)
    # Rapprocher les doigts : retour (dézoom).
    sp = max(90, min(120, cx - tl["left"] - tl["hw"] - 8))
    touch("touchStart", [(cx - sp, cy), (cx + sp, cy)])
    for k in range(1, 11):
        touch("touchMove", [(cx - sp + 7 * k, cy), (cx + sp - 7 * k, cy)])
        page.wait_for_timeout(20)
    touch("touchEnd", [])
    page.wait_for_timeout(500)
    p["zoom_apres_rapprocher"] = page.evaluate(TIMELINE_JS)["zoom"]
    r["pincer"] = p
    # Glisser à un doigt vers la gauche (geste de défilement tactile du navigateur) : la timeline défile.
    b0 = page.evaluate(TIMELINE_JS)
    vy = b0.get("vy") or cy
    try:
        b = page.locator("button[aria-label=\"Fermer la barre d'édition du clip\"]").locator("visible=true")
        if b.count(): b.first.tap(); page.wait_for_timeout(300); b0 = page.evaluate(TIMELINE_JS); vy = b0.get("vy") or b0["y"]
    except Exception:
        pass
    for essai in range(2):   # machine très chargée : un 2e essai si le 1er geste n'a rien fait défiler
        touch("touchStart", [(cx + 100, vy)])
        for k in range(1, 11):
            touch("touchMove", [(cx + 100 - 20 * k, vy)])
            page.wait_for_timeout(16)
        touch("touchEnd", [])
        page.wait_for_timeout(400)
        b1 = page.evaluate(TIMELINE_JS)
        if b1["sl"] != b0["sl"]: break
    r["glisser_un_doigt"] = {"defilement_avant": b0["sl"], "defilement_apres": b1["sl"]}
    # Fluidité : CPU ×4, lecture 3 s, temps d'image ; puis latence des touchers (Event Timing).
    try:
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
        page.evaluate("() => { window.__lat = []; }")
        a.geste(r"^Lecture$", "Lecture")
        page.wait_for_timeout(500)
        fr = page.evaluate("""() => new Promise(res => { const t = []; let last = performance.now(); const t0 = last;
          const f = (now) => { t.push(now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(f); else {
            t.sort((a, b) => a - b); const p = q => t[Math.min(t.length - 1, Math.floor(q * t.length))];
            res({ images: t.length, median_ms: +p(0.5).toFixed(1), p95_ms: +p(0.95).toFixed(1), max_ms: +t[t.length - 1].toFixed(1), longues_50ms: t.filter(x => x > 50).length }); } };
          requestAnimationFrame(f); })""")
        r["lecture_cpu4"] = fr
        a.geste(r"^Pause$", "Pause")
        page.wait_for_timeout(400)
        lat = page.evaluate("() => (window.__lat || []).map(e => e.d)")
        r["latence_toucher_cpu4_ms"] = max(lat) if lat else 0
    except Exception as e:  # noqa
        r["lecture_cpu4"] = f"erreur {e}"
    try: cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    except Exception: pass
    a.gestes = r
    print("   gestes :", json.dumps(r, ensure_ascii=False)[:600], flush=True)


def run(p, nom):
    cfg = APPAREILS[nom]
    log = Log(f"tactile_{nom}")
    b = launch(p)
    ctx, page = new_ctx(b, cfg, log)
    a = Audit(nom, cfg, page, log)
    res = {"appareil": nom, **{k: v for k, v in cfg.items()}, "zones_securite_simulees": page._safe}
    t0 = time.time()
    try:
        parcours(a)
        res["view_mode"] = page.evaluate("() => document.body.getAttribute('data-view-mode')")
        gestes(a)
        ecrans_avances(a)
    except Exception as e:  # noqa
        a.ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:200]}"); a.ch.end(ok=False)
        res["arret"] = str(e)[:400]
        try: page.screenshot(path=str(OUT / f"{nom}_arret.png"))
        except Exception: pass
    rep = a.ch.report()
    res.update({"etapes": rep["etapes"], "total": rep["total"], "ecrans": a.ecrans, "gestes": a.gestes,
                "duree_s": round(time.time() - t0, 1),
                "erreurs_console": [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:10]})
    ctx.close(); b.close()
    return res


def resume(r):
    e = r["ecrans"]
    return {"gestes_parcours": r["total"]["clics"], "secondes": round(r["total"]["ms"] / 1000, 1), "etapes_ko": r["total"]["etapes_ko"],
            "petits_44": sum(v["petits_44"] for v in e.values()), "petits_32": sum(v["petits_32"] for v in e.values()),
            "texte_12": sum(v["texte_12"] for v in e.values()), "hscroll": max([v["hscroll"] for v in e.values()] or [0]),
            "sous_encoche": sum(v["n_sous_encoche"] for v in e.values()), "recouverts": sum(len(v["recouverts"]) for v in e.values()),
            "sorties": sum(len(v["sorties"]) for v in e.values()), "view_mode": r.get("view_mode")}


def main():
    out = {}
    with sync_playwright() as p:
        for nom in WANT:
            print(f"== {nom}", flush=True)
            out[nom] = run(p, nom)
            out[nom]["resume"] = resume(out[nom])
            print("   résumé :", json.dumps(out[nom]["resume"], ensure_ascii=False), flush=True)
    tous = dict(out)
    try: tous = {**json.loads((OUT / "tactile_audit.json").read_text(encoding="utf-8")).get("appareils", {}), **out}
    except Exception: pass
    save_json(OUT / "tactile_audit.json", {"phase": PHASE, "url": BASE, "date": time.strftime("%Y-%m-%d %H:%M"), "appareils": tous})
    ko = []
    for nom, r in out.items():
        s = r["resume"]
        e = r["ecrans"]
        if s["etapes_ko"]: ko.append(f"{nom} : {s['etapes_ko']} étape(s) du parcours en échec")
        if s["hscroll"] > 1: ko.append(f"{nom} : défilement horizontal de la page ({s['hscroll']} px)")
        # Téléphone : aucune cible sous 32 px. Tablette (vues denses du studio : console, arrangement) : aucune sous 24 px.
        if r.get("tel") and s["petits_32"]: ko.append(f"{nom} : {s['petits_32']} cible(s) de moins de 32 px")
        mini = [i for v in e.values() for i in v.get("liste_32", []) if min(i["w"], i["h"]) < 24]
        if not r.get("tel") and mini: ko.append(f"{nom} : {len(mini)} cible(s) de moins de 24 px {[(i['t'], i['w'], i['h']) for i in mini][:4]}")
        # Parcours (accueil → studio → prises → export) : rien de recouvert, rien sous l'encoche.
        for k in ("01_accueil", "02_studio", "03_pendant_prise", "04_apres_prises"):
            v = e.get(k)
            if not v: ko.append(f"{nom} : écran {k} non mesuré"); continue
            if v["recouverts"]: ko.append(f"{nom} {k} : bouton(s) recouvert(s) {[x.get('el') if isinstance(x, dict) else x for x in v['recouverts']][:3]}")
            if v["n_sous_encoche"]: ko.append(f"{nom} {k} : bouton(s) sous l'encoche / la barre d'accueil {[x['t'] for x in v['sous_encoche']][:3]}")
        g = r.get("gestes") or {}
        if g.get("zoom_page_apres_double_toucher", 1) != 1: ko.append(f"{nom} : le double-toucher zoome la page")
        p = g.get("pincer") or {}
        if not p or (p.get("facteur") or 1) < 1.5: ko.append(f"{nom} : pincer n'agrandit pas la timeline {p}")
        elif (p.get("derive_px") or 0) > 24: ko.append(f"{nom} : le zoom au pincement n'est pas ancré sous les doigts ({p.get('derive_px')} px)")
        if p and p.get("zoom_apres_rapprocher") and p.get("zoom_apres") and p["zoom_apres_rapprocher"] >= p["zoom_apres"]: ko.append(f"{nom} : rapprocher les doigts ne dézoome pas")
        gl = g.get("glisser_un_doigt") or {}
        if gl and gl.get("defilement_apres") == gl.get("defilement_avant"): ko.append(f"{nom} : glisser à un doigt ne fait pas défiler la timeline")
        # Erreurs de la console (hors réponses 4xx des services SIMULÉS — tarif nova-billing, session — déjà là avant).
        errs = [x for x in r.get("erreurs_console", []) if not re.search(r"Failed to load resource: the server responded with a status of 4\d\d", x)]
        if errs: ko.append(f"{nom} : erreurs console {errs[:2]}")
    for k in ko: print("KO", k)
    sys.exit(1 if (STRICT and ko) else 0)


if __name__ == "__main__":
    main()
