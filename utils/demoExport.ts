import { DAWState, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { prepareTracksForOffline } from '../services/VstFreeze';
import { AudioEncoder } from '../services/AudioEncoder';
import { supabaseManager } from '../services/SupabaseManager';
import { getCatalogBeat } from './studioLinks';
import { capTruePeak, MP3_TRUE_PEAK_CEILING } from './loudness';

/**
 * Démo gratuite et extrait partageable.
 *
 * Le fichier propre (WAV, sans tag) reste réservé à l'achat de la licence :
 * ici on rend le mix avec un tag sonore « Make Music » régulier, pour que
 * l'artiste puisse faire écouter / partager son son… et que ça ramène au studio.
 */

const TAG_EVERY = 20; // s

/** Logo sonore synthétique (carillon montant + souffle), ~1 s. */
async function synthTag(sr: number): Promise<AudioBuffer> {
  const len = Math.round(sr * 1.1);
  const ctx = new OfflineAudioContext(2, len, sr);
  const out = ctx.createGain();
  out.gain.value = 0.55;
  out.connect(ctx.destination);
  const notes = [1046.5, 1318.5, 1568, 2093]; // do6 mi6 sol6 do7
  notes.forEach((f, i) => {
    const t = 0.02 + i * 0.09;
    for (const [mult, amp] of [[1, 1], [2.01, 0.25], [3.02, 0.08]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22 * amp, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.75);
    }
  });
  // Souffle « air » montant
  const noise = ctx.createBuffer(1, len, sr);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = noise;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(2000, 0); bp.frequency.exponentialRampToValueAtTime(9000, 0.6);
  const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, 0); ng.gain.exponentialRampToValueAtTime(0.06, 0.3); ng.gain.exponentialRampToValueAtTime(0.0001, 0.9);
  src.connect(bp).connect(ng).connect(out); src.start(0);
  return ctx.startRendering();
}

let tagCache: { sr: number; buf: AudioBuffer } | null = null;

/** Tag vocal du studio s'il existe (public/tag.mp3), sinon le logo synthétique. */
async function getTag(sr: number): Promise<AudioBuffer> {
  if (tagCache && tagCache.sr === sr) return tagCache.buf;
  let buf: AudioBuffer | null = null;
  try {
    const res = await fetch('/tag.mp3', { cache: 'force-cache' });
    if (res.ok && (res.headers.get('content-type') || '').includes('audio')) {
      const raw = await res.arrayBuffer();
      const decoded = await new OfflineAudioContext(2, 1, sr).decodeAudioData(raw);
      buf = decoded;
    }
  } catch { /* pas de tag vocal : logo synthétique */ }
  if (!buf) buf = await synthTag(sr);
  tagCache = { sr, buf };
  return buf;
}

/** Ajoute le tag au rendu : à 2 s puis toutes les 20 s. */
async function applyTag(mix: AudioBuffer): Promise<AudioBuffer> {
  const tag = await getTag(mix.sampleRate);
  for (let t = 2; t < mix.duration - 0.5; t += TAG_EVERY) {
    const at = Math.round(t * mix.sampleRate);
    for (let ch = 0; ch < mix.numberOfChannels; ch++) {
      const dst = mix.getChannelData(ch);
      const src = tag.getChannelData(Math.min(ch, tag.numberOfChannels - 1));
      for (let i = 0; i < src.length && at + i < dst.length; i++) {
        // Léger « ducking » du mix sous le tag. Pas d'écrêtage ici (il
        // saturait le MP3 jusqu'à +3,6 dBTP) : renderTagged plafonne ensuite.
        dst[at + i] = dst[at + i] * 0.75 + src[i];
      }
    }
  }
  return mix;
}

const isVoice = (t: Track) => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;

/** Fin du projet (dernière prise ou fin du beat). */
export function projectEnd(st: DAWState): number {
  let end = 0;
  st.tracks.forEach(t => t.clips.forEach(c => { if (!c.isMuted) end = Math.max(end, c.start + c.duration); }));
  return end;
}

