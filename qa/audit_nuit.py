"""Tour croisé de nuit (22/10/2026) : les nouveautés de la 1.5.16 enchaînées comme un vrai utilisateur.

Navigateur headless (aucune fenêtre), 100 % hors production (qalib → qa_hors_prod : Supabase simulé,
nova-billing simulé ici : export ouvert), micro simulé de Chrome.

Cas (tous par défaut ; `python qa/audit_nuit.py raccourcis veille …` pour en choisir) :

  parcours    Nouveau beat → séquenceur (pas, probabilité, roll, fill, 2e motif) → sampler d'un pad
              (attaque, passe-bas, hauteur) → 808 au piano roll (glissés) → synthé + tampon d'accords →
              3 prises voix (2 gardées) → console (EQ + compresseur) → export WAV → sauvegarde .zip →
              réouverture dans un navigateur neuf : état identique et rendu identique (nul ≤ −120 dBFS ;
              Chrome additionne les entrées d'un nœud dans un ordre qui varie : ±1 ulp, ≈ −170 dBFS) ;
              les sons du .zip sont SANS PERTE (prise relue = prise enregistrée, au bit près) ;
              Ctrl+Z jusqu'au début puis Ctrl+Y jusqu'au bout : même état.
  raccourcis  Piano roll ouvert (plein écran) ou batterie ouverte : les chiffres, lettres, Suppr, Ctrl+E…
              n'agissent pas sur l'arrangement caché derrière (outil, clips, zoom) ; dans le piano roll,
              G / T / Z / S restent ceux du piano roll ; dans la batterie, Maj+←/→, Suppr, Ctrl+D, [ ].
  toast       La bulle de Nova (« Batterie posée… ») ne prend pas les clics des pas de la batterie ni
              du synthé (elle laissait passer les clics vers… le chat).
  veille      À l'arrêt, plus rien ne tourne : CPU de tous les processus du navigateur mesuré (projet beat
              avec réverbes) ; un clic sur un pad, Espace, R : le son repart tout de suite.
  fuites      Batterie, sampler, piano roll, synthé, console, export ouverts / fermés 4 fois : minuteries,
              nœuds audio branchés, écouteurs et éléments de page reviennent au même niveau.
  formats     1366 / 1600 / 1920, tablette 1024 au doigt, téléphone 390, sombre et clair : batterie, menu du
              pas, sampler, piano roll et ses menus : rien ne déborde de l'écran, rien de recouvert dans la
              fenêtre du dessus, aucun nom de logiciel concurrent visible (textes ET infobulles).

NOVA_URL=http://127.0.0.1:3547/ PYTHONIOENCODING=utf-8 python qa/audit_nuit.py [cas …]
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-auditnuit) : audit_nuit.json + captures.
"""
import base64, json, os, re, sys, time, traceback, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-auditnuit")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, CHROME, FAKE_WAV, Log, launch, new_page, balayage_chevauchement, overflow_report, roll_reveal, ouvrir_plus_accueil  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RES = {"cas": {}, "mesures": {}, "ok": True}
INIT = ("try { localStorage.setItem('nova_headphones','1'); localStorage.setItem('nova_welcome_seen','1'); localStorage.setItem('nova_count_in','0');"
        " localStorage.setItem('nova_simple_mode','%s'); localStorage.setItem('nova_theme','%s'); } catch(e) {}")
DR = "[aria-labelledby='drums-title']"


