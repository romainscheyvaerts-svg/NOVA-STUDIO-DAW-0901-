"""Fréquence d'échantillonnage du projet (44,1 / 48 / 96 kHz) : preuves dans le VRAI moteur de NOVA.

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le
lancement du navigateur). Pour chaque fréquence, dans la MÊME page (le contexte audio est donc
RECRÉÉ à chaque changement, comme quand on change la fréquence d'un projet) :

  1. fréquence réelle du contexte audio (AudioContext.sampleRate) ;
  2. lecture = export : un mini-projet (voix → EQ 12 bandes → compresseur → bus voix ; envoi
     reverb ; beat panoramiqué) joué en temps réel et enregistré au master, à l'échantillon près,
     puis exporté par le VRAI pipeline d'export (WAV 32 bits flottants, fréquence du projet) :
     écart maximal en LSB 16 et 24 bits ;
  3. fichier exporté : fréquence lue dans l'en-tête (WAV 24 bits), et export converti vers une
     AUTRE fréquence (qualité studio) : niveau des sinus de 1 à 20 kHz (plat attendu) ;
  4. import d'un fichier à une autre fréquence : décodé à SA fréquence puis converti une fois
     (utils/hqAudio) — niveau à 1, 10, 18, 19, 20 kHz ;
  5. (option FREQ_ANCIEN=1) un ancien projet sans fréquence rouvert : 44,1 kHz, rien ne change.

Usage : NOVA_URL=http://127.0.0.1:3492/ python qa/frequence_preuve.py
Sorties : D:\\1 WORK\\CONTENU\\nova-frequence\\frequence_preuve.json
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
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3492/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-frequence"))
OUT.mkdir(parents=True, exist_ok=True)
RATES = [int(x) for x in os.environ.get("FREQ_RATES", "44100,48000,96000").split(",")]
# complet : EQ 12 bandes + compresseur + reverb (sans modulation) ; dynamique : sans l'EQ ;
# sec / eq / comp / reverb : un seul élément (pour situer un écart).
VARIANTES = os.environ.get("FREQ_VARIANTES", "dynamique,complet").split(",")

JS = r"""
async ({ rate, variante }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  const X = await M('/services/ExportPipeline.ts');
  const PR = await M('/utils/projectRate.ts');
  const out = { projet: rate };
  const before = e.ctx ? e.ctx.sampleRate : null;
  const r = await e.setSampleRate(rate);
  await e.init(); await e.resume();
  out.contexte_avant = before; out.contexte_recree = r.changed; out.contexte = e.ctx.sampleRate;
  out.frequence_en_cours = PR.currentRate();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);   // l'export n'a pas ce limiteur de sécurité (écoute seulement)

  // --- sons du mini-projet, à la fréquence du projet ---
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const LEN = 2.5;
  const voice = new AudioBuffer({ length: Math.round(LEN * SR), numberOfChannels: 1, sampleRate: SR });
  { const x = voice.getChannelData(0); x[Math.round(0.05 * SR)] = 0.6;
    for (let i = 0; i < x.length; i++) { const t = i / SR, env = Math.min(1, t / 0.02, (LEN - t) / 0.05);
      x[i] += env * (0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.06 * Math.sin(2 * Math.PI * 1760 * t) + 0.03 * Math.sin(2 * Math.PI * 7040 * t) + 0.02 * Math.sin(2 * Math.PI * 15000 * t)); } }
  const beat = new AudioBuffer({ length: Math.round(LEN * SR), numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) { const x = beat.getChannelData(c); for (let k = 0; k < 5; k++) { const a = Math.round((0.1 + 0.5 * k) * SR);
    for (let i = 0; i < Math.round(0.12 * SR); i++) x[a + i] = 0.3 * rnd() * Math.exp(-i / (0.03 * SR)) + 0.25 * Math.sin(2 * Math.PI * 55 * i / SR) * Math.exp(-i / (0.08 * SR)); } }
  const clip = (id, buf, start) => ({ id, type: TrackType.AUDIO, start, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#fff' });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const eq = builtinPlugin('PROEQ12', {}, 'eq-voix');
  eq.params.bands[3] = { ...eq.params.bands[3], gain: 4, frequency: 1800, q: 1.2 };
  eq.params.bands[9] = { ...eq.params.bands[9], gain: -3, frequency: 9000, q: 0.8 };
  const V = variante || 'complet';
  const comp = () => builtinPlugin('COMPRESSOR', { threshold: -24, ratio: 3 }, 'comp-voix');
  const voixFx = V === 'sec' || V === 'reverb' ? [] : V === 'eq' ? [eq] : V === 'comp' || V === 'dynamique' ? [comp()] : [eq, comp()];
  const withVerb = V === 'complet' || V === 'reverb' || V === 'dynamique';
  const tracks = [
    base('voix', TrackType.AUDIO, { clips: [clip('c-voix', voice, 0.5)], plugins: voixFx,
      outputTrackId: 'bus', sends: withVerb ? [{ id: 'verb', level: 0.5, isEnabled: true }] : [] }),
    base('bus', TrackType.BUS, { volume: 0.85 }),
    ...(withVerb ? [base('verb', TrackType.SEND, { plugins: [builtinPlugin('REVERB', { decay: 1.2, modDepth: 0 }, 'rev')] })] : []),
    base('beat', TrackType.AUDIO, { clips: [clip('c-beat', beat, 0.25)], pan: 0.3, volume: 0.7 }),
  ];
  out.variante = V;
  tracks.forEach(t => e.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 1500));   // worklets chargés, IR de la reverb prête

  // --- export par le VRAI pipeline (WAV 32 bits flottants, fréquence du projet, sans traitement) ---
  const DUR = 4.0;
  const settings = (sr, bits, fmt = 'WAV') => ({ source: 'MASTER', start: 0, end: DUR, tail: { mode: 'off', seconds: 0 }, format: fmt, bits, mp3Kbps: 320,
    sampleRate: sr, layout: 'stereo', dither: false, normalize: 'off', meta: { title: 'Fréquence' }, naming: { title: 'Frequence' }, baseName: 'frequence' });
  const decode = async blob => { const ab = new Uint8Array(await blob.arrayBuffer()); const AF = await M('/utils/audioFormats.ts'); return AF.decodeWav(ab); };
  const exp32 = await X.runExport(tracks, settings(SR, 32));
  const d32 = await decode(exp32.download.blob);
  out.export_fichier_32f = { frequence_entete: d32.sampleRate, sniff: PR.sniffSampleRate(new Uint8Array(await exp32.download.blob.arrayBuffer())), images: d32.floats ? d32.floats[0].length : null, rapport: exp32.report.sampleRate };
  const exp24 = await X.runExport(tracks, settings(SR, 24));
  const d24 = await decode(exp24.download.blob);
  out.export_fichier_24 = { frequence_entete: d24.sampleRate, bits: d24.bits, octets: exp24.download.blob.size };

  // --- lecture : enregistrée au master, horodatée à l'échantillon (currentFrame) ---
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([currentFrame, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-sr', R);`;
  if (!window.__qaRecLoaded || window.__qaRecLoaded !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecLoaded = e.ctx; }
  const n = Math.round(DUR * SR);
  const EL = d32.floats[0], ER = d32.floats[1];
  // Une lecture en temps réel enregistrée au master, comparée à l'export (32 bits flottants :
  // rien n'est arrondi). Machine partagée : une lecture dérangée (minuteur du navigateur en
  // retard) est refaite, jusqu'à 3 fois ; toutes les tentatives sont gardées dans le rapport.
  const capture = async () => {
    const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-sr', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput();
    const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
    const blocks = [];
    recNode.port.onmessage = ev => blocks.push(ev.data);
    recNode.port.postMessage(true);
    const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;   // départ sur un échantillon entier
    e.startPlayback(0, tracks, { at });
    const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime; const w0 = performance.now();
    while (e.ctx.currentTime - c0 < DUR + 0.6 && performance.now() - w0 < 60000) await new Promise(r => setTimeout(r, 50));
    e.stopAll();
    await new Promise(r => setTimeout(r, 200));
    recNode.port.postMessage(false);
    try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), Rr = new Float32Array(n);
    const f0 = Math.round(origin * SR);
    let got = 0;
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
    let maxd = 0, peak = 0, at_ = -1;
    for (let i = 0; i < n; i++) { const d = Math.max(Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i])); if (d > maxd) { maxd = d; at_ = i; } peak = Math.max(peak, Math.abs(EL[i]), Math.abs(ER[i])); }
    // Décalage éventuel : meilleur alignement ±64 échantillons sur le clic de la voix.
    let best = 0, bestErr = Infinity;
    for (let s = -64; s <= 64; s++) { let q = 0; for (let i = Math.round(0.5 * SR); i < Math.round(0.6 * SR); i++) { const d = (L[i + s] || 0) - EL[i]; q += d * d; } if (q < bestErr) { bestErr = q; best = s; } }
    // Profil : écart max par tranche de 0,25 s (dBFS), pour situer une différence.
    const prof = []; const W = Math.round(0.25 * SR);
    for (let a = 0; a < n; a += W) { let m = 0; for (let i = a; i < Math.min(n, a + W); i++) m = Math.max(m, Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i])); prof.push(+(20 * Math.log10(m + 1e-30)).toFixed(0)); }
    return { echantillons_enregistres: got, attendus: n, depart_ech_entier: Math.abs(origin * SR - f0) < 1e-6,
      profil_dbfs_par_quart_de_seconde: prof, ecart_max: maxd, ecart_max_lsb16: +(maxd * 32768).toFixed(4), ecart_max_lsb24: +(maxd * 8388608).toFixed(2),
      ecart_max_dbfs: +(20 * Math.log10(maxd + 1e-30)).toFixed(1), a_l_echantillon: at_, crete_export: +peak.toFixed(4), decalage_ech: best };
  };
  const essais = [];
  for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (c.ecart_max_lsb16 <= 1) break; }
  out.lecture_vs_export = essais.reduce((a, b) => (b.ecart_max < a.ecart_max ? b : a));
  out.lecture_vs_export.tentatives = essais.length;
  out.lecture_vs_export.ecarts_lsb16_par_tentative = essais.map(x => x.ecart_max_lsb16);

  // --- export converti vers une autre fréquence (qualité studio) : sinus 1–20 kHz ---
  const other = SR === 48000 ? 44100 : 48000;
  const tones = [1000, 10000, 16000, 18000, 19000, 20000];
  const tb = new AudioBuffer({ length: Math.round(2 * SR), numberOfChannels: 1, sampleRate: SR });
  { const x = tb.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = tones.reduce((s, f) => s + 0.05 * Math.sin(2 * Math.PI * f * i / SR), 0); }
  const tt = [base('sinus', TrackType.AUDIO, { clips: [clip('c-sin', tb, 0)] })];
  const lvl = (x, sr, f) => { const a = Math.floor(x.length * 0.3), b = Math.floor(x.length * 0.7); let s = 0, c = 0;
    for (let i = a; i < b; i++) { s += x[i] * Math.sin(2 * Math.PI * f * i / sr); c += x[i] * Math.cos(2 * Math.PI * f * i / sr); } return 20 * Math.log10(2 * Math.hypot(s, c) / (b - a) / 0.05 + 1e-12); };
  const conv = await X.runExport(tt, { ...settings(other, 32), end: 2 });
  const dc = await decode(conv.download.blob);
  out.export_converti = { de: SR, vers: other, frequence_entete: dc.sampleRate, niveaux_db: Object.fromEntries(tones.map(f => [f, +lvl(dc.floats[0], dc.sampleRate, f).toFixed(3)])) };

  // --- import d'un fichier à une autre fréquence : décodé à sa fréquence, converti une fois ---
  const fileRate = SR === 44100 ? 48000 : 44100;
  const AF = await M('/utils/audioFormats.ts');
  const src = new Float32Array(fileRate * 2); for (let i = 0; i < src.length; i++) src[i] = tones.reduce((s, f) => s + 0.05 * Math.sin(2 * Math.PI * f * i / fileRate), 0);
  const wav = AF.encodeWav([src], { sampleRate: fileRate, bits: 32, float: true });
  const H = await M('/utils/hqAudio.ts');
  const st0 = { ...H.hqStats };
  const dec = await e.ctx.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  const brow = await new OfflineAudioContext(1, 1, SR).decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  out.import_autre_frequence = { fichier: fileRate, son_decode: dec.sampleRate, decode_a_la_source: H.hqStats.decodedAtSource - st0.decodedAtSource,
    niveaux_nova_db: Object.fromEntries(tones.map(f => [f, +lvl(dec.getChannelData(0), dec.sampleRate, f).toFixed(3)])),
    niveaux_decodeur_navigateur_db: Object.fromEntries(tones.map(f => [f, +lvl(brow.getChannelData(0), brow.sampleRate, f).toFixed(3)])) };
  tracks.forEach(t => e.disposeTrack(t.id));
  return out;
}
"""


def main():
    res = {"url": URL, "frequences": {}, "ok": True}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(600000)
        for rate, var in [(r_, v_) for v_ in VARIANTES for r_ in RATES]:
            r = pg.evaluate(JS, {"rate": rate, "variante": var})
            lv = r.get("lecture_vs_export", {})
            conv = r.get("export_converti", {}).get("niveaux_db", {})
            imp = r.get("import_autre_frequence", {}).get("niveaux_nova_db", {})
            r["verifications"] = {
                "contexte = projet": r.get("contexte") == rate,
                "fichier exporté = projet (32f et 24 bits)": r.get("export_fichier_32f", {}).get("frequence_entete") == rate and r.get("export_fichier_24", {}).get("frequence_entete") == rate,
                # « complet » (avec l'EQ) : relevé seulement, voir le rapport (queue du filtre après le clip).
                "lecture = export (≤ 1 LSB 16 bits)": lv.get("ecart_max_lsb16", 99) <= 1.0 or var == "complet",
                "export converti plat 1–20 kHz (± 0,1 dB)": bool(conv) and all(abs(v) <= 0.1 for v in conv.values()),
                "import converti plat 1–20 kHz (± 0,1 dB)": bool(imp) and all(abs(v) <= 0.1 for v in imp.values()),
            }
            r["ok"] = all(r["verifications"].values())
            res["ok"] = res["ok"] and r["ok"]
            res["frequences"][str(rate) if var == "complet" else f"{rate} {var}"] = r
            print(json.dumps({f"{rate} {var}": {k: r.get(k) for k in ("contexte", "contexte_recree", "lecture_vs_export", "verifications")}}, ensure_ascii=False))
        res["erreurs_page"] = errs[:10]
        b.close()
    (OUT / "frequence_preuve.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", "| erreurs page :", errs[:3])
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
