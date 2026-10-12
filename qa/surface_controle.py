"""Surfaces de contrôle (chantier A5) : une FAUSSE surface Mackie Control (et HUI) dans un
Chrome headless (aucune fenêtre). navigator.requestMIDIAccess est remplacé avant le chargement :
la surface simulée parle MCU (poignée de main Logic Control comprise) et enregistre TOUT ce que
NOVA lui envoie. Aucun vrai périphérique MIDI n'est ouvert.

Preuves :
  0. Préférences › Surfaces de contrôle : « Détecter » trouve la X-Touch, état « Connectée » ;
     le port de la surface n'est plus un clavier MIDI (pas de notes jouées) ;
  1. fader de la surface → volume de la piste (et master) ;
  2. fader à la souris dans NOVA → moteur du fader de la surface ;
  3. banque suivante → noms des pistes 9 à 16 sur le LCD ;
  4. mute / solo / select / rec + voyants ;
  5. lecture : automation rejouée → messages de fader reçus par la surface (écart mesuré),
     vumètres (channel pressure), compteur en mesures ; boucle, avance / retour, molette, REC ;
  6. Touch : écriture au fader pendant l'appui, retour à la courbe, AUCUN message vers le fader tenu ;
  7. Latch : valeur gardée jusqu'à l'arrêt ;
  8. potard → pan ;
  9. HUI : ping, fader, afficheurs ;
 10. Web MIDI refusé / absent : message clair.

Usage : NOVA_URL=http://127.0.0.1:3437/ python qa/surface_controle.py
Sorties : D:\\1 WORK\\CONTENU\\nova-surfaces\\
"""
import json, os, re, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3437/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-surfaces")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, shot, Log, OUT  # noqa: E402
from gel_pre_effet import prepare, open_project_file  # noqa: E402
from projet_mix import make_mix_project, NAMES  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RUN = os.environ.get("QA_RUN", "1")
RES = {"run": RUN, "etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:500], flush=True)


# --- Fausse surface ------------------------------------------------------------------------
FAKE_MIDI = r"""
(() => {
  const MODE = %s; // 'ok' | 'denied' | 'absent'
  if (MODE === 'absent') { try { Object.defineProperty(navigator, 'requestMIDIAccess', { value: undefined, configurable: true }); } catch (e) {} return; }
  const mkIn = (id, name) => ({ id, name, manufacturer: 'NOVA QA', state: 'connected', connection: 'open', type: 'input', onmidimessage: null,
    open: async () => {}, close: async () => {}, addEventListener() {}, removeEventListener() {} });
  const S = window.__qaSurf = { sent: [], hui: [], kb: [], handshake: null, sysexAsked: null, clock: null, keysNotes: 0 };
  const keys = mkIn('qa-keys', 'QA Keys 49');
  const xin = mkIn('qa-xtouch-in', 'X-Touch');
  const hin = mkIn('qa-hui-in', 'QA HUI');
  const deliver = (port, bytes) => { if (port.onmidimessage) port.onmidimessage({ data: new Uint8Array(bytes), timeStamp: performance.now() }); };
  const resp = (l) => { const [l1, l2, l3, l4] = l; return [0x7f & (l1 + (l2 ^ 0xa) - l4), 0x7f & ((l3 >> 4) ^ (l1 + l4)), 0x7f & ((l4 - (l3 << 2)) ^ (l1 | l2)), 0x7f & (l2 - l3 + (0xf0 ^ (l4 << 4)))]; };
  const SERIAL = [0x51, 0x41, 0x2d, 0x58, 0x54, 0x31, 0x36], CH = [0x13, 0x37, 0x42, 0x0b];
  const xout = { id: 'qa-xtouch-out', name: 'X-Touch', manufacturer: 'NOVA QA', state: 'connected', connection: 'open', type: 'output', open: async () => {}, close: async () => {},
    send(d) {
      const a = Array.from(d);
      S.sent.push({ t: performance.now(), s: S.clock ? S.clock() : null, d: a });
      // Comportement d'une vraie MCU : Device Query → Host Connection Query (n° de série + défi).
      if (a[0] === 0xf0 && a[4] === 0x14 && a[5] === 0x00) setTimeout(() => deliver(xin, [0xf0, 0, 0, 0x66, 0x14, 0x01, ...SERIAL, ...CH, 0xf7]), 5);
      if (a[0] === 0xf0 && a[4] === 0x14 && a[5] === 0x02) {
        const want = resp(CH), got = a.slice(13, 17);
        S.handshake = { want, got, ok: want.join() === got.join() };
        setTimeout(() => deliver(xin, [0xf0, 0, 0, 0x66, 0x14, S.handshake.ok ? 0x03 : 0x04, ...SERIAL, 0xf7]), 5);
      }
    } };
  const hout = { id: 'qa-hui-out', name: 'QA HUI', manufacturer: 'NOVA QA', state: 'connected', connection: 'open', type: 'output', open: async () => {}, close: async () => {},
    send(d) { const a = Array.from(d); S.hui.push({ t: performance.now(), d: a }); if (a[0] === 0x90 && a[1] === 0 && a[2] === 0) setTimeout(() => deliver(hin, [0x90, 0x00, 0x7f]), 3); } };
  const kout = { id: 'qa-keys-out', name: 'QA Keys 49', manufacturer: 'NOVA QA', state: 'connected', connection: 'open', type: 'output', open: async () => {}, close: async () => {},
    send(d) { S.kb.push(Array.from(d)); } };
  const access = { inputs: new Map([['qa-keys', keys], ['qa-xtouch-in', xin], ['qa-hui-in', hin]]),
    outputs: new Map([['qa-keys-out', kout], ['qa-xtouch-out', xout], ['qa-hui-out', hout]]), sysexEnabled: true, onstatechange: null };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async (opts) => {
    S.sysexAsked = !!(opts && opts.sysex);
    if (MODE === 'denied') { const e = new Error('Permission refusée'); e.name = 'NotAllowedError'; throw e; }
    return access;
  } });
  // Permission déjà accordée (reprise au démarrage), comme sur un PC où Romain a dit oui une fois.
  try {
    const q = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === 'midi') ? Promise.resolve({ state: MODE === 'ok' ? 'granted' : 'denied', onchange: null }) : q(d);
  } catch (e) {}
  S.surface = (bytes) => deliver(xin, bytes);
  S.huiSurface = (bytes) => deliver(hin, bytes);
  S.keys = (bytes) => deliver(keys, bytes);
})();
"""

ST = "() => { const s = window.DAW_CONTROL.getState(); return { playing: s.isPlaying, rec: s.isRecording, loop: s.isLoopActive, time: s.currentTime, sel: s.selectedTrackId, tracks: s.tracks.map(t => ({ id: t.id, name: t.name, v: t.volume, pan: t.pan, m: !!t.isMuted, s: !!t.isSolo, a: !!t.isTrackArmed, mode: t.automationMode || 'read', lanes: (t.automationLanes || []).map(l => ({ p: l.parameterName, pts: l.points.map(q => [Math.round(q.time * 1000) / 1000, Math.round(q.value * 10000) / 10000]) })), clips: t.clips.length })) }; }"


def st(page):
    return page.evaluate(ST)


def trk(page, tid):
    return next(t for t in st(page)["tracks"] if t["id"] == tid)


def surf(page, *msgs):
    for m in msgs:
        page.evaluate("(m) => window.__qaSurf.surface(m)", list(m))


def press(page, note):
    surf(page, [0x90, note, 0x7F], [0x90, note, 0x00])
    page.wait_for_timeout(120)


def to14(p):
    return max(0, min(16383, round(max(0.0, min(1.0, p)) * 16383)))


def pos_of(gain):
    return (max(0.0, gain) / 1.5) ** 0.5


def gain_of(v14):
    return (v14 / 16383) ** 2 * 1.5


def pb(strip, gain):
    v = to14(pos_of(gain))
    return [0xE0 | strip, v & 0x7F, v >> 7]


def sent(page, since=0.0):
    return page.evaluate("(t) => window.__qaSurf.sent.filter(x => x.t >= t)", since)


def now(page):
    return page.evaluate("() => performance.now()")


def lcd_rows(msgs):
    buf = [" "] * 112
    for m in msgs:
        d = m["d"]
        if d[0] == 0xF0 and len(d) > 7 and d[4] == 0x14 and d[5] == 0x12:
            off = d[6]
            for i, b in enumerate(d[7:-1]):
                if off + i < 112: buf[off + i] = chr(b)
    s = "".join(buf)
    return s[:56], s[56:]


def counter(msgs):
    digits = [" "] * 10
    for m in msgs:
        d = m["d"]
        if d[0] == 0xB0 and 0x40 <= d[1] <= 0x49:
            v = d[2]; c = v & 0x3F; dot = bool(v & 0x40)
            ch = chr(c + 0x40) if c < 0x20 else chr(c)
            digits[9 - (d[1] - 0x40)] = ch + ("." if dot else "")
    return "".join(digits)


def faders(msgs, strip):
    return [(m["t"], m["s"], gain_of((m["d"][2] << 7) | m["d"][1])) for m in msgs if m["d"][0] == (0xE0 | strip)]


def lane_value(pts, t):
    pts = sorted(pts)
    if not pts: return None
    if t <= pts[0][0]: return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * ((t - t0) / (t1 - t0) if t1 > t0 else 1)
    return pts[-1][1]


def song_time(page):
    return page.evaluate("async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); return e.getIsPlaying() ? e.getCurrentTime() : -1; }")


def wait_song(page, t, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if song_time(page) >= t: return True
        page.wait_for_timeout(15)
    return False


def wait_js(page, js, timeout=15000):
    page.wait_for_function(js, timeout=timeout)


# Geste de fader dans la page (horloge du navigateur, sans aller-retour Python) :
# toucher, positions toutes les 30 ms pendant `ms`, relâcher.
GESTURE = r"""
async ({ strip, gain, ms }) => {
  const S = window.__qaSurf;
  const v = Math.round(Math.sqrt(gain / 1.5) * 16383);
  const t0 = performance.now();
  S.surface([0x90, 0x68 + strip, 0x7f]);
  const s0 = S.clock ? S.clock() : null;
  while (performance.now() - t0 < ms) {
    S.surface([0xe0 | strip, v & 0x7f, v >> 7]);
    await new Promise(r => setTimeout(r, 30));
  }
  const t1 = performance.now();
  const s1 = S.clock ? S.clock() : null;
  S.surface([0x90, 0x68 + strip, 0x00]);
  return { t0, t1, s0, s1 };
}
"""


def make_project():
    src = OUT / "projet_surface_20pistes.zip"
    ids = make_mix_project(src, n=20, name="Surface QA")
    with zipfile.ZipFile(src) as z:
        files = {n: z.read(n) for n in z.namelist()}
    proj = json.loads(files["project.json"])
    for t in proj["tracks"]:
        if t["id"] == "t1":  # Snare : volume automatisé (lecture)
            t["automationMode"] = "read"
            t["automationLanes"] = [{"id": "lane-vol-t1", "parameterName": "volume", "color": "#f59e0b", "isExpanded": True, "min": 0, "max": 1.5,
                                     "points": [{"id": "p0", "time": 0, "value": 0.2}, {"id": "p1", "time": 3.0, "value": 1.2}, {"id": "p2", "time": 6.0, "value": 0.2}]}]
    proj["selectedTrackId"] = "t0"
    files["project.json"] = json.dumps(proj).encode()
    with zipfile.ZipFile(src, "w") as z:
        for n, b in files.items(): z.writestr(n, b)
    return src, ids


def open_prefs(page):
    page.keyboard.press("Escape")
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type("surfaces de contr")
    page.wait_for_timeout(250)
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    page.keyboard.press("Enter")
    page.locator("[data-control-surface-settings]").wait_for(timeout=10000)
    page.wait_for_timeout(500)
    return first


def close_prefs(page):
    b = page.get_by_role("button", name="Valider").locator("visible=true")
    if b.count(): b.first.click()
    page.wait_for_timeout(300)


def section_shot(page, name):
    """Capture de la section Préférences › Surfaces de contrôle seule."""
    sec = page.locator("[data-control-surface-settings]").first
    try:
        sec.scroll_into_view_if_needed(); page.wait_for_timeout(300)
        sec.screenshot(path=str(OUT / f"{name}.png"))
    except Exception:
        shot(page, name)


def status(page):
    return page.locator("[data-surface-status]").first.get_attribute("data-surface-status")


def open_studio(page, src):
    prepare(page, None, desktop=False)
    open_project_file(page, src, {}, f"r{RUN}_00_projet")
    page.wait_for_function("() => window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.length >= 25", timeout=60000)
    adv = page.get_by_role("button", name=re.compile("mode avancé", re.I)).locator("visible=true").first
    if adv.count() and adv.is_visible(): adv.click(); page.wait_for_timeout(800)
    page.evaluate("async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); if (window.__qaSurf) window.__qaSurf.clock = () => (e.getIsPlaying() ? e.getCurrentTime() : null); }")


def run_main(b, src):
    log = Log("surface")
    ctx, page = new_page(b, "pc", log)
    ctx.add_init_script(FAKE_MIDI % json.dumps("ok"))
    ctx.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
    open_studio(page, src)
    names = [t["name"] for t in st(page)["tracks"]]

    # 0. Préférences › Surfaces de contrôle -------------------------------------------------
    pal = open_prefs(page)
    ok("0a palette : « Préférences › Surfaces de contrôle »", pal == "pal.surfaces", pal)
    section_shot(page, f"r{RUN}_01_preferences_avant")
    page.locator("[data-control-surface-settings]").get_by_role("button", name=re.compile("Détecter")).first.click()
    try:
        page.wait_for_function("() => document.querySelector('[data-surface-status]')?.getAttribute('data-surface-status') === 'connected'", timeout=10000)
    except Exception:
        pass
    stt = status(page)
    msg = page.locator("[data-surface-message]").first.inner_text() if page.locator("[data-surface-message]").count() else ""
    hs = page.evaluate("() => window.__qaSurf.handshake")
    ok("0b détection + état « Connectée » (poignée de main MCU)", stt == "connected" and hs and hs["ok"], {"etat": stt, "message": msg, "poignee": hs})
    sel_in = page.get_by_label("Port d'entrée MIDI de la surface").input_value()
    sel_out = page.get_by_label("Port de sortie MIDI de la surface").input_value()
    proto = page.get_by_label("Protocole de la surface").input_value()
    ok("0c ports et protocole choisis", sel_in == "X-Touch" and sel_out == "X-Touch" and proto == "mcu", [sel_in, sel_out, proto])
    ok("0d SysEx demandé (afficheurs)", page.evaluate("() => window.__qaSurf.sysexAsked") is True)
    section_shot(page, f"r{RUN}_02_preferences_connectee")
    close_prefs(page)
    kb_inputs = page.evaluate("async () => (await window.__novaAppModule('/services/MidiManager.ts')).midiManager.getInputs().map(i => i.name)")
    ok("0e le port de la surface n'est plus un clavier MIDI", "X-Touch" not in kb_inputs, kb_inputs)
    page.wait_for_timeout(400)
    top, bottom = lcd_rows(sent(page))
    ok("0f LCD : noms des pistes 1 à 8", all(n[:3] in top for n in ["Kick", "Snare", "Perc", "808"]), {"haut": top, "bas": bottom})
    RES["mesures"]["lcd_banque1"] = {"haut": top, "bas": bottom}

    # 1. Fader → volume ---------------------------------------------------------------------
    t0 = now(page)
    surf(page, pb(0, 0.5))
    page.wait_for_timeout(250)
    v = trk(page, "t0")["v"]
    ok("1a fader 1 de la surface → volume de « Kick » (0,500)", abs(v - 0.5) < 0.002, round(v, 4))
    echo = [m for m in sent(page, t0) if m["d"][0] == 0xE0]
    ok("1b pas d'écho vers le fader qui vient de bouger", len(echo) == 0, len(echo))
    surf(page, pb(8, 0.7))
    page.wait_for_timeout(250)
    mv = trk(page, "master")["v"]
    ok("1c fader master → volume du master", abs(mv - 0.7) < 0.002, round(mv, 4))
    surf(page, pb(8, 1.0)); page.wait_for_timeout(400)

    # 2. Souris dans NOVA → moteur du fader ------------------------------------------------
    page.evaluate("() => document.querySelector(\"[data-track-header='t4']\")?.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(300)
    box = page.locator('[data-nova-target="vol-t4"]').first.bounding_box()
    t0 = now(page)
    how = "souris"
    if box:
        y = box["y"] + box["height"] / 2
        x0 = box["x"] + box["width"] * pos_of(0.8)
        page.mouse.move(x0, y); page.mouse.down()
        for i in range(1, 9):
            page.mouse.move(x0 - box["width"] * 0.04 * i, y); page.wait_for_timeout(30)
        page.mouse.up()
    else:
        how = "handleUpdateTrack"
        page.evaluate("() => { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 't4'); window.__novaSurface.updateTrack({ ...t, volume: 0.3 }); }")
    page.wait_for_timeout(400)
    v4 = trk(page, "t4")["v"]
    f4 = faders(sent(page, t0), 4)
    last = f4[-1][2] if f4 else None
    ok(f"2 fader de NOVA bougé ({how}) → moteur du fader 5 de la surface", bool(f4) and abs(last - v4) < 0.01 and abs(v4 - 0.8) > 0.05,
       {"volume": round(v4, 4), "dernier_message": None if last is None else round(last, 4), "messages": len(f4)})

    # 3. Banque suivante --------------------------------------------------------------------
    t0 = now(page)
    press(page, 0x2F)
    page.wait_for_timeout(400)
    top, _ = lcd_rows(sent(page))
    want = names[8:16]
    def abbr(n):
        s = n.strip()
        return s if len(s) <= 6 else s.replace(" ", "")[:6]
    found = [n for n in want if abbr(n)[:4] in top]
    ok("3a BANK ▶ : noms des pistes 9 à 16 sur le LCD", len(found) == 8, {"lcd": top, "attendus": want})
    RES["mesures"]["lcd_banque2"] = top
    surf(page, pb(0, 0.6)); page.wait_for_timeout(250)
    ok("3b fader 1 → piste 9 (« Lead ») après BANK ▶", abs(trk(page, "t8")["v"] - 0.6) < 0.002, round(trk(page, "t8")["v"], 4))
    shot(page, f"r{RUN}_03_banque2")
    press(page, 0x2E)
    page.wait_for_timeout(300)
    top, _ = lcd_rows(sent(page))
    ok("3c BANK ◀ : retour aux pistes 1 à 8", "Kick" in top, top)

    # 4. Mute / solo / select / rec + voyants ----------------------------------------------
    t0 = now(page)
    press(page, 0x10 + 2); page.wait_for_timeout(200)
    press(page, 0x08 + 3); page.wait_for_timeout(200)
    press(page, 0x18 + 5); page.wait_for_timeout(300)
    s = st(page)
    m = {t["id"]: t for t in s["tracks"]}
    leds = [x["d"] for x in sent(page, t0) if x["d"][0] == 0x90]
    ok("4a MUTE 3 / SOLO 4 / SELECT 6 → état de NOVA", m["t2"]["m"] and m["t3"]["s"] and s["sel"] == "t5", {"mute": m["t2"]["m"], "solo": m["t3"]["s"], "sel": s["sel"]})
    ok("4b voyants renvoyés (mute, solo, select)", [0x90, 0x12, 0x7F] in leds and [0x90, 0x0B, 0x7F] in leds and [0x90, 0x1D, 0x7F] in leds, leds[:12])
    press(page, 0x10 + 2); press(page, 0x08 + 3)
    page.wait_for_timeout(300)
    s = st(page); m = {t["id"]: t for t in s["tracks"]}
    ok("4c second appui : mute / solo retirés", not m["t2"]["m"] and not m["t3"]["s"])

    # 5. Lecture : automation, vumètres, compteur, transport ------------------------------
    press(page, 0x18 + 0)  # SELECT Kick
    page.keyboard.press("Home"); page.wait_for_timeout(300)
    t0 = now(page)
    press(page, 0x5E)  # PLAY
    playing = page.evaluate("() => window.DAW_CONTROL.getState().isPlaying")
    wait_song(page, 5.0, 40)
    page.wait_for_timeout(100)
    allm = sent(page)
    cnt_play = counter(allm)
    tc_last = [m for m in allm if m["d"][0] == 0xB0 and 0x40 <= m["d"][1] <= 0x49 and m["s"] is not None]
    tc_song = tc_last[-1]["s"] if tc_last else None
    press(page, 0x5D)  # STOP
    page.wait_for_timeout(500)
    s = st(page)
    ok("5a PLAY puis STOP de la surface", playing and not s["playing"], {"lecture": playing, "apres_stop": s["playing"]})
    msgs = sent(page, t0)
    lane = next(l for l in trk(page, "t1")["lanes"] if l["p"] == "volume")["pts"]
    f1 = [(t, sng, g) for (t, sng, g) in faders(msgs, 1) if sng is not None and 0.2 < sng < 4.8]
    errs = []
    for (_, sng, g) in f1:
        # écart en position de fader, au meilleur instant dans les 120 ms précédentes (retard d'affichage)
        best = min(abs(pos_of(g) - pos_of(lane_value(lane, sng - k * 0.01))) for k in range(0, 13))
        errs.append(best)
    errs.sort()
    med = errs[len(errs) // 2] if errs else None
    mx = errs[-1] if errs else None
    RES["mesures"]["automation_lecture"] = {"messages_fader2": len(f1), "ecart_median_course": med, "ecart_max_course": mx,
                                            "exemples": [(round(sng, 3), round(g, 4), round(lane_value(lane, sng), 4)) for (_, sng, g) in f1[::max(1, len(f1) // 12)]]}
    ok("5b automation en lecture → fader 2 de la surface suit la courbe", len(f1) >= 20 and med is not None and med < 0.02 and mx < 0.06,
       {"messages": len(f1), "ecart_median_%": None if med is None else round(med * 100, 2), "ecart_max_%": None if mx is None else round(mx * 100, 2)})
    meters = [m["d"] for m in msgs if m["d"][0] == 0xD0]
    lv0 = [d[1] & 0x0F for d in meters if d[1] >> 4 == 0]
    ok("5c vumètres (channel pressure) pendant la lecture", len(lv0) >= 10 and max(lv0) >= 6, {"messages_tranche1": len(lv0), "niveau_max": max(lv0) if lv0 else None, "total": len(meters)})
    RES["mesures"]["vumetres"] = {"messages": len(meters), "tranche1_niveaux": sorted(set(lv0))}
    bar_want = None if tc_song is None else int(tc_song / (4 * 60 / 140)) + 1
    bar_shown = cnt_play.split(".")[0].strip()
    ok("5d compteur 7 segments en mesures (= mesure de l'instant du dernier envoi, 140 BPM)", bar_want is not None and bar_shown == str(bar_want) and tc_song > 4.5,
       {"affiche": cnt_play, "instant_s": None if tc_song is None else round(tc_song, 3), "mesure_attendue": bar_want})
    RES["mesures"]["compteur_fin_lecture"] = {"affiche": cnt_play, "instant_s": tc_song}
    # Boucle
    press(page, 0x56); page.wait_for_timeout(250)
    l1 = st(page)["loop"]
    press(page, 0x56); page.wait_for_timeout(250)
    l2 = st(page)["loop"]
    ok("5e CYCLE : boucle activée puis coupée", l1 and not l2, [l1, l2])
    # Avance / retour d'une mesure (140 BPM, 4/4 : 1,714 s)
    page.keyboard.press("Home"); page.wait_for_timeout(300)
    press(page, 0x5C); page.wait_for_timeout(300)
    tf = st(page)["time"]
    press(page, 0x5C); page.wait_for_timeout(300)
    tf2 = st(page)["time"]
    press(page, 0x5B); page.wait_for_timeout(300)
    tr = st(page)["time"]
    ok("5f FF / REW : une mesure en avant / en arrière", abs(tf - 1.7143) < 0.01 and abs(tf2 - 3.4286) < 0.01 and abs(tr - 1.7143) < 0.01, [round(tf, 4), round(tf2, 4), round(tr, 4)])
    surf(page, [0xB0, 0x3C, 0x04]); page.wait_for_timeout(300)
    tj = st(page)["time"]
    ok("5g molette : 4 crans = 4 doubles-croches", abs(tj - (tr + 4 * 60 / 140 / 4)) < 0.01, round(tj, 4))
    # Armement + REC
    press(page, 0x00 + 0); page.wait_for_timeout(800)
    armed = trk(page, "t0")["a"]
    clips0 = trk(page, "t0")["clips"]
    press(page, 0x5F)
    try:
        page.wait_for_function("() => window.DAW_CONTROL.getState().isRecording", timeout=20000)
        rec_on = True
    except Exception:
        rec_on = False
    page.wait_for_timeout(2500)
    led_rec = any(m["d"] == [0x90, 0x5F, 0x7F] for m in sent(page))
    press(page, 0x5D)
    try:
        page.wait_for_function("() => !window.DAW_CONTROL.getState().isRecording", timeout=20000)
    except Exception:
        pass
    page.wait_for_timeout(1500)
    rec_off = not st(page)["rec"]
    clips1 = trk(page, "t0")["clips"]
    ok("5h REC armé (bouton REC de la tranche) + RECORD + STOP : une prise", armed and rec_on and rec_off and led_rec,
       {"arme": armed, "enregistre": rec_on, "voyant_rec": led_rec, "arrete": rec_off, "clips_avant": clips0, "clips_apres": clips1})
    for name in ("Garder", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true")
        if bb.count(): bb.first.click(); page.wait_for_timeout(300)
    if trk(page, "t0")["a"]:
        press(page, 0x00); page.wait_for_timeout(500)
    page.keyboard.press("Escape")

    # 6. Touch sur « Hi-hats » (t2) ----------------------------------------------------------
    def write_pass(strip, tid, mode_note, mode_name, gain=0.3, touch_at=1.0, hold_ms=1000, stop_at=3.5):
        press(page, 0x18 + strip)
        press(page, mode_note)
        page.wait_for_timeout(300)
        mode = trk(page, tid)["mode"]
        base = trk(page, tid)["v"]
        page.keyboard.press("Home"); page.wait_for_timeout(400)
        t0 = now(page)
        press(page, 0x5E)
        wait_song(page, touch_at, 30)
        g = page.evaluate(GESTURE, {"strip": strip, "gain": gain, "ms": hold_ms})
        wait_song(page, stop_at, 30)
        press(page, 0x5D)
        page.wait_for_timeout(800)
        msgs = sent(page, t0)
        during = [m for m in msgs if m["d"][0] == (0xE0 | strip) and g["t0"] + 1 <= m["t"] <= g["t1"]]
        after = [(m["s"], gain_of((m["d"][2] << 7) | m["d"][1])) for m in msgs if m["d"][0] == (0xE0 | strip) and m["t"] > g["t1"] and m["s"] is not None]
        t = trk(page, tid)
        lane = next((l["pts"] for l in t["lanes"] if l["p"] == "volume"), [])
        return {"mode": mode, "base": base, "geste": g, "pendant": len(during), "apres": after, "lane": lane}

    r6 = write_pass(2, "t2", 0x4D, "touch")
    s0, s1 = r6["geste"]["s0"], r6["geste"]["s1"]
    lane = r6["lane"]
    mid = (s0 + s1) / 2 if s0 and s1 else 1.5
    v_before, v_mid, v_after = lane_value(lane, 0.5), lane_value(lane, mid), lane_value(lane, (s1 or 2.0) + 0.8)
    base = r6["base"]
    RES["mesures"]["touch"] = {"volume_avant": base, "appui_s": s0, "relachement_s": s1, "points": lane, "messages_vers_fader_tenu": r6["pendant"],
                               "retour_moteur": [(round(a, 3), round(b, 4)) for a, b in r6["apres"][:6]]}
    ok("6a bouton TOUCH de la surface → piste en Touch", r6["mode"] == "touch", r6["mode"])
    ok("6b Touch : points écrits (0,3 pendant l'appui, volume d'origine avant / après)", lane and abs(v_before - base) < 0.01 and abs(v_mid - 0.3) < 0.01 and abs(v_after - base) < 0.01,
       {"avant": v_before, "pendant": v_mid, "apres": v_after, "points": len(lane)})
    ok("6c aucun message vers le fader tenu (pas de combat)", r6["pendant"] == 0, r6["pendant"])
    ok("6d relâché : le moteur ramène le fader sur la courbe", any(abs(b - base) < 0.02 for a, b in r6["apres"]), [(round(a, 3), round(b, 3)) for a, b in r6["apres"][:3] + r6["apres"][-2:]])

    # 7. Latch sur « Perc » (t3) ------------------------------------------------------------
    r7 = write_pass(3, "t3", 0x4E, "latch")
    s0, s1 = r7["geste"]["s0"], r7["geste"]["s1"]
    lane = r7["lane"]
    v_before, v_mid, v_late = lane_value(lane, 0.5), lane_value(lane, ((s0 or 1) + (s1 or 2)) / 2), lane_value(lane, 3.3)
    RES["mesures"]["latch"] = {"volume_avant": r7["base"], "appui_s": s0, "relachement_s": s1, "points": lane, "messages_vers_fader_tenu": r7["pendant"]}
    ok("7a bouton LATCH → piste en Latch", r7["mode"] == "latch", r7["mode"])
    ok("7b Latch : 0,3 gardé après le relâchement jusqu'à l'arrêt", lane and abs(v_before - r7["base"]) < 0.01 and abs(v_mid - 0.3) < 0.01 and abs(v_late - 0.3) < 0.01,
       {"avant": v_before, "pendant": v_mid, "a_3,3_s": v_late, "points": len(lane)})
    ok("7c aucun message vers le fader tenu", r7["pendant"] == 0, r7["pendant"])
    shot(page, f"r{RUN}_04_touch_latch")

    # 8. Potard → pan ----------------------------------------------------------------------
    t0 = now(page)
    surf(page, [0xB0, 0x14, 0x05]); page.wait_for_timeout(300)
    p4 = trk(page, "t4")["pan"]
    ring = [m["d"] for m in sent(page, t0) if m["d"][0] == 0xB0 and m["d"][1] == 0x34]
    ok("8 potard 5 → pan de la piste 5, anneau renvoyé", p4 > 0.1 and ring, {"pan": p4, "anneau": ring[-1:]})
    surf(page, [0x90, 0x24, 0x7F]); page.wait_for_timeout(200)

    # 9. HUI --------------------------------------------------------------------------------
    open_prefs(page)
    page.get_by_label("Protocole de la surface").select_option("hui"); page.wait_for_timeout(400)
    page.get_by_label("Port d'entrée MIDI de la surface").select_option("QA HUI"); page.wait_for_timeout(400)
    page.get_by_label("Port de sortie MIDI de la surface").select_option("QA HUI")
    try:
        page.wait_for_function("() => document.querySelector('[data-surface-status]')?.getAttribute('data-surface-status') === 'connected'", timeout=8000)
    except Exception:
        pass
    hst = status(page)
    section_shot(page, f"r{RUN}_05_hui_connectee")
    close_prefs(page)
    page.wait_for_timeout(500)
    v = int(pos_of(0.4) * 16383)
    page.evaluate("(m) => { for (const x of m) window.__qaSurf.huiSurface(x); }", [[0xB0, 0x0F, 0x01], [0xB0, 0x2F, 0x40], [0xB0, 0x01, v >> 7], [0xB0, 0x21, v & 0x7F], [0xB0, 0x0F, 0x01], [0xB0, 0x2F, 0x00]])
    page.wait_for_timeout(300)
    hv = trk(page, "t1")["v"]
    hui = page.evaluate("() => window.__qaSurf.hui")
    scrib = ["".join(chr(c) for c in m["d"][8:12]) for m in hui if m["d"][0] == 0xF0 and m["d"][6] == 0x10]
    pings = sum(1 for m in hui if m["d"] == [0x90, 0, 0])
    ok("9 HUI : ping / connectée, fader 2 → volume, noms 4 caractères", hst == "connected" and abs(hv - 0.4) < 0.003 and any("Kick" in s for s in scrib),
       {"etat": hst, "volume": round(hv, 4), "afficheurs": scrib[:8], "pings": pings})
    RES["mesures"]["hui"] = {"afficheurs": scrib[:8], "pings": pings}

    # Désactiver : la surface s'éteint, plus rien ne part.
    open_prefs(page)
    page.locator("[data-control-surface-settings]").get_by_role("button", name="Désactiver").first.click(); page.wait_for_timeout(500)
    n_after = len(page.evaluate("() => window.__qaSurf.hui"))
    page.wait_for_timeout(1500)
    n_later = len(page.evaluate("() => window.__qaSurf.hui"))
    reset = [m["d"] for m in page.evaluate("() => window.__qaSurf.hui")][-200:]
    ok("10a Désactiver : faders remis en bas, plus aucun message", [0xB0, 0x00, 0x00] in reset and n_later == n_after and status(page) == "off", {"avant": n_after, "apres_1_5s": n_later})
    close_prefs(page)

    ok("10b clavier MIDI (autre port) jamais visé par la surface", not page.evaluate("() => window.__qaSurf.kb.length"))
    errs = [e for e in log.errors() if "favicon" not in e["text"]]
    ok("11 aucune erreur de page", not errs, errs[:5])
    RES["mesures"]["messages_mcu_total"] = page.evaluate("() => window.__qaSurf.sent.length")
    ctx.close()


def run_refus(b, src, mode):
    log = Log(f"surface_{mode}")
    ctx, page = new_page(b, "pc", log)
    ctx.add_init_script(FAKE_MIDI % json.dumps(mode))
    ctx.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
    open_studio(page, src)
    open_prefs(page)
    if mode == "denied":
        page.locator("[data-control-surface-settings]").get_by_role("button", name="Activer la surface").first.click(); page.wait_for_timeout(800)
        msg = page.locator("[data-surface-message]").first.inner_text() if page.locator("[data-surface-message]").count() else ""
        ok("12a Web MIDI refusé : message clair", status(page) == "denied" and "refusé" in msg and "Autoriser" in msg, msg)
    else:
        txt = page.locator("[data-control-surface-settings]").first.inner_text()
        ok("12b Web MIDI absent : message clair", "ne gère pas le MIDI" in txt, txt[-160:])
    section_shot(page, f"r{RUN}_06_midi_{mode}")
    ctx.close()


def main():
    src, _ = make_project()
    t = time.time()
    with sync_playwright() as p:
        b = launch(p)
        try:
            run_main(b, src)
            run_refus(b, src, "denied")
            run_refus(b, src, "absent")
        finally:
            b.close()
    RES["duree_s"] = round(time.time() - t, 1)
    n_ok = sum(1 for e in RES["etapes"].values() if e["ok"])
    RES["bilan"] = f"{n_ok}/{len(RES['etapes'])}"
    (OUT / f"surface_controle_run{RUN}.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print("BILAN", RES["bilan"], f"{RES['duree_s']} s")
    sys.exit(0 if n_ok == len(RES["etapes"]) else 1)


if __name__ == "__main__":
    main()