def check(cas, ok, quoi, detail=None):
    RES["cas"].setdefault(cas, []).append({"ok": bool(ok), "quoi": quoi, **({"detail": detail} if detail is not None and not ok else {})})
    if not ok:
        RES["ok"] = False
    print(("OK  " if ok else "KO  ") + f"[{cas}] {quoi}" + ("" if ok or detail is None else f"  → {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)
    return ok


def mesure(k, v):
    RES["mesures"][k] = v
    print(f"    mesure {k} = {json.dumps(v, ensure_ascii=False, default=str)[:400]}", flush=True)


def billing(page):
    def handle(route):
        try:
            body = json.loads(route.request.post_data or "{}")
        except Exception:
            body = {}
        d = ({"unlocked": True, "via": "pro", "reason": None, "missing": [], "items": []} if body.get("action") == "export_access"
             else {"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})
        route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
    page.route("**/functions/v1/nova-billing", handle)


def page_errors(log):
    return [e["text"][:300] for e in log.entries if e["kind"] in ("console.error", "pageerror")
            and "nova-billing" not in e["text"] and "8765" not in e["text"] and "8766" not in e["text"]]


def react_warnings(log):
    return [e["text"][:300] for e in log.entries if e["kind"] == "console.warning" and re.search(r"Warning:|React|key prop|act\(|unmounted", e["text"])]


def studio(p, vp="pc", theme="dark", simple=False, name="audit", browser=None):
    b = browser or launch(p)
    log = Log(name)
    ctx, page = new_page(b, vp, log)
    page.add_init_script(INIT % ("1" if simple else "0", theme))
    billing(page)
    page.set_default_timeout(20000)
    return b, ctx, page, log


def new_beat(page, kit="🔥 Trap"):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
    if not page.locator("[data-testid=landing-new-beat]").locator("visible=true").count():
        ouvrir_plus_accueil(page, touch=False)  # mode simple : rangé sous « Plus d'options »
    page.locator("[data-testid=landing-new-beat]").locator("visible=true").first.click(timeout=30000)
    page.wait_for_selector(DR, timeout=30000); page.wait_for_timeout(500)
    if kit:
        page.get_by_role("button", name=kit).first.click(); page.wait_for_timeout(1500)


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.DAW_CONTROL.getState(); return ({expr})(s); }}")


def wait_roll(page, timeout=10000):
    """Attend le piano roll SANS poignée Playwright sur l'élément (locator.wait_for en garde une côté
    DevTools : le piano roll fermé restait en mémoire et la mesure des fuites accusait l'appli à tort)."""
    page.wait_for_function("() => !!document.querySelector('[data-nova-pianoroll]')", timeout=timeout)


def roll_open(page):
    return page.locator("[data-nova-pianoroll]").count() > 0


def drums_open(page):
    return page.locator(DR).count() > 0


def close_roll(page):
    for _ in range(4):
        if not roll_open(page):
            return
        page.keyboard.press("Escape"); page.wait_for_timeout(300)


def open_synth_roll(page):
    t = page.evaluate("() => { const t = window.DAW_CONTROL.getState().tracks.find(t => t.type === 'MIDI' && !t.bass808); return t ? [t.id, t.clips[0].id] : null; }")
    page.evaluate("([t, c]) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId: t, clipId: c } }))", t)
    wait_roll(page, 10000); page.wait_for_timeout(400)


def add_synth(page):
    """« Synthé NOVA » (barre du bas) : piste + fenêtre du synthé + piano roll ; Échap ferme le synthé."""
    page.get_by_role("button", name=re.compile("Synthé NOVA")).first.click(); page.wait_for_timeout(1500)
    page.keyboard.press("Escape"); page.wait_for_timeout(400)


# ═══════════════════════════════════════════════════════════════════════════════════════
# raccourcis : piano roll / batterie ouverts, l'arrangement caché ne bouge pas
# ═══════════════════════════════════════════════════════════════════════════════════════

SNAP = r"""() => {
  const s = window.DAW_CONTROL.getState();
  const h = (o) => { const j = JSON.stringify(o); let x = 0; for (let i = 0; i < j.length; i++) x = (x * 31 + j.charCodeAt(i)) | 0; return x; };
  const arr = document.querySelector('[data-arrange-scroll]');
  const tools = [...document.querySelectorAll('button')].filter(b => /^(Outil |Smart Tool|Sélecteur de plage)/.test(b.getAttribute('aria-label') || '') && /bg-\[#38bdf8\]/.test(b.className)).map(b => b.getAttribute('aria-label'));
  const grid = document.querySelector('[data-nova-roll-grid]');
  const drums = s.tracks.find(t => t.id === 'track-drums');
  const synth = s.tracks.find(t => t.type === 'MIDI' && !t.bass808);
  return {
    clips: h(s.tracks.filter(t => t.type !== 'MIDI' && t.type !== 'DRUM_RACK').map(t => t.clips.map(c => [c.id, +c.start.toFixed(4), +c.duration.toFixed(4), c.fadeIn, c.fadeOut, !!c.isMuted]))),
    pistes: s.tracks.map(t => t.id).join(','), muets: s.tracks.filter(t => t.isMuted).map(t => t.id).join(','), bpm: s.bpm,
    outilArr: tools.join(','), zoomH: arr ? arr.dataset.zoomH : null, rec: !!s.isRecording,
    roll: !!document.querySelector('[data-nova-pianoroll]'), outilRoll: grid ? grid.dataset.novaTool : null, zoomRoll: grid ? grid.dataset.novaZoom : null,
    notes: synth ? h(synth.clips.map(c => (c.notes || []).map(n => [n.pitch, +n.start.toFixed(4), +n.duration.toFixed(4), !!n.muted, !!n.slide]))) : null,
    dm: drums ? h(drums.drumMachine) : null, motif: drums ? drums.drumMachine.activePattern || null : null,
  };
}"""
ARR_KEYS = ("clips", "pistes", "muets", "outilArr", "zoomH", "rec", "bpm")


def press_and_diff(page, key):
    a = page.evaluate(SNAP)
    page.keyboard.press(key); page.wait_for_timeout(350)
    b = page.evaluate(SNAP)
    return {k: [a[k], b[k]] for k in a if a[k] != b[k]}


def cas_raccourcis(p):
    b, ctx, page, log = studio(p, name="raccourcis")
    try:
        new_beat(page)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        add_synth(page)
        page.evaluate("""() => window.__novaTest.update(d => { const t = d.tracks.find(t => t.type === 'MIDI' && !t.bass808); t.clips[0].notes =
          [0, 0.5, 1, 1.5].map((s, i) => ({ id: 'qa' + i, pitch: 60 + 2 * i, start: s, duration: 0.4, velocity: 0.8 })); })""")
        close_roll(page)
        # Un clip de l'arrangement sélectionné (le clip de la batterie) : Suppr / Ctrl+D / S le toucheraient.
        page.keyboard.press("2"); page.keyboard.press("1"); page.wait_for_timeout(200)
        open_synth_roll(page)
        leaks = []
        for k in list("0123456789") + list("abcdefhijklmnopquvwxy") + ["Delete", "Backspace", "Control+e", "Control+t", "Control+b", "Control+l", "Alt+s", "Enter", "Home", "End"]:
            if not roll_open(page): open_synth_roll(page)
            d = press_and_diff(page, k)
            hidden = {x: v for x, v in d.items() if x in ARR_KEYS}
            if hidden: leaks.append({"touche": k, "arrangement": hidden})
            if "notes" in d or "dm" in d:
                page.keyboard.press("Control+z"); page.wait_for_timeout(250)
            if page.locator("[role=menu], [role=dialog]").locator("visible=true").count():
                page.keyboard.press("Escape"); page.wait_for_timeout(200)
            if st(page, "s => s.isPlaying"): page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(200)
        check("raccourcis", not leaks, "piano roll ouvert : aucune touche ne change l'arrangement caché (outil, clips, zoom, pistes)", leaks[:12])
        # Les touches propres au piano roll restent les siennes.
        own = {}
        for k, want in (("g", "GLUE"), ("t", "MUTE"), ("p", "DRAW")):
            d = press_and_diff(page, k)
            own[k] = d.get("outilRoll", [None, None])[1]
        check("raccourcis", own == {"g": "GLUE", "t": "MUTE", "p": "DRAW"}, "piano roll : G = souder, T = sourdine, P = crayon (ses outils à lui)", own)
        d = press_and_diff(page, "z")
        check("raccourcis", "zoomH" not in d, "piano roll : Z (zoom sur les notes) ne zoome pas l'arrangement caché", d)
        foc = page.evaluate("() => { const a = document.activeElement; return !!(a && a.closest && a.closest('[data-nova-pianoroll], [data-nova-transport]')); }")
        check("raccourcis", foc, "piano roll ouvert : le focus clavier est DANS le piano roll (Entrée n'active plus un bouton caché derrière)",
              page.evaluate("() => document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.innerText || document.activeElement.tagName).slice(0, 60)"))
        close_roll(page)
        check("raccourcis", not roll_open(page), "Échap ferme le piano roll")
        # Batterie ouverte, focus dans la batterie.
        page.get_by_role("button", name="Batterie").first.click(); page.wait_for_timeout(700)
        page.locator(f"{DR} [data-row=kick] button").first.click(); page.wait_for_timeout(150)
        leaks = []
        for k in list("0123456789") + ["Control+e", "Home", "End"]:
            d = press_and_diff(page, k)
            hidden = {x: v for x, v in d.items() if x in ARR_KEYS}
            if hidden: leaks.append({"touche": k, "arrangement": hidden})
        check("raccourcis", not leaks, "batterie ouverte : les chiffres n'agissent plus sur l'outil de l'arrangement derrière", leaks)
        d = press_and_diff(page, "Shift+ArrowRight")
        check("raccourcis", "dm" in d, "batterie : Maj+→ décale la rangée choisie", d)
        d = press_and_diff(page, "Control+d")
        check("raccourcis", d.get("motif") and d["motif"][0] != d["motif"][1], "batterie : Ctrl+D duplique le motif (nouveau motif affiché)", d)
        d = press_and_diff(page, "BracketLeft")
        check("raccourcis", d.get("motif") is not None, "batterie : [ revient au motif précédent", d)
        page.locator(f"{DR} [data-row=kick] button").first.dblclick(); page.wait_for_timeout(600)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        check("raccourcis", page.locator("[data-testid=pad-sampler]").count() == 0 and drums_open(page),
              "double-clic sur un pad puis Échap : le sampler se ferme, la batterie reste (la fenêtre du dessus d'abord)")
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        check("raccourcis", not drums_open(page), "Échap ferme la batterie")
        e = page_errors(log)
        check("raccourcis", not e, "aucune erreur de page", e[:5])
    finally:
        b.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# toast : la bulle de Nova ne prend pas les clics de la fenêtre de travail
# ═══════════════════════════════════════════════════════════════════════════════════════

def cas_toast(p):
    b, ctx, page, log = studio(p, name="toast")
    try:
        new_beat(page)  # « Batterie « Trap » posée… » : bulle de 6 s
        bulle = page.locator("button[role=status]").locator("visible=true")
        check("toast", bulle.count() == 1, "la bulle « Batterie posée » s'affiche")
        if bulle.count():
            bb = bulle.first.bounding_box()
            # Un pas de la batterie sous la bulle (intersection des rectangles) : on clique au milieu de l'intersection.
            under = page.evaluate("""(r) => { for (const b of document.querySelectorAll('[aria-labelledby="drums-title"] button[aria-label*=", pas "]')) {
                const q = b.getBoundingClientRect(); const L = Math.max(q.left, r.x), R = Math.min(q.right, r.x + r.width), T = Math.max(q.top, r.y), B = Math.min(q.bottom, r.y + r.height);
                if (R - L > 6 && B - T > 6) return { label: b.getAttribute('aria-label'), x: (L + R) / 2, y: (T + B) / 2 }; } return null; }""", bb)
            mesure("toast_pas_sous_la_bulle", under)
            if under:
                nom = under["label"].split(",")[0] + "," + under["label"].split(",")[1]
                page.mouse.click(under["x"], under["y"]); page.wait_for_timeout(300)
                chat = page.locator("[data-testid=nova-chat]").count()
                after = page.evaluate("(n) => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').startsWith(n)); return b ? b.getAttribute('aria-label') : null; }", nom)
                check("toast", chat == 0 and after != under["label"], f"un clic sur « {nom} » (sous la bulle) allume / éteint ce pas, sans ouvrir le chat", {"avant": under["label"], "apres": after, "chat_ouvert": chat})
            else:
                check("toast", True, "aucun pas sous la bulle à ce format")
        e = page_errors(log)
        check("toast", not e, "aucune erreur de page", e[:5])
    finally:
        b.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# veille : à l'arrêt, rien ne tourne (CPU de tous les processus du navigateur)
# ═══════════════════════════════════════════════════════════════════════════════════════

def cpu_times(bcdp):
    return {f"{x['type']}:{x['id']}": x["cpuTime"] for x in bcdp.send("SystemInfo.getProcessInfo")["processInfo"]}


def cpu_pct(page, bcdp, secs):
    a = cpu_times(bcdp); page.wait_for_timeout(int(secs * 1000)); b = cpu_times(bcdp)
    return round(100 * sum(b[k] - a.get(k, 0) for k in b) / secs, 1)


CTX_STATE = "async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts'); return audioEngine.ctx ? audioEngine.ctx.state : null; }"


def cas_veille(p):
    b, ctx, page, log = studio(p, name="veille")
    try:
        # Au premier plan, la veille attend 5 min (engine/idleSuspend) : délai ramené à 12 s pour la mesure.
        page.add_init_script("try { localStorage.setItem('nova_veille_moteur_s', '12'); } catch (e) {}")
        bcdp = b.new_browser_cdp_session()
        new_beat(page)
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        page.mouse.move(5, 5)
        page.wait_for_timeout(2000)
        actif = cpu_pct(page, bcdp, 5)
        mesure("cpu_arret_premieres_secondes_pct", actif)
        # Veille : quelques secondes sans geste ni son.
        t0 = time.time()
        while time.time() - t0 < 60 and page.evaluate(CTX_STATE) != "suspended":
            page.wait_for_timeout(500)
        veille_s = round(time.time() - t0, 1)
        etat = page.evaluate(CTX_STATE)
        mesure("veille_apres_s", veille_s)
        check("veille", etat == "suspended", "à l'arrêt, sans geste ni son, le moteur audio se met en veille", {"etat": etat, "apres_s": veille_s})
        repos = cpu_pct(page, bcdp, 10)
        mesure("cpu_arret_en_veille_pct", repos)
        check("veille", repos <= 5, f"à l'arrêt en veille : CPU de tout le navigateur ≤ 5 % d'un cœur (mesuré {repos} %, {actif} % juste avant la veille)", repos)
        # Réveil par un geste : un pad joué au clic sonne.
        page.get_by_role("button", name="Batterie").first.click(); page.wait_for_timeout(300)
        etat2 = page.evaluate(CTX_STATE)
        check("veille", etat2 == "running", "un clic réveille le moteur tout de suite", etat2)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # Réveil par la lecture (raccourci) et par l'API (comme une commande à distance).
        t0 = time.time()
        while time.time() - t0 < 60 and page.evaluate(CTX_STATE) != "suspended":
            page.wait_for_timeout(500)
        page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(1200)
        tpos = st(page, "s => s.currentTime")
        check("veille", page.evaluate(CTX_STATE) == "running" and tpos > 0.5, "lecture lancée sans geste (commande à distance) : le moteur se réveille et la tête avance", {"etat": page.evaluate(CTX_STATE), "position": tpos})
        page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(500)
        # Piste armée : jamais de veille (le micro et ses mètres doivent vivre).
        page.evaluate("() => window.__novaTest.update(d => { const t = d.tracks.find(t => t.id === 'track-rec-main'); if (t) t.isTrackArmed = true; })")
        page.wait_for_timeout(1500)
        page.mouse.move(8, 8)
        page.wait_for_timeout(15000)
        check("veille", page.evaluate(CTX_STATE) == "running", "piste armée : pas de veille (micro et mètres vivants)", page.evaluate(CTX_STATE))
        e = page_errors(log)
        check("veille", not e, "aucune erreur de page", e[:5])
    finally:
        b.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# fuites : fenêtres ouvertes / fermées, rien ne reste
# ═══════════════════════════════════════════════════════════════════════════════════════

INSTR = r"""
(() => {
  const W = window; const S = W.__fx = { iv: new Map(), nodes: new Set(), out: new WeakMap(), raf: 0 };
  const si = W.setInterval.bind(W), ci = W.clearInterval.bind(W), raf = W.requestAnimationFrame.bind(W);
  W.setInterval = (fn, ms, ...a) => { const stack = (new Error().stack || '').split('\n').slice(2, 4).join(' | ').replace(/https?:\/\/[^/]+/g, '').replace(/\?[^:)]*/g, '').slice(0, 200);
    const id = si(fn, ms, ...a); S.iv.set(id, { ms, stack }); return id; };
  W.clearInterval = (id) => { S.iv.delete(id); return ci(id); };
  W.requestAnimationFrame = (fn) => raf((t) => { S.raf++; return fn(t); });
  const P = AudioNode.prototype; const c0 = P.connect, d0 = P.disconnect;
  P.connect = function (...a) { S.out.set(this, (S.out.get(this) || 0) + 1); S.nodes.add(this); return c0.apply(this, a); };
  P.disconnect = function (...a) { if (!a.length) { S.out.set(this, 0); S.nodes.delete(this); } else { const n = Math.max(0, (S.out.get(this) || 0) - 1); S.out.set(this, n); if (!n) S.nodes.delete(this); } return d0.apply(this, a); };
})();
"""
COUNT = r"""() => { const S = window.__fx; let nodes = 0;
  for (const n of S.nodes) { if (!n.context || n.context.state === 'closed' || n.context instanceof OfflineAudioContext) continue; nodes++; }
  return { intervals: S.iv.size, ivDetail: [...S.iv.values()].map(x => x.ms + 'ms ' + x.stack), nodes, dom: document.getElementsByTagName('*').length }; }"""


def cas_fuites(p):
    b, ctx, page, log = studio(p, name="fuites")
    try:
        ctx.add_init_script(INSTR)
        cdp = ctx.new_cdp_session(page); cdp.send("Performance.enable"); cdp.send("HeapProfiler.enable")
        new_beat(page)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        add_synth(page); close_roll(page)
        synth = page.evaluate("() => { const t = window.DAW_CONTROL.getState().tracks.find(t => t.type === 'MIDI' && !t.bass808); return [t.id, t.clips[0].id]; }")

        def tour():
            page.get_by_role("button", name="Batterie").first.click(); page.wait_for_timeout(700)
            page.locator(f"{DR} [data-row=kick] button").first.dblclick(); page.wait_for_timeout(600)
            for tab in ("env", "filter", "pitch", "mod", "sample"):
                page.locator(f"[data-testid=pad-tab-{tab}]").click(); page.wait_for_timeout(120)
            page.keyboard.press("Escape"); page.wait_for_timeout(300)
            st_ = page.locator(DR).get_by_role("button", name=re.compile(r"^Snare, pas 3")).first.bounding_box()
            page.mouse.click(st_["x"] + 5, st_["y"] + 5, button="right"); page.wait_for_timeout(300)
            page.keyboard.press("Escape"); page.wait_for_timeout(200)
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
            page.evaluate("([t, c]) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId: t, clipId: c } }))", synth)
            wait_roll(page, 8000); page.wait_for_timeout(400)
            for m in ("outils", "notes", "vue"):
                bt = page.locator(f"[data-nova-roll-menu-btn={m}]").locator("visible=true")
                if bt.count(): bt.first.click(); page.wait_for_timeout(150); page.keyboard.press("Escape"); page.wait_for_timeout(150)
            close_roll(page)
            page.get_by_role("button", name="808").locator("visible=true").first.click(); page.wait_for_timeout(900)
            close_roll(page)
            page.keyboard.press("Control+Equal"); page.wait_for_timeout(1000)
            page.keyboard.press("Control+Equal"); page.wait_for_timeout(500)
            page.get_by_role("button", name=re.compile("Ouvrir le synthé")).first.click(); page.wait_for_timeout(800)
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
            page.keyboard.press("Control+Shift+e"); page.wait_for_timeout(900)
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
            page.keyboard.press("Space"); page.wait_for_timeout(1500); page.keyboard.press("Space"); page.wait_for_timeout(600)

        def mesurer():
            page.mouse.click(1200, 700); page.wait_for_timeout(3000)
            cdp.send("HeapProfiler.collectGarbage"); page.wait_for_timeout(500)
            c = page.evaluate(COUNT)
            m = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
            c["ecouteurs"] = m.get("JSEventListeners"); c["noeuds_total"] = m.get("Nodes"); c["tas_mo"] = round(m.get("JSHeapUsedSize", 0) / 1e6, 1)
            return c

        tour()
        c1 = mesurer()
        for _ in range(3):
            tour()
        c4 = mesurer()
        resume = {k: [c1[k], c4[k]] for k in ("intervals", "nodes", "dom", "ecouteurs", "noeuds_total", "tas_mo")}
        mesure("fuites_apres_1_puis_4_tours", resume)
        nouveaux = [x for x in c4["ivDetail"] if x not in c1["ivDetail"]]
        check("fuites", c4["intervals"] <= c1["intervals"], "minuteries (setInterval) : aucune de plus après 3 tours de fenêtres", nouveaux)
        check("fuites", c4["nodes"] <= c1["nodes"] + 2, "nœuds audio branchés : même nombre après 3 tours (fenêtres fermées = nœuds débranchés)", resume["nodes"])
        check("fuites", c4["dom"] <= c1["dom"] + 20, "éléments de la page : même nombre après 3 tours", resume["dom"])
        check("fuites", (c4["ecouteurs"] or 0) <= (c1["ecouteurs"] or 0) + 30, "écouteurs d'évènements : pas d'accumulation", resume["ecouteurs"])
        check("fuites", (c4["noeuds_total"] or 0) <= (c1["noeuds_total"] or 0) * 1.25 + 500, "éléments détachés gardés en mémoire : pas d'accumulation", resume["noeuds_total"])
        raf = page.evaluate("async () => { const a = window.__fx.raf; await new Promise(r => setTimeout(r, 3000)); return window.__fx.raf - a; }")
        check("fuites", raf == 0, "à l'arrêt, fenêtres fermées : aucune boucle d'image (requestAnimationFrame) ne tourne", raf)
        e = page_errors(log)
        check("fuites", not e, "aucune erreur de page", e[:5])
        w = react_warnings(log)
        check("fuites", not w, "aucun avertissement React", w[:5])
    finally:
        b.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# parcours : beat → 808 → mélodie → prises → mix → export → .zip → réouverture → annuler / rétablir
# ═══════════════════════════════════════════════════════════════════════════════════════

CANON = r"""() => {
  const s = window.DAW_CONTROL.getState();
  // Ce qui ne fait pas partie du projet (position, lecture, sélection) ou change par nature à l'ouverture
  // (identifiants des sons en mémoire, adresses blob: de la session, version du format écrite au .zip).
  const drop = new Set(['currentTime', 'isPlaying', 'isRecording', 'recStartTime', 'bufferId', 'waveformPeaks', 'peaks', 'livePreview',
    'savedAt', 'updatedAt', 'lastSavedAt', 'schemaVersion', 'selectedTrackId', 'currentView']);
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) {
      if (drop.has(k) || v[k] === undefined) continue;
      if (k === 'audioRef' && typeof v[k] === 'string' && (v[k].startsWith('blob:') || v[k].startsWith('audio/'))) continue;
      o[k] = clean(v[k]); } return o; }
    if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
    return v;
  };
  return clean(s);
}"""

RENDER_B64 = r"""async (dur) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const s = window.DAW_CONTROL.getState();
  const b = await audioEngine.renderProject(s.tracks, dur, 0, audioEngine.ctx.sampleRate, undefined, { soloIsDeliberate: true });
  const enc = (x) => { const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength); let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(t); };
  return { sr: b.sampleRate, ch: [enc(b.getChannelData(0)), enc(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0))] };
}"""

# Empreinte exacte (bits) de chaque son de prise, par clip : le .zip rouvert doit rendre les MÊMES échantillons.
TAKE_BITS = r"""async () => {
  const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
  const out = {};
  for (const t of window.DAW_CONTROL.getState().tracks) for (const c of t.clips) {
    if (c.type !== 'AUDIO' || !c.bufferId || t.id === 'instrumental') continue;
    const b = audioBufferRegistry.get(c.bufferId); if (!b) { out[c.id] = null; continue; }
    let h = 0; for (let k = 0; k < b.numberOfChannels; k++) { const u = new Uint32Array(b.getChannelData(k).buffer.slice(0)); for (let i = 0; i < u.length; i++) h = (Math.imul(h, 31) + u[i]) | 0; }
    out[c.id] = [b.length, b.numberOfChannels, b.sampleRate, h];
  }
  return out;
}"""


def dec_render(r):
    return [np.frombuffer(base64.b64decode(x), dtype="<f4").astype(np.float64) for x in r["ch"]]


def residual_db(a, b):
    n = min(len(a[0]), len(b[0]))
    d = max(float(np.max(np.abs(a[c][:n] - b[c][:n]))) for c in range(2))
    return round(20 * np.log10(max(d, 1e-12)), 1)


def diff_paths(a, b, path="", out=None):
    out = [] if out is None else out
    if len(out) > 40:
        return out
    if type(a) != type(b):
        out.append((path, str(a)[:100], str(b)[:100])); return out
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b: out.append((f"{path}.{k}", str(a.get(k))[:100], str(b.get(k))[:100]))
            else: diff_paths(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list):
        if len(a) != len(b): out.append((f"{path}[len]", len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)): diff_paths(x, y, f"{path}[{i}]", out)
    elif a != b:
        out.append((path, str(a)[:100], str(b)[:100]))
    return out


def set_range(page, sel, value):
    page.evaluate("""([sel, v]) => { const el = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); }""", [sel, value])
    page.wait_for_timeout(250)


def rec_take(page, secs=3.0):
    page.evaluate("() => window.DAW_CONTROL.seek(0)"); page.wait_for_timeout(200)
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 15 and not st(page, "s => s.isRecording"): page.wait_for_timeout(50)
    started = st(page, "s => s.isRecording")
    page.wait_for_timeout(int(secs * 1000))
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 15 and st(page, "s => s.isRecording"): page.wait_for_timeout(100)
    page.wait_for_timeout(1500)
    return started


def export_ui(page, tag, fmt=None, source=None):
    """Fenêtre Exporter (Ctrl+Maj+E) : réglages avancés si un format / une source est demandé, puis « Exporter »."""
    page.mouse.click(900, 650)
    page.keyboard.press("Control+Shift+e"); page.wait_for_timeout(1200)
    if fmt or source:
        if page.locator("[data-export-vue=avancee]").count() == 0:
            page.get_by_role("button", name=re.compile("Réglages avancés")).click(); page.wait_for_timeout(400)
        if source: page.get_by_test_id(f"export-source-{source}").click(); page.wait_for_timeout(200)
        if fmt: page.locator('[data-export-vue=avancee] label:has(> span:text-is("Type de fichier")) select').first.select_option(fmt)
        page.wait_for_timeout(200)
    go = page.get_by_test_id("export-go")
    with page.expect_download(timeout=300000) as dl:
        go.click()
    d = dl.value
    path = OUT / f"parcours_{tag}__{d.suggested_filename}"
    d.save_as(str(path))
    page.wait_for_timeout(1200)
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    return path


def ffprobe(path):
    import subprocess
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", str(path)],
                       capture_output=True, text=True, encoding="utf-8")
    try:
        return json.loads(r.stdout or "{}")
    except Exception:
        return {}


def cas_parcours(p):
    b, ctx, page, log = studio(p, name="parcours")
    zf = OUT / "parcours_audit_nuit.novaproj.zip"
    try:
        t_debut = time.time()
        new_beat(page, kit=None)
        page.wait_for_timeout(800)
        canon_debut = page.evaluate(CANON)
        page.get_by_role("button", name="🔥 Trap").first.click(); page.wait_for_timeout(1500)
        dr = page.locator(DR)
        # ── 1. Séquenceur : pas, probabilité, roll, fill, 2e motif ──
        dr.get_by_role("button", name=re.compile(r"^Snare, pas 5")).first.click(); page.wait_for_timeout(150)
        dr.get_by_role("button", name=re.compile(r"^Snare, pas 13")).first.click(); page.wait_for_timeout(150)
        stp = dr.get_by_role("button", name=re.compile(r"^Hi-hat fermé, pas 2(,|$)")).first.bounding_box()
        page.mouse.click(stp["x"] + stp["width"] / 2, stp["y"] + stp["height"] / 2, button="right"); page.wait_for_timeout(300)
        m = page.locator("[data-testid=drum-menu]").last
        m.locator("[data-testid=step-prob] [role=menuitemradio]", has_text="50 %").first.click(); page.wait_for_timeout(200)
        m.locator("[data-testid=step-roll] [role=menuitemradio]", has_text="×3").first.click(); page.wait_for_timeout(200)
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        row = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'track-drums').drumMachine.rows.find(r => r.name === 'Hi-hat fermé')")
        check("parcours", (row.get("stepProb") or [0, 0])[1] == 50 and row["ratchet"][1] == 3, "séquenceur : menu du pas → 50 % et roll ×3", {"prob": row.get("stepProb"), "roll": row["ratchet"]})
        sel = dr.locator("select").first
        if sel.count() and sel.evaluate("s => s.options.length") > 1:
            sel.select_option(index=1); page.wait_for_timeout(300)
        dm = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'track-drums').drumMachine")
        check("parcours", bool(dm.get("fill")), "séquenceur : fill choisi", dm.get("fill"))
        dr.get_by_role("button", name="Motif").first.click(); page.wait_for_timeout(400)
        dm = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'track-drums').drumMachine")
        check("parcours", len(dm.get("patterns") or []) >= 2, "séquenceur : « + Motif » crée un 2e motif", [x.get("name") for x in dm.get("patterns") or []])
        # Retour au motif A (focus dans la batterie : [ ).
        page.keyboard.press("BracketLeft"); page.wait_for_timeout(300)
        # ── 2. Sampler du kick : attaque, passe-bas, hauteur ──
        dr.locator("[data-row=kick] button").first.dblclick(); page.wait_for_timeout(600)
        page.locator("[data-testid=pad-tab-env]").click(); page.wait_for_timeout(250)
        set_range(page, "[data-testid=pad-attack] input", 0.01)
        page.locator("[data-testid=pad-tab-filter]").click(); page.wait_for_timeout(250)
        page.locator("[data-testid=pad-filter-type] [role=radio]", has_text="Passe-bas").click(); page.wait_for_timeout(200)
        page.locator("[data-testid=pad-tab-pitch]").click(); page.wait_for_timeout(250)
        set_range(page, "[data-testid=pad-tune] input", 2)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        kick = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'track-drums').drumMachine.rows.find(r => r.id === 'kick')")
        smp = kick.get("smp") or {}
        check("parcours", smp.get("attack") == 0.01 and smp.get("filterType") == "lp" and kick.get("tune") == 2, "sampler du kick : attaque 10 ms, passe-bas, +2 demi-tons", {"smp": smp, "tune": kick.get("tune")})
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        check("parcours", not drums_open(page), "Échap ferme la batterie")
        # ── 3. 808 au piano roll, glissés ──
        page.get_by_role("button", name="808").locator("visible=true").first.click(); page.wait_for_timeout(1500)
        check("parcours", roll_open(page), "808 : le piano roll s'ouvre")
        page.keyboard.press("Control+a"); page.wait_for_timeout(150)
        page.keyboard.press("s"); page.wait_for_timeout(300)
        n808 = st(page, "s => { const n = (s.tracks.find(t => t.bass808)?.clips[0]?.notes || []); return [n.length, n.filter(x => x.slide).length]; }")
        check("parcours", n808[0] > 0 and n808[1] > 0, "808 : notes de départ, Ctrl+A puis S = glissés", n808)
        close_roll(page)
        # ── 4. Synthé + tampon d'accords ──
        add_synth(page)
        check("parcours", roll_open(page), "Synthé NOVA : la fenêtre du synthé se ferme à Échap, le piano roll reste")
        roll_reveal(page, "[data-nova-roll-tool=CHORD]").click(); page.wait_for_timeout(250)
        g = page.locator("[data-nova-roll-grid]").bounding_box()
        page.mouse.click(g["x"] + 40, g["y"] + g["height"] / 2); page.wait_for_timeout(300)
        page.mouse.click(g["x"] + 240, g["y"] + g["height"] / 2 - 30); page.wait_for_timeout(300)
        syn = st(page, "s => (s.tracks.find(t => t.type === 'MIDI' && !t.bass808)?.clips[0]?.notes || []).length")
        check("parcours", syn >= 6, f"tampon d'accords : deux accords posés ({syn} notes)", syn)
        close_roll(page)
        # ── 5. Trois prises voix, deux gardées ──
        page.mouse.click(420, 860); page.wait_for_timeout(200)
        starts = []
        for i in range(3):
            starts.append(rec_take(page, 3.0))
            if i < 2:
                page.keyboard.press("Control+Alt+p"); page.wait_for_timeout(500)
        pistes = st(page, "s => s.tracks.filter(t => t.type === 'AUDIO' && t.id !== 'instrumental' && t.clips.some(c => c.bufferId)).map(t => [t.id, t.clips.length])")
        check("parcours", all(starts) and pistes, "trois prises enregistrées au micro (simulé)", {"departs": starts, "pistes": pistes})
        voix = pistes[0][0] if pistes else "track-rec-main"
        voix_nom = st(page, f"s => s.tracks.find(t => t.id === '{voix}').name")
        # ── 6. Console : EQ + compresseur sur la voix ──
        page.keyboard.press("Control+Equal"); page.wait_for_timeout(1500)
        for fx in ("égaliseur", "compresseur"):
            page.get_by_role("button", name=f"Ajouter un effet sur {voix_nom}").first.click()
            page.wait_for_selector("[data-testid=add-effect-menu]")
            page.keyboard.type(fx); page.keyboard.press("Enter"); page.wait_for_timeout(1200)
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
        plugs = st(page, f"s => s.tracks.find(t => t.id === '{voix}').plugins.map(p => p.type)")
        check("parcours", len(plugs) >= 2, "console : EQ et compresseur ajoutés sur la voix", plugs)
        page.keyboard.press("Control+Equal"); page.wait_for_timeout(800)
        mesure("parcours_construction_s", round(time.time() - t_debut, 1))
        # ── 7. Exports : WAV, MP3, stems ──
        wav = export_ui(page, "wav")
        pr = ffprobe(wav)
        dur_proj = st(page, "s => Math.max(...s.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)))")
        dur_wav = float((pr.get("format") or {}).get("duration") or 0)
        check("parcours", dur_wav >= dur_proj - 0.05, f"export WAV : {wav.name}, {dur_wav:.2f} s pour {dur_proj:.2f} s de projet", pr)
        mp3 = export_ui(page, "mp3", fmt="MP3")
        pm = ffprobe(mp3)
        check("parcours", any(s.get("codec_name") == "mp3" for s in pm.get("streams", [])), f"export MP3 : {mp3.name}", pm)
        stems = export_ui(page, "stems", source="STEMS")
        noms = zipfile.ZipFile(stems).namelist() if zipfile.is_zipfile(stems) else []
        check("parcours", len([n for n in noms if n.endswith((".wav", ".mp3", ".flac", ".aif", ".aiff"))]) >= 4, f"export des stems : {len(noms)} fichiers dans le .zip", noms[:12])
        # ── 8. Annuler jusqu'au début, puis rétablir jusqu'au bout ──
        page.mouse.click(900, 650); page.wait_for_timeout(200)
        fin = page.evaluate(CANON)
        n_undo = 0
        prev = None
        while n_undo < 400:
            page.keyboard.press("Control+z"); page.wait_for_timeout(60)
            n_undo += 1
            if n_undo % 10 == 0:
                cur = json.dumps(page.evaluate(CANON), sort_keys=True)
                if cur == prev: break
                prev = cur
        debut = page.evaluate(CANON)
        # Hors annulation, par conception : l'identifiant du projet (donné à la 1re modification) et la liste
        # des clips de la séance (clipBin : un clip retiré y reste, comme dans les logiciels de studio).
        d0 = [x for x in diff_paths(canon_debut, debut) if not (x[0] == ".id" or x[0].startswith(".clipBin"))]
        check("parcours", not d0, f"Ctrl+Z ×{n_undo} : retour exact au projet de départ (kit, pas, sampler, 808, synthé, prises et effets retirés)", d0[:20])
        n_redo = 0
        prev = None
        while n_redo < 400:
            page.keyboard.press("Control+y"); page.wait_for_timeout(60)
            n_redo += 1
            if n_redo % 10 == 0:
                cur = json.dumps(page.evaluate(CANON), sort_keys=True)
                if cur == prev: break
                prev = cur
        apres = page.evaluate(CANON)
        d = diff_paths(fin, apres)
        check("parcours", not d, f"Ctrl+Y ×{n_redo} : tout revient à l'identique (état complet)", d[:20])
        mesure("parcours_annuler_retablir", {"annuler": n_undo, "retablir": n_redo})
        # ── 9. Rendu + empreinte des prises, puis sauvegarde .zip ──
        dur = round(max(8.0, dur_proj + 0.5), 2)
        r1 = dec_render(page.evaluate(RENDER_B64, dur))
        takes1 = page.evaluate(TAKE_BITS)
        canon1 = page.evaluate(CANON)
        page.mouse.click(900, 650)
        page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(800)
        inp = page.locator("input[placeholder='Ex. : Mon premier son']")
        if inp.count(): inp.fill("Audit nuit")
        with page.expect_download(timeout=300000) as dl:
            page.get_by_text("Fichier sur cet appareil (.zip)").first.click()
        dl.value.save_as(str(zf))
        page.wait_for_timeout(800)
        canon1 = page.evaluate(CANON)
        e1 = page_errors(log)
        check("parcours", not e1, "aucune erreur de page pendant le parcours", e1[:6])
        w1 = react_warnings(log)
        check("parcours", not w1, "aucun avertissement React pendant le parcours", w1[:6])
    finally:
        b.close()
    # ── 10. Réouverture dans un navigateur neuf ──
    b2, ctx2, page2, log2 = studio(p, name="parcours_rouvert")
    try:
        page2.goto(BASE, wait_until="domcontentloaded")
        page2.get_by_text("Charger Projet").first.click(timeout=90000); page2.wait_for_timeout(700)
        with page2.expect_file_chooser(timeout=10000) as fc:
            page2.get_by_text("Charger depuis l'ordinateur").first.click()
        t0 = time.time()
        fc.value.set_files(str(zf))
        page2.wait_for_function("() => window.DAW_CONTROL && window.DAW_CONTROL.getState().name === 'Audit nuit'", timeout=90000)
        page2.wait_for_function("() => window.DAW_CONTROL.getState().tracks.every(t => t.clips.every(c => c.type !== 'AUDIO' || c.bufferId))", timeout=90000)
        mesure("parcours_reouverture_s", round(time.time() - t0, 2))
        page2.wait_for_timeout(3000)
        canon2 = page2.evaluate(CANON)
        d = diff_paths(canon1, canon2)
        check("parcours", not d, "réouverture du .zip : état identique (pistes, clips, notes, batterie, sampler, effets…)", d[:20])
        takes2 = page2.evaluate(TAKE_BITS)
        check("parcours", takes1 and takes1 == takes2, f"réouverture : les {len(takes1)} prises relues sont identiques au bit près (sons sans perte)",
              {"avant": takes1, "apres": takes2})
        r2 = dec_render(page2.evaluate(RENDER_B64, dur))
        res = residual_db(r1, r2)
        mesure("parcours_rendu_residu_dBFS", res)
        check("parcours", res <= -120, f"réouverture : rendu identique (résidu {res} dBFS ≤ −120)", res)
        e2 = page_errors(log2)
        check("parcours", not e2, "aucune erreur de page à la réouverture", e2[:6])
    finally:
        b2.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# formats : 1366 / 1920 / tablette 1024 / téléphone 390, sombre et clair
