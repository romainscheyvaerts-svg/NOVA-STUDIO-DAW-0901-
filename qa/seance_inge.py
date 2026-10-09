"""Séance réelle d'ingé son, du début à la fin (PC, souris + clavier, Chrome headless).

Comme un ingé Pro Tools en studio, dans Nova Studio (appli Windows simulée), 100 % hors
production (qa_hors_prod) :
  1. ouvrir le modèle « Session voix · Make Music »      2. importer le beat (fichier local)
  3. tempo du beat                                       4. 3 prises de lead (Loop Record, micro simulé)
  5. 2 backs importés (glisser 2 fichiers sur « Backs ») 6. comp de la meilleure prise (balayage)
  7. respirations nettoyées                              8. caler les backs sur la lead
  9. mix : insert, envoi, automation de volume sur le refrain
 10. bounce du mix (WAV)                                11. export des stems
Pour chaque étape : clics, touches, temps, chemin pris et CHAQUE friction (geste en trop, libellé
flou, fenêtre qui cache, attente, action introuvable, retour visuel manquant).

  NOVA_URL=http://127.0.0.1:3487/ QA_VP=pc|pc1366 QA_PHASE=avant|apres python qa/seance_inge.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro3\\<phase>\\seance_<vp>\\ (seance.json + captures)
"""
import base64, json, math, os, random, re, struct, sys, time, wave
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3487/")
PHASE = os.environ.get("QA_PHASE", "apres")
VP = os.environ.get("QA_VP", "pc")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro3\{PHASE}\seance_{VP}")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from nova_pro_lib import Chrono, visible_first, open_by_palette, via_menu, app_state, canvas_box, save_json  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
BPM = 140
BAR = 4 * 60 / BPM            # 1,714 s
SONG_BARS = 8                 # couplet (1-4) + refrain (5-8)
REFRAIN = (4 * BAR, 8 * BAR)


# ------------------------------------------------------------------ audio synthétique
def _write(path, samples, sr=SR, ch=1):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))


def beat_wav(path, bars=SONG_BARS):
    spb = 60 / BPM
    n = int(SR * spb * 4 * bars)
    out = []
    for i in range(n):
        t = i / SR; tb = t % spb; th = t % (spb / 2)
        v = 0.55 * math.sin(2 * math.pi * (50 + 90 * math.exp(-tb * 25)) * tb) * math.exp(-tb * 6)
        v += 0.12 * math.sin(2 * math.pi * 7000 * th) * math.exp(-th * 80)
        out += [v, v]
    _write(path, out, ch=2)


def _biquad_bp(x, sr, f, q):
    import numpy as np
    w = 2 * math.pi * f / sr; al = math.sin(w) / (2 * q); a0 = 1 + al
    b0, b2, a1, a2 = al / a0, -al / a0, -2 * math.cos(w) / a0, (1 - al) / a0
    y = np.zeros_like(x); x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, x[i], y1, v
        y[i] = v
    return y


def voice(n_bars, sr, seed=1, delay=0.0, detune=1.0, gain=0.5):
    """Voix rap synthétique (même modèle que tests/helpers/breathSignals : mots voisés à formants,
    bruit de fond −80 dBFS, respiration = bruit filtré 1,4 + 2,8 kHz à −22 dB des mots) : une phrase
    de 4 mots par mesure, la respiration juste avant la phrase suivante. `delay` décale tout (backs
    à caler), `detune` change la hauteur."""
    import numpy as np
    rnd = np.random.default_rng(seed)
    n = int(sr * BAR * n_bars)
    x = rnd.uniform(-1, 1, n) * 0.0002
    WORD_RMS = 0.1 * gain / 0.5
    for b in range(n_bars):
        t = b * BAR + 0.05 + delay
        f0 = (150 + 40 * ((b * 7) % 5) / 4) * detune
        for w in range(4):
            dur, rel = 0.18 + 0.04 * ((w + b) % 3), 0.08
            m = int((dur + rel) * sr)
            tt = np.arange(m) / sr
            F1, F2 = 600 + 80 * w, 1300 + 150 * w
            ph = np.cumsum(2 * math.pi * f0 * (1 + 0.01 * np.sin(2 * math.pi * 5.5 * tt)) / sr)
            v = np.zeros(m)
            h = 1
            while h * f0 < 5000:
                fh = h * f0
                g = 1 / (1 + ((fh - F1) / 150) ** 2) + 0.6 / (1 + ((fh - F2) / 200) ** 2) + 0.05 / h
                v += g * np.sin(h * ph); h += 1
            v += rnd.uniform(-1, 1, m) * 0.08
            env = np.minimum(1, tt / 0.015) * np.where(tt > dur, np.exp(-(tt - dur) / (rel / 4)), 1.0)
            v *= env
            body = v[int(0.02 * sr):int(dur * sr)]
            v *= WORD_RMS / max(1e-9, float(np.sqrt(np.mean(body ** 2))))
            a = int(t * sr)
            if a + m <= n: x[a:a + m] += v
            t += dur + rel * 0.6 + 0.03
        # Respiration avant la phrase suivante.
        bd = 0.30
        bt = (b + 1) * BAR + 0.05 + delay - 0.08 - bd
        m = int(bd * sr)
        seg = rnd.uniform(-1, 1, m)
        s1 = _biquad_bp(seg, sr, 1400, 0.6); s2 = _biquad_bp(s1.copy(), sr, 2800, 1)
        seg = s1 + 0.5 * s2
        seg *= WORD_RMS * 10 ** (-22 / 20) / max(1e-9, float(np.sqrt(np.mean(seg ** 2))))
        p_ = np.arange(m) / m
        seg *= np.sin(math.pi * p_) ** 1.5 * 1.6
        a = int(bt * sr)
        if 0 <= a and a + m <= n: x[a:a + m] += seg
    return np.clip(x, -1, 1).tolist()


