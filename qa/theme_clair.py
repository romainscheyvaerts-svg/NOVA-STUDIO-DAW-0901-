"""Thème clair : garde-fou contre les écrans qui restent sombres ou deviennent illisibles.

Signalé par Romain le 13/10/2026 : « sur la page d'accueil du DAW, le thème noir/blanc reste
sur noir quand on met blanc ». Ce scénario ouvre les écrans principaux en thème CLAIR (et en
sombre, pour comparer) au PC (1600 × 900) et au téléphone (390 × 844), capture chaque écran et
échoue si, en clair :

  1. une GRANDE ZONE reste très sombre (fond calculé de l'élément, et pixels de la capture) ;
  2. un TEXTE est peu contrasté sur son fond (texte blanc sur fond clair, gris pâle…) ;
  3. la bascule du thème ne s'applique pas tout de suite, ne tient pas au rechargement, ou
     n'est pas suivie quand le DAW est intégré au site (message NOVA_THEME / ?theme=light).

Zones sombres VOULUES (exclues des mesures) : images, vidéos, et les zones marquées
« .nova-sombre » ou « [data-nova-sombre] » (façades d'effets dessinées comme du matériel,
écrans de mesure). Ce choix se marque dans le code, jamais ici. Les dessins (canvas : timeline,
formes d'onde, règles) sont exclus de la lecture des styles mais COMPTÉS dans les pixels de la
capture : une règle peinte en marine en thème clair y est repérée (bande sombre).

Écrans : accueil (+ connexion, charger un projet), studio (barre du haut, pistes, timeline,
bandeau du bas), console de mixage, fenêtres (export, réglages audio, collaboration,
commentaires et versions, palette Ctrl+K, menu du clip, ajout d'effet, modèles, Master Nova,
tempo, aide), pages du téléphone (Morceau, Pistes, Mixer, FX, Sons, Nova), page d'écoute.
Chrome headless (aucune fenêtre), Supabase simulé (qa_hors_prod), compte simulé.

  NOVA_URL=http://127.0.0.1:3443/ PYTHONIOENCODING=utf-8 python qa/theme_clair.py [--formats pc,tel390] [--audit]
  --audit : mesure et capture sans échouer (pour l'état « avant »).
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-theme-clair\\qa) : captures + theme_clair.json
"""
import argparse, json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3443/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-theme-clair\qa")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, BASE, Log, FAKE_WAV  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN, NON_ABONNE  # noqa: E402
from nova_pro_lib import track_point  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # make_project, open_with_project…
from playwright.sync_api import sync_playwright  # noqa: E402
from PIL import Image  # noqa: E402

# Seuils (thème clair)
LUM_SOMBRE = 0.05        # luminance relative sous laquelle un fond est « très sombre » (≈ #3d3d3d)
AIRE_MIN = 0.012         # part de l'écran au-delà de laquelle une zone sombre compte
PIXELS_SOMBRES_MAX = 0.06  # part maximale de pixels très sombres dans une capture (hors zones voulues)
CONTRASTE_MIN = 3.0      # en dessous : texte illisible (AA « grand texte » = 3:1 ; texte courant visé 4,5:1)

ZONES_VOULUES = ".nova-sombre, [data-nova-sombre], canvas, img, video, picture, iframe"
# Pour les pixels, les dessins (canvas) COMPTENT : une règle de timeline peinte en marine se voit
# là, pas dans les styles. Un dessin sombre voulu se marque [data-nova-sombre].
PIXELS_VOULUS = ".nova-sombre, [data-nova-sombre], img, video, picture, iframe"
BANDE_LIGNES = 5         # bande sombre : 5 lignes réduites (≈ 20 px) d'affilée sombres à plus de 50 %

