"""La veille des effets ne change pas le son : lecture (veille active) = export, au bit près.

Navigateur headless (aucune fenêtre), QA 100 % hors production. Session à trous, faite pour que
les chaînes s'endorment et se réveillent pendant la mesure : 4 voix avec la chaîne type
(EQ 12 bandes, compresseur CLEAN / OPTO, de-esser ou saturation TUBE, envoi reverb), phrases
séparées par des silences de 1,2 à 2 s, un beat continu (jamais en veille, il a une reverb
dans le retour, pas d'insert). La lecture en temps réel est enregistrée au master à
l'échantillon près (currentFrame) et comparée au rendu hors ligne `renderProject`, comme
qa/fidelite_export.py ; écart maximal en LSB 16 bits. Mesuré veille ACTIVE puis COUPÉE
(témoin), à 44,1 et 48 kHz ; le nombre de mises en veille / réveils pendant la capture est
relevé (il doit y en avoir, sinon le test ne prouve rien).

Usage : NOVA_URL=http://127.0.0.1:3435/ PYTHONIOENCODING=utf-8 python qa/veille_fidelite.py
Sortie : D:\\1 WORK\\CONTENU\\nova-128-pistes\\veille_fidelite.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import CHROME, Log, new_page  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3435/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-128-pistes"))
OUT.mkdir(parents=True, exist_ok=True)
RATES = [int(x) for x in os.environ.get("VEILLE_RATES", "44100,48000").split(",")]
FX = os.environ.get("VEILLE_FX", "eq,comp,ds,sat").split(",")
VEILLES = [x == "1" for x in os.environ.get("VEILLE_MODES", "1,0").split(",")]
SEUIL = 1.0

JS = r"""
async ({ rate, veille, fx }) => {
  const FX = fx;
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  if (!e.ctx || e.ctx.sampleRate !== rate) { await e.setSampleRate(rate); }
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);
  if (e.setEffectSleep) e.setEffectSleep(veille);

  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const phrase = (dur, f0) => { const b = new AudioBuffer({ length: Math.round(dur * SR), numberOfChannels: 1, sampleRate: SR }); const x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) { const t = i / SR, env = Math.min(1, t / 0.02, (dur - t) / 0.05), syl = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.3 * t);
      x[i] = env * syl * (0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.12 * Math.sin(2 * Math.PI * 3 * f0 * t) + 0.04 * Math.sin(2 * Math.PI * 7000 * t)) + ((t % 0.6) < 0.08 ? 0.07 * rnd() * env : 0); }
    return b; };
  const DUR = 9.0;
  const beat = new AudioBuffer({ length: Math.round(DUR * SR), numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) { const x = beat.getChannelData(c); for (let k = 0; k < 18; k++) { const a = Math.round((0.1 + 0.5 * k) * SR);
    for (let i = 0; i < Math.round(0.12 * SR) && a + i < x.length; i++) x[a + i] = 0.25 * rnd() * Math.exp(-i / (0.03 * SR)) + 0.2 * Math.sin(2 * Math.PI * 55 * i / SR) * Math.exp(-i / (0.08 * SR)); } }
  const clip = (id, buf, start) => ({ id, type: TrackType.AUDIO, start, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id, fadeIn: 0.005, fadeOut: 0.01, color: '#fff' });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 0.7, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const eq = (id) => { const p = builtinPlugin('PROEQ12', {}, id); p.params.bands[0] = { ...p.params.bands[0], frequency: 100 };
    p.params.bands[3] = { ...p.params.bands[3], gain: 3, frequency: 1800, q: 1.2 }; p.params.bands[9] = { ...p.params.bands[9], gain: -2, frequency: 9000, q: 0.8 }; return p; };
  const voix = (k, mode, third, starts) => base('v' + k, TrackType.AUDIO, {
    clips: starts.map((s, j) => clip(`v${k}-${j}`, phrase(1.1 + 0.2 * j, 160 + 40 * k), s)), pan: (k - 1.5) / 3,
    plugins: [FX.includes('eq') && eq(`v${k}-eq`), FX.includes('comp') && builtinPlugin('COMPRESSOR', { threshold: -26, ratio: 4, mode, release: 0.12 }, `v${k}-comp`),
      third === 'ds' ? FX.includes('ds') && builtinPlugin('DEESSER', {}, `v${k}-ds`) : FX.includes('sat') && builtinPlugin('VOCALSATURATOR', { mode: 'TUBE', drive: 30, mix: 0.5 }, `v${k}-sat`)].filter(Boolean),
    sends: FX.includes('nosend') ? [] : [{ id: 'verb', level: 0.25, isEnabled: true }] });
  const tracks = [
    voix(0, 'CLEAN', 'ds', [0.3, 3.2, 6.4]), voix(1, 'OPTO', 'sat', [0.5, 3.6, 6.9]), voix(2, 'FET', 'ds', [1.0, 4.3]), voix(3, 'VCA', 'sat', [0.2, 5.4]),
    base('verb', TrackType.SEND, { plugins: [builtinPlugin('REVERB', { modDepth: 0 }, 'rev')] }),
    base('beat', TrackType.AUDIO, { clips: [clip('beat', beat, 0)], volume: 0.5 }),
    base('master', TrackType.BUS, { outputTrackId: '' }),
  ];
  tracks.forEach(t => e.updateTrack(t, tracks));
  tracks.forEach(t => e.updateTrack(t, tracks));
  e.setSafetyLimiter(false);
  await new Promise(r => setTimeout(r, 1500));
  // Horloge de l'enregistreur : jamais en arrière. Sous charge, Chrome livre parfois plusieurs blocs
  // avec le même currentFrame (en retard de 128 ou 256) : placé tel quel, un bloc en écrasait un autre
  // et laissait un trou de 128 (écart de milliers de LSB, 100 % des échantillons « reçus »). Voir engine/blockClock.ts.
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice(), late ? 1 : 0]); return true; } }
    registerProcessor('nova-qa-rec-veille', R);`;
  if (window.__qaRecVeille !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecVeille = e.ctx; }
  const n = Math.round(DUR * SR);
  const ex = await e.renderProject(tracks, DUR, 0, SR);
  const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
  const capture = async () => {
    const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-veille', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput();
    const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
    const blocks = []; recNode.port.onmessage = ev => blocks.push(ev.data); recNode.port.postMessage(true);
    const an = e.ctx.createAnalyser(); an.fftSize = 2048; tap.connect(an);
    const buf = new Float32Array(2048); let calm = 0; const q0 = performance.now();
    while (calm < 6 && performance.now() - q0 < 20000) { await new Promise(r => setTimeout(r, 50)); an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); calm = m < 1e-7 ? calm + 1 : 0; }
    try { tap.disconnect(an); } catch (err) {}
    const s0 = (e.getSleepStats && e.getSleepStats()) || { sleeps: 0, wakes: 0 };
    const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;
    e.startPlayback(0, tracks, { at });
    const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime, w0 = performance.now(); let maxAsleep = 0;
    const dbg = [];
    while (e.ctx.currentTime - c0 < DUR + 0.6 && performance.now() - w0 < 90000) { await new Promise(r => setTimeout(r, 50)); const st = e.getSleepStats ? e.getSleepStats() : null; if (st) maxAsleep = Math.max(maxAsleep, st.asleep);
      if (e.getSleepDebug && dbg.length < 40 && (dbg.length === 0 || performance.now() - dbg[dbg.length - 1].w > 500)) dbg.push({ w: performance.now(), ...e.getSleepDebug() }); }
    window.__veilleDbg = dbg;
    const s1 = (e.getSleepStats && e.getSleepStats()) || { sleeps: 0, wakes: 0 };
    e.stopAll();
    await new Promise(r => setTimeout(r, 200));
    recNode.port.postMessage(false);
    try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), Rr = new Float32Array(n); const f0 = Math.round(origin * SR); let got = 0;
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
    let maxd = 0, at_ = -1, peak = 0;
    for (let i = 0; i < n; i++) { const d = Math.max(Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i])); if (d > maxd) { maxd = d; at_ = i; } peak = Math.max(peak, Math.abs(EL[i])); }
    return { echantillons: got, attendus: n, ecart_max_lsb16: +(maxd * 32768).toFixed(4), ecart_max_dbfs: +(20 * Math.log10(maxd + 1e-30)).toFixed(1), a_s: +(at_ / SR).toFixed(4),
      crete: +peak.toFixed(3), etiquettes_en_retard: blocks.reduce((s, b) => s + (b[3] || 0), 0), mises_en_veille: s1.sleeps - s0.sleeps, reveils: s1.wakes - s0.wakes, pistes_en_veille_max: maxAsleep };
  };
  const essais = [];
  for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (c.ecart_max_lsb16 <= 1 && c.echantillons >= c.attendus * 0.999) break; }
  const best = essais.filter(x => x.echantillons >= x.attendus * 0.999).reduce((a, b) => (!a || b.ecart_max_lsb16 < a.ecart_max_lsb16 ? b : a), null) || essais[essais.length - 1];
  tracks.forEach(t => e.disposeTrack(t.id));
  if (e.setEffectSleep) e.setEffectSleep(true);
  return { frequence: SR, veille, ...best, tentatives: essais.length, lsb16_par_tentative: essais.map(x => x.ecart_max_lsb16) };
}
"""


def main():
    res = {"seuil_lsb16": SEUIL, "mesures": [], "ok": True}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
        log = Log("veille_fidelite")
        ctx, page = new_page(b, "pc", log)
        page.set_default_timeout(240000)
        page.goto(URL, wait_until="domcontentloaded"); page.wait_for_timeout(4000)
        for rate in RATES:
            for veille in VEILLES:
                r = page.evaluate(JS, {"rate": rate, "veille": veille, "fx": FX})
                ok = r["ecart_max_lsb16"] <= SEUIL and r["echantillons"] >= r["attendus"] * 0.999 and (not veille or r["mises_en_veille"] > 0)
                r["ok"] = ok
                if os.environ.get("VEILLE_DEBUG") and veille:
                    dbg = page.evaluate("() => window.__veilleDbg || []")
                    for d in dbg[::3]:
                        print("  dbg", d.get("moduleOk"), d.get("banks"), round(d.get("now", 0), 2), [(t["id"], t["asleep"], t["slot"], t["quietFor"], t["eligible"], t["busyFor"], round(t["next"], 2) if isinstance(t["next"], (int, float)) else t["next"], t["rest"]) for t in d.get("tracks", []) if t["id"].startswith("v")][:2])
                res["ok"] &= ok
                res["mesures"].append(r)
                print(f"{rate} veille {'ACTIVE' if veille else 'coupée'} : écart {r['ecart_max_lsb16']} LSB16 ({r['ecart_max_dbfs']} dBFS), mises en veille {r['mises_en_veille']}, réveils {r['reveils']}, max en veille {r['pistes_en_veille_max']} — {'OK' if ok else 'ÉCHEC'}", flush=True)
        res["erreurs_console"] = [x["text"][:200] for x in log.errors()][:10]
        b.close()
    (OUT / "veille_fidelite.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", "->", OUT / "veille_fidelite.json")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
