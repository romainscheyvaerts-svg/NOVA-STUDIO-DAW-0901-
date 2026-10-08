"""Preuve : « Fredonne → MIDI » au micro, SUR LE BEAT, latence compensée comme une prise normale.

Navigateur headless (aucune fenêtre), vrai moteur de NOVA. Le micro est simulé
dans le moteur lui-même : une « chanteuse » entend le beat (avec la latence de
sortie du navigateur) et chante pile sur les temps qu'elle entend ; sa voix
revient par un vrai MediaStream (getUserMedia remplacé), comme un micro.

1. Moteur : la même chanteuse fait une prise NORMALE (piste armée, REC) puis
   une prise « Fredonne → MIDI » sur le beat. On compare la place de ses
   notes sur la timeline (les deux doivent coïncider) et l'écart aux temps.
2. On entend le morceau : la sortie du master est enregistrée pendant la
   prise, avec « Fredonner sur le beat » coché puis décoché (clic seul).
3. Interface (PC) : la case est cochée par défaut ; « Chanter » lance le
   morceau ; les notes créées tombent sur les temps.
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-accords\\fredonne\\ (mesures.json + captures).

Usage : NOVA_URL=http://127.0.0.1:3437/ PYTHONIOENCODING=utf-8 python qa/fredonne_sur_le_beat.py
"""
import json, os, sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3437/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-finitions-accords\fredonne"
sys.path.insert(0, str(Path(__file__).parent))
from qalib import OUT, Log, new_page, shot, save_log, CHROME  # noqa
from playwright.sync_api import sync_playwright
import numpy as np
from gel_pre_effet import prepare, open_project_file  # noqa
from v20_preuves import make_project, wav_bytes  # noqa

# Chanteuse simulée + beat (clics sur chaque temps à 120 BPM) + enregistrement du master.
SETUP = r"""
async () => {
  const { audioEngine: E } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  await E.init(); await E.resume();
  const ctx = E.ctx, sr = ctx.sampleRate;
  // Micro simulé : chaque getUserMedia reçoit un nouveau flux branché sur la « voix ».
  const voice = ctx.createGain();
  navigator.mediaDevices.getUserMedia = async () => { const d = ctx.createMediaStreamDestination(); voice.connect(d); return d.stream; };
  // Beat : un clic par temps (120 BPM) sur 12 s.
  const beatBuf = new AudioBuffer({ length: 12 * sr, numberOfChannels: 2, sampleRate: sr });
  for (let ch = 0; ch < 2; ch++) { const x = beatBuf.getChannelData(ch); for (let b = 0; b < 24; b++) { const i0 = Math.round(b * 0.5 * sr); for (let i = 0; i < 600; i++) x[i0 + i] = 0.6 * Math.exp(-i / 120) * Math.sin(2 * Math.PI * 1000 * i / sr); } }
  const mk = (id, clips) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], plugins: [], clips, outputTrackId: 'master' });
  const tracks = [mk('beat', [{ id: 'c-beat', type: TrackType.AUDIO, start: 0, duration: 12, offset: 0, buffer: beatBuf, gain: 1, name: 'beat' }]), mk('voix', [])];
  tracks.forEach(t => E.updateTrack(t, tracks));
  // Enregistreur du master (AudioWorklet témoin).
  const code = `class R extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-master-rec', R);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  const rec = new AudioWorkletNode(ctx, 'nova-qa-master-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
  E.masterOutput.connect(rec);
  const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
  /** La chanteuse : chante (sinus 220 Hz, 0,3 s) sur les temps du projet `times`, tels qu'elle les ENTEND (latence de sortie). */
  const sing = (times, playStart) => {
    const lOut = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    for (const t of times) {
      const at = playStart + t + lOut;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 220; g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.5, at + 0.005); g.gain.setValueAtTime(0.5, at + 0.3); g.gain.linearRampToValueAtTime(0, at + 0.31);
      o.connect(g); g.connect(voice); o.start(at); o.stop(at + 0.32);
    }
    return lOut;
  };
  /** Débuts de notes (seuil sur l'enveloppe, après 50 ms de silence). */
  const onsets = (x, start, sr) => { const out = []; let quiet = 1e9; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > 0.05) { if (quiet > 0.05 * sr) out.push(Math.round((start + i / sr) * 100000) / 100000); quiet = 0; } else quiet++; } return out; };
  const masterRms = (from, to) => { let s = 0, n = 0; for (const c of chunks) { const t = c.f / sr; if (t + 128 / sr < from || t > to) continue; for (let i = 0; i < c.d.length; i++) { const ti = (c.f + i) / sr; if (ti >= from && ti < to) { s += c.d[i] * c.d[i]; n++; } } } return n ? Math.round(20 * Math.log10(Math.sqrt(s / n) + 1e-12) * 10) / 10 : null; };
  window.__qaHum = { E, ctx, sr, tracks, sing, onsets, masterRms, chunks };
  return { sr, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency || 0 };
}
"""

