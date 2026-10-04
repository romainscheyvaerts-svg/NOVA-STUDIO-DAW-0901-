/**
 * Petit client Node du pont VST (ws://127.0.0.1:8765), pour les essais RÉELS
 * (tests/live, lancés seulement avec NOVA_BRIDGE_LIVE=1, pont démarré à part).
 * Même protocole que services/NovaBridge.ts : JSON numérotés + trames binaires.
 */
import fs from 'fs';

export class LiveBridge {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  private blocks = new Map<number, Float32Array>();
  private blockWaiters = new Map<number, () => void>();
  events: any[] = [];

  async open(url = 'ws://127.0.0.1:8765') {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('Pont VST injoignable')); });
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { this.onBinary(ev.data); return; }
      const m = JSON.parse(String(ev.data));
      if (typeof m.req_id === 'number' && this.pending.has(m.req_id)) {
        const cb = this.pending.get(m.req_id)!;
        this.pending.delete(m.req_id);
        cb(m);
      } else this.events.push(m);
    };
  }

  close() { try { this.ws.close(); } catch { /* */ } }

  request(msg: Record<string, any>, timeoutMs = 60000): Promise<any> {
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`Délai dépassé : ${msg.action}`)); }, timeoutMs);
      this.pending.set(req_id, (m) => { clearTimeout(t); if (m.success === false) reject(new Error(m.error || 'erreur')); else resolve(m); });
      this.ws.send(JSON.stringify({ ...msg, req_id }));
    });
  }

  private onBinary(buf: ArrayBuffer) {
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 1) return;
    const L = u8[1];
    const h = (2 + L + 3) & ~3;
    const dv = new DataView(buf);
    const seq = dv.getUint32(h, true);
    const nframes = dv.getUint16(h + 4, true);
    const nch = u8[h + 6];
    const data = new Float32Array(buf.slice(h + 8, h + 8 + nframes * nch * 4));
    this.blocks.set(seq, data);
    this.blockWaiters.get(seq)?.();
  }

  /**
   * Fait passer un signal mono dans un slot en temps réel (blocs de 128, au plus
   * `window` blocs en vol). Renvoie la sortie (canal gauche) et les allers-retours.
   */
  async streamThrough(slotId: string, mono: Float32Array, block = 128, window = 16): Promise<{ out: Float32Array; rttMs: number[] }> {
    const sid = new TextEncoder().encode(slotId);
    const h = (2 + sid.length + 3) & ~3;
    const nblocks = Math.ceil(mono.length / block);
    const out = new Float32Array(nblocks * block);
    const rtt: number[] = [];
    const sent = new Map<number, number>();
    let next = 0;
    let done = 0;
    this.blocks.clear();
    const sendOne = (i: number) => {
      const buf = new ArrayBuffer(h + 8 + block * 4);
      const u8 = new Uint8Array(buf);
      u8[0] = 1; u8[1] = sid.length; u8.set(sid, 2);
      const dv = new DataView(buf);
      dv.setUint32(h, i, true); dv.setUint16(h + 4, block, true); u8[h + 6] = 1; u8[h + 7] = 0;
      const f = new Float32Array(buf, h + 8, block);
      f.set(mono.subarray(i * block, Math.min(mono.length, (i + 1) * block)));
      sent.set(i, performance.now());
      this.ws.send(buf);
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`flux incomplet : ${done}/${nblocks}`)), 600000);
      const pump = () => {
        while (next < nblocks && next - done < window) {
          const i = next++;
          this.blockWaiters.set(i, () => {
            this.blockWaiters.delete(i);
            const d = this.blocks.get(i)!;
            this.blocks.delete(i);
            rtt.push(performance.now() - (sent.get(i) || 0));
            for (let k = 0; k < block; k++) out[i * block + k] = d[k * 2];
            done++;
            if (done === nblocks) { clearTimeout(timer); resolve(); } else pump();
          });
          sendOne(i);
        }
      };
      pump();
    });
    return { out, rttMs: rtt };
  }
}

/** WAV PCM 16 bits mono → Float32Array. */
export const readWavMono = (path: string): { sr: number; data: Float32Array } => {
  const b = fs.readFileSync(path);
  let off = 12;
  let sr = 48000, ch = 1, bits = 16;
  let data: Float32Array | null = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); sr = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') {
      if (bits !== 16) throw new Error('WAV 16 bits attendu');
      const n = Math.floor(size / 2 / ch);
      data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = b.readInt16LE(off + 8 + i * 2 * ch) / 32768;
    }
    off += 8 + size + (size & 1);
  }
  if (!data) throw new Error('WAV sans données');
  return { sr, data };
};

export const writeWavMono = (path: string, sr: number, data: Float32Array) => {
  const n = data.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(path, b);
};
