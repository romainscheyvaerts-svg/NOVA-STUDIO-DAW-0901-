"""Séances complètes au doigt : tablette (1024 × 768, tactile) et téléphone (390 × 844).

Mêmes tâches que qa/session_voix.py, session_mix.py, session_beat.py, mais SANS clavier ni
souris : que des touchers, des appuis longs et des glissers (une saisie de chiffres compte
comme le clavier de l'écran). Chaque étape compte les gestes, le temps, les hésitations
(bouton hors de l'écran, cible de moins de 32 px, entrée introuvable) et les erreurs de la
console.
- tablette · voix : modèle « Session voix · Make Music », import du beat, tempo, armer,
  question casque, prise, respirations et justesse (appui long sur le clip), Mix auto, export ;
- tablette · mix : projet de 20 pistes, console, fader, muet / solo, effet dans un insert,
  envoi reverb, Master Nova, retour aux pistes, export ;
- tablette · beat : projet vierge, boîte à rythmes (palette), pas, lecture, export ;
- téléphone · artiste : prise de voix (question casque), respirations, Mix auto, export démo.
Chrome headless (aucune fenêtre), compte simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3492/ QA_TAG=apres PYTHONIOENCODING=utf-8 python qa/seances_doigt.py [voix mix beat tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-pro2\\point6\\<tag>\\ (seances_doigt.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3492/")
TAG = os.environ.get("QA_TAG", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro2\point6\{TAG}")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from nova_pro_lib import Chrono, track_point, app_state, save_json  # noqa: E402
from projet_mix import make_mix_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

sys.argv += [] if len(sys.argv) > 1 else ["voix", "mix", "beat", "tel"]
WANT = set(sys.argv[1:])
MIN_PX = 32

VIS = """(el) => { const r = el.getBoundingClientRect(); if (!r.width) return { ok: false, why: 'caché' };
  const off = r.bottom > innerHeight || r.right > innerWidth || r.top < 0 || r.left < 0;
  const h = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
  return { ok: !off && !!h && (el.contains(h) || h.contains(el)), off, w: Math.round(r.width), h: Math.round(r.height), hit: getComputedStyle(el, '::after').content !== 'none' || el.classList.contains('nova-hit-tactile') }; }"""


FIND = """([src, flags, scope]) => {
  const rx = new RegExp(src, flags);
  document.querySelectorAll('[data-qa-doigt]').forEach(e => e.removeAttribute('data-qa-doigt'));
  const roots = scope ? [...document.querySelectorAll(scope)] : [document];
  const sel = 'button, [role=button], [role=menuitem], [role=tab], [role=option], [role=slider], [role=radio], a, summary';
  let best = null, score = -1;
  for (const root of roots) for (const el of (root === document ? [...root.querySelectorAll(sel)] : [root, ...root.querySelectorAll(sel)].filter(e => e.matches(sel)))) {
    if (!el.getClientRects().length) continue;
    const st = getComputedStyle(el); if (st.visibility === 'hidden' || st.display === 'none') continue;
    const al = (el.getAttribute('aria-label') || '').trim(), tx = (el.innerText || '').trim().replace(/\s+/g, ' '), ti = (el.title || '').trim();
    const s = rx.test(al) ? 3 : rx.test(tx) ? 2 : rx.test(ti) ? 1 : 0;
    if (s > score) { score = s; best = el; }
    if (s === 3) break;
  }
  if (!best || score <= 0) return null;
  best.setAttribute('data-qa-doigt', '1');
  const r = best.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
}"""


def find(page, rx, scope=""):
    """Élément touchable (bouton, entrée de menu…) dont l'aria-label, le texte ou le title correspond."""
    info = page.evaluate(FIND, [rx.pattern, "i" if rx.flags & re.I else "", scope])
    return page.locator("[data-qa-doigt]").first if info else None


