"""L5 · écart 18 « Éditer par le texte » de bout en bout, navigateurs headless (aucune fenêtre),
Supabase simulé (qa_hors_prod via qalib) : jamais la production, aucun pont ni micro.

Usage (serveur NOVA lancé : npx vite --host 127.0.0.1 --port 3523 --strictPort) :
  NOVA_URL=http://127.0.0.1:3523/ python qa/voix_texte.py [A B C]

  A. bureau 1600 × 900, sombre : prise voix transcrite (mots connus) ; menu du clip → « Éditer par le
     texte… » ; clic sur un mot = plage choisie dans l'arrangement + tête de lecture ; Maj+clic étend ;
     Suppr efface (mode Slip : un blanc reste, la suite ne bouge pas) ; rendu du moteur : le mot effacé
     ne s'entend plus, jonction sans clic (pic < −60 dBFS) ; Ctrl+Z ; « Refermer le blanc » : la suite
     recule ; un silence ramené à 0,12 s ; double-clic : mot corrigé, gardé dans le projet (.zip) ;
     « Découper par phrase » : un clip par phrase, coupes dans les silences ; palette Ctrl+K ; mode
     simple : entrée cachée.
  B. téléphone 390 × 844, sombre : fenêtre en bas d'écran, mot touché, Effacer ; aucun débordement,
     boutons ≥ 40 px.
  C. bureau 1366 × 768, clair : la fenêtre (texte, sélection).
Sortie : D:\\1 WORK\\CONTENU\\nova-pro-2026\\voixrep\\texte (QA_OUT) ; code 0 si tout passe.
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\voixrep\texte")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3523/")
from qalib import *  # noqa
from qalib import OUT, run_one, shot, overflow_report  # noqa
from gel_pre_effet import open_project_file, save_zip  # noqa
from stems_separation import prepare, dismiss_popups  # noqa
from voix_ia_locale import clip_menu, menu_item, header_y  # noqa
from voix_propre import theme  # noqa

SR = 48000
T_CLIP = 2.0
WORDS = [
    (0.30, 0.62, "Je", True), (0.70, 1.05, "j'arrive", False), (1.12, 1.40, "demain", False),
    (2.10, 2.45, "Sur", True), (2.52, 2.90, "la", False), (2.94, 3.40, "prod", False),
    (4.00, 4.35, "Tout", True), (4.42, 4.80, "le", False), (4.86, 5.30, "monde", False),
]
F0 = [150, 170, 190, 210, 230, 160, 180, 200, 220]


def make_project(path: Path):
    n = 6 * SR
    rng = np.random.default_rng(3)
    x = 1e-4 * rng.uniform(-1, 1, n)
    for k, (s, e, _w, _b) in enumerate(WORDS):
        a, b = int(s * SR), int(e * SR)
        t = np.arange(b - a) / SR
        env = np.minimum(1, np.minimum(t / 0.01, (b - a - np.arange(b - a)) / SR / 0.01))
        x[a:b] += 0.3 * env * sum(np.sin(2 * np.pi * h * F0[k] * t) / h for h in range(1, 12))
    q = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(q.tobytes())
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    tr = {"version": 1, "language": "fr", "model": "large-v3-turbo", "bufferId": "@meme-son", "at": 1, "show": True,
          "words": [{"w": w, "s": s, "e": e, **({"b": True} if b else {})} for (s, e, w, b) in WORDS]}
    voix = {**base, "id": "voix", "name": "Voix", "type": "AUDIO", "color": "#f472b6",
            "clips": [{"id": "prise", "name": "Couplet", "type": "AUDIO", "audioRef": "audio/prise.wav", "color": "#f472b6",
                       "fadeIn": 0, "fadeOut": 0, "gain": 1.0, "start": T_CLIP, "offset": 0.0, "duration": 6.0, "transcript": tr}]}
    state = {
        "id": "proj-voix-texte", "name": "Test éditer par le texte (L5)", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [voix], "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/prise.wav", buf.getvalue())


def clips_now(page):
    return page.evaluate("""() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'voix').clips
      .map(c => ({ id: c.id, start: +c.start.toFixed(4), offset: +(c.offset || 0).toFixed(4), duration: +c.duration.toFixed(4), fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 }))
      .sort((a, b) => a.start - b.start)""")


RENDER_JS = """async ([from, to]) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const s = window.DAW_CONTROL.getState();
  const strip = t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] });
  const SR = 48000;
  const b = await audioEngine.renderProject(s.tracks.filter(t => t.id === 'voix').map(strip), to, 0, SR);
  const d = b.getChannelData(0);
  return Array.from(d.subarray(Math.round(from * SR), Math.round(to * SR)));
}"""


def render(page, a, b):
    return np.array(page.evaluate(RENDER_JS, [a, b]), dtype=np.float64)


def tone_db(y, f0, a, b, base):
    """Niveau (dB) de la fondamentale f0 entre a et b (s, temps du morceau ; `y` commence à `base`)."""
    i0, i1 = int((a - base) * SR), int((b - base) * SR)
    seg = y[i0:i1]
    if len(seg) < 64:
        return -200.0
    t = np.arange(i0, i1) / SR
    c, s = np.sum(seg * np.cos(2 * np.pi * f0 * t)), np.sum(seg * np.sin(2 * np.pi * f0 * t))
    return 20 * np.log10(2 * np.hypot(c, s) / len(seg) + 1e-12)


def open_dialog(page):
    clip_menu(page, "Voix", x=530)
    it = menu_item(page, "Éditer par le texte")
    shot(page, "A01_menu_clip")
    it.click()
    page.get_by_test_id("text-edit-dialog").wait_for(timeout=10000)
    page.wait_for_timeout(400)


def word(page, text):
    return page.locator(f"[data-testid=text-edit-dialog] [data-kind=mot]", has_text=re.compile("^" + re.escape(text) + "$")).first


SET_SIMPLE = """async (on) => { const { simpleModeStore } = await window.__novaAppModule('/utils/simpleMode.ts'); simpleModeStore.setPref(on); return simpleModeStore.get().simple; }"""
SEL_JS = """async () => { const { editSelectionStore } = await window.__novaAppModule('/utils/editSelection.ts'); const s = editSelectionStore.get(); return s.time ? { start: +s.time.start.toFixed(3), end: +s.time.end.toFixed(3), tracks: s.time.trackIds } : null; }"""


def scenario_desktop(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "A00_projet")
    dismiss_popups(page, 3000)
    page.evaluate(SET_SIMPLE, False); page.wait_for_timeout(500)
    open_dialog(page)
    res["mots_affiches"] = page.locator("[data-testid=text-edit-dialog] [data-kind=mot]").count()
    res["silences_affiches"] = page.locator("[data-testid=text-edit-dialog] [data-kind=silence], [data-testid=text-edit-dialog] [data-kind=respiration]").count()
    shot(page, "A02_texte")
    # Sélection : un mot, puis Maj+clic.
    word(page, "j'arrive").click(); page.wait_for_timeout(300)
    res["selection_1_mot"] = page.evaluate(SEL_JS)
    res["tete_lecture"] = page.evaluate("() => +window.DAW_CONTROL.getState().currentTime.toFixed(3)")
    word(page, "demain").click(modifiers=["Shift"]); page.wait_for_timeout(300)
    res["selection_2_mots"] = page.evaluate(SEL_JS)
    res["texte_selection"] = page.get_by_test_id("text-edit-selection").inner_text()
    shot(page, "A03_selection")
    before = clips_now(page)
    y0 = render(page, T_CLIP, T_CLIP + 6)
    # Suppr, mode Slip (par défaut) : un blanc reste.
    ripple = page.get_by_test_id("text-edit-ripple")
    if ripple.is_checked():
        ripple.uncheck()
    page.keyboard.press("Delete"); page.wait_for_timeout(700)
    after = clips_now(page)
    res["slip"] = {"avant": before, "apres": after}
    y1 = render(page, T_CLIP, T_CLIP + 6)
    res["slip_mots_effaces_db"] = {w: round(tone_db(y1, F0[k], T_CLIP + WORDS[k][0] + 0.05, T_CLIP + WORDS[k][1] - 0.05, T_CLIP), 1) for k, w in ((1, "j'arrive"), (2, "demain"))}
    res["slip_mot_garde_db"] = round(tone_db(y1, F0[3], T_CLIP + 2.15, T_CLIP + 2.40, T_CLIP) - tone_db(y0, F0[3], T_CLIP + 2.15, T_CLIP + 2.40, T_CLIP), 3)
    cut_at = after[0]["start"] + after[0]["duration"]
    j = int((cut_at - T_CLIP) * SR)
    res["slip_jonction_pic_dbfs"] = round(20 * np.log10(np.max(np.abs(y1[j - 240:j + 240])) + 1e-12), 1)
    shot(page, "A04_mot_efface_slip")
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    res["ctrl_z"] = clips_now(page) == before
    # Refermer le blanc : la suite recule.
    page.get_by_test_id("text-edit-dialog").wait_for(timeout=5000)
    page.wait_for_timeout(300)
    page.get_by_test_id("text-edit-ripple").check()
    word(page, "j'arrive").click(); page.wait_for_timeout(200)
    page.get_by_test_id("text-edit-delete").click(); page.wait_for_timeout(700)
    rip = clips_now(page)
    res["ripple"] = rip
    y2 = render(page, T_CLIP, T_CLIP + 6)
    cut2 = rip[0]["start"] + rip[0]["duration"]
    j2 = int((cut2 - T_CLIP) * SR)
    res["ripple_jonction_pic_dbfs"] = round(20 * np.log10(np.max(np.abs(y2[j2 - 240:j2 + 240])) + 1e-12), 1)
    # « demain » joue maintenant ~0,42 s plus tôt.
    res["ripple_demain_db"] = round(tone_db(y2, F0[2], T_CLIP + 1.12 - 0.425 + 0.03, T_CLIP + 1.40 - 0.425 - 0.03, T_CLIP), 1)
    shot(page, "A05_mot_efface_ripple")
    # Un silence ramené à 0,12 s.
    page.locator("[data-testid=text-edit-dialog] [data-kind=silence], [data-testid=text-edit-dialog] [data-kind=respiration]").nth(1).click()
    page.wait_for_timeout(200)
    res["silence_selection"] = page.get_by_test_id("text-edit-selection").inner_text()
    page.keyboard.press("Delete"); page.wait_for_timeout(700)
    res["apres_silence"] = clips_now(page)
    # Correction d'un mot (double-clic).
    word(page, "prod").dblclick()
    inp = page.get_by_test_id("text-edit-rename")
    inp.fill("prode"); inp.press("Enter"); page.wait_for_timeout(500)
    res["mot_corrige_affiche"] = word(page, "prode").count() == 1
    shot(page, "A06_mot_corrige")
    # Découper par phrase.
    n_before = len(clips_now(page))
    page.get_by_test_id("text-edit-split-phrase").click(); page.wait_for_timeout(700)
    res["decoupe_phrase"] = {"avant": n_before, "apres": len(clips_now(page))}
    shot(page, "A07_decoupe_phrase")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    d, _ = save_zip(page, OUT / "A_apres.zip")
    cl = d["tracks"][0]["clips"]
    res["zip"] = {"clips": len(cl), "prode": any(w["w"] == "prode" for c in cl for w in (c.get("transcript") or {}).get("words", [])),
                  "prod": any(w["w"] == "prod" for c in cl for w in (c.get("transcript") or {}).get("words", [])),
                  "fondus": sorted({round(c.get("fadeIn", 0), 3) for c in cl} | {round(c.get("fadeOut", 0), 3) for c in cl})}
    # Palette
    page.mouse.click(700, header_y(page, "Voix") + 20)
    page.keyboard.press("Control+k")
    page.get_by_test_id("command-palette").wait_for(timeout=5000)
    page.get_by_test_id("palette-input").type("éditer par le texte", delay=20)
    page.wait_for_timeout(500)
    res["palette"] = [o.inner_text().replace("\n", " · ")[:120] for o in page.locator("[data-testid=command-palette] [role=option]").all()[:3]]
    shot(page, "A08_palette")
    page.keyboard.press("Escape")
    # Mode simple : pas d'entrée.
    page.evaluate(SET_SIMPLE, True); page.wait_for_timeout(600)
    clip_menu(page, "Voix", x=530)
    menu = page.evaluate("""() => [...document.querySelectorAll('[role=menu] button, [role=menu] [data-submenu]')].map(b => (b.innerText || '') + ' ' + (b.dataset.submenu || '')).join(' ')""")
    res["mode_simple_cache"] = "Éditer par le texte" not in menu
    page.keyboard.press("Escape")
    page.evaluate(SET_SIMPLE, False)


def small_targets(page, testid):
    return page.evaluate("""(id) => [...document.querySelectorAll(`[data-testid=${id}] button, [data-testid=${id}] input[type=checkbox]`)]
      .filter(e => e.getClientRects().length && e.type !== 'checkbox').map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; })
      .filter(x => x.t && x.h < 40)""", testid)


def open_by_event(page):
    page.evaluate("""() => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: { name: 'voice-text-edit', targets: [{ trackId: 'voix', clipId: 'prise' }] } }))""")
    page.get_by_test_id("text-edit-dialog").wait_for(timeout=10000)
    page.wait_for_timeout(400)


def scenario_phone(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "B00_projet")
    dismiss_popups(page, 3000)
    open_by_event(page)
    shot(page, "B01_texte")
    w = word(page, "la")
    w.tap(); page.wait_for_timeout(300)
    res["selection"] = page.get_by_test_id("text-edit-selection").inner_text()
    shot(page, "B02_selection")
    page.get_by_test_id("text-edit-delete").tap(); page.wait_for_timeout(700)
    res["mots_restants"] = page.locator("[data-testid=text-edit-dialog] [data-kind=mot]").count()
    shot(page, "B03_efface")
    res["debordement"] = [o for o in overflow_report(page) if o.get("kind") == "page-hscroll"]
    res["petits"] = small_targets(page, "text-edit-dialog")


def scenario_light(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "C00_projet")
    dismiss_popups(page, 3000)
    open_by_event(page)
    word(page, "Sur").click(); word(page, "prod").click(modifiers=["Shift"]); page.wait_for_timeout(300)
    shot(page, "C01_selection_clair")
    res["theme"] = page.evaluate("document.documentElement.getAttribute('data-theme')")
    res["debordement"] = [o for o in overflow_report(page) if o.get("kind") == "page-hscroll"]


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    PROJECT = OUT / "projet_voix_texte.zip"
    make_project(PROJECT)
    only = set(a.upper() for a in sys.argv[1:])
    report = {"url": os.environ["NOVA_URL"]}

    def want(k):
        return not only or k in only
    if want("A"):
        theme("dark"); report["A_bureau_sombre"] = run_one(scenario_desktop, "pc", "A_bureau_sombre")
    if want("B"):
        theme("dark"); report["B_telephone"] = run_one(scenario_phone, "tel390", "B_telephone")
    if want("C"):
        theme("light"); report["C_bureau_clair"] = run_one(scenario_light, "pc1366", "C_bureau_clair")

    checks = {}
    A, B, C = (report.get(k) or {} for k in ("A_bureau_sombre", "B_telephone", "C_bureau_clair"))
    if A:
        checks["A · menu du clip → texte de la prise (9 mots, silences visibles)"] = A.get("ok") and A.get("mots_affiches") == 9 and A.get("silences_affiches", 0) >= 2
        s1, s2 = A.get("selection_1_mot") or {}, A.get("selection_2_mots") or {}
        checks["A · clic sur un mot = plage dans l'arrangement + tête de lecture ; Maj+clic étend"] = abs(s1.get("start", 0) - (T_CLIP + 0.70)) < 0.002 and abs(s1.get("end", 0) - (T_CLIP + 1.05)) < 0.002 \
            and abs((A.get("tete_lecture") or 0) - (T_CLIP + 0.70)) < 0.01 and abs(s2.get("end", 0) - (T_CLIP + 1.40)) < 0.002 and s2.get("tracks") == ["voix"]
        me = A.get("slip_mots_effaces_db") or {}
        sl = A.get("slip") or {}
        checks["A · Suppr (Slip) : mots effacés (≤ −70 dB), la suite ne bouge pas, mot suivant intact"] = bool(me) and max(me.values()) <= -70 \
            and len(sl.get("apres", [])) == 2 and abs(sl["apres"][1]["start"] - (T_CLIP + sl["apres"][1]["offset"])) < 1e-3 and abs(A.get("slip_mot_garde_db", 9)) < 0.05
        checks["A · jonctions sans clic : pic < −60 dBFS (Slip et Shuffle)"] = A.get("slip_jonction_pic_dbfs", 0) < -60 and A.get("ripple_jonction_pic_dbfs", 0) < -60
        checks["A · Ctrl+Z rend la prise entière"] = bool(A.get("ctrl_z"))
        rp = A.get("ripple") or []
        checks["A · « Refermer le blanc » : la suite recule, « demain » s'entend à sa nouvelle place"] = len(rp) == 2 and rp[1]["start"] < T_CLIP + rp[1]["offset"] - 0.3 and A.get("ripple_demain_db", -200) > -20
        checks["A · mot corrigé (double-clic) gardé dans le projet (.zip)"] = bool(A.get("mot_corrige_affiche")) and (A.get("zip") or {}).get("prode") and not (A.get("zip") or {}).get("prod")
        dp = A.get("decoupe_phrase") or {}
        checks["A · « Découper par phrase » : un clip par phrase, fondus de 10 ms"] = dp.get("apres", 0) > dp.get("avant", 99) and 0.01 in ((A.get("zip") or {}).get("fondus") or [])
        checks["A · palette Ctrl+K « éditer par le texte »"] = any("Éditer la voix par le texte" in x for x in A.get("palette") or [])
        checks["A · mode simple : entrée cachée"] = bool(A.get("mode_simple_cache"))
    if B:
        checks["B · téléphone : mot touché, effacé, sans débordement, boutons ≥ 40 px"] = B.get("ok") and B.get("mots_restants") == 8 and not B.get("debordement") and not B.get("petits")
    if C:
        checks["C · bureau clair : sélection, sans débordement"] = C.get("ok") and C.get("theme") == "light" and not C.get("debordement")
    for k, R in (("A", A), ("B", B), ("C", C)):
        if R:
            checks[f"{k} · aucune erreur dans la console"] = not R.get("errors")
    report["verifications"] = checks
    report["ok"] = bool(checks) and all(bool(v) for v in checks.values())
    (OUT / f"qa_voix_texte{'_' + ''.join(sorted(only)) if only else ''}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for k, v in checks.items():
        print(("OK   " if v else "ÉCHEC"), k)
    for k in ("A_bureau_sombre", "B_telephone", "C_bureau_clair"):
        if report.get(k) and (report[k].get("notes") or report[k].get("errors")):
            print(k, report[k].get("notes"), report[k].get("errors")[:5])
    print("OK" if report["ok"] else "ÉCHEC")
    sys.exit(0 if report["ok"] else 1)
