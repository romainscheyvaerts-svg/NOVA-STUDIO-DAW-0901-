/**
 * VST Bridge Worker v5 (nom versionné : voir vst-bridge-processor-v5.js)
 *
 * Tient la connexion AUDIO avec le pont VST (ws://127.0.0.1:8765) hors du
 * thread principal : un rendu React ou un calcul de forme d'onde ne retarde
 * plus les blocs audio. Chaque effet VST3 (AudioWorklet) a son MessagePort.
 *
 * Trame binaire (little-endian), aller et retour :
 *   u8 type=1 | u8 L | slot_id (L octets UTF-8) | bourrage jusqu'à un multiple de 4
 *   | u32 seq | u16 nframes | u8 nch | u8 flags | float32[nframes*nch] entrelacés
 *   v5 : flags & 1 → réglages horodatés après l'audio :
 *        u16 count | u16 0 | count × (u16 index, u16 décalage, f32 valeur brute)
 *        flags & 2 → nch = 4, canaux 3-4 = clé de side-chain.
 *   v5 (insert ARA, pont v12) : flags & 4 → f64 position du morceau (échantillons, -1 = arrêt)
 *        juste après l'audio, AVANT les réglages horodatés.
 *   Retour : toujours nch = 2, flags = 0.
 */

let ws = null;
let url = null;
const ports = new Map();     // slotId -> MessagePort
const headers = new Map();   // slotId -> { bytes, headerLen }
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const align4 = (n) => (n + 3) & ~3;

function connect() {
  if (!url) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => postMessage({ type: 'open' });
  ws.onclose = () => { ws = null; postMessage({ type: 'closed' }); };
  ws.onerror = () => { /* onclose suit */ };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const buf = ev.data;
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 1) return;
    const L = u8[1];
    const slotId = decoder.decode(u8.subarray(2, 2 + L));
    const h = align4(2 + L);
    const dv = new DataView(buf);
    const seq = dv.getUint32(h, true);
    const nframes = dv.getUint16(h + 4, true);
    const nch = dv.getUint8(h + 6);
    const port = ports.get(slotId);
    if (!port) return;
    // Copie vers un buffer dédié : transférable au worklet sans copie supplémentaire.
    const data = new Float32Array(nframes * 2);
    const src = new Float32Array(buf, h + 8, nframes * nch);
    if (nch === 2) data.set(src);
    else for (let i = 0; i < nframes; i++) { data[2 * i] = src[i]; data[2 * i + 1] = src[i]; }
    port.postMessage({ seq, data }, [data.buffer]);
  };
}

function header(slotId) {
  let h = headers.get(slotId);
  if (!h) {
    const bytes = encoder.encode(slotId).subarray(0, 255);
    h = { bytes, headerLen: align4(2 + bytes.length) + 8 };
    headers.set(slotId, h);
  }
  return h;
}

function sendBlock(slotId, seq, data, nch, params, tl) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { bytes, headerLen } = header(slotId);
  const ch = nch === 4 ? 4 : 2;
  const nframes = data.length / ch;
  const pc = params ? Math.floor(params.length / 3) : 0;
  const hasTl = typeof tl === 'number';
  const extra = (pc ? 4 + pc * 8 : 0) + (hasTl ? 8 : 0);
  const buf = new ArrayBuffer(headerLen + data.byteLength + extra);
  const u8 = new Uint8Array(buf);
  u8[0] = 1;
  u8[1] = bytes.length;
  u8.set(bytes, 2);
  const dv = new DataView(buf);
  const h = headerLen - 8;
  dv.setUint32(h, seq >>> 0, true);
  dv.setUint16(h + 4, nframes, true);
  dv.setUint8(h + 6, ch);
  dv.setUint8(h + 7, (pc ? 1 : 0) | (ch === 4 ? 2 : 0) | (hasTl ? 4 : 0));
  new Float32Array(buf, headerLen, data.length).set(data);
  if (hasTl) dv.setFloat64(headerLen + data.byteLength, tl, true);
  if (pc) {
    let o = headerLen + data.byteLength + (hasTl ? 8 : 0);
    dv.setUint16(o, pc, true); dv.setUint16(o + 2, 0, true); o += 4;
    for (let i = 0; i < pc; i++) {
      dv.setUint16(o, params[3 * i], true);
      dv.setUint16(o + 2, params[3 * i + 1], true);
      dv.setFloat32(o + 4, params[3 * i + 2], true);
      o += 8;
    }
  }
  ws.send(buf);
}

onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    url = m.url;
    connect();
  } else if (m.type === 'attach') {
    const { slotId, port } = m;
    const old = ports.get(slotId);
    if (old && old !== port) { try { old.close(); } catch (err) { /* déjà fermé */ } }
    ports.set(slotId, port);
    port.onmessage = (ev) => {
      const b = ev.data;
      if (b && b.data) sendBlock(slotId, b.seq, b.data, b.nch || 2, b.params || null, b.tl);
    };
  } else if (m.type === 'detach') {
    const p = ports.get(m.slotId);
    if (p) { try { p.close(); } catch (err) { /* déjà fermé */ } }
    ports.delete(m.slotId);
    headers.delete(m.slotId);
  } else if (m.type === 'close') {
    url = null;
    if (ws) { try { ws.close(); } catch (err) { /* déjà fermé */ } }
  }
};