# ═══════════════════════════════════════════════════════════════════════════════════════

CONCURRENTS = re.compile(r"Pro ?Tools|\bAvid\b|AudioSuite|Elastic (Audio|Pitch)|FL ?Studio|\bFL ?:|Image-Line|Ableton|\bLive ?:|Logic( Pro)?\b|Cubase|Studio One|Bitwig|Reaper|BandLab|GarageBand|Flex (Pitch|Time)", re.I)
TEXTES = r"""(scope) => {
  const root = (scope && document.querySelector(scope)) || document.body;
  const vis = el => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && +cs.opacity !== 0; };
  const out = new Set();
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const t = (n.nodeValue || '').trim(); if (t && n.parentElement && vis(n.parentElement)) out.add(t.slice(0, 200)); }
  for (const el of root.querySelectorAll('[title], [aria-label], [placeholder]')) if (vis(el)) for (const a of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) out.add(v.slice(0, 200)); }
  return [...out];
}"""
FORMATS = [("pc1366", "dark"), ("pc", "light"), ("pc1920", "dark"), ("tab", "light"), ("tel390", "dark")]
VPX = {"pc1366": (1366, 768), "pc": (1600, 900), "pc1920": (1920, 1080), "tab": (1024, 768), "tel390": (390, 844)}