AUDIT_JS = r"""(opts) => {
  const VOULUES = opts.voulues;
  const vw = innerWidth, vh = innerHeight, minAire = Math.max(4000, vw * vh * opts.aireMin);
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const opac = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); o *= +cs.opacity; if (cs.visibility === 'hidden' || cs.display === 'none') return 0; } return o; };
  const desc = (el) => {
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 8).join('.');
    const id = el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('role') || '';
    return `${el.tagName.toLowerCase()}${id ? '[' + id.slice(0, 30) + ']' : ''}${cls ? '.' + cls : ''}`.slice(0, 160);
  };
  // Fond effectif sous un élément : on empile les fonds semi-transparents jusqu'au premier opaque.
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
  const fondDe = (el) => {
    const pile = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/url\(/.test(cs.backgroundImage)) return null; // dégradé : inconnu
      if (cs.backgroundImage && /url\(/.test(cs.backgroundImage)) return null;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { pile.push(c); if (c[3] >= 0.99) break; }
    }
    let base = (pile.length && pile[pile.length - 1][3] >= 0.99) ? pile.pop() : bodyBg;
    while (pile.length) base = over(pile.pop(), base);
    return base;
  };
  const zones = [], textes = [];
  let n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (++n > 9000) break;
    if (el.closest(VOULUES)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    const cs = getComputedStyle(el);
    // 1. grande zone très sombre
    const w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w * h >= minAire) {
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] >= 0.6 && lum(bg) < opts.lumSombre && opac(el) > 0.3)
        zones.push({ el: desc(el), fond: cs.backgroundColor, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(w), h: Math.round(h) });
    }
    // 2. texte peu contrasté (nœud texte direct, visible)
    let txt = '';
    for (const c of el.childNodes) if (c.nodeType === 3) txt += c.textContent;
    txt = txt.trim();
    if (!txt || r.width < 4 || r.height < 6) continue;
    if (el.closest('button:disabled, [aria-disabled=true], [disabled], option, select, .sr-only')) continue;
    const o = opac(el); if (o < 0.5) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = fondDe(el); if (!bg) continue;
    const c = ratio(over([fg[0], fg[1], fg[2], fg[3] * o], bg), bg);
    if (c < opts.contrasteMin) textes.push({ el: desc(el), texte: txt.slice(0, 40), couleur: cs.color, fond: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`, contraste: Math.round(c * 100) / 100 });
  }
  // Rectangles des zones voulues (pour exclure leurs pixels de la capture)
  const voulues = [];
  for (const el of document.querySelectorAll(opts.pixelsVoulus)) {
    const r = el.getBoundingClientRect();
    if (r.width > 2 && r.height > 2 && el.getClientRects().length) voulues.push([Math.max(0, r.left), Math.max(0, r.top), Math.min(vw, r.right), Math.min(vh, r.bottom)]);
  }
  return { theme: document.documentElement.getAttribute('data-theme'), zones: zones.slice(0, 30), textes: textes.slice(0, 60), nTextes: textes.length, voulues: voulues.slice(0, 400) };
}"""


