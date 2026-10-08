"""R2 · Tempo, clic, décompte : scénario Chrome headless (aucune fenêtre), mesures sur le son réel.

1. Projet de test (silencieux, 120 BPM 4/4) ouvert dans NOVA.
2. Tap tempo : touche T tapée 8 fois à 128 BPM → tempo appliqué (puis Ctrl+Z).
3. Fenêtre Tempo et mesure : 6/8 au début, changement à la mesure 3 (90 BPM, 3/4) ; piste tempo.
4. Clic mesuré sur la sortie du master : 0,25 s en 6/8 à 120, 0,667 s en 3/4 à 90, accent au 1er temps.
5. Décompte mesuré : 2 mesures en 3/4 à 90 depuis la mesure 3 → 6 clics espacés de 0,667 s,
   chiffres 1 2 3 1 2 3 ; clic « prise seulement » muet en lecture.
6. Captures PC, tablette, téléphone (clair et sombre).
Usage : NOVA_URL=http://127.0.0.1:3443/ QA_OUT="D:\\1 WORK\\CONTENU\\nova-r1-r3" python qa/r2_tempo.py
"""
import json, os, re, sys, time
MARK = "\nwith sync_playwright() as p:"
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3443/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r1-r3")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, shot, OUT, overflow_report  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
# Outils du scénario R1 (ouvrir un projet .zip, WAV de test) sans lancer ce scénario.
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split(MARK)[0]
exec(compile(_r1, "r1_export.py", "exec"))
from playwright.sync_api import sync_playwright  # noqa: E402
import zipfile  # noqa: E402

res = {"etapes": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:500])


