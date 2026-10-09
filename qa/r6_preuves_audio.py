"""R6 · preuves audio sur le moteur RÉEL (navigateur headless, aucune fenêtre).

  1. Commit (piste entière) ≡ export de la piste : null test sur la chaîne « Voix lead
     Make Music » (EQ, compresseurs opto puis FET en 2:1 dont un avec 5 ms de lookahead =
     latence compensée, de-esser), automation d'un réglage d'effet, volume avant effets,
     envois vers une réverbe et un écho, sortie dans BUS VOX (compresseur à lookahead).
     1c : piste avec une réverbe EN INSERT (sortie master).
  2. Consolider avec effets sur une plage ≡ export : null test (clips d'origine coupés).
  3. AudioSuite sur un clip : son traité ≠ original ; « Revenir à l'original » ≡ original
     (null exact) ; AudioSuite EQ sans poignées ≡ EQ en insert (null).
  4. Bus imprimé (bus coupé) ≡ bus en direct : null test sur le mix complet.
La réponse des réverbes NOVA est reproductible (même réglage = même réponse) : deux
rendus du même son sont identiques, sans aucun artifice dans le test.

NOVA_URL=http://127.0.0.1:3444/ PYTHONIOENCODING=utf-8 python qa/r6_preuves_audio.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r4-r6\\r6_preuves_audio.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
OUT = Path(r"D:\1 WORK\CONTENU\nova-r4-r6")
OUT.mkdir(parents=True, exist_ok=True)

JS = r"""
async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const B = await import('/services/Bounce.ts');
  const C = await import('/utils/commit.ts');
  const CP = await import('/utils/clipProcess.ts');
  const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
  const { pluginParamName } = await import('/utils/automationWrite.ts');
  await audioEngine.init();
  const SR = audioEngine.ctx.sampleRate;


  // « Voix » de synthèse : harmoniques modulées + consonnes (bruit filtré) + silences.
  const voice = (() => {
    const len = 6 * SR, b = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SR });
    let n = 7;
    const nz = () => { n = (Math.imul(n, 1103515245) + 12345) >>> 0; return n / 2147483648 - 1; };
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / SR, f0 = 180 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
        let v = 0;
        for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
        const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.1 * t);
        const s = (Math.floor(t * 3) % 4 === 1) ? nz() * 0.6 : 0; // « s » toutes les secondes
        d[i] = 0.35 * (v * env + s) * (ch ? 0.9 : 1);
      }
    }
    return b;
  })();
  audioBufferRegistry.register(voice, 'voix-test');

  const eq = (hp) => ({ id: 'eq', name: 'EQ', type: 'PROEQ12', isEnabled: true, latency: 0, params: { isEnabled: true, masterGain: 1, bands: [80,150,300,500,1000,2000,4000,6000,8000,10000,12000,18000].map((f, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency: i === 0 ? hp : f, gain: i === 6 ? 3 : 0, q: i === 0 ? 0.707 : 1, isEnabled: true, isSolo: false })) } });
  const chain = (withVerb = false) => [
    eq(80),
    { id: 'opto', name: 'Opto', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { threshold: -20, ratio: 2, knee: 6, attack: 0.01, release: 0.3, makeupGain: 1.26, mix: 1, scHpFreq: 80, lookahead: 0, autoMakeup: false, mode: 'OPTO', isEnabled: true } },
    { id: 'fet', name: 'FET', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { threshold: -16, ratio: 2, knee: 3, attack: 0.0008, release: 0.06, makeupGain: 1.12, mix: 1, scHpFreq: 80, lookahead: 0.005, autoMakeup: false, mode: 'FET', isEnabled: true } },
    { id: 'ds', name: 'De-esser', type: 'DEESSER', isEnabled: true, latency: 0, params: { threshold: -25, frequency: 8000, q: 1, reduction: 0.6, mode: 'BELL', isEnabled: true } },
    ...(withVerb ? [{ id: 'rv', name: 'Réverbe', type: 'REVERB', isEnabled: true, latency: 0, params: { decay: 1.2, preDelay: 0.02, damping: 0.4, mix: 0.25, size: 0.4, mode: 'PLATE', isEnabled: true } }] : []),
  ];
  const base = (id, type, extra) => ({ id, name: id, type, color: '#3b82f6', volume: 1, pan: 0, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, totalLatency: 0, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const clip = (id, start, duration, offset, extra = {}) => ({ id, name: id, type: TrackType.AUDIO, start, duration, offset, fadeIn: 0.05, fadeOut: 0.1, gain: 0.8, color: '#3b82f6', bufferId: 'voix-test', ...extra });
  const pt = (time, value) => ({ id: `p${time}`, time, value });
  const lead = () => base('lead', TrackType.AUDIO, {
    volume: 0.8, pan: -0.2, outputTrackId: 'bus-vox',
    clips: [clip('c1', 1.3, 2.0, 0.5), clip('c2', 7.0, 1.5, 2.0)],
    plugins: chain(),
    sends: [{ id: 'echo', level: 0.3, isEnabled: true }, { id: 'verb', level: 0.25, isEnabled: true }],
    automationLanes: [
      { id: 'a1', parameterName: pluginParamName('opto', 'threshold'), points: [pt(1.3, -20), pt(2.5, -30), pt(7.5, -24)], color: '#fff', isExpanded: false, min: -60, max: 0 },
      { id: 'a2', parameterName: 'preVolume', points: [pt(1.3, 1), pt(2.0, 0.6), pt(3.0, 1)], color: '#fff', isExpanded: false, min: 0, max: 1.5 },
      { id: 'a3', parameterName: 'volume', points: [pt(0, 0.8), pt(8, 0.6)], color: '#fff', isExpanded: false, min: 0, max: 1.5 },
    ],
  });
  const back = () => base('back', TrackType.AUDIO, { volume: 0.6, pan: 0.4, outputTrackId: 'bus-vox', clips: [clip('b1', 2.0, 3.0, 1.0, { gain: 0.5 })], plugins: [eq(200)] });
  const busVox = () => base('bus-vox', TrackType.BUS, { volume: 0.85, pan: 0.1, plugins: [{ id: 'bc', name: 'Bus comp', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { threshold: -14, ratio: 2, knee: 6, attack: 0.02, release: 0.2, makeupGain: 1, mix: 1, scHpFreq: 80, lookahead: 0.003, autoMakeup: false, mode: 'VCA', isEnabled: true } }] });
  const echo = () => base('echo', TrackType.SEND, { volume: 0.7, plugins: [{ id: 'dl', name: 'Écho', type: 'DELAY', isEnabled: true, latency: 0, params: { division: '1/4', feedback: 0.3, feedbackLP: 5000, feedbackHP: 150, mix: 1, pingPong: false, bpm: 120, isEnabled: true } }] });
  const verb = () => base('verb', TrackType.SEND, { volume: 0.7, plugins: [{ id: 'rvs', name: 'Reverb courte', type: 'REVERB', isEnabled: true, latency: 0, params: { decay: 1.2, preDelay: 0.02, damping: 0.4, mix: 1, size: 0.4, mode: 'PLATE', isEnabled: true } }] });
  const master = () => base('master', TrackType.BUS, { outputTrackId: '' });

  const DUR = 13;
  const render = (tracks) => audioEngine.renderProject(tracks, DUR, 0, SR);
  const stats = (a, b) => {
    let peak = 0, diff = 0;
    for (let ch = 0; ch < 2; ch++) {
      const x = a.getChannelData(ch), y = b.getChannelData(ch);
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) { const u = x[i] || 0, v = y[i] || 0; peak = Math.max(peak, Math.abs(u)); diff = Math.max(diff, Math.abs(u - v)); }
    }
    const db = v => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity);
    return { crete_reference_dBFS: db(peak), residu_max_dBFS: db(diff), residu_relatif_dB: diff > 0 ? db(diff / peak) : -Infinity };
  };
  const out = {};

  // --- 1. Commit de la piste entière ≡ export de la piste (avec son bus, son envoi).
  const mixA = () => [lead(), busVox(), echo(), verb(), master()];
  const ref = await render(mixA());
  const cm = await B.renderCommitClip(lead(), { tail: 3, label: 'commit', session: mixA() });
  const committed = C.commitTracks(mixA(), 'lead', { id: 'lead-cm', clip: cm.clip, upTo: cm.upTo, tail: 3 });
  const afterCommit = await render(committed);
  out['1. Commit ≡ export de la piste'] = { ...stats(ref, afterCommit), debut_du_rendu_s: cm.clip.start, duree_du_rendu_s: Math.round(cm.clip.duration * 1000) / 1000, latence_compensee_ms: 5 };
  // Plancher de comparaison : le même export rendu deux fois.
  out['0. Export rendu deux fois (plancher)'] = stats(ref, await render(mixA()));
  // Restaurer : la session revient à l'identique, le son aussi.
  const restored = C.restoreCommitted(committed, 'lead-cm').tracks;
  out['1b. Restaurer la piste d’origine ≡ avant'] = { ...stats(ref, await render(restored)), meme_session: JSON.stringify(restored) === JSON.stringify(mixA()) };

  // --- 1c. Réverbe en insert (piste qui sort au master).
  const leadVerb = () => ({ ...lead(), outputTrackId: 'master', sends: [], plugins: chain(true) });
  const mixC = () => [leadVerb(), master()];
  const refC = await render(mixC());
  const cmC = await B.renderCommitClip(leadVerb(), { tail: 3, label: 'commit', session: mixC() });
  out['1c. Commit avec réverbe en insert ≡ export'] = stats(refC, await render(C.commitTracks(mixC(), 'lead', { id: 'cmv', clip: cmC.clip, upTo: cmC.upTo, tail: 3 })));

  // --- 2. Consolider avec effets sur la plage 6,5 → 9 s (clip c2 entier) ≡ export.
  const rng = { start: 6.5, end: 9.0 };
  const bn = await B.renderCommitClip(lead(), { tail: 3, range: rng, label: 'bounce', session: mixA() });
  const bounced = C.bounceTracks(mixA(), 'lead', { id: 'lead-bn', clip: bn.clip, upTo: bn.upTo, tail: 3, range: rng });
  out['2. Consolider avec effets (plage) ≡ export'] = { ...stats(ref, await render(bounced)), clips_coupes: bounced.find(t => t.id === 'lead-bn').commit.mutedClipIds.length, debut_du_rendu_s: bn.clip.start };

  // --- 3. AudioSuite sur un clip, puis retour à l'original.
  const solo = (cl, plugins = []) => [base('v', TrackType.AUDIO, { clips: [cl], plugins }), master()];
  const c0 = clip('as', 1.0, 2.0, 1.5, { fadeIn: 0, fadeOut: 0, gain: 1 });
  const origR = await render(solo(c0));
  const comp = chain()[2];
  const reg = CP.audioSuiteRegion(c0, voice.duration, 1);
  const from = Math.round(reg.from * SR), to = Math.round(reg.to * SR);
  const processed = await B.processRegion(voice, from, to, [comp], base('v', TrackType.AUDIO, {}));
  audioBufferRegistry.register(processed, 'as-p1');
  const c1 = CP.patchClip(c0, CP.audioSuitePatch(c0, { newBufferId: 'as-p1', from: from / SR, step: { type: 'COMPRESSOR', name: 'FET', at: 0 } }));
  const procR = await render(solo(c1));
  const back0 = CP.patchClip(c1, CP.audioSuiteRevertPatch(c1, id => !!audioBufferRegistry.get(id)));
  const backR = await render(solo(back0));
  out['3. AudioSuite (compresseur FET) : le son change'] = stats(origR, procR);
  out['3b. Revenir à l’original ≡ original'] = { ...stats(origR, backR), clip_identique: JSON.stringify(back0) === JSON.stringify(c0) };
  // AudioSuite EQ sans poignées ≡ le même EQ en insert.
  const eqp = eq(120);
  const r0 = CP.audioSuiteRegion(c0, voice.duration, 0);
  const pe = await B.processRegion(voice, Math.round(r0.from * SR), Math.round(r0.to * SR), [eqp], base('v', TrackType.AUDIO, {}));
  audioBufferRegistry.register(pe, 'as-eq');
  const ceq = CP.patchClip(c0, CP.audioSuitePatch(c0, { newBufferId: 'as-eq', from: Math.round(r0.from * SR) / SR, step: { type: 'PROEQ12', name: 'EQ', at: 0 } }));
  // Comparé sur la durée du clip : après sa fin, l'insert continue de sonner (résonance du
  // filtre), le clip traité s'arrête à son bord (comme l'AudioSuite de Pro Tools).
  const cut = b => { const o = new AudioBuffer({ length: b.length, numberOfChannels: 2, sampleRate: SR }); for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch).slice(); for (let i = 0; i < d.length; i++) if (i < Math.round(1.0 * SR) || i >= Math.round(3.0 * SR)) d[i] = 0; o.copyToChannel(d, ch); } return o; };
  out['3c. AudioSuite EQ ≡ EQ en insert (sur la durée du clip)'] = stats(cut(await render(solo(c0, [eq(120)]))), cut(await render(solo(ceq))));

  // --- 4. Bus imprimé (bus coupé) ≡ bus en direct, sur le mix complet.
  const mixB = () => [lead(), back(), busVox(), echo(), verb(), master()];
  const refB = await render(mixB());
  const pr = await B.renderBusPrint(mixB(), 'bus-vox', { tail: 3 });
  const printed = C.printBusTracks(mixB(), 'bus-vox', { id: 'bus-pr', clip: pr.clip, tail: 3, muteBus: true });
  out['4. Bus imprimé ≡ bus en direct (mix complet)'] = { ...stats(refB, await render(printed)), debut_du_rendu_s: pr.clip.start };
  // Le bus seul (muet ailleurs) : son imprimé ≡ ce que le bus envoie au master.
  const onlyBus = mixB().map(t => (t.id === 'echo' || t.id === 'verb' ? { ...t, isMuted: true } : t));
  const onlyPrinted = printed.map(t => (t.id === 'echo' || t.id === 'verb' ? { ...t, isMuted: true } : t));
  out['4b. Bus seul ≡ piste imprimée seule'] = stats(await render(onlyBus), await render(onlyPrinted));
  return out;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3444/"), wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(2500)
    res = pg.evaluate(JS)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    def ok_null(k, lim=-90):
        return res[k]["residu_max_dBFS"] <= lim
    checks = {
        "commit": ok_null("1. Commit ≡ export de la piste"),
        "restaurer": ok_null("1b. Restaurer la piste d’origine ≡ avant") and res["1b. Restaurer la piste d’origine ≡ avant"]["meme_session"],
        "bounce_plage": ok_null("2. Consolider avec effets (plage) ≡ export"),
        "audiosuite_change": res["3. AudioSuite (compresseur FET) : le son change"]["residu_max_dBFS"] > -40,
        "audiosuite_retour": ok_null("3b. Revenir à l’original ≡ original") and res["3b. Revenir à l’original ≡ original"]["clip_identique"],
        "audiosuite_eq_insert": ok_null("3c. AudioSuite EQ ≡ EQ en insert (sur la durée du clip)"),
        "commit_reverbe_insert": ok_null("1c. Commit avec réverbe en insert ≡ export"),
        "bus_imprime": ok_null("4. Bus imprimé ≡ bus en direct (mix complet)"),
        "bus_seul": ok_null("4b. Bus seul ≡ piste imprimée seule"),
    }
    res["_verdict"] = checks
    res["_erreurs_page"] = errs[:5]
    (OUT / "r6_preuves_audio.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("TOUT EST BON" if all(checks.values()) else f"ÉCART : {checks}", "| erreurs page :", errs[:3])
    b.close()