/** Fenêtre de 30 s autour de la voix principale (là où ça se passe). */
export function clipWindow(st: DAWState, length = 30): { start: number; duration: number } {
  const voices = st.tracks.filter(isVoice).flatMap(t => t.clips.filter(c => !c.isMuted));
  const end = projectEnd(st);
  const firstVoice = voices.length ? Math.min(...voices.map(c => c.start)) : 0;
  const start = Math.max(0, Math.min(firstVoice - 1, Math.max(0, end - length)));
  return { start, duration: Math.max(1, Math.min(length, end - start)) };
}

export async function renderTagged(st: DAWState, start: number, duration: number, onProgress?: (p: number) => void): Promise<AudioBuffer> {
  // Effets VST3 du PC : rendus par le pont ou rendu de la sauvegarde (sinon sons secs).
  const prep = await prepareTracksForOffline(st.tracks);
  let mix: AudioBuffer;
  try {
    mix = await audioEngine.renderProject(prep.tracks, duration, start, 44100, onProgress);
  } finally {
    prep.cleanup();
  }
  AudioEncoder.normalizeBuffer(mix, -1);
  await applyTag(mix);
  // Crête vraie sous le plafond MP3 (le tag et l'encodeur ajoutent de la crête).
  capTruePeak(mix, MP3_TRUE_PEAK_CEILING);
  return mix;
}

export async function demoMp3(st: DAWState, onProgress?: (p: number) => void): Promise<Blob> {
  const mix = await renderTagged(st, 0, Math.max(1, projectEnd(st)), onProgress);
  return AudioEncoder.encodeMP3Plafonne(mix, 128);
}

export function fileBaseName(st: DAWState): string {
  const beat = getCatalogBeat(st.tracks)?.title || st.beatTitle || 'mon son';
  return `${beat.replace(/[\\/:*?"<>|]+/g, '').trim()} - Nova Studio (Make Music)`;
}

async function loadCover(st: DAWState): Promise<HTMLImageElement | null> {
  const beat = getCatalogBeat(st.tracks);
  if (!beat) return null;
  try {
    const list = await supabaseManager.getActiveInstrumentals();
    const inst: any = list.find((i: any) => String(i.id) === beat.id);
    if (!inst?.cover_image_url) return null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = inst.cover_image_url;
    await img.decode();
    return img;
  } catch { return null; }
}