def make_audio():
    files = {}
    files["beat"] = OUT / "beat_140.wav"; beat_wav(files["beat"])
    files["back1"] = OUT / "back_1_haute.wav"; _write(files["back1"], voice(SONG_BARS, SR, seed=3, delay=0.045, detune=1.26, gain=0.35))
    files["back2"] = OUT / "back_2_basse.wav"; _write(files["back2"], voice(SONG_BARS, SR, seed=4, delay=0.028, detune=0.84, gain=0.35))
    # Micro simulé (Chrome le lit en boucle) : la lead, 48 kHz mono.
    files["micro"] = OUT / "micro_lead.wav"; _write(files["micro"], voice(SONG_BARS, 48000, seed=2, gain=0.55), sr=48000)
    return files


# ------------------------------------------------------------------ outils
def in_view(page, loc):
    return page.evaluate("""(el) => { const r = el.getBoundingClientRect(); if (!r.width) return false;
      if (r.bottom > innerHeight || r.right > innerWidth || r.top < 0 || r.left < 0) return false;
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); }""", loc.element_handle())


def reachable(ch, sel, label, note=True):
    loc = visible_first(ch.page, sel)
    if not loc: return None
    if not in_view(ch.page, loc):
        if note: ch.friction(f"« {label} » existe mais est hors de l'écran ou caché")
        return None
    return loc


def tracks(page):
    return app_state(page, "s => s.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, armed: !!t.isTrackArmed, out: t.outputTrackId || null, clips: t.clips.length, muted: t.clips.filter(c => c.isMuted).length, plugins: (t.plugins || []).map(p => p.name || p.type), sends: (t.sends || []).map(s => [s.id, +(+s.level).toFixed(3)]), vol: (t.automationLanes || []).filter(l => l.parameterName === 'volume').map(l => l.points.length) }))") or []


def lane_y(page, track_id):
    """Milieu vertical du couloir de la piste (fait défiler la piste dans la vue s'il le faut)."""
    r = page.evaluate("""(id) => { const h = document.querySelector(`[data-track-header='${id}']`); if (!h) return null;
      const g = document.querySelector('.nova-grille .custom-scroll'); const zone = (g || document.body).getBoundingClientRect();
      let q = h.getBoundingClientRect();
      if (q.top < zone.top + 60 || q.top + 60 > zone.bottom) { h.scrollIntoView({ block: 'center' }); q = h.getBoundingClientRect(); }
      return { top: q.top, h: q.height }; }""", track_id)
    page.wait_for_timeout(120)
    return None if not r else r["top"] + min(r["h"] * 0.5, 56)


def zoom(page):
    return page.evaluate("() => (window.__novaEdit && window.__novaEdit.zoom && window.__novaEdit.zoom()) || 40") or 40


def time_x(page, t):
    b = canvas_box(page)
    return b["x"] + t * zoom(page) - b["sl"]


def errors_since(log, n):
    return [e["text"][:160] for e in log.errors()[n:] if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])]


def toast_text(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('[role=status], [aria-live]')).map(e => e.innerText.trim()).filter(Boolean).join(' | ').slice(0, 300)")


def covered(page, sel_list):
    """Fenêtre qui cache : y a-t-il un élément fixe au-dessus des zones demandées ?"""
    return page.evaluate("""(sels) => sels.map(s => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)); return h && !el.contains(h) ? (h.closest('[role=dialog],[role=complementary],[data-nova-window]')?.getAttribute('aria-label') || h.tagName) : null; })""", sel_list)


def clear_way(ch, x, y, what):
    """Le point visé est-il bien la grille (canvas) ? Sinon : friction (message ou fenêtre posé dessus),
    et on le ferme par sa croix (1 clic) comme le ferait l'ingé."""
    page = ch.page
    info = page.evaluate("""([x, y]) => { const e = document.elementFromPoint(x, y); if (!e || e.tagName === 'CANVAS' || e.closest('.nova-grille')) return null;
      const box = e.closest('[role=status], [role=dialog], [role=region], [data-testid]') || e;
      return { label: (box.getAttribute('aria-label') || box.dataset.testid || box.innerText || box.tagName).toString().replace(/\\s+/g, ' ').slice(0, 80),
               close: !!box.querySelector('button[aria-label=Fermer]') }; }""", [x, y])
    if not info: return
    ch.friction(f"{what} : « {info['label']} » est posé dessus")
    btn = page.locator("[role=status] button[aria-label=Fermer], [role=region] button[aria-label=Fermer]").locator("visible=true")
    if info["close"] and btn.count(): ch.click(btn.first, "fermer le message")
    else: page.wait_for_timeout(4000)


def drop_files(page, files, x, y):
    """Glisser des fichiers du bureau sur l'arrangement (comme depuis l'Explorateur Windows)."""
    payload = [{"name": Path(f).name, "b64": base64.b64encode(Path(f).read_bytes()).decode()} for f in files]
    return page.evaluate("""async ([items, x, y]) => {
      const dt = new DataTransfer();
      for (const it of items) { const bin = atob(it.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        dt.items.add(new File([u], it.name, { type: 'audio/wav' })); }
      const el = document.elementFromPoint(x, y); if (!el) return 'rien sous le pointeur';
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      return el.tagName + '.' + (el.className || '').toString().slice(0, 40); }""", [payload, x, y])


