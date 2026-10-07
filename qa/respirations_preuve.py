"""Preuves « Respirations » sur une VRAIE voix (stem « Silence blanc »), navigateur headless.

  mesure  : projet LEAD + BACK 1 (même voix réelle), « Traiter les respirations de
            toutes les voix » en un clic, puis export (renderProject) avant / après :
            niveau de chaque respiration (−15 dB sur la lead, silence sur le back),
            mots intacts (niveau identique, différence échantillon par échantillon),
            pas de clic aux raccords (pas de gain par échantillon, discontinuité),
            une seule étape d'annulation, réappliquer sans cumuler. WAV avant / après.
  captures: fenêtre avec aperçu (PC), tablette (doigt), téléphone (version simple),
            panneau voix (bouton unique + mode auto + case du Mix auto), arrangement.

Usage : serveur `npx vite --port 3430 --strictPort` dans le worktree, puis
  python qa/respirations_preuve.py [mesure] [captures]
Sorties : D:\\1 WORK\\CONTENU\\nova-respirations\\
"""
import base64, json, math, os, re, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3430/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-respirations")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, OUT, Log, launch, new_page, shot, save_log  # noqa
from playwright.sync_api import sync_playwright

VOIX = Path(os.environ.get("VOIX_WAV", r"D:\1 WORK\CONTENU\nova-v18-stems\sorties-pont\Test stems\Silence blanc (extrait) 2026-10-07 22-59-22\Voix.wav"))
DUR = 45.0


def track(tid, name, clips, **extra):
    return {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
            "isTrackArmed": False, "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": "master",
            "sends": [], "clips": clips, "plugins": [], "automationLanes": [], "totalLatency": 0, **extra}


def clip(cid, name, start, dur, ref, **extra):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": 0, "fadeIn": 0.01, "fadeOut": 0.01,
            "color": "#a78bfa", "type": "AUDIO", "audioRef": ref, "gain": 1, **extra}


