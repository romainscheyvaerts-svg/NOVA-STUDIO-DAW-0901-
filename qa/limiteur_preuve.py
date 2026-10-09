"""Preuve audio du limiteur NOVA (V15) dans un vrai Chrome headless.

1. Nœud seul (OfflineAudioContext, l'AudioWorklet réel) :
   - signal fort (kick + 808 + charleys + aigus) poussé de +12 dB ;
   - sinus 997 Hz à +6 dBFS.
2. Export réel du projet (audioEngine.renderProject) avec le limiteur inséré
   sur la piste master.
Crête vraie mesurée par deux arbitres : ×4 / 48 coefficients (façon BS.1770)
et ×8 / 64 coefficients. Elle ne doit JAMAIS dépasser le plafond.
Usage : python qa/limiteur_preuve.py [url]   (défaut http://localhost:3417/)
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3417/"
OUT = Path(r"D:\1 WORK\CONTENU\nova-v14-v15")
OUT.mkdir(parents=True, exist_ok=True)

JS = r"""
async () => {
  const { LimiterNode } = await import('/engine/LimiterNode.ts');
  const { truePeakOf, lufsOf, samplePeakOf } = await import('/utils/audioMeasure.ts');
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const SR = 48000;
  const loud = (sec, level) => {
    const n = Math.round(sec * SR), L = new Float32Array(n), R = new Float32Array(n);
    let seed = 777, z1 = 0, z2 = 0, z3 = 0;
    const r0 = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    const rnd = () => { const v = r0(); const r = (v + 3 * z1 + 3 * z2 + z3) / 4; z3 = z2; z2 = z1; z1 = v; return r; };
    for (let i = 0; i < n; i++) {
      const t = i / SR, b = t % 0.5, s = t % 0.125;
      const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-b * 30)) * b) * Math.exp(-b * 8);
      const bass = 0.6 * Math.sin(2 * Math.PI * 49 * t), hat = 0.5 * rnd() * Math.exp(-s * 80);
      const lead = 0.3 * Math.sin(2 * Math.PI * 7350 * t) + 0.25 * Math.sin(2 * Math.PI * 11025.5 * t + 0.3);
      L[i] = level * (kick + bass + hat + lead); R[i] = level * (kick + bass - hat + 0.8 * lead);
    }
    return [L, R];
  };
  const sine = (sec, amp) => { const n = Math.round(sec * SR), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * 997 * i / SR + 0.7); return [x, x.slice()]; };
  const db = v => Math.round(v * 100) / 100;
  const measure = (ch, skip = 0) => { const c = ch.map(x => x.subarray(skip)); return { tp4: db(truePeakOf(c, 4, 48)), tp8: db(truePeakOf(c, 8, 64)), crete_echantillon: db(samplePeakOf(c)), lufs: db(lufsOf(c, SR)) }; };

  const throughNode = async (ch, params) => {
    const ctx = new OfflineAudioContext(2, ch[0].length + SR, SR);
    const buf = ctx.createBuffer(2, ch[0].length, SR); buf.copyToChannel(ch[0], 0); buf.copyToChannel(ch[1], 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lim = new LimiterNode(ctx, params); await lim.ready;
    src.connect(lim.input); lim.output.connect(ctx.destination); src.start(0);
    const out = await ctx.startRendering();
    const lat = Math.round(lim.latency * SR);
    return { ch: [out.getChannelData(0).slice(lat, lat + ch[0].length), out.getChannelData(1).slice(lat, lat + ch[0].length)], lat };
  };
  const res = {};
  const big = loud(8, 0.9);
  res['signal fort : entrée'] = measure(big);
  for (const [ceil, gain] of [[-1, 12], [-0.3, 12], [-1, 0]]) {
    const r = await throughNode(big, { ceiling: ceil, inputGain: gain, oversample: 4, lookahead: 3, release: 80 });
    res[`signal fort +${gain} dB, plafond ${ceil} dBTP`] = { ...measure(r.ch), plafond: ceil, latence_echantillons: r.lat };
  }
  const s = sine(4, 2);
  res['sinus 997 Hz : entrée'] = measure(s);
  for (const ceil of [-1, -0.1]) {
    const r = await throughNode(s, { ceiling: ceil, inputGain: 0, oversample: 4, lookahead: 5, release: 200 });
    res[`sinus 997 Hz +6 dBFS, plafond ${ceil} dBTP`] = { ...measure(r.ch, 9600), plafond: ceil };
  }
  // Export réel : limiteur sur la piste master.
  const b = new AudioBuffer({ length: big[0].length, numberOfChannels: 2, sampleRate: SR });
  b.copyToChannel(big[0], 0); b.copyToChannel(big[1], 1);
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], ...extra });
  const tracks = [
    base('beat', TrackType.AUDIO, { clips: [{ id: 'c1', type: TrackType.AUDIO, start: 0, duration: 8, offset: 0, buffer: b, gain: 1, name: 'beat' }], outputTrackId: 'master' }),
    base('master', TrackType.BUS, { plugins: [{ id: 'lim', type: 'LIMITER', name: 'Nova Limiter', isEnabled: true, params: { ceiling: -1, inputGain: 6, oversample: 4, lookahead: 3, release: 100, isEnabled: true } }] }),
  ];
  const ex = await audioEngine.renderProject(tracks, 8.5, 0, SR);
  res['export du projet (limiteur sur le master, +6 dB)'] = { ...measure([ex.getChannelData(0), ex.getChannelData(1)]), plafond: -1 };
  return res;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    res = pg.evaluate(JS)
    ok = True
    for k, v in res.items():
        if "plafond" in v:
            bon = v["tp4"] <= v["plafond"] + 1e-9 and v["tp8"] <= v["plafond"] + 1e-9
            v["verdict"] = "OK" if bon else "DÉPASSE"
            ok = ok and bon
    print(json.dumps(res, ensure_ascii=False, indent=1))
    print("VERDICT :", "aucun dépassement du plafond en crête vraie" if ok else "DÉPASSEMENT", "| erreurs page :", errs[:3])
    (OUT / "preuve_limiteur.json").write_text(json.dumps({"resultats": res, "ok": ok, "erreurs_page": errs[:5]}, ensure_ascii=False, indent=1), encoding="utf-8")
    b.close()
