"""Piano roll pratique (22/10/2026) : mesure des gestes et du temps pour 3 tâches réelles, puis preuves des gestes.

Headless, aucune fenêtre, 100 % hors production (qalib importe qa_hors_prod).

Trois tâches mesurées (bureau 1600 × 900, souris + clavier), chacune vérifiée note par note :
  T1 · mélodie de 8 mesures (La mineur, 140 BPM) : 4 mesures écrites, recopiées, la dernière retouchée ;
  T2 · suite d'accords La m – Fa – Do – Sol, 2 mesures chacun, accords de la gamme ;
  T3 · ligne de 808 avec glissés (motif de 2 mesures × 4).
Pour chaque tâche : nombre de gestes (clic, glisser, touche, molette) et temps estimé par le modèle
KLM (clic 1,3 s, glisser 2,4 s, touche 0,3 s, +0,4 s quand la main passe souris ↔ clavier), plus
le temps réel du robot. Méthode « avant » (interface du 21/10) ou « après » (piano roll pratique) :
choisie d'office selon l'interface trouvée (--methode avant|apres pour forcer).

Puis (interface « après » seulement) : barre épurée (outil actif, grille, gamme + 3 menus), clic droit
dans le vide = menu, double-clic = propriétés, Alt + molette = zoom vertical, Alt + glisser = sans aimant,
outils colle / sourdine / épaissir / miroir, replier aux notes utilisées, suivre la lecture, zoom sur la
sélection, quantification d'entrée de la prise, éditer un autre clip depuis le piano roll ; captures
bureau sombre / clair et tablette (1024 × 768, au doigt).

NOVA_URL=http://127.0.0.1:3544/ python qa/pianoroll_pratique.py [--methode avant|apres] [pc_dark pc_light tab_dark]
"""
import json, os, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3544/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pianoroll2\captures")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, BASE, Log, new_page, shot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROJ = OUT / "projet_pianoroll_pratique.zip"
BPM = 140
BEAT = 60 / BPM
KO = []


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:600]}"), flush=True)
    if not cond:
        KO.append(name)
    return cond


# --- Les 3 tâches (temps en temps musicaux, hauteurs MIDI) ---------------------------------------
# T1 : 4 mesures de mélodie (6 notes par mesure : 4 croches + 2 noires), recopiées en 5-8 ; mesure 8 retouchée.
RYTHME = [(0, 0.5), (0.5, 0.5), (1, 0.5), (1.5, 0.5), (2, 1), (3, 1)]
HAUTEURS = [[69, 72, 76, 74, 72, 71], [69, 71, 72, 74, 76, 72], [77, 76, 74, 72, 71, 69], [71, 72, 74, 72, 71, 68]]
MELODIE_1_4 = [(bar * 4 + s, d, HAUTEURS[bar][i]) for bar in range(4) for i, (s, d) in enumerate(RYTHME)]
FIN_8 = [(30, 1, 64), (31, 1, 69)]          # mesure 8 : les deux noires changent (Mi puis La, la cadence)
MELODIE = MELODIE_1_4 + [(s + 16, d, p) for (s, d, p) in MELODIE_1_4 if s + 16 < 30] + FIN_8
# T2 : accords de la gamme (La mineur) posés sur leur fondamentale, 2 mesures chacun.
ACCORDS = [(0, 57), (8, 53), (16, 60), (24, 55)]
ACCORDS_NOTES = sorted([(s, 8, p) for (s, r) in ACCORDS for p in {57: (57, 60, 64), 53: (53, 57, 60), 60: (60, 64, 67), 55: (55, 59, 62)}[r]])
# T3 : 808 (motif de 2 mesures) : notes tenues + glissés posés pendant la note tenue, recopié 4 fois.
MOTIF_808 = [(0, 2.5, 33, False), (1.5, 0.25, 40, True), (3, 1, 33, False), (4, 3, 28, False), (6, 0.25, 33, True), (7, 1, 31, False)]
LIGNE_808 = [(s + 8 * k, d, p, sl) for k in range(4) for (s, d, p, sl) in MOTIF_808]


