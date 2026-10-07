"""Preuves de bout en bout des vagues Pro Tools V4 (couloirs de prises, Loop Record)
et V5 (comp à la souris), plus le B3 de l'audit (« Mes prises » facile à trouver).
Navigateur headless, micro simulé (--use-fake-device-for-media-stream), aucune fenêtre.

  loop   : 3 tours de Loop Record → 3 couloirs (Prise 1..3, tours 1..3, la 3e entendue)
  comp   : 2 zones balayées à la souris dans 2 couloirs → mesure à l'export :
           bonne prise au bon endroit (corrélation avec l'audio de chaque prise),
           pas de clic ni de creux aux 4 raccords ; Ctrl+Z annule le dernier balayage
  b3     : captures « Prises (N) » (piste, clip), couloirs dépliés, « Mes prises »
           en haut du panneau, sur PC, tablette et téléphone

Usage : serveur `npx vite --port 3419 --strictPort` dans le worktree, puis
  python qa/playlists_preuve.py [loop] [b3]
Captures et mesures : D:\\1 WORK\\CONTENU\\nova-v4-v5\\
"""
import io, json, math, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://localhost:3419/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v4-v5")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log  # noqa
from playwright.sync_api import sync_playwright

SR = 48000
MIC_WAV = OUT / "micro_balayage_200_900hz.wav"
LOOP = (2.0, 6.0)


def sweep_wav(f0, f1, seconds, amp=0.25, sr=SR) -> bytes:
    """Micro simulé : sinus dont la fréquence monte sans cesse → chaque tour sonne différemment."""
    t = np.arange(int(seconds * sr)) / sr
    k = (f1 - f0) / seconds
    x = amp * np.sin(2 * np.pi * (f0 * t + 0.5 * k * t * t))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def sine_wav(freq, seconds, amp=0.25, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    x = amp * np.sin(2 * np.pi * freq * t)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def launch(p):
    if not MIC_WAV.exists():
        MIC_WAV.write_bytes(sweep_wav(200, 900, 120))
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC_WAV}", "--autoplay-policy=no-user-gesture-required"])


def track(tid, name, clips, **extra):
    return {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
            "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
            "sends": [], "clips": clips, "plugins": [], "automationLanes": [], "totalLatency": 0, **extra}


def clip(cid, name, start, dur, ref, **extra):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": 0, "fadeIn": 0.01, "fadeOut": 0.01,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1, **extra}