def make_silent_project(path, secs=12):
    sr = 48000
    silence = [(0.0, 0.0)] * int(sr * secs)
    tracks = [
        {"id": "voix", "name": "Voix", "type": "AUDIO", "color": "#ef4444", "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
         "volume": 1, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
         "clips": [{"id": "sil", "name": "Silence", "type": "AUDIO", "start": 0, "duration": secs, "offset": 0, "audioRef": "audio/sil.wav", "color": "#ef4444", "fadeIn": 0, "fadeOut": 0, "gain": 1}]},
        {"id": "master", "name": "MASTER", "type": "BUS", "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
         "volume": 1, "pan": 0, "outputTrackId": "", "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0},
    ]
    state = {"id": "qa-r2", "name": "Tempo QA", "bpm": 120, "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False,
             "loopStart": 0, "loopEnd": 4, "tracks": tracks, "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [], "markers": [],
             "metronome": {"enabled": False, "volume": 1, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/sil.wav", wav_bytes(silence))


TAP = """async () => {
  const { audioEngine } = await (window.__novaAppModule ? window.__novaAppModule('/engine/AudioEngine.ts') : import('/engine/AudioEngine.ts'));
  const { metronomeService } = await window.__novaAppModule('/services/MetronomeService.ts');
  const ctx = audioEngine.ctx, tap = audioEngine.getMasterMeterInput();
  if (!ctx || !tap) return 'pas de moteur';
  if (!window.__cap) {
    // Capture à l'échantillon près : un AudioWorklet note le n° d'échantillon (currentFrame) de chaque bloc.
    const code = `class QaCap extends AudioWorkletProcessor {
      constructor() { super(); this.on = false; this.buf = []; this.port.onmessage = e => { this.on = e.data === 'on'; if (!this.on) { this.port.postMessage(this.buf); this.buf = []; } }; }
      process(inputs) { const x = inputs[0] && inputs[0][0]; if (this.on && x) this.buf.push({ f: currentFrame, x: x.slice() }); return true; }
    }
    registerProcessor('qa-cap', QaCap);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'qa-cap', { numberOfInputs: 1, numberOfOutputs: 1 });
    const z = ctx.createGain(); z.gain.value = 0;
    tap.connect(node); node.connect(z); z.connect(ctx.destination);
    window.__cap = { node, sr: ctx.sampleRate, blocks: null };
    node.port.onmessage = e => { window.__cap.blocks = e.data; };
  }
  window.__cap.blocks = null;
  window.__cap.node.port.postMessage('on');
  metronomeService.lastScheduled = [];
  return 'ok';
}"""
ONSETS = """async () => {
  const { audioEngine } = await (window.__novaAppModule ? window.__novaAppModule('/engine/AudioEngine.ts') : import('/engine/AudioEngine.ts'));
  const { metronomeService } = await window.__novaAppModule('/services/MetronomeService.ts');
  const c = window.__cap; c.node.port.postMessage('off');
  for (let i = 0; i < 100 && !c.blocks; i++) await new Promise(r => setTimeout(r, 20));
  const out = []; const thr = 0.05; let quietUntil = -1;
  for (const b of c.blocks || []) for (let i = 0; i < b.x.length; i++) {
    const t = (b.f + i) / c.sr;
    if (t < quietUntil || Math.abs(b.x[i]) <= thr) continue;
    let pk = 0; for (let k = i; k < b.x.length; k++) pk = Math.max(pk, Math.abs(b.x[k]));
    out.push({ t, peak: pk }); quietUntil = t + 0.08;
  }
  // Crête de chaque clic : sur 20 ms après le départ (plusieurs blocs).
  for (const o of out) { let pk = 0; for (const b of c.blocks) { const t0 = b.f / c.sr; if (t0 > o.t + 0.02 || t0 + b.x.length / c.sr < o.t) continue; for (let i = 0; i < b.x.length; i++) { const t = t0 + i / c.sr; if (t >= o.t && t <= o.t + 0.02) pk = Math.max(pk, Math.abs(b.x[i])); } } o.peak = pk; }
  const clk = audioEngine.getClock();
  return { onsets: out, start: clk.startTime, sched: metronomeService.lastScheduled.slice() };
}"""


def align(onsets, sched):
    """Associe chaque clic programmé (heure du contexte) au son mesuré ; retard fixe de la chaîne (limiteur du master) retiré."""
    at = sorted(s["at"] for s in sched)
    pairs = []
    for o in onsets:
        prev = [a for a in at if a <= o["t"] + 0.0005]
        if prev: pairs.append((prev[-1], o))
    if not pairs: return 0, []
    d = sorted(o["t"] - a for a, o in pairs)
    lag = d[len(d) // 2]
    return lag, [(a, o["t"] - a - lag, o["peak"]) for a, o in pairs]


TAPS = """async ({ n, ms, sel }) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const wait = t0 + i * ms - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (sel) document.querySelector(sel).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true, cancelable: true }));
  }
}"""


def intervals(ts):
    return [round(b - a, 4) for a, b in zip(ts, ts[1:])]


with sync_playwright() as p:
    b = launch(p)
    ctx, page = new_page(b, "pc")
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    install_mocks(page, "romain", SUPERADMIN, {})
    zpath = OUT / "r2_projet_test.zip"
    make_silent_project(zpath)
    open_with_project(page, zpath)
    page.mouse.click(900, 600)  # focus hors du champ de fichier
    shot(page, "r2_00_transport_pc")

    # --- Tap tempo (touche T, 128 BPM) : tapes cadencées dans la page (pas d'aller-retour Python entre deux tapes) ---
    page.evaluate(TAPS, {"n": 8, "ms": 60000 / 128, "sel": None})
    page.wait_for_timeout(1700)
    bpm_txt = page.locator("[data-testid=open-tempo]").locator("xpath=following::span[contains(@class,'font-black')][1]").first.inner_text()
    bpm_state = page.evaluate("() => document.body.innerText.match(/(\\d+(?:[.,]\\d+)?)\\s*\\n?\\s*BPM/)?.[1]")
    ok("tap tempo (T ×8 à 128 BPM) appliqué au morceau", bpm_state is not None and abs(float(str(bpm_state).replace(',', '.')) - 128) <= 1, {"bpm_affiche": bpm_state})
    shot(page, "r2_01_apres_tap_pc")
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    bpm_back = page.evaluate("() => document.body.innerText.match(/(\\d+(?:[.,]\\d+)?)\\s*\\n?\\s*BPM/)?.[1]")
    ok("Ctrl+Z ramène le tempo d'avant (120)", bpm_back == "120", {"bpm": bpm_back})

    # --- Fenêtre Tempo et mesure ---
    page.get_by_test_id("open-tempo").click(); page.wait_for_timeout(500)
    shot(page, "r2_02_fenetre_tempo_pc")
    page.get_by_test_id("tempo-meter-6-8").click(); page.wait_for_timeout(200)
    page.get_by_test_id("tempo-new-bar").fill("3")
    page.get_by_test_id("tempo-new-bpm").fill("90")
    page.get_by_test_id("tempo-new-meter").select_option("3/4")
    page.get_by_test_id("tempo-add").click(); page.wait_for_timeout(300)
    rows = page.get_by_test_id("tempo-events").inner_text()
    ok("changement posé à la mesure 3 (90 BPM, 3/4), après 2 mesures de 6/8 à 120 (3,0 s)", "Mesure 3" in rows and "90 BPM" in rows and "3/4" in rows and "0:03,0" in rows, rows)
    shot(page, "r2_03_fenetre_tempo_changement_pc")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    lane = page.get_by_test_id("tempo-lane")
    ok("piste tempo affichée sous la règle avec le repère", lane.count() == 1 and page.get_by_test_id("tempo-badge-2").count() == 1)
    shot(page, "r2_04_piste_tempo_regle_pc")

    # --- Clic mesuré ---
    page.get_by_test_id("open-metronome").click(); page.wait_for_timeout(400)
    shot(page, "r2_05_fenetre_metronome_pc")
    page.get_by_test_id("metro-enabled").check()
    page.get_by_test_id("metro-sound-CLICK").click()
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.keyboard.press("Home"); page.wait_for_timeout(200)
    page.evaluate(TAP)
    page.keyboard.press("Space"); page.wait_for_timeout(5600)
    page.keyboard.press("Space"); page.wait_for_timeout(300)
    r = page.evaluate(ONSETS)
    sched = [s for s in r["sched"] if s.get("projectTime") is not None]
    proj_sched = [round(s["projectTime"], 6) for s in sched]
    exp = [round(0.25 * k, 6) for k in range(12)] + [round(3 + 2 / 3 * k, 6) for k in range(4)]
    ok("clic programmé sur la carte : 12 croches de 0,25 s (6/8 à 120) puis 0,667 s (3/4 à 90) dès 3,000 s", proj_sched[:16] == exp, proj_sched[:16])
    lag, al = align(r["onsets"], sched)
    errs_ms = [round(e * 1000, 2) for _, e, _ in al]
    ok("clic entendu à l'heure : chaque clic mesuré ±1 ms (le 1er ±5 ms, fondu de démarrage du master)", len(al) >= 15 and all(abs(e) <= 1.0 for e in errs_ms[1:]) and abs(errs_ms[0]) <= 5.0,
       {"ecarts_ms": errs_ms[:16], "retard_chaine_mesure_ms": round(lag * 1000, 1), "clics_mesures": len(al)})
    ts_on = [o["t"] - r["start"] - lag for o in r["onsets"]]
    later = [t for t in ts_on if 2.98 <= t < 5.2]
    ok("intervalles mesurés après le changement : 0,667 s (±1 ms), premier à 3,000 s (±2 ms)", len(later) >= 3 and all(abs(x - 2 / 3) < 0.001 for x in intervals(later)) and abs(later[0] - 3.0) < 0.002, {"intervalles": intervals(later), "premier": round(later[0], 4) if later else None})
    acc_peaks = [pk for (a, _, pk), s in zip(al, sched) if s["accent"]]
    oth_peaks = [pk for (a, _, pk), s in zip(al, sched) if not s["accent"]]
    ok("accent du 1er temps (mesures 1, 2, 3, 4) plus fort que les autres temps", acc_peaks and oth_peaks and min(acc_peaks) > max(oth_peaks) * 1.2, {"accents": acc_peaks, "autres_max": max(oth_peaks) if oth_peaks else None})
    res["clic_ecarts_ms"] = errs_ms

    # --- Décompte mesuré (2 mesures depuis la mesure 3 : 3/4 à 90) + clic « prise seulement » ---
    page.get_by_test_id("open-metronome").click(); page.wait_for_timeout(300)
    page.get_by_test_id("metro-countin-2").click()
    page.get_by_test_id("metro-mode-record").click()
    page.wait_for_timeout(200)
    summary = page.get_by_test_id("metro-countin-summary").inner_text()
    ok("fenêtre : « Prise seulement » et décompte 2 coché", page.get_by_test_id("metro-mode-record").get_attribute("aria-checked") == "true" and page.get_by_test_id("metro-countin-2").get_attribute("aria-checked") == "true")
    shot(page, "r2_06_metronome_decompte_pc")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # Lecture : le clic « prise seulement » doit se taire.
    page.keyboard.press("Home"); page.evaluate(TAP)
    page.keyboard.press("Space"); page.wait_for_timeout(1500); page.keyboard.press("Space"); page.wait_for_timeout(200)
    silent = page.evaluate(ONSETS)
    ok("clic « prise seulement » : muet pendant la simple lecture", len(silent["onsets"]) == 0 and not silent["sched"], {"onsets": len(silent["onsets"])})
    # Tête de lecture sur la mesure 3 (3,0 s) puis REC
    page.keyboard.press("Home"); page.keyboard.press("."); page.keyboard.press("."); page.wait_for_timeout(300)
    pos = page.evaluate("() => document.querySelector('[data-nova-target=clock]')?.innerText")
    labels = []
    page.evaluate(TAP)
    page.keyboard.press("r"); page.wait_for_timeout(300)
    # Haut-parleurs : pas de retour du micro dans le master (on n'y mesure que les clics).
    casque = page.get_by_role("button", name=re.compile("Non, haut-parleurs"))
    if casque.count():
        casque.first.click()
        page.wait_for_timeout(150)
    t_end = time.time() + 6.0
    while time.time() < t_end:
        txt = page.evaluate("() => document.querySelector('[aria-label=\"Annuler le décompte\"] span')?.innerText || null")
        if txt and (not labels or labels[-1] != txt): labels.append(txt)
        page.wait_for_timeout(40)
    page.wait_for_timeout(1500)
    r2 = page.evaluate(ONSETS)
    page.keyboard.press("r"); page.wait_for_timeout(1500)
    cnt = [s for s in r2["sched"] if s.get("projectTime") is None]
    rec = [s for s in r2["sched"] if s.get("projectTime") is not None]
    cat = [round(b["at"] - a["at"], 6) for a, b in zip(cnt, cnt[1:])]
    ok("décompte programmé : 2 mesures de 3/4 à 90 = 6 clics à 0,667 s, accents 1 et 4", len(cnt) == 6 and all(abs(x - 2 / 3) < 1e-6 for x in cat) and [c["accent"] for c in cnt] == [True, False, False, True, False, False],
       {"intervalles": cat, "resume_fenetre": summary, "position": pos})
    lag2, al2 = align(r2["onsets"], cnt + rec)
    e2 = [round(e * 1000, 2) for _, e, _ in al2]
    ok("décompte entendu à l'heure : 6 clics mesurés ±1 ms", len(al2) >= 6 and all(abs(e) <= 1.0 for e in e2[:6]), {"ecarts_ms": e2[:8]})
    ok("chiffres du décompte 1 2 3 1 2 3", labels[:6] == ["1", "2", "3", "1", "2", "3"], labels)
    ok("pendant la prise, le clic (prise seulement) bat les temps de la mesure 3 (3,000 ; 3,667 ; 4,333…)", len(rec) >= 2 and abs(rec[0]["projectTime"] - 3.0) < 1e-6 and all(abs(((s["projectTime"] - 3.0) / (2 / 3)) - round((s["projectTime"] - 3.0) / (2 / 3))) < 1e-6 for s in rec), [round(s["projectTime"], 4) for s in rec[:6]])
    gap = rec[0]["at"] - cnt[-1]["at"] if cnt and rec else None
    ok("la prise part pile à la fin du décompte : 1er temps de la prise un temps après le dernier clic (0,667 s ±1 ms)", gap is not None and abs(gap - 2 / 3) < 0.001, {"ecart_s": round(gap, 5) if gap else None})
    res["decompte_ecarts_ms"] = e2[:10]

    # --- Captures tablette / téléphone, thème clair ---
    for vp in ("tab", "tel"):
        c2, p2 = new_page(b, vp)
        install_mocks(p2, "romain", SUPERADMIN, {})
        try:
            open_with_project(p2, zpath)
            if vp == "tel":
                p2.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); p2.wait_for_timeout(500)
                shot(p2, "r2_07_menu_tempo_tel")
                p2.locator("button:visible", has_text="Tempo et mesure").first.click(); p2.wait_for_timeout(500)
            else:
                p2.get_by_test_id("open-tempo").click() if p2.get_by_test_id("open-tempo").is_visible() else (
                    p2.locator("button:visible[aria-label='Ouvrir le menu']").first.click(), p2.wait_for_timeout(400),
                    p2.locator("button:visible", has_text="Tempo et mesure").first.click())
                p2.wait_for_timeout(500)
            shot(p2, f"r2_08_fenetre_tempo_{vp}")
            p2.get_by_test_id("tempo-tap").tap() if vp == "tel" else p2.get_by_test_id("tempo-tap").click()
            p2.wait_for_timeout(2300)  # nouvelle série
            p2.evaluate(TAPS, {"n": 6, "ms": 600, "sel": "[data-testid=tempo-tap]"})
            p2.wait_for_timeout(200)
            tapped = p2.get_by_test_id("tempo-tap").inner_text()
            res[f"tap_doigt_{vp}"] = tapped
            shot(p2, f"r2_09_tap_doigt_{vp}")
            p2.keyboard.press("Escape"); p2.wait_for_timeout(300)
            if vp == "tel":
                p2.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); p2.wait_for_timeout(400)
                p2.locator("button:visible", has_text="Clic et décompte").first.click(); p2.wait_for_timeout(400)
            else:
                p2.get_by_test_id("open-metronome").click() if p2.get_by_test_id("open-metronome").is_visible() else None
                p2.wait_for_timeout(400)
            shot(p2, f"r2_10_fenetre_metronome_{vp}")
            res[f"debordements_{vp}"] = overflow_report(p2)
        except Exception as e:
            res[f"erreur_{vp}"] = str(e)[:300]
        c2.close()
    ok("tap au doigt (tablette, téléphone) : ~100 BPM affiché", all(re.search(r"\b(99|100|101)(\.\d)?\b", res.get(f"tap_doigt_{v}", "")) for v in ("tab", "tel")), {v: res.get(f"tap_doigt_{v}") for v in ("tab", "tel")})
    page.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
    page.get_by_test_id("open-tempo").click(); page.wait_for_timeout(400)
    shot(page, "r2_11_fenetre_tempo_pc_clair")
    page.keyboard.press("Escape")
    page.get_by_test_id("open-metronome").click(); page.wait_for_timeout(400)
    shot(page, "r2_12_fenetre_metronome_pc_clair")
    page.keyboard.press("Escape")
    res["erreurs_page"] = errs[:5]
    ok("pas d'erreur dans la page", not errs, errs[:3])
    b.close()

(OUT / "r2_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", sum(1 for v in res["etapes"].values() if v["ok"]), "/", len(res["etapes"]), "OK")