def make_project():
    def track(tid, name, color, extra=None):
        t = {"id": tid, "name": name, "type": "MIDI", "color": color, "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
             "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
             "clips": [{"id": f"{tid}-c", "name": name, "start": 0, "duration": 32 * BEAT, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": color,
                        "type": "MIDI", "notes": [], "gain": 1}]}
        t.update(extra or {})
        return t
    tracks = [track("melodie", "Mélodie", "#a78bfa"), track("accords", "Accords", "#34d399"), track("basse", "808", "#f97316")]
    # Un 2e clip sur la piste Mélodie (mesures 9-10) : éditer plusieurs clips depuis le piano roll.
    tracks[0]["clips"].append({"id": "melodie-c2", "name": "Relance", "start": 32 * BEAT, "duration": 8 * BEAT, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                               "color": "#a78bfa", "type": "MIDI", "gain": 1,
                               "notes": [{"id": "r1", "pitch": 72, "start": 0, "duration": BEAT, "velocity": 0.8}, {"id": "r2", "pitch": 74, "start": BEAT, "duration": BEAT, "velocity": 0.8}]})
    state = {"id": "proj-pr-pratique", "name": "Piano roll pratique", "bpm": BPM, "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False,
             "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": tracks, "trackGroups": [], "markers": [],
             "selectedTrackId": "melodie", "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False,
             "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True, "projectKey": 9, "projectScale": "MINOR",
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(PROJ, "w") as z:
        z.writestr("project.json", json.dumps(state))


def open_project(page):
    page.add_init_script("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); localStorage.removeItem('nova.pianoroll.prefs'); } catch (e) {}")
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=30000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(PROJ))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)


def open_roll(page, tid, cid=None):
    page.evaluate("([t, c]) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId: t, clipId: c } }))", [tid, cid or f"{tid}-c"])
    page.locator("[data-nova-pianoroll]").wait_for(timeout=8000)
    page.wait_for_timeout(500)