def ecran(page, cas, nom, scope):
    page.mouse.move(1, 1); page.wait_for_timeout(250)
    page.screenshot(path=str(OUT / f"formats_{nom}.png"))
    ov = balayage_chevauchement(page, scope)
    rec = [r for r in ov.get("recouverts", []) if not re.search(r"^(Do|Ré|Mi|Fa|Sol|La|Si)♯?-?\d", r.get("el", ""))]  # touches noires du clavier
    of = overflow_report(page)
    hscroll = [o for o in of if o["kind"] == "page-hscroll"]
    textes = page.evaluate(TEXTES, scope)
    conc = sorted({t for t in textes if CONCURRENTS.search(t)})
    check(cas, not ov.get("erreur") and not rec, f"{nom} : rien de recouvert dans la fenêtre ({ov.get('boutons')} commandes)", ov.get("erreur") or rec[:6])
    check(cas, not hscroll, f"{nom} : la page ne défile pas de côté", hscroll)
    check(cas, not conc, f"{nom} : aucun nom de logiciel concurrent (textes et infobulles)", conc[:6])
    vw = page.evaluate("() => innerWidth")
    hors = page.evaluate("""([scope, vw]) => { const r = document.querySelector(scope); if (!r) return null; const b = r.getBoundingClientRect(); return b.left < -1 || b.right > vw + 1 ? [Math.round(b.left), Math.round(b.right)] : null; }""", [scope, vw])
    check(cas, hors is None, f"{nom} : la fenêtre tient dans la largeur de l'écran", hors)


