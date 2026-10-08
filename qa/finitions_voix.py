"""Preuves « finitions voix » (respirations : téléphone, piste gelée, Mix auto), navigateur headless.

  mobile  : arrangement du téléphone, repère violet des respirations traitées (et creux
            dans la forme d'onde), capture.
  gel     : piste LEAD gelée (sans VST) → « Traiter les respirations » → regel automatique :
            le nouveau rendu contient le traitement (niveau mesuré dans les zones, mots
            identiques), Annuler revient à l'ancien rendu.
  gel_vst : piste gelée avec un VST du PC, sans le pont, dont le rendu contient déjà des
            respirations → nouveau dosage : notification « dégèle-la » + bouton Dégeler.
  mixauto : première prise du lead au micro (la vraie voix), mode auto des respirations
            DÉSACTIVÉ : le Mix auto mis tout seul traite aussi les respirations (case
            cochée par défaut).

Usage : serveur `npx vite --port 3435 --strictPort`, puis
  python qa/finitions_voix.py [mobile] [gel] [gel_vst] [mixauto]
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions\\
"""
import json, os, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3435/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import OUT, Log, launch, new_page, shot, save_log  # noqa
import respirations_preuve as R  # noqa
from playwright.sync_api import sync_playwright

VOIX, DUR = R.VOIX, R.DUR
EDITS_RENDU = [{"start": 1.0, "end": 1.3, "gainDb": -15, "fade": 0.01}]