# ------------------------------------------------------------------ la séance
def run(page, log, ch, files):
    res = {"vp": VP}
    # 1. Ouvrir le modèle ----------------------------------------------------------------
    ch.start("Ouvrir", "Session voix · Make Music depuis un modèle",
             protools="File › New Session › Create From Template › modèle › Create (≈ 4 gestes)")
    t = time.time()
    page.goto(BASE, wait_until="domcontentloaded", timeout=180000)
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=90000)
    ch.click(page.locator("[data-testid=landing-templates]:visible").first, "Depuis un modèle")
    use = page.locator("[data-template-id=tpl-make-music-voix] [data-testid=tpl-use]")
    use.first.wait_for(timeout=20000)
    ch.click(use.first, "Utiliser ce modèle")
    page.wait_for_timeout(300)
    if page.locator("[data-testid=tpl-create]:visible").count():
        ch.friction("le modèle demande une 2e confirmation"); ch.click(page.locator("[data-testid=tpl-create]:visible").first, "Créer")
    page.wait_for_timeout(600); close_welcome(page)
    try: wait_text_gone(page, "Chargement", 90)
    except Exception: pass
    ch.wait_js("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", 30000, "studio prêt")
    res["studio_ms"] = round((time.time() - t) * 1000)
    page.mouse.move(5, 5); page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "01_modele.png"))
    res["pistes_modele"] = [x["name"] for x in tracks(page)]
    # Ce que l'ingé voit sans défiler : pistes visibles en entier dans la fenêtre d'édition.
    res["pistes_visibles"] = page.evaluate("""() => { const g = document.querySelector('.nova-grille .custom-scroll'); if (!g) return null; const z = g.getBoundingClientRect();
      return Array.from(document.querySelectorAll('[data-track-header]')).filter(h => { const r = h.getBoundingClientRect(); return r.top >= z.top - 1 && r.bottom <= z.bottom + 1; }).length; }""")
    if res["pistes_visibles"] is not None and res["pistes_visibles"] < 4:
        ch.friction(f"seulement {res['pistes_visibles']} pistes visibles sans défiler (le beat, la lead, le double et les backs ne tiennent pas ensemble)")
    sb = page.evaluate("() => { const s = document.querySelector('[data-nova-sidebar], aside'); if (!s) return 0; const r = s.getBoundingClientRect(); return r.width > 40 && r.left < 10 ? Math.round(r.width) : 0; }")
    res["navigateur_px"] = sb
    if sb > 200:
        ch.friction(f"le navigateur (store de beats) est ouvert : {sb} px pris à la fenêtre d'édition pour une séance d'enregistrement")
        hide = reachable(ch, "button[aria-label='Masquer le navigateur']", "Masquer le navigateur", note=False)
        if hide: ch.click(hide, "Masquer le navigateur")
    ch.end(note=f"studio prêt en {res['studio_ms']} ms ; {res['pistes_visibles']} pistes visibles")

    # 2. Importer le beat ------------------------------------------------------------------
    ch.start("Préparer", "Importer le beat (fichier WAV du PC)", protools="File › Import › Audio : Ctrl+Maj+I + choisir le fichier (1 raccourci, 1 choix)")
    n_err = len(log.errors())
    done = False
    try:
        with page.expect_file_chooser(timeout=6000) as fc:
            # Le chemin le plus court disponible : raccourci Pro Tools, bouton visible, menu ☰, palette.
            page.keyboard.press("Control+Shift+I")
            page.wait_for_timeout(400)
        ch.cur["touches"] += 1; ch.cur["chemin"].append("touche Ctrl+Maj+I")
        done = True
    except Exception:
        pass
    if not done:
        ch.friction("Ctrl+Maj+I (Import Audio de Pro Tools) ne fait rien")
        try:
            with page.expect_file_chooser(timeout=8000) as fc:
                b = reachable(ch, "button[aria-label='Importer un fichier audio'], button[title^='Importer un fichier audio']", "Importer", note=False)
                if b: ch.click(b, "Importer (barre)")
                elif via_menu(ch, "Importer un fichier audio"): pass
                elif open_by_palette(ch, "importer audio", "pal.importAudio"): pass
                else: ch.fail("import audio introuvable")
            done = True
        except Exception as e:
            ch.fail(f"pas de sélecteur de fichier ({str(e)[:60]})")
    if done:
        fc.value.set_files(str(files["beat"])); ch.cur["clics"] += 1; ch.cur["chemin"].append("choisir beat_140.wav")
    ch.wait_js("() => window.__novaEdit.getState().tracks.some(t => t.clips.some(c => /beat_140/i.test(c.name || '')))", 20000, "beat importé")
    bt = app_state(page, "s => s.tracks.filter(t => t.clips.some(c => /beat_140/i.test(c.name || ''))).map(t => t.name)")
    res["beat_sur"] = bt
    if bt and bt != ["Beat"]: ch.friction(f"le beat n'est pas allé dans la piste « Beat » du modèle : {bt}")
    page.wait_for_timeout(600)
    res["tempo_apres_import"] = app_state(page, "s => s.bpm")
    ch.end(note=f"beat sur {bt} ; tempo du projet {res['tempo_apres_import']}")
    page.keyboard.press("Escape")

    # 3. Tempo ---------------------------------------------------------------------------------
    ch.start("Préparer", "Tempo du beat (140 BPM)", protools="Double-clic sur le tempo + saisie + Entrée (1 clic, 4 touches)")
    if abs((app_state(page, "s => s.bpm") or 0) - BPM) < 0.01:
        ch.cur["chemin"].append("déjà à 140 (tempo détecté à l'import)")
    else:
        b = reachable(ch, "[data-testid=open-tempo]", "Tempo")
        if b: ch.click(b, "Tempo")
        elif not open_by_palette(ch, "tempo", "pal.tempo"): ch.fail("fenêtre Tempo introuvable")
        inp = page.locator("input[aria-label='Tempo en BPM']").locator("visible=true")
        try: inp.first.wait_for(timeout=5000)
        except Exception: ch.fail("champ du tempo introuvable")
        if inp.count():
            inp.first.click(click_count=3); ch.cur["clics"] += 1
            ch.type(str(BPM)); ch.press("Enter")
        ch.wait_js(f"() => Math.abs(window.__novaEdit.getState().bpm - {BPM}) < 0.01", 5000, "tempo 140")
        ch.press("Escape")
        if page.locator("input[aria-label='Tempo en BPM']:visible").count(): ch.friction("Échap ne referme pas la fenêtre Tempo")
    ch.end()

    # 4. Trois prises de lead (Loop Record) ------------------------------------------------------
    LEAD = "voix-lead"
    ch.start("Enregistrer", "3 prises de lead en Loop Record (refrain, 4 mesures)",
             protools="Armer (1 clic), Sélecteur sur 4 mesures (1 glisser), Loop Record (Alt+L), Ctrl+Espace, Espace : 1 clic + 1 glisser + 3 touches")
    arm = reachable(ch, f"[data-track-header='{LEAD}'] button[aria-label^='Armer']", "R de la lead")
    if arm: ch.click(arm, "R (armer la lead)")
    else: ch.fail("bouton R de la lead inatteignable")
    y = lane_y(page, LEAD)
    ch.press("4")  # Sélecteur
    ch.drag(time_x(page, REFRAIN[0]), y, time_x(page, REFRAIN[1]), y, "plage du refrain (4 mesures)")
    sel = page.evaluate("async () => { const m = await window.__novaAppModule('/utils/editSelection.ts'); const t = m.editSelectionStore.get().time; return t && [t.start, t.end]; }")
    res["selection_refrain"] = sel
    ch.press("Alt+l")  # Loop Record (Pro Tools : Alt+L)
    lr = app_state(page, "s => ({ loop: s.isLoopActive, a: s.loopStart, b: s.loopEnd, lr: !!s.loopRecord })")
    res["loop_record"] = lr
    if lr and not lr["loop"]:
        ch.friction("Alt+L n'allume pas la boucle sur la plage (Loop Record)"); ch.press("l")
        lr = app_state(page, "s => ({ loop: s.isLoopActive, a: s.loopStart, b: s.loopEnd, lr: !!s.loopRecord })")
    if lr and abs((lr["b"] - lr["a"]) - 4 * BAR) > 0.3: ch.friction(f"la boucle ne suit pas la plage sélectionnée ({lr['a']:.2f}→{lr['b']:.2f} s)")
    ch.press("5")  # Smart Tool
    ch.press("Control+Space")
    page.wait_for_timeout(600)
    casque = page.get_by_role("button", name=re.compile("Oui, j.ai un casque")).locator("visible=true")
    if casque.count():
        ch.friction("question « Tu as un casque ? » au 1er REC (sortie audio sans nom)")
        ch.click(casque.first, "Oui, j'ai un casque")
        if not ch.wait_js("() => window.__novaEdit.getState().isRecording", 2500, ""):
            ch.cur["frictions"][-1:] = []; ch.cur["ok"] = True
            ch.friction("après la question du casque, il faut relancer REC"); ch.press("Control+Space")
    started = ch.wait_js("() => window.__novaEdit.getState().isRecording", 8000, "enregistrement lancé")
    t_rec = time.time()
    # Pré-roll / décompte éventuel + 3 tours de boucle.
    page.wait_for_timeout(int((3 * 4 * BAR + 2.2) * 1000))
    ch.press("Space")
    ch.wait_js("() => !window.__novaEdit.getState().isRecording", 15000, "fin de prise")
    page.wait_for_timeout(1800)
    res["rec_s"] = round(time.time() - t_rec, 1)
    lanes = page.evaluate("""async () => { const P = await window.__novaAppModule('/utils/playlists.ts'); const s = window.__novaEdit.getState();
      const t = s.tracks.find(x => x.id === 'voix-lead'); return P.listLanes(t).map(l => ({ n: l.n, label: l.label, start: +l.start.toFixed(2), end: +l.end.toFixed(2), used: +l.used.toFixed(2) })); }""")
    res["prises_lead"] = lanes
    page.mouse.move(5, 5)
    page.screenshot(path=str(OUT / "04_prises_lead.png"))
    tst = toast_text(page)
    ch.end(ok=bool(started) and len(lanes or []) >= 3, note=f"{len(lanes or [])} prise(s) ; message : {tst[:120]}")

    # 5. Deux backs importés (glisser) ------------------------------------------------------------
    ch.start("Enregistrer", "2 backs : glisser 2 fichiers sur la piste « Backs »",
             protools="Glisser les 2 fichiers de l'Explorateur sur la piste (1 glisser) ; Pro Tools crée une piste par fichier")
    page.keyboard.press("Escape")
    yb = lane_y(page, "backs")
    n_before = len(tracks(page))
    where = drop_files(page, [files["back1"], files["back2"]], time_x(page, 0.0) + 2, yb)
    ch.cur["clics"] += 1; ch.cur["chemin"].append(f"glisser 2 fichiers ({where})")
    ch.wait_js("() => window.__novaEdit.getState().tracks.filter(t => t.clips.some(c => /back_/i.test(c.name || ''))).length >= 2", 20000, "2 backs posés")
    page.wait_for_timeout(800)
    tr = tracks(page)
    backs = [x for x in tr if x["clips"] and any(True for _ in [0]) and x["id"] not in ("instrumental", LEAD, "voix-double")]
    res["backs"] = [{k: x[k] for k in ("id", "name", "out", "plugins")} for x in tr if x["id"] == "backs" or x["id"] not in [t0["id"] for t0 in []] and x["name"].lower().startswith(("back", "back_"))]
    newt = [x for x in tr if x["id"] not in {"instrumental", LEAD, "voix-double", "backs", "bus-vox", "send-verb-short", "send-verb-long", "send-delay", "master"}]
    res["nouvelles_pistes"] = [{k: x[k] for k in ("id", "name", "out", "plugins")} for x in newt]
    for x in newt:
        if re.search(r"\.(wav|aiff?|mp3|flac)$", x["name"], re.I): ch.friction(f"la nouvelle piste garde l'extension du fichier dans son nom (« {x['name']} ») : stems « ….wav.wav »")
        ix = [t0["id"] for t0 in tr]
        if "backs" in ix and x["id"] in ix and ix.index(x["id"]) != ix.index("backs") + 1: ch.friction(f"la 2e back est créée loin de « Backs » (position {ix.index(x['id']) + 1}, « Backs » en {ix.index('backs') + 1})")
        if x["out"] != "bus-vox": ch.friction(f"la 2e back (« {x['name']} ») part au master : pas dans le bus voix comme « Backs »")
        if not x["plugins"]: ch.friction(f"la 2e back (« {x['name']} ») n'a pas la chaîne de « Backs » (EQ, compression, de-esser)")
    page.mouse.move(5, 5)
    page.screenshot(path=str(OUT / "05_backs.png"))
    ch.end(note=f"pistes {n_before} → {len(tr)}")
    BACKS = [x["id"] for x in tracks(page) if x["clips"] and (x["id"] == "backs" or "back_" in x["name"].lower())]
    res["pistes_backs"] = BACKS

    # 6. Comp ------------------------------------------------------------------------------------
    ch.start("Éditer", "Comp : prise 1 sur les mesures 5-6, prise 2 sur 7-8 (le reste : prise 3)",
             protools="Couloirs de playlists déjà visibles ; Sélecteur sur la zone + Ctrl+Alt+V (promouvoir) : 2 glisser + 2 raccourcis")
    page.keyboard.press("Escape")
    lanes = res.get("prises_lead") or []
    if not page.locator("[data-take-lane-row]").count():
        btn = reachable(ch, "[data-takes-button='voix-lead']", "Prises (n)")
        if btn: ch.click(btn, "Prises (n) : déplier les couloirs")
        else: ch.fail("couloirs de prises introuvables")

    def swipe(n, a, b):
        row = page.locator(f'[data-take-lane-row="{n}"]').first
        # La molette amène le couloir au milieu de la vue (sinon il peut rester sous la règle, collée en haut).
        hd = page.locator(f'[data-take-lane="{n}"]').first
        if hd.count(): hd.evaluate("e => e.scrollIntoView({ block: 'center' })"); page.wait_for_timeout(200)
        r = row.bounding_box()
        yy = r["y"] + r["height"] / 2
        ch.drag(time_x(page, a), yy, time_x(page, b), yy, f"balayer la prise {n} ({a:.1f}→{b:.1f} s)")
    full = [l for l in lanes if l["end"] - l["start"] > 3 * BAR]
    if len(full) >= 2:
        swipe(full[0]["n"], REFRAIN[0] + 0.05, REFRAIN[0] + 2 * BAR)
        swipe(full[1]["n"], REFRAIN[0] + 2 * BAR, REFRAIN[1] - 0.05)
    comp = page.evaluate("""async () => { const C = await window.__novaAppModule('/utils/comping.ts');
      const t = window.__novaEdit.getState().tracks.find(x => x.id === 'voix-lead');
      return C.readComp(t.clips).map(s => ({ n: s.n, start: +s.start.toFixed(2), end: +s.end.toFixed(2) })); }""")
    res["comp"] = comp
    page.mouse.move(5, 5)
    page.screenshot(path=str(OUT / "06_comp.png"))
    ok_comp = bool(comp) and len({c["n"] for c in comp}) >= 2
    # Couloirs repliés pour retrouver la place (sinon les autres pistes sont repoussées hors de l'écran).
    btn = reachable(ch, "[data-takes-button='voix-lead']", "Prises (n)", note=False)
    if btn and btn.get_attribute("aria-expanded") == "true": ch.click(btn, "replier les couloirs")
    ch.end(ok=ok_comp, note=f"comp : {comp}")

    # 7. Respirations ------------------------------------------------------------------------------
    ch.start("Éditer", "Nettoyer les respirations (lead baissée, backs supprimées)",
             protools="Pas d'outil natif : sélection + AudioSuite (RX De-breath) par piste ≈ 4 gestes × 3 pistes")
    page.keyboard.press("Escape")
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/editSelection.ts'); m.editSelectionStore.set({ time: null, clipIds: [] }); }")
    ch.press("Control+Alt+r")
    if ch.wait_js("() => !!document.querySelector('[data-testid=breath-dialog]')", 8000, "fenêtre Respirations"):
        ch.wait_js("() => { const b = document.querySelector('[data-testid=breath-apply]'); return b && !b.disabled; }", 20000, "détection terminée")
        res["respirations_resume"] = page.evaluate("() => document.querySelector('[data-testid=breath-summary]')?.innerText || ''")
        res["respirations_pistes"] = page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=breath-track]')).map(e => e.innerText.replace(/\\s+/g, ' ').trim())")
        page.screenshot(path=str(OUT / "07_respirations.png"))
        ap = visible_first(page, "[data-testid=breath-apply]")
        if ap: ch.click(ap, "Appliquer")
        ch.wait_js("() => !document.querySelector('[data-testid=breath-dialog]')", 8000, "fenêtre refermée")
    page.wait_for_timeout(1500)
    res["respirations_toast"] = page.evaluate("() => document.querySelector('[data-testid=breath-toast]')?.innerText || ''")
    ch.end(note=(res.get("respirations_resume") or "")[:160])

    # 8. Caler les backs sur la lead -----------------------------------------------------------------
    ch.start("Éditer", "Caler les 2 backs sur la lead",
             protools="Clic droit sur le clip › ARA VocAlign › guide = lead › Align (≈ 5 gestes, plug-in payant)")
    page.keyboard.press("Escape")
    target = next((b_ for b_ in BACKS if b_ != "backs"), BACKS[0] if BACKS else None)
    yb = lane_y(page, target) if target else None
    if yb:
        clear_way(ch, time_x(page, 2.0), yb, "clic droit sur le clip de la back")
        ch.mouse_click(time_x(page, 2.0), yb, "clip de back", button="right")
        page.wait_for_timeout(250)
        page.screenshot(path=str(OUT / "08_menu_clip.png"))
        try:
            qalib.menu_pick(page, re.compile("Caler sur la lead"))
            ch.cur["clics"] += 2; ch.cur["chemin"].append("Voix › Caler sur la lead")
        except Exception as e:
            ch.fail(f"« Caler sur la lead » introuvable ({str(e)[:60]})")
    if ch.wait_js("() => !!document.querySelector('[data-testid^=ara-dialog]')", 6000, "fenêtre d'alignement"):
        page.wait_for_timeout(600)
        res["caler_candidats"] = page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=ara-candidates] label')).map(e => (e.innerText || '').trim() + (e.querySelector('input')?.checked ? ' [x]' : ' [ ]'))")
        res["caler_guide"] = page.evaluate("() => { const s = document.querySelector('[data-testid=ara-guide]'); return s ? s.options[s.selectedIndex]?.text : null; }")
        page.screenshot(path=str(OUT / "08_caler.png"))
        for _ in range(4):
            un = page.locator("[data-testid=ara-candidates] label", has_text=re.compile("back", re.I)).locator("input[type=checkbox]:not(:checked)")
            if not un.count(): break
            ch.friction("une back n'est pas proposée d'office au calage")
            ch.click(un.first, "cocher l'autre back")
        al = visible_first(page, "[data-testid=ara-align]")
        if al: ch.click(al, "Caler sur le guide")
        else: ch.fail("bouton « Caler » introuvable")
        page.wait_for_timeout(500)
        ch.wait_js("() => !/Calage|en cours|Analyse|…/i.test(document.querySelector('[data-testid=ara-info]')?.innerText || '')", 30000, "calage terminé")
        page.wait_for_timeout(800)
        res["caler_info"] = page.evaluate("() => document.querySelector('[data-testid=ara-info]')?.innerText || ''")
        page.screenshot(path=str(OUT / "08_caler_fin.png"))
        if page.locator("[data-testid^=ara-dialog]").count():
            v = visible_first(page, "[data-testid=ara-validate]")
            if v: ch.click(v, "Valider")
            else: ch.press("Escape")
    res["caler_apres"] = app_state(page, "s => s.tracks.filter(t => /back/i.test(t.name) || t.id === 'backs').map(t => t.clips.map(c => [c.name, !!c.araEdit]))")
    ch.end(note=(res.get("caler_info") or "")[:140])

    # 9a. Mix : un insert ------------------------------------------------------------------------------
    ch.start("Mixer", "Insert : saturation sur les backs", protools="Clic sur un insert vide › plug-in › Saturation (3 clics)")
    page.keyboard.press("Escape")
    lane_y(page, "backs")  # la molette amène « Backs » dans la vue (geste non compté)
    fx = reachable(ch, "[data-track-header='backs'] button[aria-label^='Effets de']", "FX des backs")
    if fx:
        ch.click(fx, "FX")
        add = page.locator("button", has_text=re.compile("Ajouter un effet")).locator("visible=true")
        if add.count(): ch.click(add.first, "Ajouter un effet")
        if ch.wait_js("() => !!document.querySelector('[data-testid=add-effect-menu]')", 4000, "liste des effets"):
            ch.type("satur"); ch.press("Enter")
    page.wait_for_timeout(800)
    n_pl = app_state(page, "s => s.tracks.find(t => t.id === 'backs').plugins.length")
    cov = page.evaluate("() => Array.from(document.querySelectorAll('[data-nova-window], [role=dialog]')).filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') || e.dataset.testid || e.tagName, Math.round(r.width), Math.round(r.height)]; })")
    res["insert_fenetres"] = cov
    page.screenshot(path=str(OUT / "09a_insert.png"))
    ch.end(ok=(n_pl or 0) >= 4, note=f"effets des backs : {n_pl} ; fenêtres ouvertes : {cov}")
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)

    # 9b. Mix : un envoi ---------------------------------------------------------------------------------
    ch.start("Mixer", "Envoi : la 2e back vers « Reverb longue »", protools="Clic sur l'envoi › glisser le niveau : 2 gestes")
    who = target or "backs"
    lane_y(page, who)
    sb = reachable(ch, f"[data-track-header='{who}'] button[aria-label^='Envois de']", "Envois")
    lv0 = app_state(page, f"s => ((s.tracks.find(t => t.id === '{who}') || {{}}).sends || []).find(x => x.id === 'send-verb-long')?.level ?? null")
    if sb:
        ch.click(sb, "Envois")
        page.wait_for_timeout(300)
        lab = page.locator(f"[data-track-header='{who}']").get_by_text(re.compile("Reverb longue", re.I)).locator("visible=true")
        if lab.count():
            r = lab.first.bounding_box()
            ch.drag(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2, r["x"] + r["width"] / 2 + 140, r["y"] + r["height"] / 2, "niveau de l'envoi")
        else:
            ch.fail("aucun envoi « Reverb longue » sur cette piste (la piste importée n'a pas les envois de « Backs »)")
    else:
        ch.fail("bouton Envois introuvable sur la piste")
    lv1 = app_state(page, f"s => ((s.tracks.find(t => t.id === '{who}') || {{}}).sends || []).find(x => x.id === 'send-verb-long')?.level ?? null")
    res["envoi_reverb_longue"] = [lv0, lv1]
    page.screenshot(path=str(OUT / "09b_envoi.png"))
    ch.end(ok=lv1 is not None and lv1 != lv0, note=f"niveau {lv0} → {lv1}")
    page.keyboard.press("Escape")

    # 9c. Mix : automation de volume sur le refrain --------------------------------------------------------
    ch.start("Mixer", "Automation : lead +2 dB sur le refrain (mesures 5 à 8)",
             protools="Vue volume de la piste, Sélecteur sur le refrain, Trim (glisser) ou Write to Selection : 1 clic + 1 glisser + 1 glisser")
    page.keyboard.press("Escape")
    y = lane_y(page, LEAD)
    ch.press("4")
    clear_way(ch, time_x(page, REFRAIN[0]), y, "début de la plage du refrain")
    ch.drag(time_x(page, REFRAIN[0]), y, time_x(page, REFRAIN[1]), y, "plage du refrain sur la lead")
    vol = visible_first(page, "[data-nova-target=range-actions] button[aria-label^='Volume']")
    if vol:
        ch.click(vol, "Volume de la plage")
        inp = visible_first(page, "input[aria-label^='Volume de la plage']")
        if inp:
            inp.click(click_count=3); ch.cur["clics"] += 1
            ch.type("2"); ch.press("Enter")
        else:
            ch.fail("champ du volume de la plage introuvable")
    else:
        ch.friction("aucune action « volume » sur une plage : il faut passer par l'éditeur d'automation (autre vue) et poser 4 points à la main")
        auto = reachable(ch, "button:has-text('AUTO')", "AUTO")
        if auto: ch.click(auto, "vue AUTO")
        page.wait_for_timeout(600)
        plus = visible_first(page, "button[aria-label='Ajouter un paramètre à automatiser sur Voix lead']")
        if plus:
            ch.click(plus, "+ paramètre (Voix lead)")
            v = page.locator("button", has_text=re.compile("^\\s*Volume\\s*$")).locator("visible=true")
            if v.count(): ch.click(v.first, "Volume")
        page.wait_for_timeout(500)
        page.keyboard.press("Escape")
        cv = page.evaluate("""() => { const h = Array.from(document.querySelectorAll('span')).find(e => /^voix lead$/i.test(e.innerText.trim()) && e.getClientRects().length);
          if (!h) return null; const y0 = h.getBoundingClientRect().bottom;
          const c = Array.from(document.querySelectorAll('canvas')).filter(c => c.getClientRects().length && c.getBoundingClientRect().height >= 40 && c.getBoundingClientRect().height <= 140 && c.getBoundingClientRect().top >= y0 - 2 && c.getBoundingClientRect().width > 300)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          const r = c.length ? c[0].getBoundingClientRect() : null; return r && { x: r.left, y: r.top, w: r.width, h: r.height }; }""")
        page.screenshot(path=str(OUT / "09c_auto_vue.png"))
        if cv:
            z = 40
            for (tt, lvl) in ((REFRAIN[0] - 0.05, 0.6), (REFRAIN[0], 0.45), (REFRAIN[1], 0.45), (REFRAIN[1] + 0.05, 0.6)):
                ch.mouse_click(cv["x"] + tt * z, cv["y"] + cv["h"] * lvl, f"point à {tt:.2f} s")
            ch.friction("valeurs des points posées au jugé (aucune saisie en dB) : +2 dB exacts impossibles")
        else:
            ch.fail("couloir d'automation introuvable")
        back = reachable(ch, "button:has-text('PISTES')", "PISTES", note=False)
        if back: ch.click(back, "retour aux PISTES")
    autom = app_state(page, "s => { const t = s.tracks.find(x => x.id === 'voix-lead'); const l = t.automationLanes.find(l => l.parameterName === 'volume'); return l ? { base: t.volume, pts: l.points.map(p => [+p.time.toFixed(2), +(20 * Math.log10(Math.max(1e-6, p.value))).toFixed(2)]), shown: !!l.isExpanded } : null; }")
    res["automation_volume"] = autom
    page.mouse.move(5, 5)
    page.screenshot(path=str(OUT / "09c_automation.png"))
    ch.end(ok=bool(autom and len(autom["pts"]) >= 3), note=json.dumps(autom, ensure_ascii=False)[:200])
    page.keyboard.press("Escape")

    # 10. Bounce du mix ----------------------------------------------------------------------------------
    ch.start("Livrer", "Bounce du mix (WAV)", protools="Ctrl+Alt+B, Bounce, nom, Enregistrer : 1 raccourci + 2 clics")
    page.keyboard.press("Escape")
    ch.press("Control+Shift+E")
    if ch.wait_js("() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')", 6000, "fenêtre Exporter"):
        mix = visible_first(page, "[data-testid=export-source-MASTER]")
        if mix and mix.get_attribute("aria-checked") != "true": ch.click(mix, "Mix")
        w = ch.wait_js("() => { const b = document.querySelector('[data-testid=export-go]'); return b && !b.disabled; }", 10000, "EXPORTER actif")
        if w and w > 1500: ch.friction(f"attente de {w} ms avant de pouvoir exporter")
        go = visible_first(page, "[data-testid=export-go]")
        try:
            with page.expect_download(timeout=180000) as dl:
                ch.click(go, "EXPORTER")
            d = dl.value
            pth = OUT / f"bounce_{d.suggested_filename or 'mix.wav'}"
            d.save_as(str(pth))
            res["bounce"] = {"fichier": d.suggested_filename, "octets": pth.stat().st_size}
        except Exception as e:
            ch.fail(f"pas de fichier ({str(e)[:80]})")
    page.wait_for_timeout(600)
    ch.end(note=json.dumps(res.get("bounce"), ensure_ascii=False))
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)

    # 11. Stems ----------------------------------------------------------------------------------------------
    ch.start("Livrer", "Export des stems (une piste par fichier, .zip)", protools="Track Bounce : sélectionner les pistes, clic droit › Bounce… › options › Bounce (≈ 5 gestes)")
    res["focus_avant_stems"] = page.evaluate("() => { const a = document.activeElement; return a ? a.tagName + ' ' + (a.getAttribute('aria-label') || a.className || '').toString().slice(0, 60) : null; }")
    ch.press("Control+Shift+E")
    page.wait_for_timeout(500)
    if not page.locator("[role=dialog][aria-labelledby=export-title]").count():
        ch.friction("Ctrl+Maj+E ne rouvre pas la fenêtre Exporter après un premier export")
        page.screenshot(path=str(OUT / "11_ctrl_maj_e_sans_effet.png"))
        b_ = reachable(ch, "button[aria-label='Exporter le mix']", "Exporter")
        if b_: ch.click(b_, "Exporter (barre)")
    if ch.wait_js("() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')", 6000, "fenêtre Exporter"):
        w = ch.wait_js("() => { const b = document.querySelector('[data-testid=export-source-STEMS]'); return b && !b.disabled; }", 30000, "choix Stems actif")
        if w and w > 1500: ch.friction(f"fenêtre Exporter occupée {w} ms (rendu précédent) avant de pouvoir choisir « Stems »")
        st_ = visible_first(page, "[data-testid=export-source-STEMS]")
        if st_: ch.click(st_, "Stems")
        else: ch.fail("choix « Stems » introuvable")
        page.wait_for_timeout(300)
        res["stems_options"] = page.evaluate("() => (document.querySelector('[role=dialog][aria-labelledby=export-title]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 700)")
        page.screenshot(path=str(OUT / "11_stems.png"))
        ch.wait_js("() => { const b = document.querySelector('[data-testid=export-go]'); return b && !b.disabled; }", 10000, "EXPORTER actif")
        go = visible_first(page, "[data-testid=export-go]")
        try:
            with page.expect_download(timeout=240000) as dl:
                ch.click(go, "EXPORTER")
            d = dl.value
            pth = OUT / f"stems_{d.suggested_filename or 'stems.zip'}"
            d.save_as(str(pth))
            import zipfile
            names = []
            try: names = zipfile.ZipFile(pth).namelist()
            except Exception: pass
            res["stems"] = {"fichier": d.suggested_filename, "octets": pth.stat().st_size, "contenu": names}
        except Exception as e:
            ch.fail(f"pas de fichier ({str(e)[:80]})")
    ch.end(note=json.dumps(res.get("stems"), ensure_ascii=False)[:300])
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)
    page.mouse.move(5, 5)
    page.screenshot(path=str(OUT / "12_fin.png"))
    res["etat_final"] = tracks(page)
    return res