def make_project(path: Path, tracks, audio: dict, name="Couloirs V4", loop=None):
    state = {
        "id": f"proj-{name}", "name": name, "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0,
        "isLoopActive": bool(loop), "loopStart": loop[0] if loop else 0, "loopEnd": loop[1] if loop else 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": tracks[0]["id"], "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in audio.items():
            z.writestr(k, v)


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}
"""


def open_project(page, f: Path, label, advanced=True):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=30000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    if advanced:
        adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
        try:
            if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
        except Exception:
            pass
    shot(page, label)


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def engine_time(page):
    return page.evaluate("async () => (await import('/engine/AudioEngine.ts')).audioEngine.getCurrentTime()")


def lanes(page, tid):
    return page.evaluate("""async (tid) => {
      const P = await import('/utils/playlists.ts');
      const t = window.__novaEdit.getState().tracks.find(x => x.id === tid);
      return P.listLanes(t).map(l => ({ n: l.n, label: l.label, start: +l.start.toFixed(3), end: +l.end.toFixed(3), used: +l.used.toFixed(3), loopPass: l.meta && l.meta.loopPass || null }));
    }""", tid)


def comp_of(page, tid):
    return page.evaluate("""async (tid) => {
      const C = await import('/utils/comping.ts');
      const t = window.__novaEdit.getState().tracks.find(x => x.id === tid);
      return C.readComp(t.clips).map(s => ({ n: s.n, start: +s.start.toFixed(4), end: +s.end.toFixed(4) }));
    }""", tid)


def close_overlays(page):
    for _ in range(3):
        page.keyboard.press("Escape"); page.wait_for_timeout(150)


# ============================================================ Loop Record + comp
EXPORT_JS = """
async ([tid, dur, zones]) => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
  const C = await import('/utils/comping.ts');
  const s = window.__novaEdit.getState();
  const tr = s.tracks.filter(t => t.id === tid).map(t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] }));
  const SR = 48000;
  const b = await audioEngine.renderProject(tr, dur, 0, SR);
  const x = b.getChannelData(0);
  // Audio de chaque prise tel qu'il devrait sonner à l'instant t (morceau de la prise, gain du clip).
  const spans = C.takeSpans(tr[0].clips);
  const srcAt = (n, t) => {
    const sp = spans.find(q => q.n === n && t >= q.start && t < q.end);
    if (!sp) return null;
    const buf = audioBufferRegistry.get(sp.base.bufferId);
    const i = Math.round((t - sp.anchor) * buf.sampleRate);
    return buf.getChannelData(0)[i] * (sp.base.gain ?? 1);
  };
  const zoneRes = zones.map(([a, z]) => {
    const out = { start: a, end: z, corr: {} };
    for (const n of [...new Set(spans.map(q => q.n))]) {
      let sxy = 0, sxx = 0, syy = 0, maxErr = 0, cnt = 0;
      for (let t = a; t < z; t += 1 / SR) {
        const y = srcAt(n, t); if (y === null) continue;
        const v = x[Math.round(t * SR)];
        sxy += v * y; sxx += v * v; syy += y * y; maxErr = Math.max(maxErr, Math.abs(v - y)); cnt++;
      }
      out.corr[n] = { r: cnt ? +(sxy / Math.sqrt(sxx * syy + 1e-20)).toFixed(4) : null, maxErr: +maxErr.toFixed(5) };
    }
    return out;
  });
  // Raccords : le rendu doit être EXACTEMENT le mélange prévu (fondus à puissance égale des deux prises).
  const F = await import('/utils/fades.ts');
  const aud = tr[0].clips.filter(c => !c.isMuted);
  const junctions = C.compJunctions(tr[0].clips).map(j => {
    let maxErr = 0, minPow = 9, maxPow = 0;
    for (let t = j.at - 0.03; t < j.at + 0.03; t += 1 / SR) {
      let y = 0, pow = 0;
      for (const c of aud) {
        if (t < c.start || t >= c.start + c.duration) continue;
        const g = F.clipGainAt(c, t - c.start);
        const buf = audioBufferRegistry.get(c.bufferId);
        y += g * buf.getChannelData(0)[Math.round((t - c.start + c.offset) * buf.sampleRate)];
        const g0 = g / (c.gain ?? 1); pow += g0 * g0;
      }
      maxErr = Math.max(maxErr, Math.abs(y - x[Math.round(t * SR)]));
      minPow = Math.min(minPow, pow); maxPow = Math.max(maxPow, pow);
    }
    return { at: j.at, from: j.from, to: j.to, ecart_au_melange_prevu: +maxErr.toFixed(5), somme_puissances_min: +minPow.toFixed(4), somme_puissances_max: +maxPow.toFixed(4) };
  });
  // Témoin : le même comp SANS crossfade (raccords bout à bout) → là, il y a des clics.
  const bare = C.rebuildTakeClips(tr[0].clips, spans, C.readComp(tr[0].clips), { xfade: 0 })
    .map(c => (c.isMuted ? c : { ...c, fadeIn: 0, fadeOut: 0 }));
  const bt = await audioEngine.renderProject([{ ...tr[0], clips: bare }], dur, 0, SR);
  return { x: Array.from(x), temoin: Array.from(bt.getChannelData(0)), zones: zoneRes, junctions };
}
"""


def max_step(x):
    x = np.asarray(x)
    return float(np.max(np.abs(np.diff(x)))) if len(x) > 1 else 0.0


def rms_db(x):
    x = np.asarray(x)
    r = math.sqrt(float(np.mean(x ** 2))) if len(x) else 0
    return 20 * math.log10(r) if r > 1e-9 else -200.0


def scenario_loop(page, res):
    f = OUT / "loop_projet.zip"
    make_project(f, [track("track-rec-main", "Voix lead", [])], {}, "Loop Record V4", loop=LOOP)
    open_project(page, f, "loop_01_session")
    page.mouse.click(800, 700); page.wait_for_timeout(200)
    res["boucle"] = st(page, "s => [s.isLoopActive, s.loopStart, s.loopEnd]")
    # --- REC (raccourci R) : Loop Record, on compte les retours au début de la boucle
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 10 and not st(page, "s => s.isRecording"):
        page.wait_for_timeout(20)
    page.wait_for_timeout(150)
    res["depart_s"] = round(engine_time(page), 3)
    t0 = time.time(); last = None; wraps = 0; times = []
    while time.time() - t0 < 30:
        t = engine_time(page)
        if last is not None and t < last - 1.0:
            wraps += 1
            times.append(round(last, 3))
        last = t
        if wraps == 1 and len(times) == 1 and not res.get("shot_rec"):
            shot(page, "loop_02_enregistrement_tour2"); res["shot_rec"] = True
        if wraps >= 3 and t > LOOP[0] + 0.4:
            break
        page.wait_for_timeout(20)
    res["tours_vus"] = wraps
    res["fin_de_boucle_vue_a_s"] = times
    page.keyboard.press("r")            # arrêt (0,4 s dans le 4e tour : trop court, jeté)
    page.wait_for_timeout(1500)
    res["isRecording_apres"] = st(page, "s => s.isRecording")
    L = lanes(page, "track-rec-main")
    res["couloirs"] = L
    res["comp_apres_loop"] = comp_of(page, "track-rec-main")
    shot(page, "loop_03_trois_couloirs")
    assert len(L) == 3, f"3 couloirs attendus, {len(L)}"
    res["ok_loop"] = bool(len(L) == 3 and [l["loopPass"] for l in L] == [1, 2, 3]
                          and all(abs(l["end"] - LOOP[1]) < 0.002 for l in L)
                          and all(abs(l["start"] - LOOP[0]) < 0.2 for l in L)
                          and len(res["comp_apres_loop"]) == 1 and res["comp_apres_loop"][0]["n"] == L[2]["n"])

    # --- Couloirs dépliés par le bouton « Prises (3) » de la piste
    btn = page.locator('[data-takes-button="track-rec-main"]')
    res["bouton_piste"] = btn.inner_text()
    res["deplies_tout_seuls_apres_loop"] = btn.get_attribute("aria-expanded") == "true"
    if not res["deplies_tout_seuls_apres_loop"]:
        btn.click(); page.wait_for_timeout(500)
    else:  # replier puis déplier au bouton (le bouton marche dans les deux sens)
        btn.click(); page.wait_for_timeout(300)
        res["replies"] = page.locator('[data-take-lane-row]').count() == 0
        btn.click(); page.wait_for_timeout(500)
    shot(page, "loop_04_couloirs_deplies")
    n1, n2, n3 = [l["n"] for l in L]

    def swipe(n, a, b):
        r = page.locator(f'[data-take-lane-row="{n}"]').first.bounding_box()
        sl = page.evaluate("() => document.querySelector('.nova-grille .custom-scroll')?.scrollLeft || 0")
        y = r["y"] + r["height"] / 2
        page.mouse.move(r["x"] + a * 40 - sl, y); page.mouse.down()
        page.mouse.move(r["x"] + (a + b) / 2 * 40 - sl, y, steps=4)
        page.mouse.move(r["x"] + b * 40 - sl, y, steps=4)
        page.mouse.up(); page.wait_for_timeout(400)

    swipe(n1, 2.5, 3.5)
    shot(page, "loop_05_comp_zone1")
    swipe(n2, 4.5, 5.5)
    page.mouse.move(700, 160)
    shot(page, "loop_06_comp_deux_zones")
    comp = comp_of(page, "track-rec-main")
    res["comp_2_zones"] = comp
    want = [[n3, 2.0, 2.5], [n1, 2.5, 3.5], [n3, 3.5, 4.5], [n2, 4.5, 5.5], [n3, 5.5, 6.0]]
    ok_zones = len(comp) == 5 and all(c["n"] == w[0] and abs(c["start"] - w[1]) < 0.03 and abs(c["end"] - w[2]) < 0.03 for c, w in zip(comp, want))
    res["comp_zones_ok"] = ok_zones
    J = [c["start"] for c in comp[1:]]
    res["raccords_s"] = J

    # --- Export (renderProject = moteur de l'export) : bonne prise au bon endroit, pas de clic
    zones = [[2.05, 2.45], [2.55, 3.45], [3.55, 4.45], [4.55, 5.45], [5.55, 5.95]]
    out = page.evaluate(EXPORT_JS, ["track-rec-main", 6.5, zones])
    x = np.array(out["x"], dtype=np.float64)
    np.save(OUT / "comp_export.npy", x.astype(np.float32))
    res["zones_correlation"] = out["zones"]
    expect = [n3, n1, n3, n2, n3]
    res["bonne_prise_partout"] = all(max(z["corr"], key=lambda k: (z["corr"][k]["r"] or -1)) == str(e) and z["corr"][str(e)]["r"] > 0.999
                                     for z, e in zip(out["zones"], expect))
    clicks = []
    d2 = np.abs(np.diff(x, 2))
    for j in J:
        a = int((j - 0.03) * SR); b = int((j + 0.03) * SR)
        regime = max(float(np.max(d2[int((j - 0.25) * SR):int((j - 0.05) * SR)])), float(np.max(d2[int((j + 0.05) * SR):int((j + 0.25) * SR)])))
        around = float(np.max(d2[a:b]))
        clicks.append({"raccord_s": j, "pic_derivee2_raccord": round(around, 6), "pic_derivee2_regime": round(regime, 6),
                       "rapport": round(around / max(regime, 1e-12), 3), "saut_max": round(max_step(x[a:b]), 5)})
    xt = np.array(out["temoin"], dtype=np.float64)
    d2t = np.abs(np.diff(xt, 2))
    res["temoin_sans_crossfade"] = [{"raccord_s": j, "rapport": round(float(np.max(d2t[int((j - 0.03) * SR):int((j + 0.03) * SR)])) / max(float(np.max(d2t[int((j - 0.25) * SR):int((j - 0.05) * SR)])), 1e-12), 1),
                                     "saut_max": round(max_step(xt[int((j - 0.03) * SR):int((j + 0.03) * SR)]), 4)} for j in J]
    regime_err = max(z["corr"][str(e)]["maxErr"] for z, e in zip(out["zones"], expect))
    res["ecart_regime_hors_raccords"] = regime_err
    res["raccords"] = clicks
    res["raccords_melange"] = out["junctions"]
    # Pas de clic : aucune discontinuité (dérivée seconde au niveau du régime établi),
    # et le rendu est exactement le crossfade prévu (puissance égale : somme des puissances = 1).
    res["pas_de_clic"] = all(c["rapport"] <= 3 for c in clicks) and all(t["rapport"] > 20 for t in res["temoin_sans_crossfade"]) and all(
        m["ecart_au_melange_prevu"] <= 1.5 * regime_err and m["somme_puissances_min"] > 0.98 and m["somme_puissances_max"] < 1.02 for m in out["junctions"])

    # --- Écoute en solo d'une prise (casque du couloir) : le moteur joue la prise seule, l'export ne change pas
    page.locator(f'[data-take-lane="{n1}"] button[aria-pressed]').first.click(); page.wait_for_timeout(500)
    res["solo"] = page.evaluate("async () => (await import('/engine/AudioEngine.ts')).audioEngine.getTakeAudition()")
    shot(page, "loop_07_ecoute_solo_prise1")
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    page.locator(f'[data-take-lane="{n1}"] button[aria-pressed]').first.click(); page.wait_for_timeout(300)
    res["solo_apres"] = page.evaluate("async () => (await import('/engine/AudioEngine.ts')).audioEngine.getTakeAudition()")

    # --- Annuler : Ctrl+Z retire le 2e balayage (une étape par balayage)
    page.mouse.click(700, 160); page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    res["comp_apres_annuler"] = comp_of(page, "track-rec-main")
    res["annuler_ok"] = any(c["n"] == n1 for c in res["comp_apres_annuler"]) and not any(c["n"] == n2 for c in res["comp_apres_annuler"])
    shot(page, "loop_08_apres_annuler")
    res["ok_comp"] = bool(res["comp_zones_ok"] and res["bonne_prise_partout"] and res["pas_de_clic"] and res["annuler_ok"]
                          and res["solo"] and res["solo"]["n"] == n1 and res["solo_apres"] is None)


# ============================================================ B3 : captures
def b3_project():
    f = OUT / "b3_projet.zip"
    clips = [clip("p1", "Prise 1", 2, 8, "audio/p1.wav", takeNumber=1, isMuted=True),
             clip("p2", "Prise 2", 2, 8, "audio/p2.wav", takeNumber=2, isMuted=True),
             clip("p3", "Prise 3", 2, 8, "audio/p3.wav", takeNumber=3)]
    meta = [{"n": 1, "recordedAt": int(time.time() * 1000) - 600000}, {"n": 2, "recordedAt": int(time.time() * 1000) - 300000, "name": "Couplet propre"},
            {"n": 3, "recordedAt": int(time.time() * 1000) - 60000}]
    make_project(f, [track("track-rec-main", "Voix lead", clips, takeMeta=meta)],
                 {"audio/p1.wav": sine_wav(220, 8), "audio/p2.wav": sine_wav(330, 8), "audio/p3.wav": sine_wav(440, 8)}, "Mes prises B3")
    return f


def scenario_b3(page, res, vp):
    f = b3_project()
    open_project(page, f, f"b3_{vp}_01_session", advanced=(vp != "tel"))
    if vp != "tel":
        btn = page.locator('[data-takes-button="track-rec-main"]').first
        res["bouton"] = btn.inner_text()
        bb = btn.bounding_box(); res["bouton_box"] = bb
        shot(page, f"b3_{vp}_02_bouton_prises_et_pastille_clip")
        # Pastille « Prises (3) ▾ » sur le clip : clip de 2 s à 10 s, zoom 40 px/s → pastille à 298 px du début du calque.
        cv = page.evaluate("() => { const c = document.querySelectorAll('.nova-grille canvas')[1].getBoundingClientRect(); const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: c.left, y: c.top, sl: sc ? sc.scrollLeft : 0 }; }")
        page.mouse.click(cv["x"] + 298 + 40 - cv["sl"], 164); page.wait_for_timeout(400)
        res["menu_pastille"] = [t.strip() for t in page.locator("button").all_inner_texts() if t.strip().startswith(("Écouter", "Garder", "Afficher", "Replier"))][:8]
        shot(page, f"b3_{vp}_02b_menu_pastille_clip")
        page.keyboard.press("Escape"); page.mouse.click(1000, 600); page.wait_for_timeout(300)
        btn.click(); page.wait_for_timeout(500)
        shot(page, f"b3_{vp}_03_couloirs")
        res["couloirs_entetes"] = page.locator('[data-take-lane]').count()
        res["overflow"] = qalib.overflow_report(page)
    # Panneau « Mix auto » : « Mes prises » en haut
    page.get_by_role("button", name=re.compile("Mix auto|Choisir un style", re.I)).locator("visible=true").first.click()
    page.wait_for_timeout(600)
    box = page.locator('[data-mes-prises]').first.bounding_box()
    buy = page.get_by_text("Faire mixer par un pro").first.bounding_box()
    res["mes_prises_y"] = box and round(box["y"]); res["achat_y"] = buy and round(buy["y"])
    res["mes_prises_avant_achat"] = bool(box and buy and box["y"] < buy["y"])
    res["mes_prises_visible_sans_defiler"] = bool(box and box["y"] < page.viewport_size["height"] - 60)
    shot(page, f"b3_{vp}_04_mes_prises_en_haut")
    res["ok"] = bool(res["mes_prises_avant_achat"] and res["mes_prises_visible_sans_defiler"] and (vp == "tel" or (res.get("couloirs_entetes") == 3 and len(res.get("menu_pastille") or []) >= 4)))


def scenario_ia(page, res):
    """V22 : 3 prises (2 fausses de 40 cents, 1 juste) → l'IA garde la juste partout ; « Revenir » rend le comp d'avant."""
    f = OUT / "ia_projet.zip"
    clips = [clip("p1", "Prise 1", 2, 8, "audio/p1.wav", takeNumber=1, isMuted=True),
             clip("p2", "Prise 2", 2, 8, "audio/p2.wav", takeNumber=2, isMuted=True),
             clip("p3", "Prise 3", 2, 8, "audio/p3.wav", takeNumber=3)]
    det = 440 * 2 ** (0.4 / 12)
    make_project(f, [track("track-rec-main", "Voix lead", clips)],
                 {"audio/p1.wav": sine_wav(det, 8), "audio/p2.wav": sine_wav(440, 8), "audio/p3.wav": sine_wav(440 * 2 ** (-0.4 / 12), 8)}, "Meilleure prise V22")
    open_project(page, f, "ia_01_session")
    res["comp_avant"] = comp_of(page, "track-rec-main")
    page.get_by_role("button", name=re.compile("Mix auto|Choisir un style", re.I)).locator("visible=true").first.click(); page.wait_for_timeout(500)
    shot(page, "ia_02_bouton_meilleure_prise")
    t0 = time.time()
    page.get_by_role("button", name=re.compile("Meilleure prise")).first.click()
    page.locator("[data-auto-comp]").wait_for(timeout=15000)
    res["calcul_s"] = round(time.time() - t0, 2)
    page.wait_for_timeout(400)
    shot(page, "ia_03_proposition")
    res["comp_ia"] = comp_of(page, "track-rec-main")
    res["notes"] = st(page, "s => s.tracks.find(t => t.id === 'track-rec-main').takeMeta")
    page.get_by_role("button", name=re.compile("Revenir à mon comp")).click(); page.wait_for_timeout(500)
    res["comp_apres_revenir"] = comp_of(page, "track-rec-main")
    res["ok_ia"] = bool(res["comp_ia"] and all(c["n"] == 2 for c in res["comp_ia"]) and res["comp_apres_revenir"] == res["comp_avant"])


def run(name, fn, vp="pc", **kw):
    log = Log(name)
    res = {"name": name, "vp": vp}
    with sync_playwright() as p:
        b = launch(p)
        ctx, page = new_page(b, vp, log)
        try:
            fn(page, res, **kw) if kw else fn(page, res)
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
    which = sys.argv[1:] or ["loop", "b3"]
    allres = {}
    if "loop" in which:
        allres["loop_comp"] = run("loop_comp", scenario_loop)
    if "ia" in which:
        allres["ia"] = run("ia", scenario_ia)
    if "b3" in which:
        for vp in ("pc", "tab", "tel"):
            allres[f"b3_{vp}"] = run(f"b3_{vp}", lambda page, res: scenario_b3(page, res, vp), vp)
    (OUT / "resultats.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1)[:6000])