def make_project(path: Path):
    tracks = [track("track-rec-main", "LEAD", [clip("lead-1", "Prise 1", 0, DUR, "audio/voix.wav", takeNumber=1)]),
              track("back-1", "BACK 1", [clip("back-c1", "Back", 0, DUR, "audio/voix.wav")], color="#f472b6")]
    state = {
        "id": "proj-respirations", "name": "Respirations (Silence blanc)", "bpm": 140, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "track-rec-main", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.write(VOIX, "audio/voix.wav")


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.removeItem('nova_breaths'); } catch (e) {}
"""


def open_project(page, f: Path, label=None):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=40000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(6000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
    adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
    try:
        if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
    except Exception:
        pass
    if label: shot(page, label)


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def close_overlays(page):
    for _ in range(3):
        page.keyboard.press("Escape"); page.wait_for_timeout(150)


def open_breaths(page, detail="{ mode: 'dialog', reason: 'menu' }"):
    page.evaluate(f"async () => {{ const B = await import('/utils/breathBus.ts'); B.requestBreaths({detail}); }}")
    page.get_by_test_id("breath-dialog").wait_for(timeout=10000)
    page.wait_for_function("() => !document.querySelector('[data-testid=breath-summary] .fa-spin')", timeout=60000)
    page.wait_for_timeout(400)


# Mesures à l'export : chaque piste seule, sans effets ni envois, avant (sans Clip.breaths) / après.
MEASURE_JS = r"""
async ([dur]) => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const s = window.__novaEdit.getState();
  const SR = 48000;
  const raw = t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] });
  const strip = t => ({ ...t, clips: t.clips.map(c => { const x = { ...c }; delete x.breaths; return x; }) });
  const db = r => 20 * Math.log10(Math.max(r, 1e-12));
  const rms = (x, a, b) => { let q = 0, n = 0; for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) { q += x[i] * x[i]; n++; } return n ? Math.sqrt(q / n) : 0; };
  const wav = (x) => {
    const n = x.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    let bin = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const out = {};
  for (const tid of ['track-rec-main', 'back-1']) {
    const t = s.tracks.find(x => x.id === tid);
    const before = (await audioEngine.renderProject([raw(strip(t))], dur, 0, SR)).getChannelData(0);
    const after = (await audioEngine.renderProject([raw(t)], dur, 0, SR)).getChannelData(0);
    const c = t.clips[0];
    const edits = (c.breaths || []).slice().sort((a, b) => a.start - b.start);
    const toT = src => c.start + (src - (c.offset || 0));
    // Respirations : niveau au creux (zone moins les fondus), avant / après.
    const per = edits.map(e => {
      const f = e.fade ?? 0.01;
      const a = Math.round((toT(e.start) + f) * SR), b = Math.round((toT(e.end) - f) * SR);
      const r0 = rms(before, a, b), r1 = rms(after, a, b);
      return { debut: +toT(e.start).toFixed(3), fin: +toT(e.end).toFixed(3), duree_ms: Math.round((e.end - e.start) * 1000),
               avant_db: +db(r0).toFixed(1), apres_db: r1 < 1e-9 ? 'silence' : +db(r1).toFixed(1), ecart_db: r1 < 1e-9 ? null : +(db(r1) - db(r0)).toFixed(2), gain_vise_db: e.gainDb };
    });
    // Mots : tout ce qui est hors des zones traitées doit être identique.
    const inZone = new Uint8Array(before.length);
    for (const e of edits) for (let i = Math.round(toT(e.start) * SR) - 1; i <= Math.round(toT(e.end) * SR) + 1; i++) if (i >= 0 && i < inZone.length) inZone[i] = 1;
    let maxDiff = 0, q0 = 0, q1 = 0, nOut = 0;
    for (let i = 0; i < before.length; i++) if (!inZone[i]) { const d = Math.abs(after[i] - before[i]); if (d > maxDiff) maxDiff = d; q0 += before[i] * before[i]; q1 += after[i] * after[i]; nOut++; }
    // Trames « mot » (20 ms à moins de 12 dB de la crête locale ±1 s) : touchées par une zone ?
    const W = Math.round(0.02 * SR), fr = [];
    for (let i = 0; i + W <= before.length; i += W) fr.push(db(rms(before, i, i + W)));
    let wordFramesTouched = 0, wordFrames = 0;
    for (let k = 0; k < fr.length; k++) {
      let loc = -200; for (let j = Math.max(0, k - 50); j <= Math.min(fr.length - 1, k + 50); j++) loc = Math.max(loc, fr[j]);
      if (fr[k] < loc - 12 || fr[k] < -50) continue;
      wordFrames++;
      let touched = false; for (let i = k * W; i < (k + 1) * W; i++) if (inZone[i]) { touched = true; break; }
      if (touched) wordFramesTouched++;
    }
    // Clics : pas de gain d'un échantillon à l'autre (rapport après / avant là où le signal est net),
    // et discontinuité : plus grand saut |x[i]−x[i−1]| autour de chaque raccord, après vs avant.
    let maxGainStep = 0, maxJumpAfter = 0, maxJumpBefore = 0, worstJumpRatio = 0;
    for (const e of edits) {
      for (const edge of [toT(e.start), toT(e.end)]) {
        const a = Math.round((edge - 0.02) * SR), b = Math.round((edge + 0.02) * SR);
        let prevG = null, jA = 0, jB = 0;
        for (let i = Math.max(1, a); i < Math.min(before.length, b); i++) {
          jA = Math.max(jA, Math.abs(after[i] - after[i - 1])); jB = Math.max(jB, Math.abs(before[i] - before[i - 1]));
          if (Math.abs(before[i]) > 0.01) { const g = after[i] / before[i]; if (prevG !== null) maxGainStep = Math.max(maxGainStep, Math.abs(g - prevG)); prevG = g; } else prevG = null;
        }
        maxJumpAfter = Math.max(maxJumpAfter, jA); maxJumpBefore = Math.max(maxJumpBefore, jB);
        if (jB > 0) worstJumpRatio = Math.max(worstJumpRatio, jA / jB);
      }
    }
    out[tid] = {
      piste: t.name, respirations: edits.length, detail: per,
      mots: { ecart_max_echantillon: +maxDiff.toExponential(2), niveau_avant_db: +db(Math.sqrt(q0 / nOut)).toFixed(3), niveau_apres_db: +db(Math.sqrt(q1 / nOut)).toFixed(3),
              trames_mot: wordFrames, trames_mot_touchees: wordFramesTouched },
      raccords: { pas_de_gain_max_par_echantillon: +maxGainStep.toFixed(4), saut_max_apres: +maxJumpAfter.toFixed(4), saut_max_avant: +maxJumpBefore.toFixed(4), pire_rapport_sauts: +worstJumpRatio.toFixed(3) },
      wav_avant: wav(before), wav_apres: wav(after),
    };
  }
  return out;
}
"""


def scenario_mesure(page, res):
    f = OUT / "projet_respirations.zip"
    make_project(f)
    open_project(page, f, "01_projet_ouvert_pc")
    res["pistes"] = st(page, "s => s.tracks.map(t => [t.id, t.name, t.clips.length])")
    hist0 = page.evaluate("() => 0")
    # Un seul clic pour toute la session : bouton du panneau voix.
    page.locator("[data-nova-target=mix-auto]").first.click(); page.wait_for_timeout(600)
    shot(page, "02_panneau_voix_pc")
    page.get_by_test_id("breath-all").click()
    page.get_by_test_id("breath-undo").wait_for(timeout=90000)
    res["recapitulatif"] = page.get_by_test_id("breath-toast").inner_text()
    shot(page, "03_recapitulatif_un_clic_pc")
    close_overlays(page)
    res["apres_un_clic"] = st(page, "s => s.tracks.map(t => [t.name, t.clips.map(c => (c.breaths || []).length)])")
    # Une seule étape d'annulation : Annuler (Ctrl+Z) retire tout.
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    res["apres_annuler"] = st(page, "s => s.tracks.map(t => [t.name, t.clips.map(c => (c.breaths || []).length)])")
    page.keyboard.press("Control+y"); page.wait_for_timeout(500)
    res["apres_retablir"] = st(page, "s => s.tracks.map(t => [t.name, t.clips.map(c => (c.breaths || []).length)])")
    # Réappliquer avec un autre dosage (−20 dB) ne cumule pas.
    page.evaluate("async () => { const B = await import('/components/BreathTools.tsx'); B.setBreathPrefs({ settings: { leadDb: 20 } }); (await import('/utils/breathBus.ts')).requestBreaths({ mode: 'apply', reason: 'panel' }); }")
    page.wait_for_timeout(3000)
    res["lead_gains_apres_reapplication"] = st(page, "s => [...new Set(s.tracks[0].clips[0].breaths.map(e => e.gainDb))]")
    page.evaluate("async () => { const B = await import('/components/BreathTools.tsx'); B.setBreathPrefs({ settings: { leadDb: 15 } }); (await import('/utils/breathBus.ts')).requestBreaths({ mode: 'apply', reason: 'panel' }); }")
    page.wait_for_timeout(3000)
    res["lead_gains_final"] = st(page, "s => [...new Set(s.tracks[0].clips[0].breaths.map(e => e.gainDb))]")
    shot(page, "04_arrangement_respirations_traitees_pc")
    t0 = time.time()
    m = page.evaluate(MEASURE_JS, [DUR])
    res["export_s"] = round(time.time() - t0, 1)
    for tid, name in (("track-rec-main", "lead"), ("back-1", "back")):
        d = m[tid]
        (OUT / f"{name}_avant.wav").write_bytes(base64.b64decode(d.pop("wav_avant")))
        (OUT / f"{name}_apres.wav").write_bytes(base64.b64decode(d.pop("wav_apres")))
        res[f"export_{name}"] = d
    lead, back = res["export_lead"], res["export_back"]
    ecarts = [x["ecart_db"] for x in lead["detail"] if x["ecart_db"] is not None]
    res["verdict"] = {
        "respirations_lead": lead["respirations"],
        "ecart_lead_moyen_db": round(sum(ecarts) / max(1, len(ecarts)), 2) if ecarts else None,
        "ecart_lead_min_max_db": [min(ecarts), max(ecarts)] if ecarts else None,
        "back_silence": all(x["apres_db"] == "silence" for x in back["detail"]),
        "mots_identiques_lead": lead["mots"]["ecart_max_echantillon"] < 1e-6 and lead["mots"]["trames_mot_touchees"] == 0,
        "mots_identiques_back": back["mots"]["ecart_max_echantillon"] < 1e-6 and back["mots"]["trames_mot_touchees"] == 0,
        "pas_de_clic": lead["raccords"]["pire_rapport_sauts"] <= 1.05 and back["raccords"]["pire_rapport_sauts"] <= 1.05,
        "une_seule_annulation": all(sum(c) == 0 for _, c in res["apres_annuler"]) and res["apres_retablir"] == res["apres_un_clic"],
        "sans_cumul": res["lead_gains_apres_reapplication"] == [-20] and res["lead_gains_final"] == [-15],
    }


def scenario_captures(page, res, vp):
    f = OUT / "projet_respirations.zip"
    if not f.exists(): make_project(f)
    open_project(page, f)
    close_overlays(page)
    open_breaths(page)
    res["compteur"] = page.get_by_test_id("breath-count").inner_text() if page.get_by_test_id("breath-count").count() else None
    res["resume"] = page.get_by_test_id("breath-summary").inner_text()
    shot(page, f"10_fenetre_respirations_{vp}")
    if vp != "tel":
        # Exclure une respiration au doigt / à la souris : touche la 1re zone de l'aperçu.
        cv = page.get_by_test_id("breath-wave")
        box = cv.bounding_box()
        zones = page.evaluate("""async () => {
          const B = await import('/utils/breaths.ts');
          const s = window.__novaEdit.getState();
          const c = s.tracks[0].clips[0];
          const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
          return B.detectClipBreaths(c, audioBufferRegistry.get(c.bufferId), 'normale').map(r => [r.start, r.end]);
        }""")
        res["zones_lead"] = len(zones)
        before = page.get_by_test_id("breath-count").inner_text()
        # La vue (8 s) commence un tiers avant la 1re respiration : on touche son milieu.
        view = max(0, zones[0][0] - 8 / 3)
        x = box["x"] + ((zones[0][0] + zones[0][1]) / 2 - view) / 8 * box["width"]
        if vp == "tab": page.touchscreen.tap(x, box["y"] + box["height"] / 2)
        else: page.mouse.click(x, box["y"] + box["height"] / 2)
        page.wait_for_timeout(500)
        res["compteur_apres_exclusion"] = page.get_by_test_id("breath-count").inner_text()
        res["exclusion_ok"] = before != res["compteur_apres_exclusion"]
        shot(page, f"11_respiration_exclue_{vp}")
        page.get_by_test_id("breath-play-after").click(); page.wait_for_timeout(400)
        shot(page, f"12_ecoute_apres_{vp}")
        page.get_by_test_id("breath-play-after").click()
        # Type de piste modifiable : le back passe en « Voix principale » puis revient.
        sel = page.get_by_label("Type de voix de BACK 1")
        res["type_back_devine"] = sel.input_value()
    page.get_by_test_id("breath-apply").first.click()
    page.get_by_test_id("breath-undo").wait_for(timeout=60000)
    res["recapitulatif"] = page.get_by_test_id("breath-toast").inner_text()
    shot(page, f"13_applique_{vp}")
    close_overlays(page)
    # Panneau voix : bouton unique, mode auto, case du Mix auto.
    try:
        page.locator("[data-nova-target=mix-auto]").locator("visible=true").first.click(); page.wait_for_timeout(600)
        page.get_by_test_id("breath-panel").scroll_into_view_if_needed(); page.wait_for_timeout(200)
        shot(page, f"14_panneau_voix_{vp}")
        page.get_by_test_id("breath-with-mix").scroll_into_view_if_needed(); page.wait_for_timeout(200)
        shot(page, f"15_mix_auto_case_{vp}")
    except Exception as e:  # noqa
        res["panneau"] = f"non trouvé : {str(e)[:120]}"


def scenario_auto(page, res):
    """Mode auto : prise au micro (micro simulé = la vraie voix), traitée à la fin de la prise.
    Seule la nouvelle prise est touchée ; « Annuler » retire le traitement, pas la prise."""
    f = OUT / "projet_auto.zip"
    tracks = [track("track-rec-main", "LEAD", [clip("old-1", "Ancienne prise", 20, 10, "audio/voix.wav", takeNumber=1, offset=0)])]
    state = json.loads(json.dumps({"tracks": tracks}))
    with zipfile.ZipFile(f, "w") as z:
        st0 = {"id": "proj-auto", "name": "Respirations auto", "bpm": 140, "timeSignature": {"numerator": 4, "denominator": 4},
               "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
               "tracks": state["tracks"], "trackGroups": [], "markers": [], "selectedTrackId": "track-rec-main", "currentView": "ARRANGEMENT",
               "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
               "recStartTime": None, "isDelayCompEnabled": True, "breathAuto": True,
               "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
               "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
        z.writestr("project.json", json.dumps(st0))
        z.write(VOIX, "audio/voix.wav")
    open_project(page, f, "20_auto_projet")
    close_overlays(page)
    res["auto_projet"] = st(page, "s => s.breathAuto")
    page.mouse.click(800, 700); page.wait_for_timeout(200)
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 15 and not st(page, "s => s.isRecording"):
        page.wait_for_timeout(50)
    res["enregistre"] = st(page, "s => s.isRecording")
    page.wait_for_timeout(13000)
    page.keyboard.press("r")
    page.get_by_test_id("breath-undo").wait_for(timeout=60000)
    res["notification"] = page.get_by_test_id("breath-toast").inner_text()
    shot(page, "21_auto_apres_prise")
    clips = "s => s.tracks[0].clips.map(c => [c.name, +c.start.toFixed(2), +c.duration.toFixed(2), (c.breaths || []).length, !!c.isMuted])"
    res["clips_apres_prise"] = st(page, clips)
    page.get_by_test_id("breath-undo").click(); page.wait_for_timeout(600)
    res["clips_apres_annuler"] = st(page, clips)
    res["ok"] = (any(c[3] > 0 for c in res["clips_apres_prise"] if c[0] != "Ancienne prise")
                 and all(c[3] == 0 for c in res["clips_apres_prise"] if c[0] == "Ancienne prise")
                 and len(res["clips_apres_annuler"]) == len(res["clips_apres_prise"])
                 and all(c[3] == 0 for c in res["clips_apres_annuler"]))


def launch_voice_mic(p):
    from qalib import CHROME
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={VOIX}", "--autoplay-policy=no-user-gesture-required"])


def run(name, fn, vp="pc", **kw):
    log = Log(name)
    res = {"name": name, "vp": vp}
    with sync_playwright() as p:
        b = launch_voice_mic(p) if name == "auto" else launch(p)
        ctx, page = new_page(b, vp, log)
        page.set_default_timeout(30000)
        try:
            fn(page, res, **kw)
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
    which = sys.argv[1:] or ["mesure", "captures"]
    allres = {}
    if "mesure" in which:
        allres["mesure"] = run("mesure", scenario_mesure)
    if "auto" in which:
        allres["auto"] = run("auto", scenario_auto)
    if "captures" in which:
        for vp in ("pc", "tab", "tel"):
            allres[f"captures_{vp}"] = run(f"captures_{vp}", lambda page, res, v=vp: scenario_captures(page, res, v), vp)
    (OUT / f"resultats_{'_'.join(which)}.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1)[:9000])
