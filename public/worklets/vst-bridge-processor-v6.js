/**
 * VST Bridge Processor v6
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
 *
 * v5 (R9) — automation : AUTO_SLOTS AudioParam « p0 »… (valeur brute 0–1 du
 * réglage VST, -1 = libre). Le moteur y programme les voies d'automation
 * d'avance, avec la même avance PDC que les effets NOVA. Chaque bloc envoyé
 * porte les changements qui le concernent, horodatés à l'échantillon près :
 *   - valeur au début du bloc si elle a bougé de plus de TOL, au plus une fois
 *     tous les RAMP_BLOCKS blocs par réglage (rampes : débit limité, ≈ 5 ms) ;
 *   - tout saut de plus de JUMP au sein du bloc, à son échantillon exact
 *     (paliers), au plus MAX_PER_BLOCK par réglage.
 * v5 (R10) — side-chain : 2e entrée = clé ; si la clé est active, le bloc
 * part en 4 canaux (principal G/D puis clé G/D).
 * v6 — départ de lecture : message { type: 'reset' } → le bloc suivant part avec le drapeau
 * RESET (même s'il est silencieux) : le pont remet le plugin à zéro juste avant lui, comme
 * l'instance hors ligne de l'export (Pro-C 3 gardait une mémoire d'une écoute à l'autre).
 * v5 (insert ARA, pont v12) — position du morceau : en mode « ara », chaque bloc part avec
 * la position du morceau de son ENTRÉE (échantillons ; -1 = transport arrêté) : la sortie à
 * l'instant t du contexte = morceau t − origine ; le bloc envoyé à f ressort à f + latence.
 * Le plugin (Melodyne) joue les clips de la piste à cette position, comme dans Pro Tools.
 * v6 (C6) — tampon adaptatif (si processorOptions.maxPrebufferFrames > prebufferFrames) :
 * un bloc absent à son heure alors que le pont répond (en retard) n'est plus perdu : la sortie
 * l'ATTEND. Le tampon passe au palier suivant (× 1,5, 2, 3, 4 du pré-tampon, plafond
 * maxPrebufferFrames) : la sortie rend du silence (« attente ») le temps de l'agrandissement,
 * puis le flux reprend AU BLOC MANQUANT, sans rien sauter. Le plugin a donc reçu et traité
 * tous les blocs, dans l'ordre, comme à l'export. Message { type: 'delay', frames } aussitôt :
 * le moteur décale d'autant la compensation (PDC) et le transport (AudioEngine.holdTransport).
 * Le tampon ne redescend que sur ordre du thread principal ({ type: 'delay', frames } plus
 * petit, transport arrêté), d'après l'âge des retours mesuré ici (ageMaxFrames).
 * Compteurs : underruns (blocs rendus en silence faute de son), dropouts (coupures = suites
 * de tels blocs), late (blocs arrivés après leur heure), grows (agrandissements).
 */

const RING = 512; // blocs gardés (≈ 1,4 s à 48 kHz)
const AUTO_SLOTS = 32;
const TOL = 1e-4;
const JUMP = 0.02;
const MAX_PER_BLOCK = 4;
const RAMP_BLOCKS = 2;
// Paliers du tampon adaptatif, en multiples du pré-tampon de base (même calcul que
// utils/vstAdaptiveBuffer.ts, côté thread principal).
const ADAPT_STEPS = [1, 1.5, 2, 3, 4];
// Le pont répond mais trop tard : au bout de LATE_TRIGGER blocs en retard, un bloc absent est
// une vraie perte (pas le tout premier passage dans le plugin, qui peut tarder).
const LATE_TRIGGER = 8;
// Mise en route du plugin (≈ 1 s après son chargement) : ses premiers passages peuvent tarder,
// ce n'est pas un pont lent. Ni compté ni agrandi pendant ce temps.
const WARMUP_BLOCKS = 375;
// Marge gardée au-dessus de l'âge maximal des retours vu pendant un agrandissement (≈ 21 ms) :
// la gigue du pont ne doit pas forcer un 2e agrandissement (un 2e trou) juste après.
const ADAPT_MARGIN_BLOCKS = 8;