def cas_formats(p):
    br = launch(p)
    try:
        for vp, theme in FORMATS:
            touch = vp in ("tab", "tel390")
            b, ctx, page, log = studio(p, vp=vp, theme=theme, name=f"formats_{vp}_{theme}", browser=br)
            tag = f"{vp}_{theme}"
            try:
                new_beat(page)
                page.wait_for_timeout(6000)  # la bulle « Batterie posée » est partie
                ecran(page, "formats", f"{tag} batterie", DR)
                pas = page.locator(DR).get_by_role("button", name=re.compile(r"^Snare, pas 5")).first
                pas.scroll_into_view_if_needed()
                bb = pas.bounding_box()
                if touch: pas.dispatch_event("contextmenu", {"clientX": bb["x"] + 5, "clientY": bb["y"] + 5})
                else: page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2, button="right")
                page.wait_for_timeout(400)
                ecran(page, "formats", f"{tag} menu du pas", "[data-testid=drum-menu]")
                page.keyboard.press("Escape"); page.wait_for_timeout(300)
                check("formats", page.locator("[data-testid=drum-menu]").count() == 0, f"{tag} : Échap ferme le menu du pas")
                kick = page.locator(f"{DR} [data-row=kick] button").first
                if touch:
                    kb = kick.bounding_box(); kick.dispatch_event("contextmenu", {"clientX": kb["x"] + 5, "clientY": kb["y"] + 5}); page.wait_for_timeout(300)
                    page.locator("[data-testid=row-edit-sound]").click()
                else:
                    kick.dblclick()
                page.wait_for_timeout(600)
                for tab in ("sample", "env", "filter", "pitch", "mod"):
                    t = page.locator(f"[data-testid=pad-tab-{tab}]")
                    (t.tap() if touch else t.click()); page.wait_for_timeout(250)
                    page.locator("[data-testid=pad-sampler]").scroll_into_view_if_needed()
                    ecran(page, "formats", f"{tag} sampler {tab}", "[data-testid=pad-sampler]")
                page.keyboard.press("Escape"); page.wait_for_timeout(300)
                page.keyboard.press("Escape"); page.wait_for_timeout(400)
                if vp == "tel390":
                    continue  # téléphone : le piano roll et ses menus sont vérifiés par pianoroll_pro / pianoroll_pratique
                add_synth(page)
                if not roll_open(page): open_synth_roll(page)
                ecran(page, "formats", f"{tag} piano roll", "[data-nova-pianoroll]")
                for m in ("outil", "outils", "notes", "vue"):
                    bt = page.locator(f"[data-nova-roll-menu-btn={m}]").locator("visible=true")
                    if not bt.count():
                        continue
                    (bt.first.tap() if touch else bt.first.click()); page.wait_for_timeout(300)
                    ecran(page, "formats", f"{tag} piano roll menu {m}", f"[data-nova-roll-menu=liste-{m}]")
                    page.keyboard.press("Escape"); page.wait_for_timeout(250)
                    check("formats", roll_open(page) and not page.locator(f"[data-nova-roll-menu=liste-{m}]").count(), f"{tag} : Échap ferme le menu « {m} » sans fermer le piano roll")
                close_roll(page)
                e = page_errors(log)
                check("formats", not e, f"{tag} : aucune erreur de page", e[:4])
            finally:
                ctx.close()
    finally:
        br.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# collab : séquenceur, sampler, 808, synthé et accords en direct entre deux onglets
