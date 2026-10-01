import { AIAction, Clip, Track } from '../types';
import { getVocalRole, isVoiceTrack, VocalRole, ROLE_LABELS } from './vocalRoles';

/**
 * « Écoute » du mix par Nova, comme un ingé son en session : niveaux réels des
 * prises et du beat, équilibre lead / beat, voix secondaires / lead, prises
 * saturées ou trop faibles. Chaque remarque peut pointer le réglage à l'écran
 * (spotlight) et proposer la correction.
 */

export interface TrackLevel {
  id: string;
  name: string;
  role: VocalRole;
  /** Crête des prises brutes (dBFS) : indique saturation / prise trop faible. */
  peakDb: number;
  /** Niveau moyen des passages chantés, brut (dBFS). */
  rmsDb: number;
  /** Niveau dans le mix : brut + gain de clip + fader + effets (estimation). */
  mixDb: number;
  volume: number;
  pan: number;
  takes: number;
}

export interface MixIssue {
  id: string;
  severity: 'bad' | 'warn' | 'tip';
  title: string;
  detail: string;
  /** Cible data-nova-target à montrer (ex. vol-track-rec-main). */
  target?: string;
  spotlightText?: string;
  fix?: { label: string; actions: AIAction[] };
}

export interface MixReport {
  tracks: TrackLevel[];
  issues: MixIssue[];
  summary: string;
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
const pct = (v: number) => `${Math.round(v * 100)} %`;
const clampVol = (v: number) => Math.max(0.05, Math.min(1.5, v));

interface BufferStats { peak: number; rmsActive: number }
const statsCache = new WeakMap<AudioBuffer, Map<string, BufferStats>>();

/** Crête et niveau moyen des fenêtres « actives » (au-dessus de -50 dBFS) d'un passage. */
function analyse(buffer: AudioBuffer, from: number, to: number): BufferStats {
  const key = `${from.toFixed(3)}-${to.toFixed(3)}`;
  let perBuf = statsCache.get(buffer);
  if (!perBuf) { perBuf = new Map(); statsCache.set(buffer, perBuf); }
  const hit = perBuf.get(key);
  if (hit) return hit;

  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buffer.length, Math.ceil(to * sr));
  const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
  const step = 2; // un échantillon sur deux : largement assez pour un niveau
  const win = 2048;
  let peak = 0;
  let energy = 0;
  let activeWins = 0;
  for (let i = a; i < b; i += win) {
    const end = Math.min(b, i + win);
    let sum = 0;
    let n = 0;
    for (let j = i; j < end; j += step) {
      let v = 0;
      for (const ch of chans) { const s = ch[j]; v += s; const as = s < 0 ? -s : s; if (as > peak) peak = as; }
      v /= chans.length;
      sum += v * v;
      n++;
    }
    const ms = n ? sum / n : 0;
    if (ms > 1e-5) { energy += ms; activeWins++; } // -50 dBFS
  }
  const res = { peak, rmsActive: activeWins ? Math.sqrt(energy / activeWins) : 0 };
  perBuf.set(key, res);
  return res;
}

/** Gain approximatif ajouté par la chaîne d'effets (compresseur + gain de sortie). */
function chainGainDb(t: Track): number {
  let g = 0;
  for (const p of t.plugins) {
    if (!p.isEnabled || p.params?.isEnabled === false) continue;
    if (p.type === 'COMPRESSOR') {
      // Le compresseur baisse les crêtes et le gain de compensation remonte le tout :
      // en moyenne la voix ressort ~ (makeup - 3) dB plus fort.
      const makeup = typeof p.params?.makeupGain === 'number' ? db(p.params.makeupGain) : 0;
      g += makeup - 3;
    }
    if (p.type === 'VOCALSATURATOR' && typeof p.params?.outputGain === 'number') g += db(p.params.outputGain);
  }
  return g;
}

