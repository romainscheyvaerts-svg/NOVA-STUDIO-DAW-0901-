/**
 * Lot 1 « Voix propre » : moteur de mesure (lancé par qa/mesure_voix_propre.py).
 * Fait tourner EXACTEMENT la chaîne du site (utils/voiceClean + RNNoise WASM de
 * public/wasm/rnnoise) sous Node, sur une liste de fichiers WAV, et note le temps.
 *
 *   npx vite-node qa/mesure_voix_propre_moteur.ts -- travaux.json resultats.json
 *
 * travaux.json : { "jobs": [ { "input": "a.wav", "output": "b.wav",
 *   "options": { "noise": true, "reverb": false, "level": false, "strength": "medium" },
 *   "external": "dfn3.wav" (facultatif : voix déjà passée dans DeepFilterNet 3), "reverb": true } ] }
 * Les WAV d'entrée et de sortie sont en float 32 bits.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createRnnoise } from '../utils/rnnoise';
import { cleanVoice, type CleanCache, type CleanOptions } from '../utils/voiceClean';

interface Job { input: string; output: string; options: CleanOptions; external?: string; reverb?: boolean; cacheKey?: string }

function readWav(p: string): { channels: Float32Array[]; sampleRate: number } {
  const b = readFileSync(p);
  let o = 12, sr = 0, bits = 0, ch = 1, fmt = 1;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { fmt = b.readUInt16LE(o + 8); ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
    if (id === 'data') {
      const bps = bits / 8;
      const n = Math.floor(sz / bps / ch);
      const chs = Array.from({ length: ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        const at = o + 8 + (i * ch + c) * bps;
        chs[c][i] = bits === 32 && fmt === 3 ? b.readFloatLE(at) : bits === 16 ? b.readInt16LE(at) / 32768 : b.readIntLE(at, 3) / 8388608;
      }
      return { channels: chs, sampleRate: sr };
    }
    o += 8 + sz + (sz & 1);
  }
  throw new Error(`WAV illisible : ${p}`);
}

function writeWav(p: string, chs: Float32Array[], sr: number) {
  const n = chs[0].length, ch = chs.length;
  const b = Buffer.alloc(44 + n * ch * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * ch * 4, 28); b.writeUInt16LE(ch * 4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(n * ch * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) b.writeFloatLE(chs[c][i], 44 + (i * ch + c) * 4);
  writeFileSync(p, b);
}

const args = process.argv.slice(2).filter(a => a !== '--');
const [jobsPath, outPath] = args;
const { jobs } = JSON.parse(readFileSync(jobsPath, 'utf8')) as { jobs: Job[] };
const t0 = performance.now();
const engine = await createRnnoise(readFileSync(new URL('../public/wasm/rnnoise/rnnoise.wasm', import.meta.url)));
const loadMs = performance.now() - t0;
const caches = new Map<string, CleanCache>();
const results: unknown[] = [];
for (const job of jobs) {
  const inp = readWav(job.input);
  const external = job.external ? { channels: readWav(job.external).channels, reverb: !!job.reverb } : null;
  const cache = job.cacheKey ? caches.get(job.cacheKey) ?? null : null;
  const t = performance.now();
  const res = cleanVoice({ channels: inp.channels, sampleRate: inp.sampleRate, options: job.options }, { engine, external, cache });
  const ms = performance.now() - t;
  if (job.cacheKey && res.cache) caches.set(job.cacheKey, res.cache);
  writeWav(job.output, res.channels, res.sampleRate);
  results.push({ ...job, ms: Math.round(ms), duration: res.stats.duration, rtf: Math.round((ms / 1000 / res.stats.duration) * 1000) / 1000, cache_reutilise: !!cache, stats: res.stats });
  process.stdout.write('.');
}
writeFileSync(outPath, JSON.stringify({ chargement_wasm_ms: Math.round(loadMs), node: process.version, results }, null, 1));
console.log(`\n${results.length} traitements`);
