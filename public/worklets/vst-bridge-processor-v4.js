/**
 * VST Bridge Processor v4
 *
 * Nom de fichier versionné : le service worker garde les worklets en cache
 * (même nom = même contenu) ; une nouvelle version du protocole = un nouveau nom.
 *
 * Un effet VST3 du PC dans la chaîne Web Audio. Chaque bloc de 128 échantillons
 * part vers le pont (via un Worker qui tient le WebSocket, pour ne pas dépendre
 * du thread principal de la page) et revient traité, numéroté.
 *
 * Latence FIXE : la sortie du bloc n est le bloc traité n - delayBlocks
 * (pré-tampon). Le moteur compense cette latence à la lecture.
 * Bloc absent à l'heure (pont en retard) : silence pour ce bloc. Jamais de
 * mélange sec + traité.
 *
 * Inactif (plugin pas chargé sur le pont) ou contourné (piste armée : retour
 * casque sans retard) : le son passe tel quel, sans latence.
 */

const RING = 512; // blocs gardés (≈ 1,4 s à 48 kHz)

class VSTBridgeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.delayBlocks = Math.max(2, Math.min(RING - 8, Math.round((o.prebufferFrames || 2048) / 128)));
    this.ring = new Array(RING);
    this.bridge = null;       // MessagePort vers le Worker
    this.active = false;      // plugin chargé et flux ouvert
    this.bypass = false;      // piste armée : passe-plat
    this.seq = 0;
    this.underruns = 0;
    this.received = 0;
    this.silentIn = 0;
    this.lastRecvSeq = -1;
    this.lastLoudSeq = -1;
    this.statsAt = 0;
    this.activeSince = 0;     // les premiers blocs (remplissage du pré-tampon) ne sont pas des pertes

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'port') {
        this.bridge = m.port;
        this.bridge.onmessage = (ev) => this.onProcessed(ev.data);
      } else if (m.type === 'active') {
        if (m.on && !this.active) { this.ring = new Array(RING); this.activeSince = this.seq; this.received = 0; } // tampon propre
        this.active = !!m.on;
      } else if (m.type === 'bypass') {
        if (!m.on && this.bypass) { this.ring = new Array(RING); this.activeSince = this.seq; }
        this.bypass = !!m.on;
      }
    };
  }

  onProcessed(m) {
    if (!m || typeof m.seq !== 'number' || !m.data) return;
    // Trop tard : l'heure de ce bloc est passée (compté comme manquant).
    if (m.seq < this.seq - this.delayBlocks) return;
    this.ring[m.seq % RING] = { seq: m.seq, data: m.data };
    this.received++;
    if (m.seq > this.lastRecvSeq) this.lastRecvSeq = m.seq;
    const d = m.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 1e-5 || d[i] < -1e-5) { if (m.seq > this.lastLoudSeq) this.lastLoudSeq = m.seq; break; }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const inp = inputs[0] || [];
    const iL = inp[0];
    const iR = inp[1] || inp[0];
    const n = oL.length;

    if (!this.active || this.bypass || !this.bridge) {
      if (iL) { oL.set(iL); if (oR !== oL) oR.set(iR); } else { oL.fill(0); if (oR !== oL) oR.fill(0); }
      this.seq++;
      return true;
    }

    // 1) Envoi du bloc courant (entrelacé stéréo)
    const data = new Float32Array(n * 2);
    let loud = false;
    if (iL) {
      for (let i = 0; i < n; i++) {
        const l = iL[i], r = iR[i];
        data[2 * i] = l; data[2 * i + 1] = r;
        if (!loud && (l > 1e-6 || l < -1e-6 || r > 1e-6 || r < -1e-6)) loud = true;
      }
    }
    this.silentIn = loud ? 0 : this.silentIn + 1;
    // Silence prolongé en entrée ET sortie déjà silencieuse (queue de réverbe
    // finie) : inutile de solliciter le pont. Le bloc est marqué silencieux.
    const gate = this.silentIn > this.delayBlocks + 64 && (this.lastRecvSeq - this.lastLoudSeq) > 64;
    if (gate) {
      this.ring[this.seq % RING] = { seq: this.seq, data: null };
    } else {
      this.bridge.postMessage({ seq: this.seq, data }, [data.buffer]);
    }

    // 2) Sortie : le bloc traité d'il y a delayBlocks
    const want = this.seq - this.delayBlocks;
    const e = want >= 0 ? this.ring[want % RING] : null;
    const hit = !!(e && e.seq === want);
    if (hit && e.data) {
      const d = e.data;
      for (let i = 0; i < n; i++) { oL[i] = d[2 * i]; if (oR !== oL) oR[i] = d[2 * i + 1]; }
    } else {
      oL.fill(0); if (oR !== oL) oR.fill(0);
      // Le tout premier bloc traité peut tarder (premier passage dans le plugin) : on ne compte qu'ensuite.
      if (want >= this.activeSince && this.received > 0 && !hit) this.underruns++;
    }
    if (hit) this.ring[want % RING] = undefined;

    this.seq++;
    if (this.seq - this.statsAt >= 375) { // ≈ toutes les secondes
      this.statsAt = this.seq;
      this.port.postMessage({ type: 'stats', underruns: this.underruns, received: this.received, seq: this.seq });
    }
    return true;
  }
}

registerProcessor('vst-bridge-processor-v4', VSTBridgeProcessor);