def main():
    files = make_audio()
    qalib.FAKE_WAV = str(files["micro"])
    with sync_playwright() as p:
        b = launch(p)
        log = Log(f"seance_{VP}")
        ctx, page = new_page(b, VP, log=log, touch=False)
        page.set_default_timeout(20000)
        page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        install_mocks(page, "romain", SUPERADMIN, {})
        ch = Chrono(f"seance_{VP}", page, log, OUT)
        t0 = time.time()
        try:
            extra = run(page, log, ch, files)
        except Exception as e:
            ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:300]}"); ch.end(ok=False)
            extra = {"arret": str(e)[:400]}
            page.screenshot(path=str(OUT / "arret.png"))
        rep = ch.report()
        rep["phase"] = PHASE; rep["viewport"] = qalib.VIEWPORTS[VP]
        rep["mesures"] = extra
        rep["duree_totale_s"] = round(time.time() - t0, 1)
        rep["erreurs_console"] = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:15]
        save_json(OUT / "seance.json", rep)
        print("\nTOTAL :", json.dumps(rep["total"], ensure_ascii=False), "| console :", len(rep["erreurs_console"]))
        ctx.close(); b.close()
    sys.exit(1 if rep["total"]["etapes_ko"] else 0)


if __name__ == "__main__":
    main()