ENGINE = r"""
async () => {
  const { E, ctx, sr, tracks, sing, onsets, masterRms, chunks } = window.__qaHum;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const NOTES = [4.0, 4.5, 5.0, 5.5, 6.0];   // temps 1 à 4 de la mesure 3, puis le temps 1 de la mesure 4
  const res = {};
  // 1) Prise NORMALE : piste armée, lecture depuis 2 s, REC, la chanteuse chante sur les temps.
  await E.armTrack('voix');
  E.startPlayback(2.0, tracks);
  await E.startRecording(E.getCurrentTime(), 'voix');
  sing(NOTES, E.playbackStartTime);
  await wait(5200);
  const r = await E.stopRecording(); E.stopAll();
  const normal = r ? onsets(r.clip.buffer.getChannelData(0), r.clip.start, r.clip.buffer.sampleRate) : [];
  res.prise_normale = { notes_s: normal, ecart_ms: normal.map((t, k) => Math.round((t - NOTES[k]) * 1e4) / 10) };
  await wait(300);
  // 2) « Fredonne → MIDI » sur le beat : prise à partir de 4 s (décompte : la mesure 2-4 s, sur le beat).
  for (const onBeat of [true, false]) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks.length = 0;
    const t0 = ctx.currentTime;
    const { recordAt } = await E.startHumTake(stream, tracks, 4.0, 120, 4, onBeat);
    const playStart = recordAt - 4.0;          // temps 0 du projet (horloge)
    const playing = E.getIsPlaying();
    const lOut = sing(NOTES, playStart);
    await wait((recordAt - ctx.currentTime) * 1000 + 2800);
    const h = await E.stopHumTake();
    const hum = h ? onsets(h.data, h.start, h.sr) : [];
    res[onBeat ? 'fredonne_sur_le_beat' : 'fredonne_au_clic'] = {
      lecture_pendant_la_prise: playing,
      niveau_master_decompte_dB: masterRms(recordAt - 1.9, recordAt - 0.05),
      niveau_master_prise_dB: masterRms(recordAt + 0.05, recordAt + 2.4),
      latence_compensee_ms: h ? Math.round(h.latency * 1e4) / 10 : null,
      latence_de_sortie_ms: Math.round(lOut * 1e4) / 10,
      debut_prise_s: h ? Math.round(h.start * 1e5) / 1e5 : null,
      notes_s: hum, ecart_ms: hum.map((t, k) => Math.round((t - NOTES[k]) * 1e4) / 10),
      ecart_avec_prise_normale_ms: hum.map((t, k) => normal[k] === undefined ? null : Math.round((t - normal[k]) * 1e4) / 10),
      sans_compensation_ecart_ms: h ? hum.map((t, k) => Math.round((t + h.latency - NOTES[k]) * 1e4) / 10) : null,
    };
    await wait(400);
  }
  return res;
}
"""