def close_roll(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    if page.locator("[data-nova-pianoroll]").count():
        page.keyboard.press("Escape"); page.wait_for_timeout(300)


NOTES = """(cid) => { for (const t of window.__novaEdit.getState().tracks) { const c = t.clips.find(x => x.id === cid); if (c)
  return (c.notes || []).map(n => ({ p: n.pitch, s: Math.round(n.start / %f * 1000) / 1000, d: Math.round(n.duration / %f * 1000) / 1000, v: Math.round(n.velocity * 127), slide: !!n.slide, muted: !!n.muted })); } return null; }""" % (BEAT, BEAT)

GEOM = """() => { const g = document.querySelector('[data-nova-roll-grid]'); const r = g.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height, sl: g.scrollLeft, st: g.scrollTop, zoom: +g.dataset.novaZoom, rowH: +g.dataset.novaRowH,
    rows: (g.dataset.novaRows || '').split(',').filter(Boolean).map(Number) }; }"""

# Boutons visibles dans les barres du piano roll (hors grille, clavier, couloirs).
BAR_BUTTONS = """() => { const p = document.querySelector('[data-nova-pianoroll]'); if (!p) return null;
  const bars = [...p.querySelectorAll('[data-nova-roll="barre"], [data-nova-roll="barre-avancee"]')];
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'; };
  const b = bars.flatMap(z => [...z.querySelectorAll('button, select, input')]).filter(vis);
  return { n: b.length, noms: b.map(e => (e.getAttribute('aria-label') || e.innerText || e.title || '').trim().slice(0, 30)) }; }"""


class Gestes:
    """Compte les gestes et estime le temps humain (modèle KLM simplifié)."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.n = {"clic": 0, "glisser": 0, "touche": 0, "molette": 0}
        self.klm = 0.0
        self.main = "souris"
        self.t0 = time.time()

    def _main(self, m):
        if self.main != m:
            self.klm += 0.4
            self.main = m

    def clic(self):
        self._main("souris"); self.n["clic"] += 1; self.klm += 1.3

    def glisser(self):
        self._main("souris"); self.n["glisser"] += 1; self.klm += 2.4

    def touche(self):
        self._main("clavier"); self.n["touche"] += 1; self.klm += 0.3

    def molette(self):
        self._main("souris"); self.n["molette"] += 1; self.klm += 0.8

    def bilan(self):
        return {"gestes": sum(self.n.values()), "detail": dict(self.n), "temps_estime_s": round(self.klm, 1), "temps_robot_s": round(time.time() - self.t0, 1)}


class Roll:
    def __init__(self, page, g):
        self.page, self.g = page, g

    def geom(self):
        return self.page.evaluate(GEOM)

    def row_y(self, g, pitch):
        rows = g["rows"]
        i = rows.index(pitch) if rows and pitch in rows else (127 - pitch)
        return g["top"] + i * g["rowH"] - g["st"] + g["rowH"] / 2

    def show(self, pitch, beat=0):
        self.page.evaluate("""([p, x]) => { const g = document.querySelector('[data-nova-roll-grid]'); const h = +g.dataset.novaRowH;
          const rows = (g.dataset.novaRows || '').split(',').filter(Boolean).map(Number); const i = rows.length ? Math.max(0, rows.indexOf(p)) : 127 - p;
          g.scrollTop = i * h - g.clientHeight / 2; g.scrollLeft = x; }""", [pitch, max(0, beat * BEAT * self.geom()["zoom"] - 40)])
        self.page.wait_for_timeout(120)

    def xy(self, beat, pitch, dx=4):
        g = self.geom()
        x = g["left"] + beat * BEAT * g["zoom"] - g["sl"] + dx
        y = self.row_y(g, pitch)
        if x < g["left"] + 8 or x > g["left"] + g["w"] - 30 or y < g["top"] + 4 or y > g["top"] + g["h"] - 4:
            self.show(pitch, beat - 1)
            g = self.geom()
            x = g["left"] + beat * BEAT * g["zoom"] - g["sl"] + dx
            y = self.row_y(g, pitch)
        return x, y

    def click(self, beat, pitch, dx=4, mods=None, button="left", count=True):
        x, y = self.xy(beat, pitch, dx)
        for m in mods or []:
            self.page.keyboard.down(m)
        self.page.mouse.click(x, y, button=button)
        for m in mods or []:
            self.page.keyboard.up(m)
        if count: self.g.clic()
        self.page.wait_for_timeout(90)

    def drag(self, b0, p0, b1, p1, dx0=4, dx1=-3, mods=None, count=True):
        x0, y0 = self.xy(b0, p0, dx0)
        g = self.geom()
        x1 = g["left"] + b1 * BEAT * g["zoom"] - g["sl"] + dx1
        y1 = self.row_y(g, p1)
        if x1 > g["left"] + g["w"] - 20:   # fin hors de l'écran : on dézoome d'abord la vue sur le début
            self.page.evaluate("(v) => { document.querySelector('[data-nova-roll-grid]').scrollLeft = v; }", max(0, b0 * BEAT * g["zoom"] - 40))
            self.page.wait_for_timeout(100)
            x0, y0 = self.xy(b0, p0, dx0)
            g = self.geom()
            x1 = g["left"] + b1 * BEAT * g["zoom"] - g["sl"] + dx1
        for m in mods or []:
            self.page.keyboard.down(m)
        self.page.mouse.move(x0, y0); self.page.mouse.down()
        self.page.mouse.move(x1, y1, steps=6); self.page.mouse.up()
        for m in mods or []:
            self.page.keyboard.up(m)
        if count: self.g.glisser()
        self.page.wait_for_timeout(110)

    def key(self, k, count=True):
        self.page.keyboard.press(k)
        if count: self.g.touche()
        self.page.wait_for_timeout(90)


def nouvelle_ui(page):
    return page.locator("[data-nova-roll-menu-btn]").count() > 0


def ouvrir_menu(page, nom, g=None):
    """Interface « après » : ouvre un menu déroulant de la barre (outil, outils, notes, vue)."""
    page.locator(f"[data-nova-roll-menu-btn={nom}]").first.click(); page.wait_for_timeout(200)
    if g: g.clic()


def choisir(page, sel, g=None):
    page.locator(sel).locator("visible=true").first.click(); page.wait_for_timeout(200)
    if g: g.clic()


def same(notes, want, slide=False):
    have = sorted((round(n["s"], 2), round(n["d"], 2), n["p"]) + ((n["slide"],) if slide else ()) for n in notes)
    exp = sorted((round(s, 2), round(d, 2), p) + ((sl,) if slide else ()) for (s, d, p, *sl0) in want for sl in [sl0[0] if sl0 else False])
    return have == exp, {"manque": [x for x in exp if x not in have][:8], "en_trop": [x for x in have if x not in exp][:8], "n": [len(have), len(exp)]}


# --- Tâches ----------------------------------------------------------------------------------------
def t1_melodie(page, methode):
    g = Gestes(); roll = Roll(page, g)
    open_roll(page, "melodie")
    roll.show(72, 0)
    cur = None
    for (s, d, p) in MELODIE_1_4:
        if cur is not None and abs(cur - d) < 1e-6:
            roll.click(s, p)
        else:
            roll.drag(s, p, s + d, p)
            cur = d
    roll.key("Control+a"); roll.key("Control+b")
    # Mesure 8 : les deux dernières noires changent (clic droit = effacer, clic = poser).
    for (s, d, p) in MELODIE_1_4[-2:]:
        roll.click(s + 16, p, button="right")
    for (s, d, p) in FIN_8:
        roll.click(s, p)
    res = g.bilan()
    good, diff = same(page.evaluate(NOTES, "melodie-c"), [(s, d, p) for (s, d, p) in MELODIE])
    close_roll(page)
    return res, good, diff


KEYS = {0: "a", 1: "w", 2: "s", 3: "e", 4: "d", 5: "f", 6: "t", 7: "g", 8: "y", 9: "h", 10: "u", 11: "j", 12: "k", 13: "o", 14: "l", 15: "p", 16: ";", 17: "'"}


def t1_pas_a_pas(page, methode):
    """Même mélodie, au clavier de l'ordinateur en saisie pas à pas (Do3 = touche A), mesure 8 retouchée à la souris."""
    g = Gestes(); roll = Roll(page, g)
    open_roll(page, "melodie")
    roll.show(72, 0)
    if methode == "avant":
        page.locator("[data-nova-roll=pas-a-pas]").first.click(); g.clic(); page.wait_for_timeout(200)
        page.locator("[data-nova-roll=clavier]").first.click(); g.clic(); page.wait_for_timeout(200)
    else:
        ouvrir_menu(page, "notes", g); choisir(page, "[data-nova-roll=pas-a-pas]", g)
        ouvrir_menu(page, "notes", g); choisir(page, "[data-nova-roll=clavier]", g)
    page.mouse.move(5, 5)
    cur = None
    for (s, d, p) in MELODIE_1_4:
        if cur is None or abs(cur - d) > 1e-6:
            if methode == "avant":
                page.locator(f"[data-nova-step-value='{'1/8' if d == 0.5 else '1/4'}']").first.click(); g.clic()
            else:
                roll.key("4" if d == 0.5 else "3")
            cur = d
        roll.key(KEYS[p - 60])
    if methode == "avant":
        page.locator("[data-nova-roll=pas-a-pas]").first.click(); g.clic()
        page.locator("[data-nova-roll=clavier]").first.click(); g.clic()
    else:
        page.locator("[data-nova-step=stop]").first.click(); g.clic()
        page.locator("[data-nova-roll=clavier-couper]").first.click(); g.clic()
    page.wait_for_timeout(200)
    roll.key("Control+a"); roll.key("Control+b")
    for (s, d, p) in MELODIE_1_4[-2:]:
        roll.click(s + 16, p, button="right")
    (s0, d0, p0), (s1, d1, p1) = FIN_8
    roll.drag(s0, p0, s0 + d0, p0)
    roll.click(s1, p1)
    res = g.bilan()
    good, diff = same(page.evaluate(NOTES, "melodie-c"), [(s, d, p) for (s, d, p) in MELODIE])
    close_roll(page)
    return res, good, diff


def t2_accords(page, methode):
    g = Gestes(); roll = Roll(page, g)
    open_roll(page, "accords")
    roll.show(60, 0)
    if methode == "avant":
        page.locator("[data-nova-roll=accords]").first.click(); g.clic(); page.wait_for_timeout(200)
        page.get_by_role("button", name=__import__("re").compile("^Accord de la gamme")).first.click(); g.clic(); page.wait_for_timeout(200)
        for (s, r) in ACCORDS:
            roll.click(s, r)
        roll.key("Control+a")
        notes = page.evaluate(NOTES, "accords-c")
        d0 = notes[0]["d"] if notes else 0.25
        roll.drag(d0, 57, 8, 57, dx0=-3, dx1=-3)     # poignée de durée d'un accord → toutes les notes sélectionnées
        page.locator("[data-nova-roll=accords]").first.click(); g.clic(); page.wait_for_timeout(200)
        page.get_by_role("button", name="Notes simples (couper l'outil accords)").click(); g.clic(); page.wait_for_timeout(200)
    else:
        ouvrir_menu(page, "outil", g)
        choisir(page, "[data-nova-roll-tool=CHORD]", g)
        (s0, r0) = ACCORDS[0]
        roll.drag(s0, r0, s0 + 8, r0)                 # clic + glisser = l'accord et sa longueur
        for (s, r) in ACCORDS[1:]:
            roll.click(s, r)
        roll.key("p")                                  # retour au crayon
    res = g.bilan()
    good, diff = same(page.evaluate(NOTES, "accords-c"), ACCORDS_NOTES)
    close_roll(page)
    return res, good, diff


def t3_808(page, methode):
    g = Gestes(); roll = Roll(page, g)
    open_roll(page, "basse")
    roll.show(33, 0)
    cur = None
    for (s, d, p, sl) in MOTIF_808:
        if sl and methode == "avant":
            roll.key("s")                                       # mode glissé
            if cur is not None and abs(cur - d) < 1e-6:
                roll.click(s, p)
            else:
                roll.drag(s, p, s + d, p); cur = d
            roll.key("s")
        elif sl:
            roll.click(s, p, mods=["Shift"])                   # Maj + clic : une note glissée (longueur des glissés)
        elif cur is not None and abs(cur - d) < 1e-6:
            roll.click(s, p)
        else:
            roll.drag(s, p, s + d, p); cur = d
    roll.key("Control+a")
    for _ in range(3):
        roll.key("Control+b")
    res = g.bilan()
    good, diff = same(page.evaluate(NOTES, "basse-c"), LIGNE_808, slide=True)
    close_roll(page)
    return res, good, diff



TARGETS = """() => {
  const p = document.querySelector('[data-nova-pianoroll]'); if (!p) return null;
  const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const zones = [...p.querySelectorAll('[data-nova-roll="barre"]'), ...document.querySelectorAll('[data-nova-roll-menu]')];
  const t = zones.flatMap(z => [...z.querySelectorAll('button, select, input[type=checkbox], input[type=range]')]).filter(vis)
    .filter(e => { const r = e.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth; });
  const small = t.map(e => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.innerText || e.title || '').toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => Math.min(x.w, x.h) < 43.5);
  return { cibles: t.length, petites: small.slice(0, 12), n_petites: small.length, defilement_horizontal: document.documentElement.scrollWidth > innerWidth + 1 };
}"""

SET_NOTES = """([cid, notes]) => { const s = window.DAW_CONTROL.getState(); for (const t of s.tracks) { if (t.clips.some(c => c.id === cid))
  window.DAW_CONTROL.updateTrack({ ...t, clips: t.clips.map(c => c.id === cid ? { ...c, notes } : c) }); } }"""


def poser(page, cid, notes):
    page.evaluate(SET_NOTES, [cid, [{"id": f"q{i}", "pitch": p, "start": s * BEAT, "duration": d * BEAT, "velocity": 0.6} for i, (s, d, p) in enumerate(notes)]])
    page.wait_for_timeout(250)


def menu_item(page, menu, sel):
    ouvrir_menu(page, menu)
    page.locator(f"[data-nova-roll-menu=liste-{menu}] {sel}").first.click(); page.wait_for_timeout(250)


def fermer_menus(page):
    if page.locator("[data-nova-roll-menu]").count():
        page.keyboard.press("Escape"); page.wait_for_timeout(200)


def preuves(page, tag, r):
    """Gestes et outils du piano roll pratique (interface « après »)."""
    roll = Roll(page, Gestes())
    open_roll(page, "melodie")
    bar = page.evaluate(BAR_BUTTONS)
    r["barre"] = bar
    ok(f"{tag} : barre épurée (≤ 12 commandes : outil, grille, gamme, Outils ▾, Notes ▾, Vue ▾…)", bar["n"] <= 12
       and all(page.locator(f"[data-nova-roll-menu-btn={m}]").count() for m in ("outil", "outils", "notes", "vue"))
       and page.locator("[data-nova-roll=grille]").count() > 0 and page.locator("[data-nova-roll=gamme]").count() > 0, bar)
    for m in ("outil", "outils", "notes", "vue"):
        ouvrir_menu(page, m)
        shot(page, f"{tag}_10_menu_{m}")
        fermer_menus(page)
    ok(f"{tag} : Échap ferme le menu, pas le piano roll", page.locator("[data-nova-pianoroll]").count() == 1 and page.locator("[data-nova-roll-menu]").count() == 0)

    # Clic droit dans le vide : menu ; sur une note : effacée.
    poser(page, "melodie-c", [(0, 1, 69), (1, 1, 69), (2, 1, 72), (3, 1, 76)])
    roll.show(72, 0)
    roll.click(6, 60, button="right", count=False)
    r["clic_droit_menu"] = page.locator("[data-nova-roll-menu=liste-ctx]").count()
    shot(page, f"{tag}_11_clic_droit")
    fermer_menus(page)
    roll.click(3.5, 76, button="right", count=False)
    n = page.evaluate(NOTES, "melodie-c")
    ok(f"{tag} : clic droit dans le vide = menu, sur une note = effacée", r["clic_droit_menu"] == 1 and len(n) == 3 and not page.locator("[data-nova-roll-menu]").count(), [r["clic_droit_menu"], len(n)])

    # Double-clic : propriétés ; vélocité au maximum (Fin), glissé.
    x, y = roll.xy(2, 72, 10)
    page.mouse.dblclick(x, y); page.wait_for_timeout(300)
    has_props = page.locator("[data-nova-roll-menu=proprietes]").count() == 1
    if has_props:
        shot(page, f"{tag}_12_proprietes")
        page.locator("[data-nova-note-vel]").focus(); page.keyboard.press("End"); page.wait_for_timeout(200)
        page.locator("[data-nova-note-slide]").click(); page.wait_for_timeout(200)
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
    n = page.evaluate(NOTES, "melodie-c")
    tgt = [x for x in n if x["p"] == 72]
    ok(f"{tag} : double-clic = propriétés (vélocité 127, glissé)", has_props and bool(tgt) and tgt[0]["v"] == 127 and tgt[0]["slide"] and len(n) == 3, n)

    # Alt + molette : zoom vertical ; Ctrl + molette : zoom horizontal ; Maj + Alt + molette sur une note : vélocité.
    g0 = roll.geom()
    page.mouse.move(*roll.xy(6, 64)); page.keyboard.down("Alt"); page.mouse.wheel(0, -200); page.keyboard.up("Alt"); page.wait_for_timeout(250)
    g1 = roll.geom()
    page.mouse.move(*roll.xy(0, 69, 10)); page.keyboard.down("Control"); page.mouse.wheel(0, -200); page.keyboard.up("Control"); page.wait_for_timeout(250)
    g2 = roll.geom()
    v0 = [x["v"] for x in page.evaluate(NOTES, "melodie-c") if x["s"] == 0][0]
    page.mouse.move(*roll.xy(0, 69, 10)); page.keyboard.down("Shift"); page.keyboard.down("Alt"); page.mouse.wheel(0, -100); page.keyboard.up("Alt"); page.keyboard.up("Shift"); page.wait_for_timeout(250)
    v1 = [x["v"] for x in page.evaluate(NOTES, "melodie-c") if x["s"] == 0][0]
    r["molette"] = {"rowH": [g0["rowH"], g1["rowH"]], "zoom": [g1["zoom"], g2["zoom"]], "vel": [v0, v1]}
    ok(f"{tag} : Alt + molette = zoom vertical, Ctrl + molette = zoom horizontal, Maj + Alt + molette = vélocité",
       g1["rowH"] > g0["rowH"] and g2["zoom"] > g1["zoom"] and v1 > v0, r["molette"])

    # Alt + glisser : déplacement sans aimant.
    roll.show(69, 0)
    x0, y0 = roll.xy(1, 69, 12)
    page.mouse.move(x0, y0); page.keyboard.down("Alt"); page.mouse.down(); page.mouse.move(x0 + 13, y0, steps=4); page.mouse.up(); page.keyboard.up("Alt")
    page.wait_for_timeout(200)
    moved = [x for x in page.evaluate(NOTES, "melodie-c") if x["p"] == 69 and x["s"] > 0.5]
    off = bool(moved) and abs(moved[0]["s"] * 4 - round(moved[0]["s"] * 4)) > 0.01
    ok(f"{tag} : Alt + glisser une note = sans aimant (hors grille)", off, moved)

    # Souder, sourdine, épaissir, miroir.
    poser(page, "melodie-c", [(0, 1, 69), (1, 1, 69), (2, 1, 72), (3, 1, 76)])
    roll.show(72, 0)
    page.keyboard.press("g"); roll.click(0, 69, 10, count=False); page.keyboard.press("t"); roll.click(2, 72, 10, count=False)
    n = page.evaluate(NOTES, "melodie-c")
    ok(f"{tag} : outil Souder (G) puis Sourdine (T)", len(n) == 3 and any(x["p"] == 69 and x["d"] == 2 for x in n) and any(x["p"] == 72 and x["muted"] for x in n), n)
    page.keyboard.press("p"); page.keyboard.press("Control+a")
    menu_item(page, "outils", "[data-nova-roll=epaissir]")
    n2 = page.evaluate(NOTES, "melodie-c")
    ok(f"{tag} : Épaissir (+ octave) double chaque note une octave au-dessus", len(n2) == 6 and sorted(x["p"] for x in n2 if x["p"] > 80) == [81, 84, 88], n2)
    poser(page, "melodie-c", [(0, 1, 69), (1, 1, 72), (2, 1, 76)])
    page.keyboard.press("Control+a")
    menu_item(page, "outils", "[data-nova-roll=miroir]")
    n3 = sorted((x["s"], x["p"]) for x in page.evaluate(NOTES, "melodie-c"))
    ok(f"{tag} : Miroir dans la gamme (La mineur) : La Do Mi devient Mi Ré La", [p for _, p in n3] == [76, 74, 69], n3)

    # Vue : replier aux notes utilisées, zoom sur la sélection, suivre la lecture.
    menu_item(page, "vue", "[data-nova-roll=replier-utilisees]")
    fermer_menus(page)
    rows = roll.geom()["rows"]
    shot(page, f"{tag}_13_replie_notes_utilisees")
    ok(f"{tag} : replier aux notes utilisées (3 lignes)", rows == [76, 74, 69], rows)
    menu_item(page, "vue", "[data-nova-roll=replier-non]")
    fermer_menus(page)
    z0 = roll.geom()["zoom"]
    page.keyboard.press("Control+a"); page.keyboard.press("z"); page.wait_for_timeout(400)
    gz = roll.geom()
    ok(f"{tag} : Z = zoom sur la sélection", gz["zoom"] > z0 * 1.3 and gz["sl"] < 3 * BEAT * gz["zoom"], {"avant": z0, "apres": gz["zoom"], "sl": gz["sl"]})
    page.evaluate("() => window.DAW_CONTROL.setLoop(false, 0, 0)")
    page.locator("[data-nova-pianoroll] button[aria-label='Lecture']").click()
    page.wait_for_timeout(2600)
    sl = roll.geom()["sl"]
    page.locator("[data-nova-pianoroll] button[aria-label='Pause']").click(); page.wait_for_timeout(300)
    ok(f"{tag} : suivre la lecture (la vue tourne la page)", sl > 50, sl)

    # Quantification d'entrée : prise jouée 37 ms après les temps, écrite sur la grille.
    poser(page, "melodie-c", [])
    menu_item(page, "notes", "[data-nova-roll=quantif-entree]")
    fermer_menus(page)
    menu_item(page, "notes", "[data-nova-roll=rec-midi]")
    page.wait_for_timeout(500)
    played = page.evaluate("""async ([B]) => { const { midiInput } = await window.__novaAppModule('/services/MidiInput.ts');
      const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const o = { source: 'screen', trackId: 'melodie' }; const out = [];
      for (const p of [60, 62, 64]) {
        const t0 = audioEngine.getCurrentTime(); const target = Math.ceil(t0 / B + 0.6) * B + 0.037;
        while (audioEngine.getCurrentTime() < target) await new Promise(r => setTimeout(r, 5));
        midiInput.noteOn(p, 100, o); out.push(Math.round(audioEngine.getCurrentTime() * 1000) / 1000);
        await new Promise(r => setTimeout(r, 180)); midiInput.noteOff(p, o);
      }
      return out; }""", [BEAT])
    page.locator("[data-nova-pianoroll] button[aria-label='Pause']").click(); page.wait_for_timeout(600)
    rec = page.evaluate(NOTES, "melodie-c")
    on_grid = bool(rec) and all(abs(x["s"] * 4 - round(x["s"] * 4)) < 0.01 for x in rec)
    r["prise"] = {"joue_s": played, "ecrit_temps": [x["s"] for x in rec]}
    ok(f"{tag} : prise MIDI calée sur la grille (quantification d'entrée)", len(rec) == 3 and on_grid, r["prise"])
    menu_item(page, "notes", "[data-nova-roll=quantif-entree]")
    fermer_menus(page)
    if page.locator("[data-nova-roll=rec-actif]").count():
        page.locator("[data-nova-roll=rec-actif]").click(); page.wait_for_timeout(200)

    # Plusieurs clips : la « Relance » (mesures 9-10) ouverte avec ; clic sur une de ses notes = elle devient le clip édité.
    ouvrir_menu(page, "vue")
    page.locator("[data-nova-open-clip='melodie-c2']").first.click(); page.wait_for_timeout(250)
    fermer_menus(page)
    n_open = page.locator("[data-nova-open-note='melodie-c2']").count()
    roll.show(73, 31)
    shot(page, f"{tag}_14_clips_ouverts")
    page.locator("[data-nova-open-note='melodie-c2']").first.click(); page.wait_for_timeout(700)
    cs = page.evaluate("() => +document.querySelector('[data-nova-roll-grid]').dataset.novaClipStart")
    ok(f"{tag} : plusieurs clips : notes de l'autre clip visibles, un clic l'édite", n_open == 2 and abs(cs - 32 * BEAT) < 1e-3, {"notes_ouvertes": n_open, "debut_clip": cs})
    shot(page, f"{tag}_15_clip_actif_change")
    close_roll(page)


def tablette(page, tag, r):
    open_roll(page, "accords")
    roll = Roll(page, Gestes())
    roll.show(60, 0)
    x, y = roll.xy(0, 60)
    page.touchscreen.tap(x, y); page.wait_for_timeout(300)
    n = page.evaluate(NOTES, "accords-c")
    ok(f"{tag} : au doigt, une touche pose une note", len(n) >= 1, n)
    shot(page, f"{tag}_20_tablette")
    for m in ("outil", "outils", "notes", "vue"):
        b = page.locator(f"[data-nova-roll-menu-btn={m}]").first.bounding_box()
        page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2); page.wait_for_timeout(300)
        t = page.evaluate(TARGETS)
        r[f"cibles_{m}"] = t
        ok(f"{tag} : menu {m} : cibles ≥ 44 px au doigt, pas de défilement horizontal", t["n_petites"] == 0 and not t["defilement_horizontal"], t["petites"])
        shot(page, f"{tag}_21_menu_{m}")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
    close_roll(page)