def tap(ch, rx, label, scope="", required=True, wait_s=3.0):
    # Insensible à la casse : les libellés en capitales (CSS uppercase) arrivent en capitales dans innerText.
    rx = re.compile(rx if isinstance(rx, str) else rx.pattern, re.I)
    el = find(ch.page, rx, scope)
    t0 = time.time()
    while not el and required and time.time() - t0 < wait_s:   # fenêtre en train de s'ouvrir : on attend comme un humain
        ch.page.wait_for_timeout(200); el = find(ch.page, rx, scope)
    if not el:
        (ch.fail if required else ch.friction)(f"« {label} » introuvable au doigt")
        if required:
            try: ch.page.screenshot(path=str(OUT / f"introuvable_{ch.name}_{re.sub(r'[^a-z0-9]+', '_', label.lower())[:30]}.png"))
            except Exception: pass
        return False
    v = ch.page.evaluate(VIS, el.element_handle())
    if not v["ok"]:
        if v.get("off"): ch.friction(f"« {label} » hors de l'écran : il faut faire défiler")
        try: el.scroll_into_view_if_needed(timeout=3000)
        except Exception: pass
        v2 = ch.page.evaluate(VIS, el.element_handle())
        if not v2["ok"] and not v2.get("off"): ch.friction(f"« {label} » recouvert par autre chose")
    if min(v.get("w", 99), v.get("h", 99)) < MIN_PX and not v.get("hit"):
        ch.friction(f"« {label} » : cible de {v.get('w')}×{v.get('h')} px au doigt")
    try:
        bb = el.bounding_box()
        ch.page.touchscreen.tap(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
        if ch.cur: ch.cur["clics"] += 1; ch.cur["chemin"].append(f"doigt {label}")
        ch.page.wait_for_timeout(250)
    except Exception as e:
        (ch.fail if required else ch.friction)(f"« {label} » : toucher impossible ({str(e)[:60]})")
        return False
    return True


def long_press(ch, x, y, label):
    ch.page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); const o = { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 9, isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', o)); }""", [x, y])
    ch.page.wait_for_timeout(750)
    ch.page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 9 })); }""", [x, y])
    if ch.cur: ch.cur["clics"] += 1; ch.cur["chemin"].append(f"appui long {label}")
    ch.page.wait_for_timeout(400)


def drag_touch(ch, x0, y0, x1, y1, label, steps=10):
    """Vrai glisser au doigt (Input.dispatchTouchEvent de Chrome : événements tactiles et pointeurs réels)."""
    p = ch.page
    cdp = p.context.new_cdp_session(p)
    pt = lambda x, y: [{"x": x, "y": y, "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt(x0, y0)})
    for k in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps)})
        p.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()
    if ch.cur: ch.cur["clics"] += 1; ch.cur["chemin"].append(f"glisser {label}")
    p.wait_for_timeout(300)


def clip_mid(page, track_id):
    """Milieu du 1er clip de la piste (une prise peut être découpée en phrases)."""
    c = app_state(page, f"s => {{ const t = s.tracks.find(t => t.id === '{track_id}'); const c = t && [...t.clips].sort((a, b) => b.duration - a.duration)[0]; return c ? {{ start: c.start, dur: c.duration }} : null; }}")
    return track_point(page, track_id, c["start"] + c["dur"] / 2) if c else None


def open_export(ch):
    """Exporter : bouton de la barre, sinon menu ☰ (la barre replie ce qui ne tient pas)."""
    if tap(ch, r"^Exporter le mix", "Exporter (barre)", required=False): return True
    ch.friction("« Exporter » replié dans le menu ☰")
    tap(ch, r"^Ouvrir le menu$", "menu ☰"); ch.page.wait_for_timeout(300)
    return tap(ch, r"^Exporter", "Exporter", scope="[role=dialog]")


def digits(ch, text):
    ch.page.keyboard.type(text, delay=20)
    if ch.cur: ch.cur["touches"] += len(text); ch.cur["chemin"].append(f"clavier de l'écran « {text} »")


def tracks(page):
    return app_state(page, "s => s.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, armed: !!t.isTrackArmed, clips: t.clips.length, plugins: (t.plugins || []).length }))") or []


def beat_wav(path):
    """Beat trap synthétique de 4 mesures à 140 BPM (comme session_voix.py)."""
    import math, struct, wave
    SR = 44100; bpm = 140; spb = 60 / bpm; n = int(SR * spb * 4 * 4)
    out = bytearray()
    for i in range(n):
        t = i / SR; tb = t % spb; th = t % (spb / 2)
        v = 0.55 * math.sin(2 * math.pi * (50 + 90 * math.exp(-tb * 25)) * tb) * math.exp(-tb * 6) + 0.12 * math.sin(2 * math.pi * 7000 * th) * math.exp(-th * 80)
        s = int(max(-1, min(1, v)) * 32767); out += struct.pack("<hh", s, s)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bytes(out))


def studio_ready(ch):
    try: wait_text_gone(ch.page, "Chargement", 90)
    except Exception: pass
    return ch.wait_js("() => !!window.__novaEdit && !!document.body", 30000, "studio prêt")


def casque(ch):
    """Question « casque ? » au 1er REC : on la note et on répond au doigt."""
    page = ch.page
    page.wait_for_timeout(700)
    if find(page, re.compile("Oui, j.ai un casque", re.I)):
        ch.friction("question « casque ? » au 1er REC")
        tap(ch, re.compile("Oui, j.ai un casque", re.I), "Oui, j'ai un casque")
        return True
    return False


def export(ch, out_name):
    page = ch.page
    ok = ch.wait_js("() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')", 8000, "fenêtre Exporter")
    if not ok: return None
    for _ in range(50):   # « VÉRIFICATION… » (compte) : on attend que le bouton s'active, comme l'utilisateur
        if page.evaluate("() => Array.from(document.querySelectorAll('[role=dialog] button')).some(b => /EXPORTER|Télécharger|Mon morceau complet/i.test(b.innerText) && !b.disabled)"): break
        page.wait_for_timeout(200)
    bt = page.locator("[role=dialog] button:visible", has_text=re.compile(r"^\s*EXPORTER\s*$"))
    if not bt.count():
        # Version simple (téléphone) : « Mon morceau complet » lance l'export WAV.
        bt = page.locator("[role=dialog] button:visible", has_text=re.compile(r"Mon morceau complet"))
    if not bt.count():
        ch.fail("bouton EXPORTER introuvable"); return None
    got = []
    page.on("download", lambda d: got.append(d))
    ch.tap(bt.last, "EXPORTER")
    t0 = time.time()
    while time.time() - t0 < 120 and not got:
        # Au doigt (téléphone, tablette), la fin de l'export propose « Télécharger » (pas de
        # téléchargement automatique après un long calcul) : un toucher de plus.
        dl = page.locator("button:visible", has_text=re.compile(r"^\s*Télécharger\s*$"))
        if dl.count():
            ch.friction("export au doigt : « Télécharger » à toucher en plus")
            ch.tap(dl.first, "Télécharger"); page.wait_for_timeout(1500)
            break
        page.wait_for_timeout(300)
    t1 = time.time()
    while time.time() - t1 < 20 and not got: page.wait_for_timeout(200)
    if not got:
        page.screenshot(path=str(OUT / f"{out_name}_export_ko.png"))
        ch.fail("pas de fichier exporté"); return None
    d = got[0]
    p = OUT / f"{out_name}.{(d.suggested_filename or 'x.wav').split('.')[-1]}"
    d.save_as(str(p))
    return {"fichier": d.suggested_filename, "octets": p.stat().st_size}


def context(b, vp):
    log = Log(f"doigt_{vp}")
    ctx, page = new_page(b, "tab" if vp == "tab" else "tel", log=log, touch=True)
    if vp == "tel": page.set_viewport_size({"width": 390, "height": 844})
    page.set_default_timeout(20000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    return ctx, page, log


def landing(ch):
    page = ch.page
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
    # Écran de chargement (fondu de 300 ms) : un toucher trop tôt tombe dessus.
    page.wait_for_function("() => !document.getElementById('loading-screen')", timeout=10000)
    page.wait_for_timeout(300)


# ─── Tablette · voix ──────────────────────────────────────────────────────────────
def seance_voix(ch, res):
    page = ch.page
    ch.start("Ouvrir", "Session voix Make Music (modèle) ; sans modèle : projet vierge + piste voix")
    landing(ch)
    lead = "voix-lead"
    tap(ch, r"Depuis un modèle", "Depuis un modèle")
    try: page.locator("[data-template-id=tpl-make-music-voix] [data-testid=tpl-use]").first.wait_for(timeout=15000)
    except Exception: pass
    if page.locator("[data-template-id=tpl-make-music-voix]").count():
        tap(ch, r"^Utiliser ce modèle$", "Utiliser ce modèle", scope="[data-template-id=tpl-make-music-voix]")
        page.wait_for_timeout(800); close_welcome(page); studio_ready(ch)
    else:
        # Version d'avant : aucun modèle livré. Projet vierge, puis une piste voix (armée d'office).
        ch.friction("aucun modèle livré : projet vierge + piste voix")
        page.keyboard.press("Escape"); tap(ch, r"^Fermer$", "Fermer les modèles", required=False)
        tap(ch, r"Nouveau Projet", "Nouveau Projet"); page.wait_for_timeout(800); close_welcome(page); studio_ready(ch)
        ids0 = {t["id"] for t in tracks(page)}
        tap(ch, r"^Ajouter une piste voix", "Piste voix"); page.wait_for_timeout(800)
        lead = next((t["id"] for t in tracks(page) if t["id"] not in ids0), "track-rec-main")
    res["lead"] = lead
    ch.end(note=str([t["name"] for t in tracks(page)]))
    page.screenshot(path=str(OUT / "tab_voix_01_studio.png"))

    ch.start("Préparer", "Importer le beat (menu ☰)")
    wav = OUT / "beat_140.wav"; beat_wav(wav)
    try:
        with page.expect_file_chooser(timeout=8000) as fc:
            if not tap(ch, r"Importer un fichier audio", "Importer (barre)", required=False):
                tap(ch, r"^Ouvrir le menu$", "menu ☰"); page.wait_for_timeout(300)
                tap(ch, r"Importer un fichier audio", "Importer un fichier audio", scope="[role=dialog]")
        fc.value.set_files(str(wav)); ch.cur["clics"] += 1
    except Exception as e:
        ch.fail(f"import : {str(e)[:80]}")
    ch.wait_js("() => window.__novaEdit.getState().tracks.some(t => t.clips.some(c => /beat_140/i.test(c.name || '')))", 20000, "beat importé")
    ch.end()

    ch.start("Préparer", "Tempo à 140 BPM")
    if not tap(ch, r"^Tempo : \d", "Tempo (barre)", required=False):
        tap(ch, r"Tempo et mesure|mesure \d", "pastille 4/4")
    inp = page.locator("input[aria-label='Tempo en BPM']").locator("visible=true")
    try: inp.first.wait_for(timeout=4000)
    except Exception: ch.fail("fenêtre Tempo pas ouverte")
    if inp.count():
        inp.first.tap(); ch.cur["clics"] += 1
        inp.first.fill(""); digits(ch, "140")
        tap(ch, r"^Fermer$", "Fermer", scope="[role=dialog]")
    ch.wait_js("() => Math.abs(window.__novaEdit.getState().bpm - 140) < 0.01", 5000, "tempo 140")
    ch.end()

    ch.start("Enregistrer", "Armer la lead, REC, question casque, prise de 4 s, Stop")
    lead_name = app_state(page, f"s => s.tracks.find(t => t.id === '{lead}').name")
    if not app_state(page, f"s => !!s.tracks.find(t => t.id === '{lead}').isTrackArmed"):
        tap(ch, rf"Armer l.enregistrement : {re.escape(lead_name)}$", "R de la lead")
    tap(ch, r"^Enregistrer$", "REC")
    if casque(ch) and not ch.wait_js("() => window.__novaEdit.getState().isRecording", 2500, ""):
        ch.cur["frictions"][-1:] = []; ch.cur["ok"] = True
        ch.friction("après la question du casque, il faut retoucher REC"); tap(ch, r"^Enregistrer$", "REC")
    started = ch.wait_js("() => window.__novaEdit.getState().isRecording", 8000, "enregistrement lancé")
    page.wait_for_timeout(4000)
    tap(ch, r"^(Stop|Arrêter)", "Stop")
    ch.wait_js("() => !window.__novaEdit.getState().isRecording", 15000, "fin de prise")
    page.wait_for_timeout(1200)
    n = app_state(page, f"s => (s.tracks.find(t => t.id === '{lead}') || {{ clips: [] }}).clips.length")
    res["prise_lead"] = n
    ch.end(ok=bool(started) and (n or 0) >= 1, note=f"clips sur la lead : {n}")
    page.screenshot(path=str(OUT / "tab_voix_02_prise.png"))

    ch.start("Éditer", "Respirations (appui long sur le clip, menu)")
    pt = clip_mid(page, lead)
    if pt: long_press(ch, pt[0], pt[1], "clip de la lead")
    if tap(ch, r"^Respirations…", "Respirations…", scope="[role=menu]"):
        if ch.wait_js("() => /Respirations/.test(document.querySelector('[role=dialog]')?.innerText || '')", 5000, "fenêtre Respirations"):
            tap(ch, r"^Appliquer$", "Appliquer", scope="[role=dialog]")
    page.wait_for_timeout(400)
    if page.evaluate("() => /Respirations/.test(document.querySelector('[role=dialog]')?.innerText || '')"):
        tap(ch, r"^Fermer$", "Fermer", scope="[role=dialog]", required=False)
    ch.end()

    ch.start("Éditer", "Justesse note par note (appui long, ouvrir, fermer)")
    if pt: long_press(ch, pt[0], pt[1], "clip de la lead")
    tap(ch, r"^Justesse note par note…", "Justesse…", scope="[role=menu]")
    ch.wait_js("() => !!document.querySelector('[data-testid=pitch-editor]')", 10000, "éditeur de justesse")
    page.screenshot(path=str(OUT / "tab_voix_03_justesse.png"))
    tap(ch, r"^Fermer", "Fermer la justesse", scope="[data-testid=pitch-editor]")
    if page.locator("[data-testid=pitch-editor]").count(): ch.fail("la justesse ne se ferme pas au doigt")
    ch.end()

    ch.start("Mix", "Mix auto (panneau, appliquer un style)")
    tap(ch, r"^Mix auto", "Mix auto")
    if ch.wait_js("() => !!document.querySelector('[aria-labelledby=vocal-tools-title]')", 6000, "panneau Mix auto"):
        page.screenshot(path=str(OUT / "tab_voix_04_mix_auto.png"))
        tap(ch, r"Trap autotune", "style Trap autotune", scope="[aria-labelledby=vocal-tools-title]")
        page.wait_for_timeout(800)
        tap(ch, r"^Fermer$", "Fermer", scope="[aria-labelledby=vocal-tools-title]", required=False)
    ch.end()

    ch.start("Livrer", "Exporter la démo (WAV)")
    open_export(ch)
    res["export_tab_voix"] = export(ch, "tab_voix_demo")
    ch.end(note=json.dumps(res.get("export_tab_voix"), ensure_ascii=False))


# ─── Tablette · mix ──────────────────────────────────────────────────────────────
def seance_mix(ch, res):
    page = ch.page
    ch.start("Ouvrir", "Ouvrir le projet de 20 pistes (menu ☰ › Ouvrir un projet)")
    z = OUT / "mix20.zip"; make_mix_project(z, 20)
    landing(ch)
    tap(ch, r"Nouveau Projet", "Nouveau Projet"); page.wait_for_timeout(600); close_welcome(page); studio_ready(ch)
    tap(ch, r"^Ouvrir un projet$", "Ouvrir (barre)", required=False) or (tap(ch, r"^Ouvrir le menu$", "menu ☰") and tap(ch, r"Ouvrir un projet", "Ouvrir un projet", scope="[role=dialog]"))
    tap(ch, r"Fichier sur l.ordinateur", "Fichier sur l'ordinateur")
    try:
        page.set_input_files('input[type=file][accept=".zip,.json"]', str(z)); ch.cur["clics"] += 1
        page.get_by_text("Projet chargé").first.wait_for(timeout=60000)
    except Exception as e: ch.fail(f"projet : {str(e)[:60]}")
    ch.end()

    ch.start("Mix", "Console (menu ☰ › Console)")
    tap(ch, r"^Ouvrir le menu$", "menu ☰"); page.wait_for_timeout(300)
    tap(ch, r"^Console$", "Console", scope="[role=dialog]")
    ok = ch.wait_js("() => document.querySelectorAll('[data-strip-id]').length > 5", 8000, "console")
    page.screenshot(path=str(OUT / "tab_mix_01_console.png"))
    ch.end(ok=bool(ok))

    ch.start("Mix", "Fader de la lead −3 dB (glisser), muet puis solo")
    # La tranche de la lead est hors de l'écran (9e tranche) : un glisser horizontal de la console.
    lead_id = app_state(page, "s => s.tracks.find(t => t.name === 'Lead').id")
    page.locator(f"[data-strip-id='{lead_id}']").first.scroll_into_view_if_needed()
    if ch.cur: ch.cur["clics"] += 1; ch.cur["chemin"].append("glisser la console jusqu'à la lead")
    page.wait_for_timeout(600)
    f = page.locator("[role=slider][aria-label='Volume Lead']").first
    if f.count():
        f.scroll_into_view_if_needed()
        if not page.evaluate(VIS, f.element_handle())["ok"]: ch.friction("fader de la lead hors de l'écran (console coupée en bas)")
        f.scroll_into_view_if_needed(); bb = f.bounding_box()
        v0 = app_state(page, "s => s.tracks.find(t => t.name === 'Lead').volume")
        drag_touch(ch, bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] * 0.3, bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] * 0.55, "fader Lead")
        v1 = app_state(page, "s => s.tracks.find(t => t.name === 'Lead').volume")
        res["fader_lead"] = [v0, v1]
        if v1 == v0: ch.fail("le fader ne bouge pas au doigt")
    else: ch.fail("fader de la lead introuvable")
    tap(ch, r"^(Muet|Mute)\b.*Lead$|Muet : Lead|Mute Lead", "Muet Lead", required=False)
    tap(ch, r"Solo : Lead|Solo Lead", "Solo Lead", required=False)
    ch.end()

    ch.start("Mix", "Compresseur dans un insert de la lead")
    tap(ch, r"Ajouter un effet sur Lead$", "insert vide de la lead")
    page.wait_for_timeout(500); page.screenshot(path=str(OUT / "tab_mix_02_ajouter_effet.png"))
    if ch.wait_js("() => !!document.querySelector('[data-testid=add-effect-menu], [role=dialog][aria-label*=effet i], [role=menu]')", 4000, "menu des effets"):
        tap(ch, r"^Compresseur", "Compresseur")
    n = app_state(page, "s => s.tracks.find(t => t.name === 'Lead').plugins.length")
    res["inserts_lead"] = n
    page.keyboard.press("Escape")
    ch.end(ok=(n or 0) >= 1)

    ch.start("Master", "Master Nova (menu ☰ › Master Nova)")
    if not tap(ch, r"^Master Nova", "Master Nova (barre)", required=False):
        tap(ch, r"^Ouvrir le menu$", "menu ☰"); page.wait_for_timeout(300)
        tap(ch, r"^Master Nova", "Master Nova", scope="[role=dialog]")
    ok = ch.wait_js("() => !!document.querySelector('[data-nova-master]')", 8000, "Master Nova")
    tap(ch, r"^Fermer", "Fermer", scope="[data-nova-master]", required=False)
    page.keyboard.press("Escape") if page.locator("[data-nova-master]").count() else None
    ch.end(ok=bool(ok))

    ch.start("Mix", "Retour aux pistes (menu ☰ › Pistes)")
    tap(ch, r"^Ouvrir le menu$", "menu ☰"); page.wait_for_timeout(300)
    tap(ch, r"^Pistes$", "Pistes", scope="[role=dialog]")
    ch.wait_js("() => !!document.querySelector('.nova-grille canvas')", 6000, "arrangement")
    ch.end()

    ch.start("Livrer", "Exporter le mix")
    open_export(ch)
    res["export_tab_mix"] = export(ch, "tab_mix")
    ch.end(note=json.dumps(res.get("export_tab_mix"), ensure_ascii=False))


# ─── Tablette · beat ─────────────────────────────────────────────────────────────
def seance_beat(ch, res):
    page = ch.page
    ch.start("Ouvrir", "Nouveau projet")
    landing(ch)
    tap(ch, r"Nouveau Projet", "Nouveau Projet"); page.wait_for_timeout(600); close_welcome(page); studio_ready(ch)
    ch.end()

    ch.start("Batterie", "Ouvrir la boîte à rythmes (loupe, « batterie »)")
    tap(ch, r"Chercher une action", "loupe")
    try:
        page.locator("[data-testid=command-palette] input").first.wait_for(timeout=3000)
        digits(ch, "batterie")
        page.wait_for_timeout(200)
        tap(ch, re.compile("atterie|ythme", re.I), "1re action", scope="[data-testid=command-palette] [role=option]")
    except Exception as e: ch.fail(f"palette : {str(e)[:60]}")
    ok = ch.wait_js("() => !!document.querySelector('[aria-labelledby=drums-title]')", 8000, "boîte à rythmes")
    page.screenshot(path=str(OUT / "tab_beat_01_batterie.png"))
    ch.end(ok=bool(ok))

    ch.start("Batterie", "Choisir le style Trap")
    tap(ch, r"Trap$", "Trap", scope="[aria-labelledby=drums-title]")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(OUT / "tab_beat_02_trap.png"))
    ch.end()

    ch.start("Batterie", "Caisse claire sur 2 et 4 (2 touchers)")
    before = app_state(page, "s => JSON.stringify((s.tracks.find(t => t.drumMachine) || {}).drumMachine || null).length")
    for n in (5, 13):
        rx = rf"^(Snare|Caisse claire|Clap)[^,]*, pas {n}(,|$| )"
        if not find(page, re.compile(rx, re.I)):
            tap(ch, rf"^Pas {((n - 1) // 8) * 8 + 1} à", f"page des pas {n}", required=False)
        tap(ch, rx, f"caisse claire, pas {n}", scope="[aria-labelledby=drums-title]")
    after = app_state(page, "s => JSON.stringify((s.tracks.find(t => t.drumMachine) || {}).drumMachine || null).length")
    res["pas_changes"] = [before, after]
    ch.end(ok=before != after)

    ch.start("Batterie", "Écouter puis arrêter, fermer")
    tap(ch, r"^(Lecture|Lire|Écouter)$", "Lecture", required=False)
    page.wait_for_timeout(1500)
    tap(ch, r"^(Stop|Pause|Arrêter)$", "Stop", required=False)
    tap(ch, r"^Fermer la batterie", "Fermer la boîte à rythmes", required=False)
    ch.end()

    ch.start("Livrer", "Exporter le beat")
    open_export(ch)
    res["export_tab_beat"] = export(ch, "tab_beat")
    ch.end(note=json.dumps(res.get("export_tab_beat"), ensure_ascii=False))


# ─── Téléphone · artiste ─────────────────────────────────────────────────────────
def seance_tel(ch, res):
    page = ch.page
    ch.start("Ouvrir", "Nouveau projet (téléphone)")
    landing(ch)
    tap(ch, r"Nouveau Projet", "Nouveau Projet"); page.wait_for_timeout(600); close_welcome(page); studio_ready(ch)
    page.screenshot(path=str(OUT / "tel_01_studio.png"))
    ch.end()

    ch.start("Enregistrer", "REC, question casque, prise de 4 s, Stop")
    tap(ch, r"^Enregistrer$", "REC")
    if casque(ch) and not ch.wait_js("() => window.__novaEdit.getState().isRecording", 2500, ""):
        ch.cur["frictions"][-1:] = []; ch.cur["ok"] = True
        ch.friction("après la question du casque, il faut retoucher REC"); tap(ch, r"^Enregistrer$", "REC")
    started = ch.wait_js("() => window.__novaEdit.getState().isRecording", 8000, "enregistrement lancé")
    page.wait_for_timeout(4000)
    tap(ch, r"^(Stop|Arrêter)", "Stop")
    ch.wait_js("() => !window.__novaEdit.getState().isRecording", 15000, "fin de prise")
    page.wait_for_timeout(1200)
    rec = app_state(page, "s => s.tracks.filter(t => t.clips.length && t.id !== 'instrumental').map(t => t.name)")
    res["tel_prise"] = rec
    page.screenshot(path=str(OUT / "tel_02_prise.png"))
    ch.end(ok=bool(started) and bool(rec), note=str(rec))

    ch.start("Éditer", "Respirations (toucher la prise, puis RESPIRATIONS)")
    cid = app_state(page, "s => { const t = s.tracks.find(t => t.clips.length && t.id !== 'instrumental'); return t ? t.clips[0].id : null; }")
    clip = page.locator(f"[data-clip-id='{cid}']").locator("visible=true") if cid else None
    if clip is not None and clip.count():
        bb = clip.first.bounding_box()
        page.touchscreen.tap(bb["x"] + min(bb["width"] / 2, 60), bb["y"] + bb["height"] / 2); ch.cur["clics"] += 1; ch.cur["chemin"].append("doigt sur la prise")
        page.wait_for_timeout(400)
    else: ch.friction("prise introuvable dans le morceau")
    if tap(ch, re.compile("Respirations", re.I), "Respirations"):
        if ch.wait_js("() => /Respirations/.test(document.querySelector('[role=dialog]')?.innerText || '')", 4000, ""):
            tap(ch, r"^Appliquer$", "Appliquer", scope="[role=dialog]", required=False)
    page.wait_for_timeout(500)
    if page.evaluate("() => /Respirations/.test(document.querySelector('[role=dialog]')?.innerText || '')"):
        tap(ch, r"^Fermer$", "Fermer", scope="[role=dialog]", required=False)
    page.screenshot(path=str(OUT / "tel_03_respirations.png"))
    ch.end()

    ch.start("Mix", "Mix auto")
    tap(ch, r"^Mix auto", "Mix auto")
    if ch.wait_js("() => !!document.querySelector('[aria-labelledby=vocal-tools-title]')", 6000, "panneau Mix auto"):
        page.screenshot(path=str(OUT / "tel_04_mix_auto.png"))
        tap(ch, r"Trap autotune", "style Trap autotune", scope="[aria-labelledby=vocal-tools-title]")
        page.wait_for_timeout(800)
        tap(ch, r"^Fermer$", "Fermer", scope="[aria-labelledby=vocal-tools-title]", required=False)
    ch.end()

    ch.start("Livrer", "Exporter la démo")
    if not tap(ch, r"^Exporter", "Exporter (barre)", required=False):
        tap(ch, r"^Ouvrir le menu$", "menu ☰"); page.wait_for_timeout(300)
        tap(ch, r"Exporter", "Exporter", scope="[role=dialog]")
    res["export_tel"] = export(ch, "tel_demo")
    page.screenshot(path=str(OUT / "tel_05_export.png"))
    ch.end(note=json.dumps(res.get("export_tel"), ensure_ascii=False))


SEANCES = [("voix", "tab", seance_voix), ("mix", "tab", seance_mix), ("beat", "tab", seance_beat), ("tel", "tel", seance_tel)]
out = {"tag": TAG, "seances": {}}
with sync_playwright() as p:
    b = launch(p)
    for name, vp, fn in SEANCES:
        if name not in WANT: continue
        print(f"\n=== {name} ({vp})")
        ctx, page, log = context(b, vp)
        ch = Chrono(f"doigt_{name}", page, log, OUT)
        res = {}
        try: fn(ch, res)
        except Exception as e:
            ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:200]}"); ch.end(ok=False)
            page.screenshot(path=str(OUT / f"{name}_arret.png"))
        rep = ch.report(); rep["mesures"] = res
        rep["erreurs_console"] = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:10]
        out["seances"][name] = rep
        print("TOTAL", name, json.dumps(rep["total"], ensure_ascii=False), "| console :", len(rep["erreurs_console"]))
        ctx.close()
    b.close()
save_json(OUT / "seances_doigt.json", out)