# ═══════════════════════════════════════════════════════════════════════════════════════

RENDER_TRACK = r"""async ([tid, dur]) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const s = window.__novaEdit.getState();
  const t = s.tracks.find(x => x.id === tid); if (!t) return null;
  const one = { ...t, outputTrackId: undefined, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], plugins: [] };
  const b = await audioEngine.renderProject([one], dur, 0, 48000);
  const enc = (x) => { const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength); let r = ''; for (let i = 0; i < u.length; i += 0x8000) r += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(r); };
  return { sr: 48000, ch: [enc(b.getChannelData(0)), enc(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0))] };
}"""


def palette(page, mot):
    page.mouse.click(900, 650); page.wait_for_timeout(150)
    page.keyboard.press("Control+k"); page.wait_for_timeout(500)
    page.keyboard.type(mot); page.wait_for_timeout(400)
    page.keyboard.press("Enter"); page.wait_for_timeout(1200)


def cas_collab(p):
    from collab_sim import FakeNovaCloud, FakeRealtime, connect
    from gel_pre_effet import prepare, open_project_file
    from feat_lib import feat_project, dismiss, wait_for, collab, open_panel, close_panel, REC_INIT
    LINA, MAX = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True, pro={LINA})
    rt = FakeRealtime()
    src = OUT / "collab_nuit_depart.novaproj.zip"
    feat_project(src, name="Collab de nuit")
    b = launch(p)
    try:
        logA, logE = Log("collab_A"), Log("collab_E")
        ctxA, A = new_page(b, "pc", logA)
        ctxE, E = new_page(b, "pc", logE)
        for pg in (A, E):
            pg.add_init_script(REC_INIT)
            pg.add_init_script(INIT % ("0", "dark"))
            prepare(pg, None, desktop=False)
        connect(A, cloud, rt, "A", LINA, "lina@test.local")
        connect(E, cloud, rt, "E", MAX, "max@test.local")
        open_project_file(A, src, {}, "collab_A1")
        dismiss(A)
        open_panel(A)
        A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
        A.get_by_role("button", name="Démarrer la collaboration en direct").click()
        wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez Lina")
        sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
        link = f"{sid}.{cloud.sessions[sid]['secret']}"
        close_panel(A)
        E.goto(f"{BASE}?session={link}&invite=1", wait_until="domcontentloaded")
        wait_for(E, lambda: E.get_by_test_id("collab-arrival").count() > 0, 60, what="arrivée de Max")
        E.wait_for_timeout(1500); dismiss(E)
        E.get_by_test_id("arrival-role-engineer").click()
        E.get_by_label("Ton nom", exact=True).fill("Max")
        E.get_by_test_id("arrival-join").click()
        wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="Max relié")
        dismiss(E)

        def converge(quoi, timeout=40):
            t0 = time.time(); last = None
            while time.time() - t0 < timeout:
                fa = A.evaluate("() => window.__novaCollab && window.__novaCollab.fingerprint ? window.__novaCollab.fingerprint() : null")
                fe = E.evaluate("() => window.__novaCollab && window.__novaCollab.fingerprint ? window.__novaCollab.fingerprint() : null")
                if fa and fe and fa["sig"] == fe["sig"]:
                    s = round(time.time() - t0, 1)
                    check("collab", True, f"{quoi} : même projet chez Lina et Max ({s} s)")
                    return s
                last = (fa, fe)
                time.sleep(0.4)
            ecarts = []
            if last and last[0] and last[1]:
                tb = {t["id"]: t for t in last[1]["tracks"]}
                for t in last[0]["tracks"]:
                    o = tb.get(t["id"])
                    if not o: ecarts.append(f"{t['name']} absente chez Max"); continue
                    ecarts += [f"{t['name']} : {k}" for k in t["parts"] if t["parts"][k] != o["parts"].get(k)]
            check("collab", False, f"{quoi} : même projet chez Lina et Max", ecarts[:10])
            return None

        # ── Lina : batterie (palette), kit, pas, menu du pas, sampler du pad ──
        palette(A, "batterie")
        A.wait_for_selector(DR, timeout=15000)
        A.get_by_role("button", name="🔥 Trap").first.click(); A.wait_for_timeout(1500)
        dr = A.locator(DR)
        dr.get_by_role("button", name=re.compile(r"^Snare, pas 5")).first.click(); A.wait_for_timeout(200)
        sb = dr.get_by_role("button", name=re.compile(r"^Hi-hat fermé, pas 4(,|$)")).first.bounding_box()
        A.mouse.click(sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2, button="right"); A.wait_for_timeout(300)
        mm = A.locator("[data-testid=drum-menu]").last
        mm.locator("[data-testid=step-prob] [role=menuitemradio]", has_text="50 %").first.click(); A.wait_for_timeout(150)
        mm.locator("[data-testid=step-roll] [role=menuitemradio]", has_text="×2").first.click(); A.wait_for_timeout(150)
        A.keyboard.press("Escape"); A.wait_for_timeout(200)
        dr.locator("[data-row=kick] button").first.dblclick(); A.wait_for_timeout(600)
        A.locator("[data-testid=pad-tab-env]").click(); A.wait_for_timeout(200)
        set_range(A, "[data-testid=pad-attack] input", 0.02)
        A.locator("[data-testid=pad-tab-filter]").click(); A.wait_for_timeout(200)
        A.locator("[data-testid=pad-filter-type] [role=radio]", has_text="Passe-bas").click(); A.wait_for_timeout(200)
        A.keyboard.press("Escape"); A.wait_for_timeout(300)
        A.keyboard.press("Escape"); A.wait_for_timeout(400)
        converge("batterie (kit, pas, probabilité, roll, sampler du pad)")
        # ── Lina : 808 (glissés) et synthé (tampon d'accords) ──
        palette(A, "basse 808")
        if roll_open(A):
            A.keyboard.press("Control+a"); A.wait_for_timeout(150); A.keyboard.press("s"); A.wait_for_timeout(300)
        close_roll(A)
        palette(A, "synthé nova")
        A.keyboard.press("Escape"); A.wait_for_timeout(400)
        if not roll_open(A): open_synth_roll(A)
        roll_reveal(A, "[data-nova-roll-tool=CHORD]").click(); A.wait_for_timeout(250)
        g = A.locator("[data-nova-roll-grid]").bounding_box()
        A.mouse.click(g["x"] + 40, g["y"] + g["height"] / 2); A.wait_for_timeout(300)
        close_roll(A)
        notes = A.evaluate("() => window.__novaEdit.getState().tracks.filter(t => t.novaSynth).map(t => [t.name, t.clips.map(c => [c.start, c.duration, (c.notes || []).length])])")
        mesure("collab_synthe_notes", notes)
        converge("808 avec glissés et synthé avec un accord")
        # ── Le même son des deux côtés (rendu de chaque instrument chez Lina et chez Max) ──
        ids = A.evaluate("() => window.__novaEdit.getState().tracks.filter(t => t.id === 'track-drums' || t.bass808 || t.novaSynth).map(t => [t.id, t.name])")
        fin = A.evaluate("() => Math.max(8, ...window.__novaEdit.getState().tracks.flatMap(t => t.clips.map(c => c.start + c.duration)))") + 1
        for tid, nom in ids:
            ra = A.evaluate(RENDER_TRACK, [tid, fin]); re_ = E.evaluate(RENDER_TRACK, [tid, fin])
            if not ra or not re_:
                check("collab", False, f"rendu de « {nom} » des deux côtés", {"lina": bool(ra), "max": bool(re_)}); continue
            a, e = dec_render(ra), dec_render(re_)
            crete = round(20 * np.log10(max(float(np.max(np.abs(a[0]))), 1e-12)), 1)
            r = residual_db(a, e)
            check("collab", crete > -60 and r <= -100, f"« {nom} » sonne pareil chez Max (crête {crete} dBFS, écart {r} dBFS)", {"crete": crete, "ecart": r})
        # ── Coupure réseau de Max (8 s) pendant que Lina change un pas et que Max règle le volume du synthé ──
        cloud.down.add("E"); rt.drop("E"); rt.blocked.add("E")
        E.context.set_offline(True)
        A.evaluate("() => window.__novaTest.update(d => { const t = d.tracks.find(t => t.id === 'track-drums'); const r = t.drumMachine.rows.find(r => r.id === 'clap'); if (r) r.tune = 3; })")
        E.evaluate("() => window.__novaTest.update(d => { const t = d.tracks.find(t => t.novaSynth); if (t) t.volume = 0.6; })")
        E.wait_for_timeout(8000)
        cloud.down.discard("E"); rt.blocked.discard("E")
        E.context.set_offline(False)
        E.evaluate("() => window.dispatchEvent(new Event('online'))")
        converge("après 8 s de coupure réseau chez Max (une modification de chaque côté)", timeout=60)
        vols = [pg.evaluate("() => { const s = window.__novaEdit.getState(); return [s.tracks.find(t => t.novaSynth)?.volume, s.tracks.find(t => t.id === 'track-drums')?.drumMachine.rows.find(r => r.id === 'clap')?.tune]; }") for pg in (A, E)]
        check("collab", vols[0] == vols[1] == [0.6, 3], "rien de perdu : volume du synthé (Max, hors ligne) et accord du clap (Lina) des deux côtés", vols)
        for nom, lg in (("Lina", logA), ("Max", logE)):
            # Réponses 401 / 404 des fonctions SIMULÉES (daw-listen sans lien d'écoute, session pas encore créée) :
            # le navigateur les journalise, l'appli les gère ; seules les vraies erreurs de la page comptent.
            er = [x for x in page_errors(lg) if not x.startswith("Failed to load resource")]
            check("collab", not er, f"aucune erreur de page chez {nom}", er[:5])
    finally:
        b.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# perf : ouverture d'une séance de 20 pistes, ouverture des fenêtres, clic → son
