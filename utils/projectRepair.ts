/**
 * Validation et réparation d'un projet NOVA (project.json d'un .novaproj.zip,
 * sauvegarde automatique, session en ligne).
 *
 * Pro Tools refuse d'ouvrir une session abîmée (« session corrompue ») : NOVA
 * l'ouvre quand même, avec ce qu'il a pu sauver, et dit précisément ce qu'il a
 * réparé. Un projet tronqué (coupure de courant pendant l'écriture), des sons
 * manquants, des identifiants en double ou des valeurs absurdes (NaN, Infinity)
 * ne font plus planter le chargement.
 *
 * Module pur (aucun audio, aucun réseau) : testable tel quel.
 */

const TRACK_TYPES = new Set(['AUDIO', 'MIDI', 'BUS', 'SEND', 'SAMPLER', 'DRUM_RACK', 'DRUM_SAMPLER', 'MELODIC_SAMPLER']);
/** Sortie « dans le vide » (utils/trackStructure VOID_OUTPUT) : toujours valide. */
const VOID_OUTPUT = '__nova_void__';
const DENOMINATORS = new Set([1, 2, 4, 8, 16, 32]);

export interface SalvagedJson {
  /** Valeur lue (réparée si le texte était tronqué), null si rien n'est lisible. */
  value: any | null;
  /** Le texte n'était pas un JSON complet : il a été coupé à la dernière valeur entière. */
  truncated: boolean;
  note?: string;
}

/**
 * JSON.parse, sinon lecture d'un JSON TRONQUÉ (écriture interrompue) : on coupe
 * à la dernière valeur complète et on referme les chaînes / tableaux / objets
 * ouverts. Ne lève jamais d'exception.
 */
export function salvageJson(text: string): SalvagedJson {
  if (typeof text !== 'string') return { value: null, truncated: false, note: 'Contenu absent' };
  try { return { value: JSON.parse(text), truncated: false }; } catch { /* réparation ci-dessous */ }

  type Frame = { kind: '{' | '['; expect: 'key' | 'colon' | 'value' | 'comma' };
  const stack: Frame[] = [];
  let lastGood: { pos: number; closers: string } | null = null;
  const closers = () => stack.map(f => (f.kind === '{' ? '}' : ']')).reverse().join('');
  const n = text.length;
  let i = 0;
  // Valeur complète : le conteneur parent attend maintenant une virgule (ou sa fin).
  const valueDone = (end: number) => {
    const top = stack[stack.length - 1];
    if (!top) { lastGood = { pos: end, closers: '' }; return; }
    top.expect = 'comma';
    lastGood = { pos: end, closers: closers() };
  };
  const isDelim = (c: string | undefined) => c === undefined || /[\s,\]\}:]/.test(c);

  outer:
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    const top = stack[stack.length - 1];
    if (c === '{' || c === '[') {
      if (top && top.expect !== 'value') break;
      stack.push({ kind: c, expect: c === '{' ? 'key' : 'value' });
      i++;
      lastGood = { pos: i, closers: closers() };
      continue;
    }
    if (c === '}' || c === ']') {
      if (!top || (c === '}' ? top.kind !== '{' : top.kind !== '[')) break;
      // Fin de conteneur après une virgule pendante : on s'arrête à la dernière valeur.
      if (top.expect === 'colon' || (top.expect === 'value' && top.kind === '{')) break;
      stack.pop();
      i++;
      if (!stack.length) { lastGood = { pos: i, closers: '' }; break; }
      valueDone(i);
      continue;
    }
    if (c === ',') {
      if (!top || top.expect !== 'comma') break;
      top.expect = top.kind === '{' ? 'key' : 'value';
      i++;
      continue;
    }
    if (c === ':') {
      if (!top || top.expect !== 'colon') break;
      top.expect = 'value';
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '"') break;
        j++;
      }
      if (j >= n) break; // chaîne coupée : on s'arrête avant
      const end = j + 1;
      if (top && top.kind === '{' && top.expect === 'key') { top.expect = 'colon'; i = end; continue; }
      if (top && top.expect !== 'value') break;
      i = end;
      if (!top) { lastGood = { pos: i, closers: '' }; break; }
      valueDone(i);
      continue;
    }
    // Nombre ou littéral (true / false / null) : complet seulement s'il est suivi d'un séparateur.
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) break;
    const end = i + m[0].length;
    if (end >= n || !isDelim(text[end])) break outer;
    if (top && top.expect !== 'value') break;
    i = end;
    if (!top) { lastGood = { pos: i, closers: '' }; break; }
    valueDone(i);
  }

  const good = lastGood as { pos: number; closers: string } | null;
  if (!good) return { value: null, truncated: true, note: 'Aucune donnée lisible' };
  const candidate = text.slice(0, good.pos).replace(/,\s*$/, '') + good.closers;
  try {
    return { value: JSON.parse(candidate), truncated: true, note: `Lu jusqu'au caractère ${good.pos} sur ${n}` };
  } catch {
    return { value: null, truncated: true, note: 'Réparation impossible' };
  }
}