def ui(page, res):
    """Fenêtre « Fredonne → MIDI » : case cochée par défaut, le morceau joue pendant la prise, notes sur les temps."""
    page.evaluate(SETUP)
    # Ouvre la fenêtre (même chemin que le menu : fenêtre Pro Tools « audio-to-midi », micro).
    page.evaluate("async () => { const { openNovaWindow } = await import('/utils/novaWindows.ts'); openNovaWindow('audio-to-midi', { convert: { mode: 'melody', mic: true, instrument: 'piano' } }); }")
    page.wait_for_selector("[data-testid=audio-to-midi]", timeout=10000)
    page.wait_for_timeout(500)
    res["case_presente"] = page.get_by_test_id("hum-on-beat").count() > 0
    res["case_cochee_par_defaut"] = page.get_by_test_id("hum-on-beat").is_checked() if res["case_presente"] else None
    shot(page, "ui_01_fenetre_case_cochee")
    page.get_by_test_id("hum-record").click()
    page.wait_for_function("() => /Décompte/.test(document.querySelector('[data-testid=audio-to-midi]').innerText)", timeout=8000)
    res["decompte_texte"] = page.locator("[data-testid=audio-to-midi]").inner_text()[:400]
    # La chanteuse chante sur les temps 1-4 de la mesure qui suit le décompte.
    res["ui_lecture"] = page.evaluate("""() => { const { E, sing } = window.__qaHum; const h = E.humTake;
      const t = h.from; sing([t, t + 0.5, t + 1.0, t + 1.5], h.playStart); window.__qaFrom = t;
      return { joue: E.getIsPlaying(), prise_a: t, lecture_depuis: Math.round((E.getCurrentTime()) * 1000) / 1000 }; }""")
    shot(page, "ui_02_decompte_le_morceau_joue")
    page.wait_for_function("() => /Je t’écoute/.test(document.querySelector('[data-testid=audio-to-midi]').innerText)", timeout=8000)
    page.wait_for_timeout(2600)
    shot(page, "ui_03_prise")
    page.get_by_test_id("hum-stop").click()
    page.wait_for_function("() => { const d = document.querySelector('[data-testid=audio-to-midi]'); return d && (/notes|Je n’entends/.test(d.innerText)) && !/J’écoute ta/.test(d.innerText); }", timeout=20000)
    page.wait_for_timeout(500)
    shot(page, "ui_04_notes")
    try:
        res["resume"] = page.get_by_test_id("hum-summary").inner_text()
    except Exception:  # noqa
        res["resume"] = page.locator("[data-testid=audio-to-midi]").inner_text()[:300]
    page.get_by_test_id("a2m-create").click(); page.wait_for_timeout(800)
    res["piste_creee"] = page.evaluate("""() => { const s = window.__novaEdit.getState(); const t = s.tracks.find(x => x.id.startsWith('track-hum-'));
      return t ? { name: t.name, debut_clip: t.clips[0].start, notes: t.clips[0].notes.map(n => Math.round((t.clips[0].start + n.start) * 1000) / 1000) } : null; }""")
    res["prise_a"] = page.evaluate("() => window.__qaFrom")
    shot(page, "ui_05_piste_creee")


def main():
    res = {}
    log = Log("fredonne_sur_le_beat")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"])
        ctx, page = new_page(b, "pc", log)
        page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
        page.goto(os.environ["NOVA_URL"], wait_until="domcontentloaded")
        page.wait_for_timeout(3000)
        res["contexte"] = page.evaluate(SETUP)
        res["moteur"] = page.evaluate(ENGINE)
        page.close(); ctx.close()
        # Interface : un projet avec un beat (clics à 120 BPM), la fenêtre au micro.
        sr = 44100
        beat = np.zeros((2, 16 * sr), np.float32)
        for k in range(32):
            i0 = int(k * 0.5 * sr); n = np.arange(600)
            beat[:, i0:i0 + 600] = 0.6 * np.exp(-n / 120) * np.sin(2 * np.pi * 1000 * n / sr)
        proj = OUT / "projet_beat.zip"
        make_project(proj, "Fredonne sur le beat", [("instrumental", "Beat (clics)", wav_bytes(beat, sr), 16.0, 0)], key=(9, "MINOR"), bpm=120)
        ctx, page = new_page(b, "pc", log)
        page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
        prepare(page)
        open_project_file(page, proj, res, "ui_00_projet")
        page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
        try:
            ui(page, res.setdefault("interface", {}))
        except Exception as e:  # noqa
            res["interface"]["exception"] = f"{type(e).__name__}: {str(e)[:400]}"
            shot(page, "ui_echec")
        res["erreurs_page"] = [e["text"][:200] for e in log.errors()][:8]
        b.close()
    save_log(log, {"result": res})
    (OUT / "mesures.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
