import { AIAction, DAWState, Track, TrackType } from '../types';
import { findVocalMixStyle } from './vocalPresets';

/**
 * Commandes de Nova comprises SANS l'IA : exécution immédiate, même hors
 * ligne ou si le serveur d'IA ne répond pas. Les questions et demandes
 * ouvertes (« pourquoi », « conseille-moi »…) partent à l'IA.
 */

export interface LocalCommandResult {
  text: string;
  actions: AIAction[];
}

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();

const isVoice = (t: Track) => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;

/** Piste voix visée : la sélectionnée si c'est une voix, sinon REC / la première voix. */
function voiceTrack(st: DAWState, msg: string): Track | undefined {
  const voices = st.tracks.filter(isVoice);
  // « mes backs », « les harmonies », « ad-libs »
  const byName = (re: RegExp) => voices.find(t => re.test(norm(t.name)) && t.clips.length) || voices.find(t => re.test(norm(t.name)));
  if (/\bback/.test(msg)) return byName(/back/);
  if (/harmo/.test(msg)) return byName(/harmo/);
  if (/ad.?lib/.test(msg)) return byName(/ad.?lib/);
  const sel = voices.find(t => t.id === st.selectedTrackId);
  return sel || voices.find(t => t.id === 'track-rec-main') || voices[0];
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Dernière prise de la piste : tous les clips qui partagent l'enregistrement le plus récent. */
function lastTake(t: Track) {
  const clips = t.clips.filter(c => !c.isMuted);
  if (!clips.length) return null;
  const latest = clips.reduce((a, b) => ((b.bufferId || b.id) > (a.bufferId || a.id) ? b : a));
  const key = latest.bufferId || latest.id;
  const parts = t.clips.filter(c => (c.bufferId || c.id) === key);
  return { parts, start: Math.min(...parts.map(c => c.start)) };
}

export function parseLocalCommand(raw: string, st: DAWState): LocalCommandResult | null {
  const msg = norm(raw);
  if (!msg || msg.length > 90) return null;
  // Questions et demandes de conseil : pour l'IA.
  if (/\?|\b(pourquoi|comment|conseil\w*|quel\w*|quoi|explique\w*|aide moi a choisir|tu penses|recommande\w*)\b/.test(msg)) return null;

  const voice = voiceTrack(st, msg);
  const beat = st.tracks.find(t => t.id === 'instrumental');
  const more = /\b(monte|augmente|plus fort|plus haut|remonte|booste|plus de)\b/.test(msg);
  const less = /\b(baisse|diminue|moins fort|plus bas|reduis|moins de)\b/.test(msg);
  const say = (text: string, ...actions: AIAction[]): LocalCommandResult => ({ text, actions });

  // --- Transport ---
  // « coupe » seul = stop ; « coupe le métronome / la réverb » est traité plus bas.
  if (/^(stop|arrete|stoppe|pause)\b|^(coupe|arrete)( tout| le son| la musique| la lecture)?$/.test(msg))
    return say('⏹ Stop.', { action: 'STOP', payload: {} });
  if (/\b(refais|recommence|refaire|on la refait|reprends) (la |ma )?prise\b|^(refais|recommence)$/.test(msg) && voice) {
    const last = lastTake(voice);
    return say('🔁 On la refait : je me cale au début de ta dernière prise, décompte puis enregistrement.',
      ...(last ? [{ action: 'SEEK', payload: { time: Math.max(0, last.start) } } as AIAction] : []),
      { action: 'RECORD', payload: {} });
  }
  if (/\b(enregistre|enregistrer|rec|on enregistre|lance (l )?enregistrement|je suis pret)\b/.test(msg) && !/sauvegard/.test(msg))
    return say('🔴 C\'est parti : décompte, puis enregistrement. Réappuie sur REC pour arrêter.', { action: 'RECORD', payload: {} });
  if (/^(lance|joue|play|lecture|ecoute|fais ecouter|vas y)\b/.test(msg) && !/\b(mix|analyse)\b/.test(msg))
    return say('▶ Lecture.', { action: 'PLAY', payload: {} });
  if (/\b(reviens|retour|retourne|va) au debut\b|^debut$/.test(msg)) return say('⏮ Retour au début.', { action: 'SEEK', payload: { time: 0 } });
  if (/\b(annule|ctrl z|reviens en arriere|defais)\b/.test(msg)) return say('↩️ Annulé.', { action: 'UNDO', payload: {} });

  // --- Prises ---
  if (/\b(supprime|efface|vire|enleve)\b.*\b(derniere )?prise\b/.test(msg) && voice) {
    const last = lastTake(voice);
    if (!last) return say("Il n'y a pas encore de prise à supprimer sur cette piste.");
    return say(`🗑 Dernière prise supprimée sur ${voice.name} (Annuler pour la récupérer).`,
      ...last.parts.map(c => ({ action: 'DELETE_CLIP', payload: { trackId: voice.id, clipId: c.id } } as AIAction)));
  }
  if (/\b(nettoie|nettoyer|retire|enleve|supprime)\b.*\b(blanc|silence|souffle)/.test(msg))
    return say('🧹 Je retire les blancs de ta voix.', { action: 'CLEAN_SILENCE', payload: voice ? { trackId: voice.id } : {} });

  // --- Volumes ---
  if ((more || less) && /\b(voix|vocal|moi|ma voix|lead|backs?|harmo\w*|ad.?libs?)\b/.test(msg) && voice) {
    const v = clamp(voice.volume * (more ? 1.22 : 0.8), 0.05, 1.5);
    return say(`${more ? '🔊 Je monte' : '🔉 Je baisse'} ${voice.name} à ${pct(v)}.`,
      { action: 'SET_VOLUME', payload: { trackId: voice.id, volume: Math.round(v * 100) / 100 } },
      { action: 'HIGHLIGHT', payload: { target: `vol-${voice.id}`, text: `${voice.name} à ${pct(v)}` } });
  }
  if ((more || less) && /\b(beat|instru|prod|musique|son)\b/.test(msg) && beat) {
    const v = clamp(beat.volume * (more ? 1.22 : 0.8), 0.05, 1.5);
    return say(`${more ? '🔊 Je monte' : '🔉 Je baisse'} le beat à ${pct(v)}.`,
      { action: 'SET_VOLUME', payload: { trackId: beat.id, volume: Math.round(v * 100) / 100 } },
      { action: 'HIGHLIGHT', payload: { target: `vol-${beat.id}`, text: `Beat à ${pct(v)}` } });
  }

  // --- Réverb / délai (sur toutes les voix) ---
  const fx = /\b(reverb|reverbe|espace|salle)\b/.test(msg) ? 'send-verb-short' : /\b(delay|echo|delai)\b/.test(msg) ? 'send-delay' : null;
  if (fx && (more || less || /\b(ajoute|rajoute|mets)\b/.test(msg) || /\b(sans|enleve|retire|coupe)\b/.test(msg))) {
    const off = /\b(sans|enleve|retire|coupe)\b/.test(msg);
    const voices = st.tracks.filter(isVoice);
    const actions: AIAction[] = voices.map(t => {
      const cur = t.sends.find(s => s.id === fx)?.level ?? 0;
      const level = off ? 0 : clamp(cur + (less ? -0.08 : 0.08), 0, 0.6);
      return { action: 'SET_SEND_LEVEL', payload: { trackId: t.id, sendId: fx, level: Math.round(level * 100) / 100 } };
    });
    const what = fx === 'send-delay' ? 'de délai' : 'de réverb';
    return say(off ? `Je coupe ${fx === 'send-delay' ? 'le délai' : 'la réverb'} sur tes voix.` : `${less ? 'Moins' : 'Plus'} ${what} sur tes voix.`, ...actions);
  }

  // --- Auto-Tune ---
  if (/auto ?tune|autotune|justesse|robot/.test(msg) && voice) {
    if (/\b(sans|enleve|retire|coupe|supprime|pas d)\b/.test(msg))
      return say('Auto-Tune retiré de ta voix.', { action: 'REMOVE_PLUGIN', payload: { trackId: voice.id, pluginType: 'AUTOTUNE' } });
    const hard = more || /robot|fort|serre|max/.test(msg);
    const soft = less || /naturel|leger|discret/.test(msg);
    const params = hard ? { speed: 0, humanize: 0, mix: 1 } : soft ? { speed: 0.45, humanize: 0.45, mix: 0.8 } : { speed: 0.15, humanize: 0.2, mix: 1 };
    return say(hard ? '🤖 Auto-Tune serré (effet robot) sur ta voix.' : soft ? '🎶 Auto-Tune plus naturel sur ta voix.' : 'Auto-Tune ajouté sur ta voix, calé sur la gamme du beat.',
      ...st.tracks.filter(isVoice).map(t => ({ action: 'UPDATE_PLUGIN', payload: { trackId: t.id, pluginType: 'AUTOTUNE', params } } as AIAction)));
  }

  // --- Styles de mix ---
  const styleWords: [RegExp, string][] = [
    [/\btrap\b/, 'trap-autotune'], [/\bdrill\b/, 'drill'], [/\b(chant|rnb|r ?n ?b|r&b|chante)\b/, 'chant-rnb'],
    [/\b(telephone|radio)\b/, 'telephone'], [/\b(brute|sans effet|naturelle?)\b/, 'voix-brute'], [/\b(rap clair|boom ?bap|old ?school|clair)\b/, 'rap-clair'],
  ];
  if (/\b(style|mix|mixe|son|effet)\b/.test(msg) || styleWords.some(([re]) => re.test(msg))) {
    const hit = styleWords.find(([re]) => re.test(msg));
    if (hit) {
      const style = findVocalMixStyle(hit[1]);
      return say(`${style?.emoji || '🎚️'} Style « ${style?.name} » appliqué. Lance la lecture pour écouter, et dis-moi si tu veux plus ou moins de réverb.`,
        { action: 'APPLY_MIX_STYLE', payload: { style: hit[1] } });
    }
    if (/\b(mix auto|styles?|choisis un style|mixe ma voix)\b/.test(msg)) return say('Voici les styles de mix : choisis-en un, je règle tout.', { action: 'OPEN_MIX_STYLES', payload: {} });
  }

  // --- Session ---
  if (/\b(paroles|prompteur|texte|lyrics)\b/.test(msg)) return say('📝 Le prompteur est ouvert : écris ou colle tes paroles, elles défileront pendant la prise.', { action: 'OPEN_LYRICS', payload: {} });
  if (/\b(backs?|doubl)/.test(msg) && /\b(fais|faire|prepare|on fait|passe|enregistre)\b/.test(msg)) return say('🎤 Je prépare la piste des backs.', { action: 'PREPARE_PART', payload: { part: 'back' } });
  if (/\bharmo/.test(msg) && /\b(fais|faire|prepare|on fait|passe|enregistre)\b/.test(msg)) return say('🎶 Je prépare la piste des harmonies.', { action: 'PREPARE_PART', payload: { part: 'harmony' } });
  if (/\bad.?libs?\b/.test(msg) && /\b(fais|faire|prepare|on fait|passe|enregistre)\b/.test(msg)) return say('🔥 Je prépare la piste des ad-libs.', { action: 'PREPARE_PART', payload: { part: 'adlib' } });
  if (/\b(ecoute|analyse|verifie|check)\b.*\bmix\b|\bmon mix\b/.test(msg)) return say("🎧 J'écoute ton mix…", { action: 'ANALYZE_MIX', payload: {} });

  // --- Tempo / métronome / boucle ---
  const bpm = msg.match(/\b(bpm|tempo)\D{0,6}(\d{2,3})\b|\b(\d{2,3}) ?bpm\b/);
  if (bpm) { const v = Number(bpm[2] || bpm[3]); if (v >= 50 && v <= 220) return say(`Tempo à ${v} BPM.`, { action: 'SET_BPM', payload: { bpm: v } }); }
  if (/\b(metronome|click|clic)\b/.test(msg)) {
    const off = /\b(coupe|enleve|retire|sans|desactive|arrete)\b/.test(msg);
    return say(off ? 'Métronome coupé.' : 'Métronome activé.', { action: 'SET_METRONOME', payload: { enabled: !off } });
  }
  if (/\b(boucle|loop)\b/.test(msg)) return say('🔁 Boucle activée / désactivée.', { action: 'TOGGLE_LOOP', payload: {} });

  // --- Offres du studio ---
  if (/\b(acheter|achete|licence|payer)\b/.test(msg)) return say('🛒 Je t\'ouvre la fiche d\'achat de l\'instru.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'beat' } });
  if (/\b(reserver|reservation|venir au studio|session au studio|studio en vrai)\b/.test(msg))
    return say('🎙️ Je t\'ouvre la réservation d\'une session au studio, avec un ingé son.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'session' } });
  if (/\b(faire mixer|mixage pro|ingenieur|inge son pro|par un pro)\b/.test(msg)) return say('🎚️ Je t\'ouvre la réservation d\'un mixage par nos ingés son.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'mix' } });

  return null;
}
