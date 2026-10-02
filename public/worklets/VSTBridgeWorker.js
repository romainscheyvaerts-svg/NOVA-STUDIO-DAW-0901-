/**
 * VST Bridge Worker v4
 *
 * Tient la connexion AUDIO avec le pont VST (ws://127.0.0.1:8765) hors du
 * thread principal : un rendu React ou un calcul de forme d'onde ne retarde
 * plus les blocs audio. Chaque effet VST3 (AudioWorklet) a son MessagePort.
 *
 * Trame binaire (little-endian), aller et retour :
 *   u8 type=1 | u8 L | slot_id (L octets UTF-8) | bourrage jusqu'à un multiple de 4
 *   | u32 seq | u16 nframes | u8 nch | u8 flags | float32[nframes*nch] entrelacés
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

function sendBlock(slotId, seq, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { bytes, headerLen } = header(slotId);
  const nframes = data.length / 2;
  const buf = new ArrayBuffer(headerLen + data.byteLength);
  const u8 = new Uint8Array(buf);
  u8[0] = 1;
  u8[1] = bytes.length;
  u8.set(bytes, 2);
  const dv = new DataView(buf);
  const h = headerLen - 8;
  dv.setUint32(h, seq >>> 0, true);
  dv.setUint16(h + 4, nframes, true);
  dv.setUint8(h + 6, 2);
  dv.setUint8(h + 7, 0);
  new Float32Array(buf, headerLen, data.length).set(data);
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
      if (b && b.data) sendBlock(slotId, b.seq, b.data);
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