export interface RepairOptions {
  /** Fichiers présents dans l'archive (« audio/x.wav ») ; null : pas de vérification. */
  audioRefs?: Set<string> | null;
  /** Sons connus en mémoire (bufferId) ; absent : pas de vérification. */
  knownBufferIds?: (id: string) => boolean;
}

export interface RepairResult {
  state: any;
  /** Une ligne par réparation, en français, regroupée (« 3 clips en double renommés »). */
  report: string[];
  repaired: boolean;
  /** Rien n'est récupérable (pas un projet). */
  fatal?: string;
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Garantit un projet jouable. Ne lève jamais : un champ illisible est remplacé
 * par sa valeur par défaut, un élément inutilisable est retiré, et chaque
 * réparation est comptée pour le rapport.
 */
export function repairProject(raw: any, opts: RepairOptions = {}): RepairResult {
  const counts = new Map<string, number>();
  const names = new Map<string, Set<string>>();
  const bump = (k: string, who?: string) => {
    counts.set(k, (counts.get(k) || 0) + 1);
    if (who) { if (!names.has(k)) names.set(k, new Set()); names.get(k)!.add(who); }
  };

  if (!isObj(raw)) {
    return { state: null, report: ['Le fichier ne contient pas de projet lisible.'], repaired: true, fatal: "Ce fichier n'est pas un projet NOVA lisible." };
  }
  const state: any = { ...raw };

  if (typeof state.id !== 'string' || !state.id) { if (state.id !== undefined) bump('projectId'); state.id = `proj-repare-${Date.now().toString(36)}`; }
  if (typeof state.name !== 'string') { state.name = 'Projet récupéré'; bump('projectName'); }
  if (!finite(state.bpm) || state.bpm < 20 || state.bpm > 400) { if (state.bpm !== undefined) bump('bpm'); state.bpm = 120; }
  const ts = state.timeSignature;
  if (!isObj(ts) || !Number.isInteger(ts.numerator) || ts.numerator < 1 || ts.numerator > 32 || !DENOMINATORS.has(ts.denominator)) {
    if (ts !== undefined) bump('timeSignature');
    state.timeSignature = { numerator: 4, denominator: 4 };
  }
  if (state.markers !== undefined && !Array.isArray(state.markers)) { state.markers = []; bump('markers'); }
  if (Array.isArray(state.markers)) {
    const before = state.markers.length;
    state.markers = state.markers.filter((m: any) => isObj(m) && finite(m.time) && m.time >= 0);
    if (state.markers.length !== before) for (let k = before - state.markers.length; k > 0; k--) bump('markerDropped');
  }
  if (state.trackGroups !== undefined && !Array.isArray(state.trackGroups)) { state.trackGroups = []; bump('trackGroups'); }
  for (const k of ['loopStart', 'loopEnd', 'currentTime'] as const) {
    if (state[k] !== undefined && (!finite(state[k]) || state[k] < 0)) { state[k] = 0; bump('transport'); }
  }

  if (!Array.isArray(state.tracks)) {
    state.tracks = [];
    bump('noTracks');
  }

  // --- Pistes ------------------------------------------------------------------
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  const tracks: any[] = [];
  state.tracks.forEach((t0: any, ti: number) => {
    if (!isObj(t0)) { bump('trackDropped'); return; }
    const t: any = { ...t0 };
    let id = typeof t.id === 'string' && t.id ? t.id : '';
    if (!id) { id = `piste-${ti + 1}`; bump('trackNoId'); }
    if (trackIds.has(id)) {
      let k = 2;
      while (trackIds.has(`${id}-${k}`)) k++;
      bump('trackDup', typeof t.name === 'string' ? t.name : id);
      id = `${id}-${k}`;
    }
    while (trackIds.has(id)) id = `${id}-x`;
    t.id = id;
    trackIds.add(id);
    if (typeof t.name !== 'string' || !t.name.trim()) { t.name = id === 'master' ? 'MASTER BUS' : `Piste ${ti + 1}`; bump('trackName'); }
    if (!TRACK_TYPES.has(t.type)) { t.type = id === 'master' ? 'BUS' : 'AUDIO'; bump('trackType', t.name); }
    if (typeof t.color !== 'string') t.color = '#64748b';
    for (const b of ['isMuted', 'isSolo', 'isTrackArmed', 'isFrozen'] as const) if (typeof t[b] !== 'boolean') t[b] = false;
    if (!finite(t.volume) || t.volume < 0) { if (t.volume !== undefined) bump('volume', t.name); t.volume = 1; } else if (t.volume > 4) { t.volume = 4; bump('volume', t.name); }
    if (!finite(t.pan)) { if (t.pan !== undefined) bump('pan', t.name); t.pan = 0; } else if (t.pan < -1 || t.pan > 1) { t.pan = Math.max(-1, Math.min(1, t.pan)); bump('pan', t.name); }
    if (!finite(t.totalLatency)) t.totalLatency = 0;
    if (typeof t.outputTrackId !== 'string') t.outputTrackId = id === 'master' ? '' : 'master';
    for (const a of ['clips', 'plugins', 'sends', 'automationLanes'] as const) {
      if (!Array.isArray(t[a])) { if (t[a] !== undefined) bump('arrayField', t.name); t[a] = []; }
    }

    // Clips
    const clips: any[] = [];
    t.clips.forEach((c0: any) => {
      if (!isObj(c0)) { bump('clipDropped', t.name); return; }
      const c: any = { ...c0 };
      if (!finite(c.duration) || c.duration <= 0) { bump('clipDropped', t.name); return; }
      let cid = typeof c.id === 'string' && c.id ? c.id : '';
      if (!cid) { cid = `clip-${id}-${clips.length + 1}`; bump('clipNoId'); }
      if (clipIds.has(cid)) {
        let k = 2;
        while (clipIds.has(`${cid}-r${k}`)) k++;
        cid = `${cid}-r${k}`;
        bump('clipDup', t.name);
      }
      c.id = cid;
      clipIds.add(cid);
      for (const f of ['start', 'offset', 'fadeIn', 'fadeOut'] as const) {
        if (c[f] === undefined) { c[f] = 0; continue; }
        if (!finite(c[f]) || c[f] < 0) { c[f] = 0; bump('clipTime', t.name); }
      }
      if (c.gain !== undefined && (!finite(c.gain) || c.gain < 0)) { delete c.gain; bump('clipGain', t.name); }
      if (typeof c.name !== 'string') c.name = 'Clip';
      if (typeof c.color !== 'string') c.color = t.color;
      if (!TRACK_TYPES.has(c.type)) c.type = t.type === 'MIDI' ? 'MIDI' : 'AUDIO';
      if (c.notes !== undefined) {
        if (!Array.isArray(c.notes)) { c.notes = []; bump('notes', t.name); }
        else {
          const before = c.notes.length;
          c.notes = c.notes.filter((nt: any) => isObj(nt) && finite(nt.pitch) && finite(nt.start) && nt.start >= 0 && finite(nt.duration) && nt.duration > 0)
            .map((nt: any) => (finite(nt.velocity) ? nt : { ...nt, velocity: 0.8 }));
          if (c.notes.length !== before) bump('notes', t.name);
        }
      }
      // Son introuvable : le clip reste (placement, nom), hors ligne.
      const missingRef = opts.audioRefs && typeof c.audioRef === 'string' && /^audio\//.test(c.audioRef) && !opts.audioRefs.has(c.audioRef);
      const missingBuf = !!opts.knownBufferIds && typeof c.bufferId === 'string' && c.bufferId && !opts.knownBufferIds(c.bufferId);
      // Clip audio sans aucune référence de son (fichier coupé avant son audioRef) : hors ligne aussi.
      const noSound = !!opts.audioRefs && c.type === 'AUDIO' && t.type === 'AUDIO' && !c.audioRef && !c.bufferId && !c.buffer && !c.notes && !c.isOffline;
      if ((missingRef || missingBuf || noSound) && !c.isUnlicensed) {
        c.isOffline = true;
        if (missingRef) delete c.audioRef;
        if (missingBuf) delete c.bufferId;
        bump('clipOffline', t.name);
      }
      clips.push(c);
    });
    t.clips = clips;

    // Effets
    const pids = new Set<string>();
    const plugins: any[] = [];
    t.plugins.forEach((p0: any, pi: number) => {
      if (!isObj(p0) || typeof p0.type !== 'string' || !p0.type) { bump('pluginDropped', t.name); return; }
      const p: any = { ...p0 };
      let pid = typeof p.id === 'string' && p.id ? p.id : '';
      if (!pid || pids.has(pid)) {
        const base = pid || `fx-${id}-${pi + 1}`;
        let k = pid ? 2 : 1;
        pid = pid ? `${base}-${k}` : base;
        while (pids.has(pid)) pid = `${base}-${++k}`;
        bump(p0.id ? 'pluginDup' : 'pluginNoId', t.name);
      }
      p.id = pid;
      pids.add(pid);
      if (typeof p.name !== 'string') p.name = p.type;
      if (typeof p.isEnabled !== 'boolean') p.isEnabled = true;
      if (!isObj(p.params)) { if (p.params !== undefined) bump('pluginParams', t.name); p.params = {}; }
      if (!finite(p.latency)) p.latency = 0;
      plugins.push(p);
    });
    t.plugins = plugins;

    // Automation
    const lanes: any[] = [];
    t.automationLanes.forEach((l0: any, li: number) => {
      if (!isObj(l0) || typeof l0.parameterName !== 'string') { bump('laneDropped', t.name); return; }
      const l: any = { ...l0 };
      if (typeof l.id !== 'string' || !l.id) l.id = `auto-${id}-${li + 1}`;
      const pts = Array.isArray(l.points) ? l.points : [];
      const good = pts.filter((q: any) => isObj(q) && finite(q.time) && q.time >= 0 && finite(q.value));
      if (good.length !== pts.length || !Array.isArray(l.points)) bump('autoPoints', t.name);
      const sorted = [...good].sort((a: any, b: any) => a.time - b.time);
      if (sorted.some((q: any, k: number) => q !== good[k])) bump('autoOrder', t.name);
      l.points = sorted.map((q: any, k: number) => (typeof q.id === 'string' ? q : { ...q, id: `${l.id}-p${k}` }));
      if (!finite(l.min)) l.min = 0;
      if (!finite(l.max)) l.max = 1;
      if (typeof l.isExpanded !== 'boolean') l.isExpanded = false;
      if (typeof l.color !== 'string') l.color = t.color;
      lanes.push(l);
    });
    t.automationLanes = lanes;

    // Rendu gelé illisible : la piste repasse en direct.
    if (t.frozenClip !== undefined && (!isObj(t.frozenClip) || !finite(t.frozenClip.duration) || t.frozenClip.duration <= 0)) {
      delete t.frozenClip;
      if (t.isFrozen) bump('frozen', t.name);
      t.isFrozen = false;
    }
    tracks.push(t);
  });
  state.tracks = tracks;

  // --- Références entre pistes (une fois tous les ids connus) ----------------
  const hasMaster = trackIds.has('master');
  for (const t of tracks) {
    const out = t.outputTrackId;
    if (out && out !== 'master' && out !== VOID_OUTPUT && (!trackIds.has(out) || out === t.id)) {
      t.outputTrackId = t.id === 'master' ? '' : 'master';
      bump('output', t.name);
    }
    if (t.id === 'master' && t.outputTrackId === 'master') t.outputTrackId = '';
    if (!hasMaster && t.outputTrackId === 'master') { /* piste master recréée à l'ouverture (migrateLoadedState) */ }
    const sends: any[] = [];
    const seen = new Set<string>();
    t.sends.forEach((s: any) => {
      if (!isObj(s) || typeof s.id !== 'string' || !trackIds.has(s.id) || s.id === t.id || seen.has(s.id)) { bump('send', t.name); return; }
      seen.add(s.id);
      const s2: any = { ...s };
      if (!finite(s2.level) || s2.level < 0) s2.level = 0;
      if (typeof s2.isEnabled !== 'boolean') s2.isEnabled = true;
      if (s2.pan !== undefined && !finite(s2.pan)) delete s2.pan;
      sends.push(s2);
    });
    t.sends = sends;
    for (const ref of ['parentFolderId', 'vcaId'] as const) {
      if (t[ref] !== undefined && (typeof t[ref] !== 'string' || !trackIds.has(t[ref]))) { delete t[ref]; bump('structure', t.name); }
    }
  }
  if (state.selectedTrackId != null && !trackIds.has(state.selectedTrackId)) state.selectedTrackId = tracks[0]?.id ?? null;

  // --- Rapport -----------------------------------------------------------------
  const who = (k: string) => {
    const s = names.get(k);
    if (!s || !s.size) return '';
    const list = [...s];
    return ` (${list.slice(0, 3).map(x => `« ${x} »`).join(', ')}${list.length > 3 ? ` et ${list.length - 3} autre${list.length - 3 > 1 ? 's' : ''}` : ''})`;
  };
  const lines: [string, (n: number) => string][] = [
    ['noTracks', () => 'Liste des pistes illisible : projet ouvert sans piste.'],
    ['trackDropped', n => `${plural(n, 'piste illisible retirée', 'pistes illisibles retirées')}.`],
    ['trackNoId', n => `${plural(n, 'piste sans identifiant', 'pistes sans identifiant')} : identifiant recréé.`],
    ['trackDup', n => `${plural(n, 'piste en double renommée', 'pistes en double renommées')}${who('trackDup')}.`],
    ['trackName', n => `${plural(n, 'piste sans nom renommée', 'pistes sans nom renommées')}.`],
    ['trackType', n => `${plural(n, 'piste de type inconnu passée', 'pistes de type inconnu passées')} en piste audio${who('trackType')}.`],
    ['volume', n => `${plural(n, 'volume invalide remis', 'volumes invalides remis')} à 0 dB ou borné${who('volume')}.`],
    ['pan', n => `${plural(n, 'panoramique invalide recentré', 'panoramiques invalides recentrés')} ou borné${who('pan')}.`],
    ['arrayField', n => `${plural(n, 'liste illisible', 'listes illisibles')} (clips, effets, envois ou automation) remise${n > 1 ? 's' : ''} à vide${who('arrayField')}.`],
    ['clipDropped', n => `${plural(n, 'clip illisible ou de durée nulle retiré', 'clips illisibles ou de durée nulle retirés')}${who('clipDropped')}.`],
    ['clipNoId', n => `${plural(n, 'clip sans identifiant', 'clips sans identifiant')} : identifiant recréé.`],
    ['clipDup', n => `${plural(n, 'clip en double renommé', 'clips en double renommés')}${who('clipDup')}.`],
    ['clipTime', n => `${plural(n, 'position ou fondu de clip invalide remis', 'positions ou fondus de clips invalides remis')} à 0${who('clipTime')}.`],
    ['clipGain', n => `${plural(n, 'gain de clip invalide retiré', 'gains de clips invalides retirés')}.`],
    ['notes', n => `${plural(n, 'clip MIDI', 'clips MIDI')} avec des notes illisibles (retirées)${who('notes')}.`],
    ['clipOffline', n => `${plural(n, 'clip dont le son est introuvable', 'clips dont le son est introuvable')} : gardé${n > 1 ? 's' : ''} hors ligne (muet${n > 1 ? 's' : ''})${who('clipOffline')}.`],
    ['pluginDropped', n => `${plural(n, 'effet illisible retiré', 'effets illisibles retirés')}${who('pluginDropped')}.`],
    ['pluginNoId', n => `${plural(n, 'effet sans identifiant', 'effets sans identifiant')} : identifiant recréé${who('pluginNoId')}.`],
    ['pluginDup', n => `${plural(n, 'effet en double renommé', 'effets en double renommés')}${who('pluginDup')}.`],
    ['pluginParams', n => `${plural(n, 'réglage d\'effet illisible remis', 'réglages d\'effets illisibles remis')} par défaut${who('pluginParams')}.`],
    ['laneDropped', n => `${plural(n, 'couloir d\'automation illisible retiré', 'couloirs d\'automation illisibles retirés')}${who('laneDropped')}.`],
    ['autoPoints', n => `${plural(n, 'couloir d\'automation', 'couloirs d\'automation')} avec des points invalides (retirés)${who('autoPoints')}.`],
    ['autoOrder', n => `${plural(n, 'couloir d\'automation remis', 'couloirs d\'automation remis')} dans l'ordre du temps${who('autoOrder')}.`],
    ['frozen', n => `${plural(n, 'rendu gelé illisible : piste dégelée', 'rendus gelés illisibles : pistes dégelées')}${who('frozen')}.`],
    ['output', n => `${plural(n, 'sortie vers une piste absente redirigée', 'sorties vers des pistes absentes redirigées')} vers le master${who('output')}.`],
    ['send', n => `${plural(n, 'envoi vers une piste absente (ou en double) retiré', 'envois vers des pistes absentes (ou en double) retirés')}${who('send')}.`],
    ['structure', n => `${plural(n, 'lien de dossier / VCA vers une piste absente retiré', 'liens de dossiers / VCA vers des pistes absentes retirés')}${who('structure')}.`],
    ['bpm', () => 'Tempo invalide : remis à 120 BPM.'],
    ['timeSignature', () => 'Signature rythmique invalide : remise à 4/4.'],
    ['markers', () => 'Liste des repères illisible : remise à vide.'],
    ['markerDropped', n => `${plural(n, 'repère invalide retiré', 'repères invalides retirés')}.`],
    ['trackGroups', () => 'Groupes de pistes illisibles : retirés.'],
    ['transport', () => 'Positions de lecture / boucle invalides remises à 0.'],
    ['projectId', () => 'Identifiant du projet recréé.'],
    ['projectName', () => 'Nom du projet absent : « Projet récupéré ».'],
  ];
  const report: string[] = [];
  for (const [k, fmt] of lines) {
    const c = counts.get(k);
    if (c) report.push(fmt(c));
  }
  return { state, report, repaired: report.length > 0 };
}
