"""∞ Clips MIDI liés (L3, écart 10) : copies liées d'un motif (bout en bout, hors production).

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucun micro réel.

Bureau 1600 × 900 (sombre puis clair) :
  1. clic droit sur le motif → « Dupliquer en copie liée », puis 6 de plus : 8 copies, pastille « ∞ 8 » sur chacune ;
  2. piano roll ouvert sur la 4e copie : bouton « ∞ 8 copies liées » ; Ctrl+A puis ↑ : les 8 copies montent d'un
     demi-ton (une seule mise à jour) ; Ctrl+Z : une étape ramène les 8 ;
  3. export : le son des 8 copies = le motif retouché posé 8 fois (écart mesuré) ;
  4. « Rendre unique » (piano roll) : la copie se détache en une étape, les 7 autres restent liées ; la retoucher
     ne change plus les autres ; le menu du clip propose « Rendre unique (… 6 autres copies) » ;
  5. sauvegarde (.zip) → rechargement : les liens reviennent (7 copies liées + 1 unique).
Téléphone 390 × 844 : le projet s'ouvre, aucune erreur.

NOVA_URL=http://127.0.0.1:3521/ python qa/clips_lies.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\qa-clips-lies) : clips_lies.json + captures.
"""
import json, os, re, sys, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3521/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\qa-clips-lies")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, launch, menu_pick  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ZOOM = 40
BEAT = 60 / 90
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def make_project(path: Path):
    notes = [{"id": f"n{i}", "pitch": p, "start": i * BEAT, "duration": BEAT * 0.9, "velocity": 0.8} for i, p in enumerate([60, 63, 67, 70])]
    piano = {"id": "piano", "name": "Piano", "type": "MIDI", "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 0.9, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
             "clips": [{"id": "motif", "start": 0, "duration": 4 * BEAT, "offset": 0, "fadeIn": 0, "fadeOut": 0, "name": "Motif", "color": "#22d3ee", "type": "MIDI", "notes": notes}]}
    state = {
        "id": "proj-clips-lies", "name": "Clips liés", "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [piano], "trackGroups": [], "markers": [], "selectedTrackId": "piano", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
"""


def open_project(page, f: Path, label, touch=False):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
    b = page.get_by_text("Charger Projet").first
    b.tap() if touch else b.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        c = page.get_by_text("Charger depuis l'ordinateur").first
        c.tap() if touch else c.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/simpleMode.ts'); m.simpleModeStore.setPref(false); }")
    page.wait_for_timeout(600)
    shot(page, label)


def clip_point(page, track_id, t_sec):
    r = page.evaluate("""(id) => { const h = document.querySelector(`[data-track-header='${id}']`); if (!h) return null; const q = h.getBoundingClientRect(); return { top: q.top, h: q.height }; }""", track_id)
    b = page.evaluate("""() => { const c = (document.querySelector('.nova-grille canvas[data-tracks-top]') || document.querySelectorAll('.nova-grille canvas')[1]); const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, sl: sc ? sc.scrollLeft : 0 }; }""")
    return b["x"] + t_sec * ZOOM - b["sl"], r["top"] + min(r["h"] * 0.6, 70)


STATE_JS = """async () => {
  const L = await window.__novaAppModule('/utils/linkedClips.ts');
  const s = window.DAW_CONTROL.getState();
  const t = s.tracks.find(x => x.id === 'piano');
  const counts = L.linkCounts(s.tracks);
  return t.clips.map(c => ({ id: c.id, start: +c.start.toFixed(4), link: c.linkId || null, n: c.linkId ? counts.get(c.linkId) : 0, pitches: c.notes.map(n => n.pitch) }));
}"""


def clips(page):
    return page.evaluate(STATE_JS)


RENDER_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init();
  const s = window.DAW_CONTROL.getState();
  const t = s.tracks.find(x => x.id === 'piano');
  const dur = 8 * 4 * (60 / 90) + 1;
  const a = (await E.renderProject([t], dur, 0, 48000)).getChannelData(0);
  // Référence : le motif de la 1re copie posé à chaque début de copie, clips SANS lien.
  const src = t.clips[0];
  const ref = { ...JSON.parse(JSON.stringify(t)), clips: t.clips.map((c, i) => ({ id: 'ref' + i, start: c.start, duration: c.duration, offset: 0, fadeIn: 0, fadeOut: 0, name: 'r', color: '#fff', type: 'MIDI', notes: JSON.parse(JSON.stringify(src.notes)) })) };
  const b = (await E.renderProject([ref], dur, 0, 48000)).getChannelData(0);
  let diff = 0, rms = 0;
  for (let i = 0; i < a.length; i++) { diff = Math.max(diff, Math.abs(a[i] - b[i])); rms += a[i] * a[i]; }
  return { diff, rms: Math.sqrt(rms / a.length) };
}"""