# ═══════════════════════════════════════════════════════════════════════════════════════

def projet_20(path, n=20, dur=30.0, sr=44100):
    import io as _io
    t = np.arange(int(dur * sr)) / sr
    tracks = [{"id": "master", "name": "MASTER BUS", "type": "BUS", "color": "#64748b", "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
               "volume": 1, "pan": 0, "outputTrackId": "", "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        for i in range(n):
            x = (0.2 * np.sin(2 * np.pi * (110 + 17 * i) * t)).astype("<f4")
            b = _io.BytesIO()
            with wave.open(b, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((x * 32767).astype("<i2").tobytes())
            z.writestr(f"audio/p{i}.wav", b.getvalue())
            tracks.insert(-1, {"id": f"t{i}", "name": f"Piste {i + 1}", "type": "AUDIO", "color": "#3b82f6", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                               "isFrozen": False, "volume": 0.6, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
                               "clips": [{"id": f"c{i}", "name": f"Prise {i + 1}", "start": 0, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee",
                                          "type": "AUDIO", "audioRef": f"audio/p{i}.wav", "gain": 1}]})
        st_ = {"id": "proj-perf20", "name": "Séance 20 pistes", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False, "isRecording": False,
               "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "t0",
               "currentView": "ARRANGEMENT", "projectMode": "BEATMAKING", "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
               "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
        z.writestr("project.json", json.dumps(st_))
    return path


def chrono_ouverture(page, geste, sel):
    t0 = page.evaluate("() => performance.now()")
    geste()
    page.wait_for_function(f"() => !!document.querySelector({json.dumps(sel)})", timeout=20000)
    return round(page.evaluate("() => new Promise(r => requestAnimationFrame(() => r(performance.now())))") - t0)


def cas_perf(p):
    zf = projet_20(OUT / "perf_20_pistes.novaproj.zip")
    b, ctx, page, log = studio(p, name="perf")
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text("Charger Projet").first.click(timeout=90000); page.wait_for_timeout(700)
        with page.expect_file_chooser(timeout=10000) as fc:
            page.get_by_text("Charger depuis l'ordinateur").first.click()
        t0 = time.time()
        fc.value.set_files(str(zf))
        page.wait_for_function("() => window.DAW_CONTROL && window.DAW_CONTROL.getState().id === 'proj-perf20' && window.DAW_CONTROL.getState().tracks.filter(t => t.clips[0] && t.clips[0].bufferId).length >= 20", timeout=120000)
        ouverture = round(time.time() - t0, 2)
        mesure("perf_ouverture_20_pistes_s", ouverture)
        check("perf", ouverture < 8, f"séance de 20 pistes × 30 s ouverte en {ouverture} s (< 8 s)", ouverture)
        page.wait_for_timeout(1500)
        for nm in ("C'est parti", "Plus tard"):
            bb = page.get_by_role("button", name=nm, exact=True).locator("visible=true").first
            try:
                if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
            except Exception:
                pass
        page.mouse.click(900, 650); page.wait_for_timeout(300)
        t = {}
        t["batterie"] = chrono_ouverture(page, lambda: page.get_by_role("button", name="Batterie").locator("visible=true").first.click(), DR)
        page.get_by_role("button", name="🔥 Trap").first.click(); page.wait_for_timeout(1200)
        t["sampler_du_pad"] = chrono_ouverture(page, lambda: page.locator(f"{DR} [data-row=kick] button").first.dblclick(), "[data-testid=pad-sampler]")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # Clic → son : du geste (pointerdown) au départ du son dans le moteur (triggerTrackAttack).
        page.evaluate("""async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts'); const o = audioEngine.triggerTrackAttack.bind(audioEngine);
          window.__hits = []; audioEngine.triggerTrackAttack = (...a) => { window.__hits.push(performance.now()); return o(...a); };
          window.addEventListener('pointerdown', () => { window.__down = performance.now(); }, true); window.addEventListener('keydown', () => { window.__down = performance.now(); }, true); }""")
        lat = []
        for k in range(5):
            page.locator(f"{DR} [data-row=snare] button").first.click(); page.wait_for_timeout(250)
            lat.append(page.evaluate("() => window.__hits.length ? +(window.__hits[window.__hits.length - 1] - window.__down).toFixed(2) : null"))
        mesure("perf_clic_pad_vers_son_ms", lat)
        ok_lat = [x for x in lat if x is not None]
        check("perf", ok_lat and max(ok_lat[1:] or ok_lat) < 10, f"clic sur un pad → son en {max(ok_lat) if ok_lat else '?'} ms au pire (< 10 ms après le 1er)", lat)
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        page.mouse.click(900, 650); page.wait_for_timeout(300)
        t["synthe_et_piano_roll"] = chrono_ouverture(page, lambda: page.get_by_role("button", name=re.compile("Synthé NOVA")).locator("visible=true").first.click(), "[data-nova-pianoroll]")
        page.keyboard.press("Escape"); page.wait_for_timeout(300); close_roll(page)
        page.mouse.click(900, 650); page.wait_for_timeout(300)
        t["console_20_pistes"] = chrono_ouverture(page, lambda: page.keyboard.press("Control+Equal"), '[role=slider][aria-label="Volume Piste 1"]')
        page.keyboard.press("Control+Equal"); page.wait_for_timeout(500)
        t["export"] = chrono_ouverture(page, lambda: page.keyboard.press("Control+Shift+e"), "[data-testid=export-go]")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        mesure("perf_ouverture_fenetres_ms", t)
        lent = {k: v for k, v in t.items() if v > 1500}
        check("perf", not lent, "chaque fenêtre s'ouvre en moins de 1,5 s (20 pistes chargées)", t)
        e = page_errors(log)
        check("perf", not e, "aucune erreur de page", e[:4])
    finally:
        b.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# simple : mode simple épuré, les nouveautés restent au même endroit en mode avancé
# ═══════════════════════════════════════════════════════════════════════════════════════

AVANCE = ["tools-more", "grid-value", "view-menu", "dock-session-menu"]


def cas_simple(p):
    """Projet voix : le mode simple cache les menus de studio. « Nouveau beat » passe d'office en mode avancé
    (utils/simpleMode : le beatmaking en a besoin) : la batterie, la 808 et le synthé y sont à portée de main."""
    for simple in (True, False):
        b, ctx, page, log = studio(p, simple=simple, name=f"simple_{simple}")
        mode = "simple" if simple else "avancé"
        try:
            page.goto(BASE, wait_until="domcontentloaded")
            page.get_by_text("Nouveau Projet").first.click(timeout=90000); page.wait_for_timeout(4000)
            for nm in ("C'est parti", "Plus tard"):
                bb = page.get_by_role("button", name=nm, exact=True).locator("visible=true").first
                try:
                    if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
                except Exception:
                    pass
            page.mouse.move(2, 2); page.wait_for_timeout(300)
            menus = {m: page.locator(f'[data-testid="{m}"]').locator("visible=true").count() for m in AVANCE}
            if simple:
                check("simple", not any(menus.values()), "projet voix, mode simple : aucun menu de studio (Outils ▾, Édition ▾, Vue ▾, Session ▾)", menus)
            else:
                check("simple", all(menus.values()), "projet voix, mode avancé : menus Outils ▾, Édition ▾, Vue ▾ et Session ▾ présents", menus)
            # Boutons de COMMANDE du studio (le catalogue d'instrus du mode simple, avec ses « Écouter / Essayer /
            # Acheter » par beat, n'en fait pas partie : c'est une liste à parcourir).
            nb = page.evaluate("() => [...document.querySelectorAll('button')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && !/^(Écouter|ESSAYER|Acheter|🎧 Instrus|🎹 Mélodies)/.test((b.getAttribute('aria-label') || b.innerText || '').trim())).length")
            mesure(f"simple_boutons_visibles_{'simple' if simple else 'avance'}", nb)
            new_beat(page)
            check("simple", drums_open(page), f"mode {mode} : « Nouveau beat » ouvre la batterie")
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
            for nom in ("Batterie", "808", "Synthé NOVA"):
                check("simple", page.get_by_role("button", name=re.compile(nom)).locator("visible=true").count() > 0, f"mode {mode}, beat : bouton « {nom} » à portée de main")
            e = page_errors(log)
            check("simple", not e, f"mode {mode} : aucune erreur de page", e[:4])
        finally:
            b.close()
    a, s_ = RES["mesures"].get("simple_boutons_visibles_avance"), RES["mesures"].get("simple_boutons_visibles_simple")
    check("simple", a and s_ and s_ < a, f"mode simple plus épuré : {s_} boutons visibles contre {a} en mode avancé (projet voix)", [s_, a])


CAS = {"parcours": cas_parcours, "raccourcis": cas_raccourcis, "toast": cas_toast, "veille": cas_veille, "fuites": cas_fuites, "formats": cas_formats,
       "collab": cas_collab, "perf": cas_perf, "simple": cas_simple}


def main():
    todo = [a for a in sys.argv[1:] if a in CAS] or list(CAS)
    with sync_playwright() as p:
        for name in todo:
            t0 = time.time()
            try:
                CAS[name](p)
            except Exception as e:
                check(name, False, f"exception : {type(e).__name__}: {str(e)[:500]}")
                traceback.print_exc()
            RES["mesures"][f"duree_{name}_s"] = round(time.time() - t0, 1)
    (OUT / "audit_nuit.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    ko = [f"[{c}] {x['quoi']}" for c, xs in RES["cas"].items() for x in xs if not x["ok"]]
    print(f"\nBILAN : {sum(len(x) for x in RES['cas'].values()) - len(ko)} / {sum(len(x) for x in RES['cas'].values())} vérifications au vert")
    for k in ko:
        print("  KO", k)
    sys.exit(0 if RES["ok"] else 1)


if __name__ == "__main__":
    main()