/** Format vidéo le mieux accepté par Insta / TikTok que le navigateur sait produire. */
function pickVideoType(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const opts = [
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  return opts.find(o => MediaRecorder.isTypeSupported(o.mime)) || null;
}

export const canMakeVideo = () => !!pickVideoType() && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;

/**
 * Vidéo verticale 30 s (720×1280) : pochette, titre, spectre animé, lien du
 * studio. Enregistrée en temps réel (≈ durée de l'extrait).
 */
export async function clipVideo(st: DAWState, onProgress?: (p: number) => void): Promise<{ blob: Blob; ext: string }> {
  const type = pickVideoType();
  if (!type) throw new Error("Ce navigateur ne sait pas créer de vidéo.");
  const { start, duration } = clipWindow(st);
  const audio = await renderTagged(st, start, duration, p => onProgress?.(p * 0.25));
  const cover = await loadCover(st);
  const title = getCatalogBeat(st.tracks)?.title || st.beatTitle || 'Mon son';

  const W = 720, H = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  // Le moteur peut ne pas être démarré (page rechargée) : on le démarre ici.
  if (!audioEngine.ctx) await audioEngine.init();
  const ctx = audioEngine.ctx!;
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const src = ctx.createBufferSource();
  src.buffer = audio;
  const an = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.75;
  const dest = ctx.createMediaStreamDestination();
  src.connect(an); an.connect(dest);
  const freq = new Uint8Array(an.frequencyBinCount);

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 160_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  const draw = (t: number) => {
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#071016'); bg.addColorStop(0.55, '#07080c'); bg.addColorStop(1, '#130a20');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // Pochette
    const cs = 460, cx = (W - cs) / 2, cy = 190;
    g.save();
    g.shadowColor = 'rgba(34,211,238,0.55)'; g.shadowBlur = 60;
    g.beginPath(); (g as any).roundRect?.(cx, cy, cs, cs, 36); if (!(g as any).roundRect) g.rect(cx, cy, cs, cs);
    g.fillStyle = '#0b0d12'; g.fill();
    g.restore();
    if (cover) {
      g.save(); g.beginPath(); (g as any).roundRect?.(cx, cy, cs, cs, 36); if (!(g as any).roundRect) g.rect(cx, cy, cs, cs); g.clip();
      const s = Math.max(cs / cover.width, cs / cover.height);
      g.drawImage(cover, cx + (cs - cover.width * s) / 2, cy + (cs - cover.height * s) / 2, cover.width * s, cover.height * s);
      g.restore();
    }
    // Textes
    g.textAlign = 'center';
    g.fillStyle = '#67e8f9'; g.font = '600 26px Inter, system-ui, sans-serif';
    g.fillText('MA VOIX SUR UNE PROD MAKE MUSIC', W / 2, 120);
    g.fillStyle = '#ffffff'; g.font = '900 54px Inter, system-ui, sans-serif';
    const tt = title.split('|')[0].trim();
    g.fillText(tt.length > 22 ? tt.slice(0, 21) + '…' : tt, W / 2, 740);
    // Spectre
    an.getByteFrequencyData(freq);
    const bars = 40, bw = 10, gap = 6, total = bars * (bw + gap) - gap, x0 = (W - total) / 2, base = 960;
    for (let b = 0; b < bars; b++) {
      const v = freq[Math.floor(Math.pow(b / bars, 1.7) * freq.length * 0.8)] / 255;
      const h = 8 + v * 160;
      const k = b / (bars - 1);
      g.fillStyle = `rgb(${Math.round(34 + 134 * k)},${Math.round(211 - 126 * k)},${Math.round(238 + 9 * k)})`;
      g.fillRect(x0 + b * (bw + gap), base - h, bw, h * 2 - 16);
    }
    // Progression
    const p = Math.min(1, t / duration);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(80, 1110, W - 160, 6);
    const pg = g.createLinearGradient(80, 0, W - 80, 0); pg.addColorStop(0, '#22d3ee'); pg.addColorStop(1, '#a855f7');
    g.fillStyle = pg; g.fillRect(80, 1110, (W - 160) * p, 6);
    // Appel à l'action
    g.fillStyle = '#ffffff'; g.font = '700 30px Inter, system-ui, sans-serif';
    g.fillText('Essaie ta voix gratuitement', W / 2, 1180);
    g.fillStyle = '#67e8f9'; g.font = '600 26px Inter, system-ui, sans-serif';
    g.fillText('studiomakemusic.com', W / 2, 1222);
  };

  draw(0);
  rec.start(250);
  const t0 = ctx.currentTime + 0.05;
  src.start(t0);
  await new Promise<void>(resolve => {
    const tick = () => {
      const t = ctx.currentTime - t0;
      draw(Math.max(0, t));
      onProgress?.(0.25 + 0.75 * Math.min(1, t / duration));
      if (t >= duration + 0.2) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await new Promise<void>(resolve => { rec.onstop = () => resolve(); rec.stop(); });
  try { src.disconnect(); an.disconnect(); } catch { /* */ }
  return { blob: new Blob(chunks, { type: type.mime.split(';')[0] }), ext: type.ext };
}

export async function clipAudioMp3(st: DAWState, onProgress?: (p: number) => void): Promise<Blob> {
  const { start, duration } = clipWindow(st);
  const mix = await renderTagged(st, start, duration, onProgress);
  return AudioEncoder.encodeMP3Plafonne(mix, 160);
}

/** Partage natif (téléphone) si possible, sinon téléchargement. */
export async function shareOrSave(blob: Blob, filename: string, saveBlob: (b: Blob, n: string) => Promise<void>) {
  const file = new File([blob], filename, { type: blob.type });
  const nav: any = navigator;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Mon son sur une prod Make Music', text: 'Enregistré avec Nova Studio · studiomakemusic.com' });
      return 'shared';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  await saveBlob(blob, filename);
  return 'saved';
}
