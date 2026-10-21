"""📌 Playlist : glisser un clip vers le haut l'y ajoute (bout en bout, hors production).

Projet « Voix lead » NON armée avec deux clips importés (pas des prises) :
  1. la playlist est visible dès l'ouverture (en-tête vide au-dessus de la piste d'enregistrement) ;
  2. clip A glissé vers le haut dans la playlist : 1 ligne, le clip n'a pas bougé et devient une prise ;
  3. clip B glissé pareil : 2 lignes, la playlist a grandi ;
  4. Ctrl+Z : retour à 1 ligne.

NOVA_URL=http://127.0.0.1:3485/ python qa/playlist_glisser.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-prises-gardees\\qa_glisser) : playlist_glisser.json + captures.
"""
import io, json, math, os, sys, wave, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3485/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-prises-gardees\qa_glisser")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TID = "track-voix"
HEAD_H = 30
checks = []


def check(name, cond, detail=None):
    checks.append({"nom": name, "ok": bool(cond), "detail": detail})
    print(("OK  " if cond else "KO  ") + name + ("" if cond else f"  → {json.dumps(detail, ensure_ascii=False, default=str)[:400]}"))


def tone(freq, seconds, sr=48000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b"".join(int(8000 * math.sin(2 * math.pi * freq * i / sr)).to_bytes(2, "little", signed=True)
                               for i in range(int(seconds * sr))))
    return buf.getvalue()


def make_project(path: Path):
    clip = lambda cid, name, start, ref: {"id": cid, "name": name, "start": start, "duration": 4, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                                          "type": "AUDIO", "color": "#22d3ee", "audioRef": ref}
    track = {"id": TID, "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
             "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
             "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
             "clips": [clip("clip-a", "Voix importée A", 0, "audio/a.wav"), clip("clip-b", "Voix importée B", 6, "audio/b.wav")]}
    state = {
        "id": "proj-playlist-glisser", "name": "Playlist glisser", "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": TID, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "vocalMixStyle": "voix-brute",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/a.wav", tone(220, 4))
        z.writestr("audio/b.wav", tone(330, 4))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
"""

GEO_JS = """(tid) => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const zone = document.querySelector(`[data-kept-zone="${tid}"]`);
  const layer = document.querySelector('[data-testid="kept-layer"]');
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === tid);
  return {
    zone: box(zone && zone.parentElement), count: zone ? +zone.dataset.keptCount : null,
    layer: box(layer), stripText: (document.querySelector(`[data-kept-strip="${tid}"]`) || {}).innerText || null,
    zoomH: layer ? +layer.dataset.zoomH : null, scrollLeft: layer ? +layer.dataset.scrollLeft : null, zoomV: layer ? +layer.dataset.zoomV : null,
    clips: t.clips.map(c => ({ id: c.id, start: c.start, end: c.start + c.duration, takeNumber: c.takeNumber ?? null, muted: !!c.isMuted })),
    kept: (t.takeMeta || []).filter(m => m.kept).map(m => ({ n: m.n, name: m.name || null })),
  };
}"""


def geo(page):
    return page.evaluate(GEO_JS, TID)


def open_project(page, f: Path):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    page.keyboard.press("Escape")


def drag_up(page, g, cid):
    c = [x for x in g["clips"] if x["id"] == cid][0]
    x0 = g["layer"]["x"] + (c["start"] + c["end"]) / 2 * g["zoomH"] - g["scrollLeft"]
    y0 = g["zone"]["y"] + g["zone"]["h"] + g["zoomV"] - 14
    page.mouse.move(x0, y0); page.mouse.down()
    page.mouse.move(x0 + 3, y0 - 20, steps=3)
    page.mouse.move(x0 + 3, g["zone"]["y"] + HEAD_H / 2, steps=8)
    page.wait_for_timeout(200)
    hot = page.evaluate(f"() => (document.querySelector('[data-kept-strip=\"{TID}\"]') || {{}}).innerText || ''")
    page.mouse.up(); page.wait_for_timeout(700)
    return c, hot


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
    try:
        f = OUT / "playlist_glisser.zip"
        OUT.mkdir(parents=True, exist_ok=True)
        make_project(f)
        log = Log("playlist_glisser")
        ctx, page = new_page(b, "pc", log=log, touch=False)
        open_project(page, f)
        g = geo(page)
        check("ouverture : playlist visible (en-tête vide) au-dessus de « Voix lead » non armée",
              g["zone"] and abs(g["zone"]["h"] - HEAD_H) < 1 and g["count"] == 0, g)
        shot(page, "glisser_00_playlist_vide")
        h0 = g["zone"]["h"] if g["zone"] else 0

        a, hot = drag_up(page, g, "clip-a")
        g = geo(page)
        a2 = [x for x in g["clips"] if x["id"] == "clip-a"][0]
        check("clip A glissé vers le haut : 1 ligne, le clip n'a pas bougé et devient une prise",
              g["count"] == 1 and abs(a2["start"] - a["start"]) < 1e-3 and a2["takeNumber"] is not None and not a2["muted"],
              {"count": g["count"], "avant": a, "apres": a2, "bandeau_pendant": hot})
        check("bandeau pendant le glisser : « Lâche ici »", "Lâche ici" in hot, hot)
        check("la ligne porte le nom du clip", any(k["name"] == "Voix importée A" for k in g["kept"]), g["kept"])
        h1 = g["zone"]["h"]
        shot(page, "glisser_01_une_ligne")

        bclip, _ = drag_up(page, g, "clip-b")
        g = geo(page)
        h2 = g["zone"]["h"]
        check("clip B glissé pareil : 2 lignes, la playlist a grandi", g["count"] == 2 and h2 > h1 > h0, {"count": g["count"], "hauteurs": [h0, h1, h2]})
        shot(page, "glisser_02_deux_lignes")

        page.mouse.click(5, 5)
        page.keyboard.press("Control+z"); page.wait_for_timeout(600)
        g = geo(page)
        check("Ctrl+Z : retour à 1 ligne", g["count"] == 1, g["count"])

        errs = log.errors()
        check("aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()
    finally:
        b.close()

bilan = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "playlist_glisser.json").write_text(json.dumps({"verifications": checks, "bilan": bilan}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(bilan, ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