/** Plus petit palier (en blocs) ≥ need, plafonné à max. */
function stepCovering(base, need, max) {
  for (const k of ADAPT_STEPS) { const b = Math.round(base * k); if (b >= need) return Math.min(b, max); }
  return max;
}

/** Palier suivant (en blocs) au-dessus de cur, plafonné à max. */
function nextStepBlocks(base, cur, max) {
  for (const k of ADAPT_STEPS) { const b = Math.round(base * k); if (b > cur) return Math.min(b, max); }
  return max;
}

class VSTBridgeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const out = [];
    for (let i = 0; i < AUTO_SLOTS; i++) out.push({ name: `p${i}`, defaultValue: -1, minValue: -1, maxValue: 1, automationRate: 'a-rate' });
    return out;
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.delayBlocks = Math.max(2, Math.min(RING - 8, Math.round((o.prebufferFrames || 2048) / 128)));
    // Tampon adaptatif (C6) : actif seulement si un plafond plus grand est donné.
    this.baseBlocks = this.delayBlocks;
    this.maxBlocks = Math.max(this.baseBlocks, Math.min(RING - 8, Math.round((o.maxPrebufferFrames || 0) / 128)));
    this.adaptive = this.maxBlocks > this.baseBlocks;
    this.hold = 0;            // blocs d'attente restants (agrandissement en cours)
    this.late = 0;            // blocs arrivés après leur heure (total)
    this.lateSinceActive = 0;
    this.dropouts = 0;        // coupures : suites de blocs rendus en silence faute de son
    this.inGap = false;
    this.grows = 0;
    this.delayId = 0;         // dernier ordre { type: 'delay', id } appliqué (thread principal)
    this.ageMax = 0;          // âge maximal (blocs) des retours depuis les dernières stats
    this.recvPeriod = 0;      // retours reçus depuis les dernières stats
    this.sentLoud = new Uint8Array(RING); // le bloc envoyé portait du son (une coupure s'entendrait)
    this.episode = false;     // agrandissement en cours (de la 1re attente à la reprise du son)
    this.episodeAge = 0;      // âge maximal des retours pendant cet agrandissement
    this.ring = new Array(RING);
    this.bridge = null;       // MessagePort vers le Worker
    this.active = false;      // plugin chargé et flux ouvert
    this.bypass = false;      // piste armée : passe-plat
    this.sidechain = false;   // clé branchée et prise en charge par le pont
    this.seq = 0;
    this.underruns = 0;
    this.received = 0;
    this.silentIn = 0;
    this.lastRecvSeq = -1;
    this.lastLoudSeq = -1;
    this.statsAt = 0;
    this.activeSince = 0;     // les premiers blocs (remplissage du pré-tampon) ne sont pas des pertes
    this.armed = new Uint8Array(AUTO_SLOTS);
    this.lastSent = new Float32Array(AUTO_SLOTS).fill(NaN);
    this.lastSentAt = new Float64Array(AUTO_SLOTS).fill(-1e9);
    this.paramsSent = 0;
    this.paramBlocks = 0;
    this.pbuf = new Float32Array(AUTO_SLOTS * MAX_PER_BLOCK * 3);
    // Insert ARA : origines du morceau (images du contexte) par segment de sortie, latence (images).
    this.ara = false;
    this.tlSegs = [];
    this.tlLatency = 0;
    this.tlPlaying = false;
    this.tlSentPlaying = false;
    this.tlMuteBefore = -1;
    this.resetPending = false;
    this.resetsSent = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'port') {
        this.bridge = m.port;
        this.bridge.onmessage = (ev) => this.onProcessed(ev.data);
      } else if (m.type === 'active') {
        if (m.on && !this.active) { this.ring = new Array(RING); this.activeSince = this.seq; this.received = 0; this.lateSinceActive = 0; this.hold = 0; this.inGap = false; this.lastSent.fill(NaN); } // tampon propre
        this.active = !!m.on;
      } else if (m.type === 'bypass') {
        if (!m.on && this.bypass) { this.ring = new Array(RING); this.activeSince = this.seq; this.lateSinceActive = 0; this.hold = 0; this.inGap = false; this.lastSent.fill(NaN); }
        this.bypass = !!m.on;
      } else if (m.type === 'arm') {
        // Réglage déclaré au pont (SET_AUTOMATION_MAP) : ses valeurs peuvent partir.
        if (m.index >= 0 && m.index < AUTO_SLOTS) { this.armed[m.index] = m.on ? 1 : 0; this.lastSent[m.index] = NaN; }
      } else if (m.type === 'rearm') {
        this.lastSent.fill(NaN);
      } else if (m.type === 'sidechain') {
        this.sidechain = !!m.on;
      } else if (m.type === 'ara') {
        this.ara = !!m.on;
      } else if (m.type === 'timeline') {
        // { from, origin } en images du contexte : à partir de from (sortie), morceau = t − origin.
        const seg = { from: m.from, origin: m.origin };
        if (m.reset || !this.tlPlaying) this.tlSegs = [seg];
        else { this.tlSegs = this.tlSegs.filter(s => s.from < seg.from); this.tlSegs.push(seg); if (this.tlSegs.length > 8) this.tlSegs.shift(); }
        if (typeof m.latency === 'number') this.tlLatency = m.latency;
        this.tlPlaying = true;
      } else if (m.type === 'tlstop') {
        this.tlPlaying = false;
        // Arrêt net (comme Pro Tools) : la fin déjà en route dans le pré-tampon n'est pas jouée.
        this.tlMuteBefore = this.seq;
      } else if (m.type === 'reset') {
        this.resetPending = true;
      } else if (m.type === 'tllatency') {
        this.tlLatency = m.latency || 0;
      } else if (m.type === 'delay') {
        // Ordre du thread principal (transport arrêté) : tampon ramené à `frames` (ou agrandi).
        const want = Math.max(2, Math.min(this.maxBlocks, Math.round((Number(m.frames) || 0) / 128)));
        const target = this.delayBlocks + this.hold;
        if (want < target) { this.delayBlocks = Math.min(this.delayBlocks, want); this.hold = want - this.delayBlocks; }
        else if (want > target) this.hold += want - target;
        if (typeof m.id === 'number') this.delayId = m.id;
      }
    };
  }

  onProcessed(m) {
    if (!m || typeof m.seq !== 'number' || !m.data) return;
    // Âge du retour : blocs écoulés depuis l'envoi (le bloc doit revenir au plus tard à delayBlocks).
    const age = this.seq - m.seq;
    if (age > this.ageMax) this.ageMax = age;
    if (this.episode && age > this.episodeAge) this.episodeAge = age;
    // Trop tard : l'heure de ce bloc est passée (compté comme manquant).
    if (m.seq < this.seq - this.delayBlocks) { this.late++; this.lateSinceActive++; return; }
    this.ring[m.seq % RING] = { seq: m.seq, data: m.data };
    this.received++;
    this.recvPeriod++;
    if (m.seq > this.lastRecvSeq) this.lastRecvSeq = m.seq;
    const d = m.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 1e-5 || d[i] < -1e-5) { if (m.seq > this.lastLoudSeq) this.lastLoudSeq = m.seq; break; }
    }
  }

  /** Changements de réglages de ce bloc : [index, décalage, valeur]… dans this.pbuf ; renvoie leur nombre. */
  collectParams(parameters, n) {
    let c = 0;
    for (let i = 0; i < AUTO_SLOTS; i++) {
      if (!this.armed[i]) continue;
      const arr = parameters[`p${i}`];
      if (!arr || !arr.length) continue;
      let last = this.lastSent[i];
      const v0 = arr[0];
      let k = 0;
      // Rampe : au plus une valeur tous les RAMP_BLOCKS blocs (première valeur : tout de suite).
      if (v0 >= 0 && !(Math.abs(v0 - last) <= TOL) && (last !== last || this.seq - this.lastSentAt[i] >= RAMP_BLOCKS)) {
        this.pbuf[c * 3] = i; this.pbuf[c * 3 + 1] = 0; this.pbuf[c * 3 + 2] = v0; c++; k++;
        last = v0;
        this.lastSentAt[i] = this.seq;
      }
      if (arr.length > 1) {
        for (let s = 1; s < n && k < MAX_PER_BLOCK; s++) {
          const v = arr[s];
          if (v >= 0 && Math.abs(v - last) > JUMP) {
            this.pbuf[c * 3] = i; this.pbuf[c * 3 + 1] = s; this.pbuf[c * 3 + 2] = v; c++; k++;
            last = v;
            this.lastSentAt[i] = this.seq;
          }
        }
      }
      this.lastSent[i] = last;
    }
    return c;
  }

  process(inputs, outputs, parameters) {
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

    // 1) Envoi du bloc courant (entrelacé stéréo, ou 4 canaux avec la clé)
    const key = this.sidechain ? (inputs[1] || []) : null;
    const kL = key ? key[0] : null;
    const kR = key ? (key[1] || key[0]) : null;
    const nch = key ? 4 : 2;
    const data = new Float32Array(n * nch);
    let loud = false;
    if (iL) {
      for (let i = 0; i < n; i++) {
        const l = iL[i], r = iR[i];
        data[nch * i] = l; data[nch * i + 1] = r;
        if (!loud && (l > 1e-6 || l < -1e-6 || r > 1e-6 || r < -1e-6)) loud = true;
      }
    }
    if (kL) {
      for (let i = 0; i < n; i++) {
        const l = kL[i], r = kR[i];
        data[4 * i + 2] = l; data[4 * i + 3] = r;
        if (!loud && (l > 1e-6 || l < -1e-6 || r > 1e-6 || r < -1e-6)) loud = true;
      }
    }
    const pc = this.collectParams(parameters, n);
    this.silentIn = loud ? 0 : this.silentIn + 1;
    // Insert ARA : position du morceau de ce bloc (sortie à currentFrame + latence).
    let tl = -1;
    if (this.ara && this.tlPlaying && this.tlSegs.length) {
      const g = currentFrame + this.tlLatency;
      let seg = this.tlSegs[0];
      for (let k = 1; k < this.tlSegs.length; k++) if (this.tlSegs[k].from <= g) seg = this.tlSegs[k];
      tl = g - seg.origin;
    }
    // Silence prolongé en entrée ET sortie déjà silencieuse (queue de réverbe
    // finie) : inutile de solliciter le pont. Le bloc est marqué silencieux.
    // Un changement de réglage part quand même (il doit tomber à son heure).
    // Insert ARA : à l'arrêt, rien à jouer (silence sans solliciter le pont) ; en lecture, tout part.
    // Le premier bloc après l'arrêt part quand même (position -1) : le plugin apprend l'arrêt
    // (sinon Melodyne rejoue un bout de l'ancienne position à la relance).
    const reset = this.resetPending;
    this.resetPending = false;
    if (reset) this.resetsSent++;
    const gate = !reset && (this.ara ? (tl < 0 && pc === 0 && !this.tlSentPlaying) : (pc === 0 && this.silentIn > this.delayBlocks + 64 && (this.lastRecvSeq - this.lastLoudSeq) > 64));
    if (this.ara && !gate) this.tlSentPlaying = tl >= 0;
    this.sentLoud[this.seq % RING] = loud ? 1 : 0;
    if (gate) {
      this.ring[this.seq % RING] = { seq: this.seq, data: null };
    } else if (pc > 0) {
      const params = this.pbuf.slice(0, pc * 3);
      this.paramsSent += pc;
      this.paramBlocks++;
      this.bridge.postMessage(this.ara ? { seq: this.seq, data, nch, params, tl, reset } : { seq: this.seq, data, nch, params, reset }, [data.buffer, params.buffer]);
    } else {
      this.bridge.postMessage(this.ara ? { seq: this.seq, data, nch, tl, reset } : { seq: this.seq, data, nch, reset }, [data.buffer]);
    }

    // 2) Sortie : le bloc traité d'il y a delayBlocks
    let silentLate = false;
    if (this.hold > 0) {
      // Agrandissement du tampon en cours : la sortie attend (silence), aucun bloc n'est sauté.
      oL.fill(0); if (oR !== oL) oR.fill(0);
      this.hold--;
      this.delayBlocks++;
      this.underruns++;
      silentLate = true;
      // Fin de l'attente : si les retours vus pendant ce temps sont plus vieux que la marge, le
      // tampon monte encore, DANS le même trou (pas un 2e trou au prochain pic de gigue).
      if (this.hold === 0 && this.episode && this.delayBlocks < this.maxBlocks && this.episodeAge + ADAPT_MARGIN_BLOCKS > this.delayBlocks) {
        const target = stepCovering(this.baseBlocks, this.episodeAge + ADAPT_MARGIN_BLOCKS, this.maxBlocks);
        if (target > this.delayBlocks) {
          this.hold = target - this.delayBlocks;
          this.grows++;
          this.port.postMessage({ type: 'delay', frames: target * 128, grows: this.grows, at: this.seq });
        }
      }
    } else {
      const want = this.seq - this.delayBlocks;
      const e = want >= 0 ? this.ring[want % RING] : null;
      const hit = !!(e && e.seq === want);
      if (hit && e.data && !(this.ara && want < this.tlMuteBefore)) {
        const d = e.data;
        for (let i = 0; i < n; i++) { oL[i] = d[2 * i]; if (oR !== oL) oR[i] = d[2 * i + 1]; }
      } else {
        oL.fill(0); if (oR !== oL) oR.fill(0);
        // Le tout premier bloc traité peut tarder (premier passage dans le plugin) : on ne compte
        // qu'ensuite — ou dès que le pont répond, mais systématiquement en retard. Seulement les
        // blocs qui s'entendraient : du son en entrée, ou une queue (réverbe) encore audible.
        const audible = this.sentLoud[want % RING] === 1 || (this.lastLoudSeq >= 0 && want - this.lastLoudSeq <= 64);
        if (want >= this.activeSince + WARMUP_BLOCKS && !hit && audible && (this.received > 0 || this.lateSinceActive >= LATE_TRIGGER)) {
          this.underruns++;
          silentLate = true;
          if (this.adaptive && this.delayBlocks < this.maxBlocks) {
            // Palier suivant : ce bloc-ci est la 1re attente ; le bloc manquant reste attendu.
            const target = nextStepBlocks(this.baseBlocks, this.delayBlocks, this.maxBlocks);
            if (!this.episode) { this.episode = true; this.episodeAge = 0; }
            this.hold = target - this.delayBlocks - 1;
            this.delayBlocks++;
            this.grows++;
            this.port.postMessage({ type: 'delay', frames: target * 128, grows: this.grows, at: this.seq });
          }
        }
      }
      if (hit) this.ring[want % RING] = undefined;
      if (hit && e.data) this.episode = false;   // le son a repris : fin de l'agrandissement
    }
    if (silentLate) { if (!this.inGap) { this.dropouts++; this.inGap = true; } }
    else this.inGap = false;

    this.seq++;
    if (this.seq - this.statsAt >= 375) { // ≈ toutes les secondes
      this.statsAt = this.seq;
      this.port.postMessage({ type: 'stats', underruns: this.underruns, received: this.received, seq: this.seq, paramsSent: this.paramsSent, paramBlocks: this.paramBlocks, resets: this.resetsSent,
        dropouts: this.dropouts, late: this.late, grows: this.grows, delayFrames: (this.delayBlocks + this.hold) * 128, delayId: this.delayId,
        ageMaxFrames: this.ageMax * 128, recvPeriod: this.recvPeriod });
      this.ageMax = 0;
      this.recvPeriod = 0;
    }
    return true;
  }
}

registerProcessor('vst-bridge-processor-v6', VSTBridgeProcessor);