def pixels_sombres(path, voulues):
    """Part des pixels très sombres (luminance < ~0,05) hors zones voulues, sur une capture réduite,
    et hauteur (px) de la plus haute bande horizontale sombre (règle, barre, bandeau restés noirs)."""
    im = Image.open(path).convert("RGB")
    W, H = im.size
    k = 4
    sm = im.resize((W // k, H // k))
    px = sm.load()
    mask = [[False] * (W // k) for _ in range(H // k)]
    for x0, y0, x1, y1 in voulues:
        for yy in range(int(y0) // k, min(H // k, int(y1) // k + 1)):
            row = mask[yy]
            for xx in range(int(x0) // k, min(W // k, int(x1) // k + 1)):
                row[xx] = True
    tot = dark = 0
    suite = bande = 0
    for yy in range(H // k):
        lt = ld = 0
        for xx in range(W // k):
            if mask[yy][xx]: continue
            r, g, b = px[xx, yy]
            lt += 1
            if 0.2126 * r + 0.7152 * g + 0.0722 * b < 62: ld += 1
        tot += lt; dark += ld
        suite = suite + 1 if lt > (W // k) * 0.3 and ld > lt * 0.5 else 0
        bande = max(bande, suite)
    return (round(dark / tot, 4) if tot else 0.0), bande * k


res = {"ecrans": [], "bascule": {}, "echecs": []}


def _page(b, vp, log):
    """Page headless (qalib) ; navigation jusqu'à 90 s : le serveur de dev recompile après une modification."""
    ctx, page = new_page(b, vp, log)
    page.set_default_navigation_timeout(90000)
    return ctx, page


def mesure(page, nom, vp, theme, settle=500):
    page.wait_for_timeout(settle)
    path = OUT / f"{vp}_{theme}_{nom}.png"
    page.screenshot(path=str(path))
    a = page.evaluate(AUDIT_JS, {"voulues": ZONES_VOULUES, "pixelsVoulus": PIXELS_VOULUS, "aireMin": AIRE_MIN,
                                 "lumSombre": LUM_SOMBRE, "contrasteMin": CONTRASTE_MIN})
    frac, bande = pixels_sombres(path, a["voulues"])
    item = {"ecran": nom, "format": vp, "theme": theme, "theme_html": a["theme"], "pixels_sombres": frac, "bande_sombre_px": bande,
            "zones_sombres": a["zones"], "textes_peu_contrastes": a["textes"], "n_textes_peu_contrastes": a["nTextes"],
            "capture": path.name}
    if theme == "light":
        pb = []
        if a["theme"] != "light": pb.append(f"<html data-theme> = {a['theme']}")
        if a["zones"]: pb.append(f"{len(a['zones'])} zone(s) très sombre(s)")
        if frac > PIXELS_SOMBRES_MAX: pb.append(f"{frac:.0%} de pixels très sombres")
        if bande >= BANDE_LIGNES * 4: pb.append(f"bande sombre de {bande} px de haut")
        if a["nTextes"]: pb.append(f"{a['nTextes']} texte(s) sous {CONTRASTE_MIN}:1")
        item["ok"] = not pb
        item["problemes"] = pb
        if pb: res["echecs"].append(f"{vp}/{nom} : " + ", ".join(pb))
        print(("OK  " if not pb else "KO  ") + f"{vp:6s} {nom:28s} pixels sombres {frac:.1%}" + ("" if not pb else "  → " + " · ".join(pb)), flush=True)
        for z in a["zones"][:4]: print("      zone :", z["el"], z["fond"], f"{z['w']}×{z['h']}")
        for t in a["textes"][:6]: print("      texte :", repr(t["texte"]), t["contraste"], t["couleur"], "sur", t["fond"], t["el"][:90])
    res["ecrans"].append(item)
    return item


def fermer(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(350)
    page.keyboard.press("Escape"); page.wait_for_timeout(250)


def palette(page, query, pid):
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type(query, delay=10); page.wait_for_timeout(200)
    o = page.locator(f"[data-testid=command-palette] [data-palette-id='{pid}']")
    if o.count(): o.first.click()
    else: page.keyboard.press("Enter")
    page.wait_for_timeout(900)


def set_theme_init(ctx, theme, bienvenue_vue=True):
    vu = "localStorage.setItem('nova_welcome_seen', '1');" if bienvenue_vue else ""
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); {vu} }} catch (e) {{}}")


def essai(nom, fn):
    try:
        fn()
    except Exception as e:  # noqa
        print(f"??  {nom} : {type(e).__name__}: {str(e)[:160]}", flush=True)
        res.setdefault("gestes_impossibles", []).append(f"{nom} : {str(e)[:160]}")


def accueil(page, vp, theme):
    page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    page.wait_for_timeout(1500)
    mesure(page, "accueil", vp, theme)
    if vp != "pc":
        page.mouse.wheel(0, 900); page.wait_for_timeout(400)
        mesure(page, "accueil_catalogue", vp, theme)
        page.mouse.wheel(0, -3000)

    def auth():
        page.locator("header button:visible", has_text="Connexion").first.click(); page.wait_for_timeout(700)
        mesure(page, "connexion", vp, theme)
        fermer(page)
        if page.locator("button[aria-label=Fermer]").locator("visible=true").count():
            page.locator("button[aria-label=Fermer]").locator("visible=true").first.click()
    essai("connexion", auth)

    def charger():
        page.get_by_role("button", name=re.compile("Charger Projet")).first.click(); page.wait_for_timeout(600)
        mesure(page, "charger_projet", vp, theme)
        page.locator("button[aria-label=Fermer]").locator("visible=true").first.click(); page.wait_for_timeout(300)
    essai("charger projet", charger)


def bascule(b):
    """Le bouton soleil / lune s'applique tout de suite, tient au rechargement ; le site peut imposer le thème."""
    ctx, page = _page(b, "pc", Log("bascule"))
    page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    r = {}
    page.locator("button[aria-label='Passer au thème clair']").first.click(); page.wait_for_timeout(400)
    r["clic_immediat"] = page.evaluate("() => document.documentElement.dataset.theme") == "light"
    r["fond_clair"] = page.evaluate("() => getComputedStyle(document.querySelector('.nova-grille')).backgroundColor")
    page.reload(timeout=90000); page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    r["garde_au_rechargement"] = page.evaluate("() => document.documentElement.dataset.theme") == "light"
    page.locator("button[aria-label='Passer au thème sombre']").first.click(); page.wait_for_timeout(300)
    r["retour_sombre"] = page.evaluate("() => document.documentElement.dataset.theme") == "dark"
    ctx.close()
    # DAW intégré au site (cadre, autre domaine) : le site impose son thème par ?theme= et par message.
    # Le « site » est servi sur l'autre nom local (localhost ⇄ 127.0.0.1) : autre origine, réseau local.
    autre = BASE.replace("127.0.0.1", "localhost") if "127.0.0.1" in BASE else BASE.replace("localhost", "127.0.0.1")

    def site(origin, src, html_style=""):
        # Page « du site » : un vrai document local (fichier statique du serveur), vidé puis garni
        # d'un cadre. Une page simulée par route() serait « publique » pour Chrome, qui refuserait
        # alors d'y charger un cadre du réseau local (Local Network Access).
        ctx, page = _page(b, "pc", Log("cadre"))
        page.goto(origin + "deploy-info.json", wait_until="domcontentloaded", timeout=90000)
        page.evaluate("""([src, st]) => { document.documentElement.innerHTML = '<body style="margin:0"></body>';
          if (st) document.documentElement.setAttribute('style', st);
          const f = document.createElement('iframe'); f.id = 'daw'; f.src = src; f.style.cssText = 'width:1580px;height:880px;border:0';
          document.body.appendChild(f); }""", [src, html_style])
        fr = page.frame_locator("#daw")
        fr.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
        frame = [f for f in page.frames if f != page.main_frame][0]
        return ctx, page, fr, frame

    ctx, page, fr, frame = site(autre, BASE + "?embed=1&theme=light")
    theme = lambda: frame.evaluate("() => document.documentElement.dataset.theme")
    r["cadre_theme_url"] = theme() == "light"
    r["cadre_bouton_visible"] = fr.locator("button[aria-label^='Passer au thème']").locator("visible=true").count() > 0
    page.screenshot(path=str(OUT / "pc_light_accueil_dans_le_site.png"))
    page.evaluate("() => document.getElementById('daw').contentWindow.postMessage({ type: 'NOVA_THEME', theme: 'dark' }, '*')")
    page.wait_for_timeout(400)
    r["cadre_message_sombre"] = theme() == "dark"
    page.evaluate("() => document.getElementById('daw').contentWindow.postMessage({ type: 'NOVA_THEME', theme: 'light' }, '*')")
    page.wait_for_timeout(400)
    r["cadre_message_clair"] = theme() == "light"
    ctx.close()
    # Même domaine (copie embarquée dans l'appli iPhone) : le DAW lit <html class="dark"> du site, en direct.
    ctx, page, fr, frame = site(BASE, BASE + "?embed=1", "--background: 0 0% 100%")
    theme = lambda: frame.evaluate("() => document.documentElement.dataset.theme")
    r["meme_domaine_clair"] = theme() == "light"
    page.evaluate("() => document.documentElement.classList.add('dark')"); page.wait_for_timeout(400)
    r["meme_domaine_sombre_en_direct"] = theme() == "dark"
    page.evaluate("() => document.documentElement.classList.remove('dark')"); page.wait_for_timeout(400)
    r["meme_domaine_clair_en_direct"] = theme() == "light"
    ctx.close()
    res["bascule"] = r
    for k, v in r.items():
        if v is False:
            res["echecs"].append(f"bascule : {k}")
    print(("OK  " if all(v is not False for v in r.values()) else "KO  ") + "bascule du thème " + json.dumps(r, ensure_ascii=False), flush=True)


def studio_pc(b, theme, zpath):
    log = Log(f"studio_pc_{theme}")
    ctx, page = _page(b, "pc", log)
    set_theme_init(ctx, theme)
    accueil(page, "pc", theme)
    install_mocks(page, "romain", SUPERADMIN, {})
    open_with_project(page, zpath)
    page.mouse.click(5, 300); page.keyboard.press("Escape")
    mesure(page, "studio", "pc", theme, 900)
    windows = [
        ("export", lambda: page.keyboard.press("Control+Shift+E")),
        ("palette", lambda: (page.keyboard.press("Control+k"), page.wait_for_timeout(300), page.keyboard.type("ex", delay=10))),
        ("reglages_audio", lambda: palette(page, "audio carte son", "pal.audio")),
        ("collaboration", lambda: palette(page, "collaborer", "pal.collab")),
        ("commentaires_versions", lambda: palette(page, "commentaires versions", "pal.reviews")),
        ("modeles", lambda: palette(page, "modeles", "pal.templates")),
        ("master_nova", lambda: palette(page, "master nova", "pal.masterNova")),
        ("tempo", lambda: palette(page, "tempo", "pal.tempo")),
        ("aide_raccourcis", lambda: page.keyboard.press("Shift+Slash")),
        ("menu_clip", lambda: page.mouse.click(*track_point(page, "voix", 3.0), button="right")),
        ("partage", lambda: palette(page, "partager", "pal.share")),
        ("groupes", lambda: palette(page, "groupes", "pal.groups")),
        ("justesse_note_par_note", lambda: (page.mouse.click(*track_point(page, "voix", 3.0)), page.wait_for_timeout(200), palette(page, "justesse", "pal.pitch"))),
        ("respirations", lambda: (page.mouse.click(*track_point(page, "voix", 3.0)), page.wait_for_timeout(200), page.keyboard.press("Control+Alt+r"))),
        ("automation", lambda: palette(page, "automation", "pal.automation")),
        ("piano_roll", lambda: palette(page, "piano roll midi", "pal.midi")),
    ]
    for nom, act in windows:
        def run(nom=nom, act=act):
            act(); page.wait_for_timeout(700)
            mesure(page, nom, "pc", theme)
        essai(nom, run)
        fermer(page)
        page.mouse.move(5, 5)

    def ajout_effet():
        fermer(page)
        palette(page, "arrangement", "view.arrangement")  # retour à l'arrangement (après automation / piano roll)
        fermer(page)
        page.locator("[data-nova-target='fx-voix']").locator("visible=true").first.click()
        page.wait_for_timeout(600)
        mesure(page, "effets_piste", "pc", theme)
        page.get_by_role("button", name=re.compile("Ajouter un effet")).locator("visible=true").first.click()
        page.wait_for_timeout(900)
        mesure(page, "ajout_effet", "pc", theme)
    essai("ajout_effet", ajout_effet)
    fermer(page)

    def mixer():
        page.keyboard.press("Control+Equal"); page.wait_for_timeout(1200)
        mesure(page, "console_mixage", "pc", theme)
        page.keyboard.press("Control+Equal"); page.wait_for_timeout(600)
    essai("console", mixer)

    def menu():
        page.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(600)
        mesure(page, "menu", "pc", theme)
    essai("menu", menu)
    fermer(page)
    res.setdefault("erreurs_console", {})[f"pc_{theme}"] = [e["text"][:200] for e in log.errors() if "8765" not in e["text"] and "8766" not in e["text"]][:10]
    ctx.close()


def studio_tel(b, theme, zpath):
    log = Log(f"studio_tel_{theme}")
    ctx, page = _page(b, "tel390", log)
    set_theme_init(ctx, theme, bienvenue_vue=False)
    accueil(page, "tel390", theme)
    install_mocks(page, "romain", SUPERADMIN, {})
    page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    try:
        page.get_by_role("button", name="C'est parti", exact=True).locator("visible=true").first.wait_for(timeout=8000)
        mesure(page, "bienvenue", "tel390", theme)
    except Exception:
        print("--  bienvenue : fenêtre d'accueil non vue", flush=True)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 60)
    page.wait_for_timeout(1500)
    close_welcome(page)
    mesure(page, "studio_morceau", "tel390", theme, 900)
    nav = page.locator("[role=navigation][aria-label='Onglets du studio']")
    labels = [t.strip() for t in nav.locator("button").all_inner_texts()]
    for lab in labels:
        if not lab or lab == "Morceau": continue
        def run(lab=lab):
            nav.locator("button", has_text=lab).first.click(); page.wait_for_timeout(900)
            mesure(page, "studio_" + re.sub(r"\W+", "_", lab.lower()), "tel390", theme)
        essai(lab, run)
        if lab == "Paroles":
            nav.locator("button", has_text=lab).first.click(); page.wait_for_timeout(400)
    def avance():
        nav.locator("button", has_text="Morceau").first.click(); page.wait_for_timeout(500)
        page.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(600)
        mesure(page, "menu", "tel390", theme)
    essai("menu tel", avance)
    fermer(page)
    res.setdefault("erreurs_console", {})[f"tel_{theme}"] = [e["text"][:200] for e in log.errors() if "8765" not in e["text"] and "8766" not in e["text"]][:10]
    ctx.close()


def abonnement(b, theme, vp):
    """Fenêtre Nova Pro (abonnement) : un compte gratuit importe sa propre instru depuis l'accueil."""
    ctx, page = _page(b, vp, Log("abonnement"))
    set_theme_init(ctx, theme)
    install_mocks(page, "artiste", NON_ABONNE, {})
    page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    page.set_input_files('input[type=file][accept="audio/*"]', FAKE_WAV)
    page.get_by_text("Nova Pro", exact=False).locator("visible=true").last.wait_for(timeout=15000)
    page.wait_for_timeout(1200)
    mesure(page, "abonnement_nova_pro", vp, theme)
    ctx.close()


def ecoute(b, theme):
    for vp in ("tel390",):
        ctx, page = _page(b, vp, Log("ecoute"))
        set_theme_init(ctx, theme)
        page.goto(BASE + "ecoute.html", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(2500)
        mesure(page, "page_ecoute_lien_incomplet", vp, theme)
        ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--formats", default="pc,tel390")
    ap.add_argument("--themes", default="light,dark")
    ap.add_argument("--audit", action="store_true", help="mesurer sans échouer")
    ap.add_argument("--sans-bascule", action="store_true")
    a = ap.parse_args()
    fmts = a.formats.split(",")
    z = OUT / "theme_clair.zip"; make_project(z)
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        if not a.sans_bascule:
            try:
                bascule(b)
            except Exception as e:  # noqa
                res["echecs"].append(f"bascule du thème : {type(e).__name__}: {str(e)[:200]}")
                print("KO  bascule du thème :", str(e)[:300], flush=True)
        for theme in [t for t in a.themes.split(",") if t]:
            if "pc" in fmts: essai(f"studio pc {theme}", lambda: studio_pc(b, theme, z))
            if "tel390" in fmts: essai(f"studio tel {theme}", lambda: studio_tel(b, theme, z))
            essai(f"écoute {theme}", lambda: ecoute(b, theme))
            for vp in fmts: essai(f"abonnement {vp} {theme}", lambda: abonnement(b, theme, vp))
        b.close()
    res["duree_s"] = round(time.time() - t0)
    clair = [e for e in res["ecrans"] if e["theme"] == "light"]
    res["bilan"] = {"ecrans_clairs": len(clair), "ok": sum(1 for e in clair if e.get("ok")), "echecs": res["echecs"],
                    "gestes_impossibles": res.get("gestes_impossibles", [])}
    (OUT / "theme_clair.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
    if a.audit:
        return 0
    if res["echecs"]:
        print("ÉCHEC : écrans sombres ou peu lisibles en thème clair (voir ci-dessus)")
        return 1
    if a.themes and len(clair) < 10:
        print("ÉCHEC : trop peu d'écrans mesurés")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
