/**
 * « Monter vers −14 LUFS » quand la crête bloque un simple gain (lot 12) : le limiteur crête
 * vraie de NOVA (engine/limiterCore.ts, celui du master express utils/quickMaster.ts), seul,
 * sans EQ ni Mastering Transient : le son n'est pas recoloré, il est juste plus fort.
 * Gain d'entrée réglé par itérations (méthode de la sécante du master express).
 */
import { limitPass, nextGain, type QmControl } from './quickMaster';
import { lufsOf, truePeakOf } from './audioMeasure';

export interface LevelResult { out: Float32Array[]; inputGainDb: number; lufs: number; truePeak: number }

/** Le limiteur NOVA avec un gain d'entrée donné (rejouable tel quel sur l'instrumental et l'a cappella). */
export async function limitWithGain(ch: Float32Array[], sr: number, inputGainDb: number, ceilingDbtp: number, ctl: QmControl = {}): Promise<Float32Array[]> {
  const stereo = ch.length >= 2 ? ch : [ch[0], ch[0]];
  const out = await limitPass(stereo, sr, { ceilingDb: ceilingDbtp - 0.2, releaseMs: 100, lookaheadMs: 3, oversample: 4 }, inputGainDb, ctl, 'Limiteur NOVA…', 0, 1);
  return ch.length >= 2 ? out : [out[0]];
}

export async function levelWithLimiter(ch: Float32Array[], sr: number, targetLufs: number, ceilingDbtp: number, ctl: QmControl = {}): Promise<LevelResult> {
  const start = lufsOf(ch, sr);
  if (!Number.isFinite(start)) throw new Error('Le morceau est silencieux.');
  const hist: { gain: number; lufs: number }[] = [];
  let gain = Math.max(0, Math.min(18, targetLufs - start));
  let best: { out: Float32Array[]; gain: number; lufs: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const out = await limitWithGain(ch, sr, gain, ceilingDbtp, ctl);
    const l = lufsOf(out, sr);
    hist.push({ gain, lufs: l });
    if (!best || Math.abs(l - targetLufs) < Math.abs(best.lufs - targetLufs)) best = { out, gain, lufs: l };
    if (Math.abs(l - targetLufs) < 0.2) break;
    const next = Math.max(0, Math.min(18, nextGain(hist, targetLufs)));
    if (Math.abs(next - gain) < 0.05) break;
    gain = next;
  }
  // Contrôle final de la crête (le limiteur détecte à ×4).
  const tp = truePeakOf(best!.out, 4, 16);
  if (tp > ceilingDbtp) {
    const g = Math.pow(10, (ceilingDbtp - 0.05 - tp) / 20);
    for (const x of best!.out) for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  return { out: best!.out, inputGainDb: best!.gain, lufs: lufsOf(best!.out, sr), truePeak: truePeakOf(best!.out, 4, 16) };
}