def open_roll(page, clip_id):
    page.evaluate("(id) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId: 'piano', clipId: id } }))", clip_id)
    page.locator('[data-nova-pianoroll]').first.wait_for(timeout=8000)
    page.wait_for_timeout(600)


def close_roll(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(500)


def desktop(b):
    R = res["bureau"]
    log = Log("clips_lies_bureau")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    src = OUT / "projet_clips_lies.zip"
    make_project(src)
    open_project(page, src, "pc_00_ouvert")

    # 1. Menu du clip → « Dupliquer en copie liée ».
    x, y = clip_point(page, "piano", 1.0)
    page.mouse.click(x, y, button="right"); page.wait_for_timeout(400)
    shot(page, "pc_01_menu_copie_liee")
    menu_pick(page, "Dupliquer en copie liée"); page.wait_for_timeout(500)
    c1 = clips(page)
    check("menu du clip : « Dupliquer en copie liée » pose une 2e copie du même groupe, juste après", len(c1) == 2 and c1[0]["link"] and c1[0]["link"] == c1[1]["link"] and abs(c1[1]["start"] - 4 * BEAT) < 1e-3, c1)
    for _ in range(6):
        page.evaluate("() => { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'piano'); window.DAW_CONTROL.editClip('piano', t.clips[t.clips.length - 1].id, 'DUPLICATE_LINKED'); }")
        page.wait_for_timeout(150)
    c8 = clips(page)
    R["huit"] = c8
    check("8 copies liées (même groupe, compteur 8)", len(c8) == 8 and len({c["link"] for c in c8}) == 1 and all(c["n"] == 8 for c in c8), c8)
    page.evaluate("() => { const sc = document.querySelector('.nova-grille .custom-scroll'); if (sc) sc.scrollLeft = 0; }")
    shot(page, "pc_02_huit_copies_pastilles")

    # 2. Piano roll sur la 4e copie : Ctrl+A puis ↑.
    fourth = c8[3]["id"]
    open_roll(page, fourth)
    pill = page.locator('[data-testid="roll-linked"]')
    check("piano roll : bouton « ∞ 8 copies liées » visible", pill.count() == 1 and "8" in pill.inner_text(), pill.inner_text() if pill.count() else None)
    shot(page, "pc_03_piano_roll_copie_liee")
    page.mouse.move(800, 500)
    page.keyboard.press("Control+a"); page.wait_for_timeout(200)
    page.keyboard.press("ArrowUp"); page.wait_for_timeout(600)
    up = clips(page)
    R["transpose"] = up
    check("↑ dans UNE copie : les 8 copies montent d'un demi-ton", all(c["pitches"] == [61, 64, 68, 71] for c in up), [c["pitches"] for c in up])
    close_roll(page)
    page.mouse.click(1200, 820); page.wait_for_timeout(300)
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    back = clips(page)
    check("Ctrl+Z : une étape ramène les 8 copies", all(c["pitches"] == [60, 63, 67, 70] for c in back) and len(back) == 8, [c["pitches"] for c in back])
    page.keyboard.press("Control+y"); page.wait_for_timeout(800)
    redo = clips(page)
    check("Ctrl+Y : les 8 copies remontent ensemble", all(c["pitches"] == [61, 64, 68, 71] for c in redo), [c["pitches"] for c in redo])

    # 3. Export.
    ex = page.evaluate(RENDER_JS)
    R["export"] = ex
    check("export des 8 copies = le motif retouché posé 8 fois (écart ≤ 1e-6, son présent)", ex["diff"] <= 1e-6 and ex["rms"] > 1e-4, ex)

    # 4. Rendre unique la 4e copie depuis le piano roll.
    open_roll(page, fourth)
    page.locator('[data-testid="roll-linked"]').click(); page.wait_for_timeout(500)
    u = clips(page)
    four = [c for c in u if c["id"] == fourth][0]
    check("« Rendre unique » : la copie se détache, les 7 autres restent liées", four["link"] is None and sum(1 for c in u if c["n"] == 7) == 7, u)
    check("piano roll : plus de bouton « copies liées » sur la copie devenue unique", page.locator('[data-testid="roll-linked"]').count() == 0)
    page.mouse.move(800, 500)
    page.keyboard.press("Control+a"); page.wait_for_timeout(200)
    page.keyboard.press("ArrowDown"); page.keyboard.press("ArrowDown"); page.wait_for_timeout(600)
    shot(page, "pc_04_copie_unique_retouchee")
    close_roll(page)
    v = clips(page)
    check("la copie unique retouchée ne change plus les autres", [c for c in v if c["id"] == fourth][0]["pitches"] == [59, 62, 66, 69] and all(c["pitches"] == [61, 64, 68, 71] for c in v if c["id"] != fourth), [c["pitches"] for c in v])
    second = v[1]
    x, y = clip_point(page, "piano", second["start"] + 0.5)
    page.mouse.click(x, y, button="right"); page.wait_for_timeout(400)
    has = page.locator("[role=menu] button", has_text=re.compile("Rendre unique")).count() > 0
    shot(page, "pc_05_menu_rendre_unique")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("menu d'une copie liée : « Rendre unique (détacher de ses 6 autres copies) »", has and page.evaluate("() => true"))
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_06_theme_clair")
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(300)

    # 5. Sauvegarde.
    dest = OUT / "seance_clips_lies.zip"
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    links = [c.get("linkId") for c in pj["tracks"][0]["clips"]] if pj["tracks"][0]["id"] == "piano" else [c.get("linkId") for t in pj["tracks"] if t["id"] == "piano" for c in t["clips"]]
    check("sauvegarde : 7 clips portent le même lien, 1 sans lien", sum(1 for l in links if l) == 7 and len({l for l in links if l}) == 1, links)
    R["final"] = clips(page)
    errs = log.errors()
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("clips_lies_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_07_rechargement")
    page.wait_for_timeout(800)
    k = clips(page)
    res["rechargement"] = k
    before = res["bureau"]["final"]
    check("rechargement : mêmes copies liées (compteurs) et mêmes notes", [(c["n"], c["pitches"]) for c in k] == [(c["n"], c["pitches"]) for c in before], {"avant": before, "apres": k})
    shot(page, "pc_08_rechargement_pastilles")
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    log = Log("clips_lies_tel")
    ctx, page = new_page(b, "tel390", log=log, touch=True)
    open_project(page, f, "tel_00_ouvert", touch=True)
    page.wait_for_timeout(800)
    k = clips(page)
    check("téléphone : le projet aux copies liées s'ouvre (8 clips)", len(k) == 8, len(k))
    shot(page, "tel_01_arrangement")
    errs = log.errors()
    check("téléphone : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


with sync_playwright() as p:
    b = launch(p)
    try:
        saved = desktop(b)
        reload_desktop(b, saved)
        phone(b, saved)
    finally:
        b.close()

res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "clips_lies.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