def vider(page, cid):
    page.evaluate("""(cid) => { const s = window.DAW_CONTROL.getState(); for (const t of s.tracks) { const c = t.clips.find(x => x.id === cid);
      if (c) window.DAW_CONTROL.updateTrack({ ...t, clips: t.clips.map(y => y.id === cid ? { ...y, notes: [] } : y) }); } }""", cid)
    page.wait_for_timeout(300)


def mesurer(page, tag, methode, r):
    open_roll(page, "melodie")
    r["barre"] = page.evaluate(BAR_BUTTONS)
    shot(page, f"{tag}_00_barre_{methode}")
    close_roll(page)
    for name, fn in (("T1_melodie_8_mesures", t1_melodie), ("T1b_melodie_pas_a_pas", t1_pas_a_pas), ("T2_suite_accords", t2_accords), ("T3_808_glisses", t3_808)):
        if name.startswith("T1b"):
            vider(page, "melodie-c")
        res, good, diff = fn(page, methode)
        r[name] = res
        ok(f"{tag} · {methode} · {name} : {res['gestes']} gestes, ~{res['temps_estime_s']} s (résultat exact)", good, diff)
    open_roll(page, "basse")
    shot(page, f"{tag}_01_808_{methode}")
    close_roll(page)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    make_project()
    args = sys.argv[1:]
    methode = None
    if "--methode" in args:
        methode = args[args.index("--methode") + 1]
    only = [a for a in args if not a.startswith("--") and a not in ("avant", "apres")]
    runs = [("pc", "dark"), ("pc", "light"), ("tab", "dark")]
    res = {}
    for vp, theme in runs:
        tag = f"{vp}_{theme}"
        if only and tag not in only:
            continue
        os.environ["QA_THEME"] = theme
        log = Log(f"pianoroll_pratique_{tag}")
        r = {}
        with sync_playwright() as p:
            b = qalib.launch(p)
            ctx, page = new_page(b, vp, log)
            try:
                open_project(page)
                open_roll(page, "melodie")
                m = methode or ("apres" if nouvelle_ui(page) else "avant")
                close_roll(page)
                r["methode"] = m
                if vp == "pc" and theme == "dark" and "--sans-mesure" not in args:
                    mesurer(page, tag, m, r)
                if m == "apres" and vp == "pc":
                    preuves(page, tag, r)
                if m == "apres" and vp == "tab":
                    tablette(page, tag, r)
            except Exception as e:  # noqa
                r["ERREUR"] = f"{type(e).__name__}: {str(e)[:400]}"
                ok(f"{tag} : scénario complet", False, r["ERREUR"])
                try: shot(page, f"{tag}_ECHEC")
                except Exception: pass
            r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:8]
            ok(f"{tag} : aucune erreur dans la console", not r["erreurs_console"], r["erreurs_console"])
            ctx.close(); b.close()
        res[tag] = r
    res["KO"] = KO
    name = f"pianoroll_pratique_{methode or 'auto'}.json"
    (OUT / name).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: {t: v.get(t) for t in ("methode", "T1_melodie_8_mesures", "T1b_melodie_pas_a_pas", "T2_suite_accords", "T3_808_glisses")} for k, v in res.items() if k != "KO"}, ensure_ascii=False, indent=1))
    print(f"{'KO' if KO else 'OK'} : {len(KO)} échec(s)")
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