def projet(path: Path, tracks, **extra):
    st0 = {"id": f"proj-{path.stem}", "name": path.stem, "bpm": 140, "timeSignature": {"numerator": 4, "denominator": 4},
           "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
           "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "track-rec-main", "currentView": "ARRANGEMENT",
           "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
           "recStartTime": None, "isDelayCompEnabled": True,
           "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
           "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}, **extra}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(st0))
        z.write(VOIX, "audio/voix.wav")


TREAT = """async () => { const B = await import('/utils/breathBus.ts'); B.requestBreaths({ mode: 'apply', reason: 'menu' }); }"""


def scenario_mobile(page, res):
    f = OUT / "projet_mobile.zip"
    projet(f, [R.track("track-rec-main", "LEAD", [R.clip("lead-1", "Prise 1", 0, DUR, "audio/voix.wav")])])
    R.open_project(page, f)
    R.close_overlays(page)
    page.evaluate(TREAT)
    page.get_by_test_id("breath-undo").wait_for(timeout=90000)
    res["notification"] = page.get_by_test_id("breath-toast").inner_text()
    page.get_by_role("button", name="Fermer").locator("visible=true").last.click()
    page.wait_for_timeout(400)
    res["respirations"] = R.st(page, "s => (s.tracks[0].clips[0].breaths || []).length")
    # Onglet « Morceau » (arrangement du téléphone).
    try:
        page.get_by_role("navigation", name="Onglets du studio").get_by_text("Morceau").click(); page.wait_for_timeout(800)
    except Exception:
        pass
    marks = page.get_by_test_id("mobile-breath-mark")
    res["reperes_visibles"] = marks.count()
    if marks.count():
        b = marks.first.bounding_box()
        res["premier_repere"] = {k: round(v, 1) for k, v in (b or {}).items()}
    # Défile jusqu'au premier repère pour le voir à l'écran.
    if marks.count():
        marks.first.evaluate("el => el.scrollIntoView({ inline: 'center', block: 'center' })"); page.wait_for_timeout(600)
        b = marks.first.bounding_box()
        res["premier_repere_a_l_ecran"] = {k: round(v, 1) for k, v in (b or {}).items()}
    shot(page, "mobile_01_arrangement_reperes_respirations")
    res["ok"] = res["respirations"] > 0 and res["reperes_visibles"] > 0


def freeze_via_menu(page, name="LEAD"):
    page.get_by_text(name, exact=True).locator("visible=true").first.click(button="right")
    page.wait_for_timeout(300)
    page.get_by_text("Geler la piste (freeze)").locator("visible=true").first.click()
    page.wait_for_function("() => { const t = window.__novaEdit.getState().tracks[0]; return t.isFrozen && !!t.frozenClip; }", timeout=60000)
    page.wait_for_timeout(500)


ZONE_JS = r"""
async ([bufId, zones]) => {
  const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
  const b = audioBufferRegistry.get(bufId);
  if (!b) return null;
  const x = b.getChannelData(0), sr = b.sampleRate;
  const rms = (a, z) => { let q = 0, n = 0; for (let i = Math.max(0, a); i < Math.min(x.length, z); i++) { q += x[i] * x[i]; n++; } return n ? Math.sqrt(q / n) : 0; };
  return zones.map(([s, e]) => rms(Math.round(s * sr), Math.round(e * sr)));
}
"""


def scenario_gel(page, res):
    f = OUT / "projet_gel.zip"
    projet(f, [R.track("track-rec-main", "LEAD", [R.clip("lead-1", "Prise 1", 0, DUR, "audio/voix.wav")])])
    R.open_project(page, f)
    R.close_overlays(page)
    freeze_via_menu(page)
    t0 = R.st(page, "s => ({ id: s.tracks[0].frozenClip.id, buf: s.tracks[0].frozenClip.bufferId, sig: !!s.tracks[0].frozenPluginSig })")
    res["rendu_avant"] = t0
    shot(page, "gel_01_piste_gelee")
    page.evaluate(TREAT)
    page.wait_for_function("() => /regelée|dégèle/.test(document.querySelector('[data-testid=breath-toast]')?.innerText || '')", timeout=120000)
    res["notification"] = page.get_by_test_id("breath-toast").inner_text()
    shot(page, "gel_02_regel_automatique")
    s1 = R.st(page, """s => { const t = s.tracks[0], c = t.clips[0];
        return { gelee: t.isFrozen, rendu: t.frozenClip.id, buf: t.frozenClip.bufferId, respirations: (c.breaths || []).length,
                 dans_le_rendu: (c.freezeRef && c.freezeRef.breaths || []).length, ancre_sur_le_rendu: !!c.freezeRef && c.freezeRef.renderId === t.frozenClip.id,
                 zones: (c.breaths || []).map(e => [e.start + (e.fade || 0.01), e.end - (e.fade || 0.01)]) }; }""")
    zones = s1.pop("zones")
    res["apres"] = s1
    # Rendu avant / après dans les zones (au creux) : −15 dB attendu ; et hors zones identique.
    a = page.evaluate(ZONE_JS, [t0["buf"], zones])
    b = page.evaluate(ZONE_JS, [s1["buf"], zones])
    import math
    ecarts = [round(20 * math.log10(max(y, 1e-12) / max(x, 1e-12)), 2) for x, y in zip(a or [], b or []) if x > 1e-6]
    res["ecart_rendu_db_min_max"] = [min(ecarts), max(ecarts)] if ecarts else None
    res["ecart_rendu_db_moyen"] = round(sum(ecarts) / len(ecarts), 2) if ecarts else None
    # Mots : une zone de 2 s sans respiration (entre deux zones) identique entre les deux rendus.
    words = []
    prev = 0.0
    for z0, z1 in zones:
        if z0 - prev > 0.6: words.append([prev + 0.15, z0 - 0.15])
        prev = z1
    wa = page.evaluate(ZONE_JS, [t0["buf"], words[:8]]) or []
    wb = page.evaluate(ZONE_JS, [s1["buf"], words[:8]]) or []
    res["mots_ecart_db_max"] = round(max(abs(20 * math.log10(max(y, 1e-12) / max(x, 1e-12))) for x, y in zip(wa, wb) if x > 1e-6), 4) if wa else None
    # Lecture : les tranches ne rejouent pas le traitement une 2e fois.
    res["tranches_avec_respirations"] = page.evaluate("""async () => { const F = await import('/utils/freeze.ts');
        const t = window.__novaEdit.getState().tracks[0]; return F.frozenPlayback(t).render.filter(c => (c.breaths || []).length).length; }""")
    page.get_by_test_id("breath-undo").click(); page.wait_for_timeout(800)
    res["apres_annuler"] = R.st(page, "s => ({ gelee: s.tracks[0].isFrozen, rendu: s.tracks[0].frozenClip && s.tracks[0].frozenClip.id, respirations: (s.tracks[0].clips[0].breaths || []).length })")
    res["ok"] = (s1["gelee"] and s1["rendu"] != t0["id"] and s1["respirations"] > 0 and s1["dans_le_rendu"] == s1["respirations"]
                 and s1["ancre_sur_le_rendu"] and res["ecart_rendu_db_moyen"] is not None and -17 < res["ecart_rendu_db_moyen"] < -13
                 and (res["mots_ecart_db_max"] or 0) < 0.01 and res["tranches_avec_respirations"] == 0
                 and res["apres_annuler"]["rendu"] == t0["id"] and res["apres_annuler"]["respirations"] == 0)


def scenario_gel_vst(page, res):
    f = OUT / "projet_gel_vst.zip"
    vst = {"id": "vst-1", "name": "Pro-Q 3", "type": "VST3", "isEnabled": True, "params": {"path": "C:/VST3/FabFilter Pro-Q 3.vst3"}, "latency": 0}
    fz = {"id": "frozen-lead", "name": "LEAD (rendu)", "start": 0, "duration": DUR, "offset": 0, "fadeIn": 0, "fadeOut": 0,
          "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "isMuted": False}
    ref = {"renderId": "frozen-lead", "anchor": 0, "from": 0, "to": DUR, "fadeIn": 0.01, "fadeOut": 0.01, "gain": 1, "srcClipId": "lead-1", "breaths": EDITS_RENDU}
    c = R.clip("lead-1", "Prise 1", 0, DUR, "audio/voix.wav", breaths=EDITS_RENDU, freezeRef=ref)
    projet(f, [R.track("track-rec-main", "LEAD", [c], plugins=[vst], isFrozen=True, frozenClip=fz, frozenUpToPluginIndex=0, frozenPluginSig="sig-vst")])
    R.open_project(page, f)
    R.close_overlays(page)
    res["chargee_gelee"] = R.st(page, "s => !!s.tracks[0].isFrozen && !!s.tracks[0].frozenClip")
    page.evaluate(TREAT)
    page.wait_for_function("() => /dégèle/.test(document.querySelector('[data-testid=breath-toast]')?.innerText || '')", timeout=120000)
    res["notification"] = page.get_by_test_id("breath-toast").inner_text()
    res["bouton"] = page.get_by_test_id("breath-toast-action").inner_text()
    shot(page, "gel_vst_01_degele_la")
    page.get_by_test_id("breath-toast-action").click(); page.wait_for_timeout(700)
    shot(page, "gel_vst_02_clic_degeler_sans_pont")
    res["toujours_gelee_sans_pont"] = R.st(page, "s => !!s.tracks[0].isFrozen")
    res["ok"] = res["chargee_gelee"] and "dégèle-la" in res["notification"] and res["bouton"] == "Dégeler" and res["toujours_gelee_sans_pont"]


def scenario_mixauto(page, res, case=True):
    f = OUT / "projet_mixauto.zip"
    # Une ancienne prise plus loin (30 s) : seule la NOUVELLE prise doit être traitée.
    projet(f, [R.track("track-rec-main", "LEAD", [R.clip("old-1", "Ancienne prise", 30, 10, "audio/voix.wav", takeNumber=1)])], breathAuto=False)
    R.open_project(page, f)
    R.close_overlays(page)
    if not case:
        # Case « Traiter les respirations » du Mix auto décochée : rien ne doit être traité.
        # Décochée à la main dans le panneau Mix auto (comme l'utilisateur).
        page.locator("[data-nova-target=mix-auto]").locator("visible=true").first.click(); page.wait_for_timeout(600)
        box = page.get_by_test_id("breath-with-mix")
        box.scroll_into_view_if_needed(); box.uncheck(); page.wait_for_timeout(200)
        res["case_decochee"] = not box.is_checked()
        R.close_overlays(page)
    res["avant"] = R.st(page, "s => ({ style: s.vocalMixStyle || null, auto: s.breathAuto })")
    res["case_mix_auto"] = page.evaluate("() => { try { return JSON.parse(localStorage.getItem('nova_breaths') || '{}').withMix; } catch (e) { return 'err'; } }")
    page.mouse.click(800, 700); page.wait_for_timeout(200)
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 15 and not R.st(page, "s => s.isRecording"):
        page.wait_for_timeout(50)
    res["enregistre"] = R.st(page, "s => s.isRecording")
    page.wait_for_timeout(14000)
    page.keyboard.press("r")
    page.wait_for_function("() => !!window.__novaEdit.getState().vocalMixStyle", timeout=30000)
    if not case:
        page.wait_for_timeout(6000)
        res["apres_prise"] = R.st(page, "s => ({ style: s.vocalMixStyle, clips: s.tracks[0].clips.map(c => [c.name, +c.duration.toFixed(2), (c.breaths || []).length]) })")
        res["toast"] = page.evaluate("() => document.querySelector('[data-testid=breath-toast]')?.innerText || null")
        shot(page, "mixauto_02_case_decochee_rien")
        res["ok"] = bool(res["apres_prise"]["style"]) and all(c[2] == 0 for c in res["apres_prise"]["clips"]) and res["toast"] is None
        return
    page.get_by_test_id("breath-undo").wait_for(timeout=90000)
    res["notification"] = page.get_by_test_id("breath-toast").inner_text()
    shot(page, "mixauto_01_premiere_prise_style_et_respirations")
    clips = "s => ({ style: s.vocalMixStyle, clips: s.tracks[0].clips.map(c => [c.name, +c.duration.toFixed(2), (c.breaths || []).length]) })"
    res["apres_prise"] = R.st(page, clips)
    # Annuler (notification) : retire les respirations, garde la prise et le style.
    page.get_by_test_id("breath-undo").click(); page.wait_for_timeout(700)
    res["apres_annuler"] = R.st(page, clips)
    res["ok"] = (bool(res["apres_prise"]["style"]) and any(c[2] > 0 for c in res["apres_prise"]["clips"] if c[0] != "Ancienne prise")
                 and all(c[2] == 0 for c in res["apres_prise"]["clips"] if c[0] == "Ancienne prise")
                 and res["apres_annuler"]["style"] == res["apres_prise"]["style"]
                 and all(c[2] == 0 for c in res["apres_annuler"]["clips"]) and len(res["apres_annuler"]["clips"]) == len(res["apres_prise"]["clips"]))


def run(name, fn, vp="pc"):
    log = Log(name)
    res = {"name": name, "vp": vp}
    with sync_playwright() as p:
        b = R.launch_voice_mic(p) if name.startswith("mixauto") else launch(p)
        ctx, page = new_page(b, vp, log)
        page.set_default_timeout(30000)
        try:
            fn(page, res)
        except Exception as e:  # noqa
            res["EXCEPTION"] = f"{type(e).__name__}: {str(e)[:500]}"
            try: shot(page, f"{name}__ECHEC")
            except Exception: pass
        finally:
            res["erreurs_page"] = [e["text"][:240] for e in log.errors()][:15]
            save_log(log, {"result": res})
            ctx.close(); b.close()
    return res


if __name__ == "__main__":
    which = sys.argv[1:] or ["mobile", "gel", "gel_vst", "mixauto", "mixauto_off"]
    table = {"mobile": (scenario_mobile, "tel"), "gel": (scenario_gel, "pc"), "gel_vst": (scenario_gel_vst, "pc"), "mixauto": (scenario_mixauto, "pc"),
             "mixauto_off": (lambda page, res: scenario_mixauto(page, res, case=False), "pc")}
    allres = {w: run(w, *table[w]) for w in which}
    (OUT / f"finitions_voix_{'_'.join(which)}.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1)[:9000])
