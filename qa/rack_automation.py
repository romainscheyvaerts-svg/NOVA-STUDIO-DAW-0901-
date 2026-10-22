"""Automation d'un effet placé dans une branche du « Rack parallèle » (22/10/2026), par le vrai moteur.

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le lancement).
Piste : sinus 220 Hz ; rack : branche 1 = Compresseur NOVA neutre (seuil 0 dB, ratio 1:1) à 0 dB,
branche 2 coupée, mélange 100 %. Voie « plugin::rack::comp/makeupGain » : ×1 jusqu'à 1,2 s puis
rampe jusqu'à ×2 à 1,8 s.

  - export : 0,2-1,0 s = niveau d'origine (0 dB), 2,0-2,8 s = +6,02 dB (±0,1) ; voie en mode Off : 0 dB ;
  - éditeur d'automation : le réglage apparaît (« Branche 1 · Compresseur · Gain de compensation ») ;
  - lecture en temps réel enregistrée au master = export, depuis 0 (écart ≤ 1 LSB 16 bits), 44,1 et 48 kHz.

NOVA_URL=http://127.0.0.1:3525/ python qa/rack_automation.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import APP_MODULE_INIT, CHROME  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3525/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\rack_automation"))
OUT.mkdir(parents=True, exist_ok=True)
SEUIL = 1.0

JS = r"""
async ({ rate }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  const R = await M('/engine/fxRack.ts');
  if (!e.ctx || e.ctx.sampleRate !== rate) await e.setSampleRate(rate);
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);
  const LEN = 3.2;
  const tone = new AudioBuffer({ length: Math.round(LEN * SR), numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) { const x = tone.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / SR) * Math.min(1, i / (0.01 * SR)); }
  const comp = builtinPlugin('COMPRESSOR', { threshold: 0, ratio: 1, makeupGain: 1, knee: 0 }, 'comp');
  const rack = { ...R.rackDefaults(), mix: 100 };
  rack.branches = [{ id: 'rb-1', level: 0, plugins: [comp] }, { id: 'rb-2', level: -80, plugins: [] }];
  const lane = { id: 'l', parameterName: 'plugin::rack::comp/makeupGain', color: '#fb923c', isExpanded: true, min: 0, max: 8,
    points: [{ id: 'a', time: 0, value: 1 }, { id: 'b', time: 1.2, value: 1 }, { id: 'c', time: 1.8, value: 2 }] };
  const mk = mode => [
    { id: 'v', name: 'v', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: 'master', automationMode: mode,
      plugins: [{ id: 'rack', name: 'Rack parallèle', type: 'FXRACK', isEnabled: true, latency: 0, params: rack }],
      clips: [{ id: 'c', type: TrackType.AUDIO, start: 0, duration: LEN, offset: 0, buffer: tone, gain: 1, name: 'c', fadeIn: 0, fadeOut: 0, color: '#fff' }], automationLanes: [lane] },
    { id: 'master', name: 'master', type: TrackType.BUS, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: '', plugins: [], clips: [], automationLanes: [] },
  ];
  const rms = (b, a, z) => { const d = b.getChannelData(0); let s = 0, n = 0; for (let i = Math.floor(a * SR); i < Math.floor(z * SR); i++) { s += d[i] * d[i]; n++; } return 10 * Math.log10(s / n + 1e-30); };
  const out = { frequence: SR };
  for (const mode of ['read', 'off']) {
    const b = await e.renderProject(mk(mode), LEN, 0, SR);
    out['export_' + mode] = { avant_db: +(rms(b, 0.2, 1.0) - 20 * Math.log10(0.2 / Math.SQRT2)).toFixed(3), apres_moins_avant_db: +(rms(b, 2.0, 2.8) - rms(b, 0.2, 1.0)).toFixed(3) };
  }
  // Éditeur d'automation : réglages proposés pour le rack.
  const tracks = mk('read');
  tracks.forEach(t => e.updateTrack(t, tracks)); tracks.forEach(t => e.updateTrack(t, tracks));
  e.setSafetyLimiter(false);
  await new Promise(r => setTimeout(r, 1200));
  e.startPlayback(0, tracks); e.stopAll();
  const prm = (e.getTrackPluginParameters('v')[0] || { params: [] }).params;
  out.editeur = prm.filter(p => p.id.includes('/')).map(p => `${p.id} = ${p.name}`);
  // Lecture en temps réel enregistrée au master = export.
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-rack', R);`;
  if (window.__qaRecRack !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecRack = e.ctx; }
  const dur = 3.0, n = Math.round(dur * SR);
  const ex = await e.renderProject(tracks, dur, 0, SR);
  const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
  const capture = async () => {
    const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-rack', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput();
    const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
    const blocks = []; recNode.port.onmessage = ev => blocks.push(ev.data); recNode.port.postMessage(true);
    await new Promise(r => setTimeout(r, 400));
    const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;
    e.startPlayback(0, tracks, { at });
    const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime, w0 = performance.now();
    while (e.ctx.currentTime - c0 < dur + 0.6 && performance.now() - w0 < 60000) await new Promise(r => setTimeout(r, 50));
    e.stopAll();
    await new Promise(r => setTimeout(r, 200));
    recNode.port.postMessage(false);
    try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), Rr = new Float32Array(n), f0 = Math.round(origin * SR);
    let got = 0;
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i]));
    return { echantillons: got, attendus: n, ecart_lsb16: +(d * 32768).toFixed(4) };
  };
  const essais = [];
  for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (c.ecart_lsb16 <= 1 && c.echantillons >= c.attendus * 0.999) break; }
  out.lecture = essais.filter(x => x.echantillons >= x.attendus * 0.999).reduce((a, b) => (!a || b.ecart_lsb16 < a.ecart_lsb16 ? b : a), null) || essais[essais.length - 1];
  out.lecture.tentatives = essais.length;
  tracks.forEach(t => e.disposeTrack(t.id));
  return out;
}
"""

checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def main():
    res = {"url": URL, "mesures": {}}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(300000)
        for rate in (44100, 48000):
            try:
                r = pg.evaluate(JS, {"rate": rate})
            except Exception as ex:
                r = {"erreur": str(ex)[:300]}
            res["mesures"][str(rate)] = r
            print(rate, json.dumps(r, ensure_ascii=False), flush=True)
            t = f"[{rate} Hz]"
            er, eo = r.get("export_read") or {}, r.get("export_off") or {}
            check(f"{t} export : avant la voie, niveau d'origine (0 dB ±0,05)", abs(er.get("avant_db", 9)) <= 0.05, er)
            check(f"{t} export : gain de compensation automatisé ×1 → ×2 dans la branche = +6,02 dB (±0,1)", abs(er.get("apres_moins_avant_db", 0) - 6.0206) <= 0.1, er)
            check(f"{t} export : voie en mode Off = aucun changement (±0,05 dB)", abs(eo.get("apres_moins_avant_db", 9)) <= 0.05, eo)
            check(f"{t} éditeur d'automation : réglages des effets de la branche proposés (Compresseur · Gain de compensation)",
                  any("comp/makeupGain" in x and "Branche 1" in x and "Gain de compensation" in x for x in (r.get("editeur") or [])), r.get("editeur"))
            lec = r.get("lecture") or {}
            check(f"{t} lecture = export au bit près (≤ {SEUIL} LSB 16 bits)", lec.get("ecart_lsb16", 99) <= SEUIL and lec.get("echantillons", 0) >= lec.get("attendus", 1) * 0.999, lec)
        res["erreurs_page"] = errs[:5]
        check("aucune erreur de page", not errs, errs[:5])
        b.close()
    res["checks"] = checks
    res["ok"] = all(c["ok"] for c in checks)
    (OUT / "rack_automation.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", f"{sum(c['ok'] for c in checks)}/{len(checks)}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