export function analyseMix(tracks: Track[], getBuffer: (c: Clip) => AudioBuffer | undefined, vocalMixStyle?: string): MixReport {
  const levels: TrackLevel[] = [];
  for (const t of tracks) {
    const role = getVocalRole(t);
    if (role !== 'beat' && !isVoiceTrack(t)) continue;
    const clips = t.clips.filter(c => !c.isMuted);
    if (!clips.length) continue;
    let peak = 0;
    let energy = 0;
    let weight = 0;
    let gainSum = 0;
    for (const c of clips) {
      const buf = getBuffer(c);
      if (!buf) continue;
      const s = analyse(buf, c.offset || 0, (c.offset || 0) + c.duration);
      peak = Math.max(peak, s.peak);
      energy += s.rmsActive * s.rmsActive * c.duration;
      weight += c.duration;
      gainSum += (c.gain ?? 1) * c.duration;
    }
    if (!weight) continue;
    const rms = Math.sqrt(energy / weight);
    const clipGain = gainSum / weight;
    const muted = t.isMuted ? -120 : 0;
    levels.push({
      id: t.id, name: t.name, role,
      peakDb: db(peak), rmsDb: db(rms),
      mixDb: db(rms) + db(clipGain) + db(t.volume) + chainGainDb(t) + muted,
      volume: t.volume, pan: t.pan, takes: clips.length,
    });
  }

  const issues: MixIssue[] = [];
  const beat = levels.find(l => l.role === 'beat');
  const leads = levels.filter(l => l.role === 'lead');
  const lead = leads.sort((a, b) => b.mixDb - a.mixDb)[0];

  // 1. Qualité des prises (ça ne se rattrape pas au mix : on le dit tout de suite)
  for (const l of levels) {
    if (l.role === 'beat') continue;
    if (l.peakDb > -0.3) {
      issues.push({
        id: `clip-${l.id}`, severity: 'bad',
        title: `${l.name} : la prise sature`,
        detail: "Ta voix tape dans le rouge : ça grésille et ça ne se répare pas au mix. Recule d'une main du micro (15 cm) ou chante un peu moins fort, puis refais la prise.",
        target: `track-${l.id}`, spotlightText: 'Cette prise sature : refais-la un peu plus loin du micro',
      });
    } else if (l.rmsDb < -38) {
      issues.push({
        id: `quiet-${l.id}`, severity: 'warn',
        title: `${l.name} : prise très faible`,
        detail: "On t'entend à peine dans le micro : rapproche-toi (une main de distance) ou monte le gain de ton micro. Une prise trop faible ramène du souffle quand on la remonte.",
        target: `track-${l.id}`, spotlightText: 'Prise trop faible : rapproche-toi du micro',
      });
    }
  }

  // 2. Équilibre lead / beat : la voix doit passer juste au-dessus du beat
  if (lead && beat) {
    const target = vocalMixStyle === 'chant-rnb' ? 0 : 1.5;
    const diff = lead.mixDb - beat.mixDb;
    if (diff < target - 3.5 || diff > target + 5) {
      const tooLow = diff < target;
      const delta = target - diff;
      let actions: AIAction[];
      let spotTarget: string;
      let spot: string;
      const newLead = clampVol(lead.volume * Math.pow(10, delta / 20));
      if (tooLow && newLead >= 1.49) {
        // Fader voix déjà en haut : on baisse plutôt le beat.
        const newBeat = clampVol(beat.volume * Math.pow(10, -delta / 20));
        actions = [{ action: 'SET_VOLUME', payload: { trackId: beat.id, volume: Math.round(newBeat * 100) / 100 }, description: `Beat à ${pct(newBeat)}` }];
        spotTarget = `vol-${beat.id}`;
        spot = `Baisse le beat vers ${pct(newBeat)}`;
      } else {
        actions = [{ action: 'SET_VOLUME', payload: { trackId: lead.id, volume: Math.round(newLead * 100) / 100 }, description: `${lead.name} à ${pct(newLead)}` }];
        spotTarget = `vol-${lead.id}`;
        spot = `${tooLow ? 'Monte' : 'Baisse'} ce fader vers ${pct(newLead)}`;
      }
      issues.push({
        id: 'lead-vs-beat', severity: Math.abs(delta) > 6 ? 'bad' : 'warn',
        title: tooLow ? 'Ta voix est noyée dans le beat' : 'Ta voix est trop devant le beat',
        detail: tooLow
          ? `Ta voix est environ ${Math.round(Math.abs(delta))} dB trop basse : on perd les paroles. Il faut qu'elle passe juste au-dessus du beat.`
          : `Ta voix est environ ${Math.round(Math.abs(delta))} dB trop forte : elle « flotte » au-dessus du beat au lieu d'être dedans.`,
        target: spotTarget, spotlightText: spot,
        fix: { label: 'Corrige le volume', actions },
      });
    }
  }

  // 3. Voix secondaires : plus basses que le lead et ouvertes sur les côtés
  if (lead) {
    const secondaires = levels.filter(l => l.role === 'back' || l.role === 'harmony' || l.role === 'adlib');
    secondaires.forEach((l, i) => {
      const targetRel = l.role === 'adlib' ? -8 : -6;
      const rel = l.mixDb - lead.mixDb;
      if (rel > targetRel + 3) {
        const newVol = clampVol(l.volume * Math.pow(10, (targetRel - rel) / 20));
        issues.push({
          id: `sec-loud-${l.id}`, severity: 'warn',
          title: `${l.name} couvre ton lead`,
          detail: `Les ${ROLE_LABELS[l.role].toLowerCase()} doivent soutenir la voix principale, pas passer devant : environ ${Math.abs(targetRel)} dB en dessous du lead.`,
          target: `vol-${l.id}`, spotlightText: `Baisse ce fader vers ${pct(newVol)}`,
          fix: { label: 'Baisse-les', actions: [{ action: 'SET_VOLUME', payload: { trackId: l.id, volume: Math.round(newVol * 100) / 100 }, description: `${l.name} à ${pct(newVol)}` }] },
        });
      }
      if (Math.abs(l.pan) < 0.1) {
        const side = i % 2 === 0 ? -1 : 1;
        const pan = side * (l.role === 'adlib' ? 0.6 : l.role === 'harmony' ? 0.5 : 0.35);
        issues.push({
          id: `sec-pan-${l.id}`, severity: 'tip',
          title: `${l.name} : ouvre-les sur le côté`,
          detail: "Au centre, les voix secondaires se battent avec le lead. Décalées à gauche ou à droite, elles élargissent le refrain et le lead reste clair.",
          target: `track-${l.id}`, spotlightText: 'Tourne le bouton rond (panoramique) sur le côté',
          fix: { label: 'Ouvre-les', actions: [{ action: 'SET_PAN', payload: { trackId: l.id, pan }, description: `${l.name} ${pan < 0 ? 'à gauche' : 'à droite'}` }] },
        });
      }
    });
  }

  // 4. Pas encore de style : c'est le geste qui change le plus le son
  if (lead && !vocalMixStyle) {
    issues.push({
      id: 'no-style', severity: 'tip',
      title: 'Ta voix est encore « brute »',
      detail: 'Aucun traitement pour l\'instant. Choisis un style de mix : EQ, compression, de-esser et réverb se règlent en un clic.',
      target: 'mix-auto', spotlightText: 'Choisis un style ici',
      fix: { label: 'Choisir un style', actions: [{ action: 'OPEN_MIX_STYLES', payload: {}, description: 'Ouvrir Mix auto' }] },
    });
  }

  const order = { bad: 0, warn: 1, tip: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  let summary: string;
  if (!lead) summary = "Je n'ai pas encore de voix à écouter : enregistre une prise et je te dis ce que j'en pense.";
  else if (!issues.length) summary = '👌 Ton mix est équilibré : la voix passe bien au-dessus du beat et les prises sont propres.';
  else if (issues.some(i => i.severity === 'bad')) summary = "J'ai écouté ton mix : il y a un point important à régler en premier.";
  else summary = `J'ai écouté ton mix : ${issues.length} réglage${issues.length > 1 ? 's' : ''} pour le rendre plus pro.`;

  return { tracks: levels, issues, summary };
}

/** Crête et niveau moyen d'une prise entière (dBFS), pour le bilan après la prise. */
export const takeStats = (buffer: AudioBuffer) => {
  const s = analyse(buffer, 0, buffer.duration);
  return { peakDb: db(s.peak), rmsDb: db(s.rmsActive), silent: s.rmsActive === 0 };
};

/** Résumé compact des niveaux pour le contexte de l'IA. */
export const levelsForAI = (r: MixReport) =>
  r.tracks.map(l => ({ id: l.id, role: l.role, mixDb: Math.round(l.mixDb), peakDb: Math.round(l.peakDb), volume: l.volume, pan: l.pan }));
