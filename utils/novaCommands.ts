import { AIAction, DAWState, Track, TrackType } from '../types';
import { findVocalMixStyle } from './vocalPresets';
import { listTakes, selectTakeActions } from './takes';
import { parseVstCommand } from './novaVstCommands';
import { novaBridge } from '../services/NovaBridge';

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
  // Les traits d'union deviennent des espaces : « vas-y » = « vas y ».
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();

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
  // Pont VST connecté : Nova mixe sur les plugins du PC (liste, styles, réglages).
  const vst = parseVstCommand(raw, st, novaBridge.isConnected() && !!novaBridge.getBridgeState().paramsText);
  if (vst) return vst;
  if (!msg || msg.length > 90) return null;
  // Questions et demandes de conseil : pour l'IA.
  if (/\?|\b(pourquoi|comment|conseil\w*|quel\w*|quoi|explique\w*|aide moi a choisir|tu penses|recommande\w*)\b/.test(msg)) return null;

  const voice = voiceTrack(st, msg);
  const beat = st.tracks.find(t => t.id === 'instrumental');
  const more = /\b(monte|augmente|plus fort|plus haut|remonte|booste|plus de)\b/.test(msg);
  const less = /\b(baisse|diminue|moins fort|plus bas|reduis|moins de)\b/.test(msg);
  const say = (text: string, ...actions: AIAction[]): LocalCommandResult => ({ text, actions });

  // Comping : « garde la prise 2 sur la partie 2 / le refrain / la boucle »
  const compCmd = msg.match(/\b(garde|prends|choisis|mets)\b.*\bprise (\d+)\b.*\b(sur|pour|dans) (l |la |le |les )?(.+)$/);
  if (compCmd && voice && !/\btout\b|\bentier/.test(compCmd[5])) {
    const n = parseInt(compCmd[2], 10);
    const zone = compCmd[5].trim();
    return say(`🎚️ Je garde la prise ${n} sur « ${zone} » (les autres prises restent dessous).`,
      { action: 'COMP_TAKE', payload: { take: n, zone, trackId: voice.id } });
  }
  // Session à emporter : « emporte la session », « je veux continuer chez moi / sur mon iPad »
  if (/\b(emport|chez (moi|lui|elle|toi)|sur (mon|son|ton) (ipad|ordi|ordinateur|pc|mac)|session en ligne|qr ?code)/.test(msg)) {
    return say('🏠 Je mets la session en ligne : lien et QR code pour la continuer chez toi, et je peux la ranger dans ton compte Make Music.', { action: 'OPEN_TAKE_HOME', payload: {} });
  }
  // Punch-in : « punch de 0:45 à 0:52 », « refais juste de 1:10 à 1:16 », « punch »
  const pr = msg.match(/\b(punch|refais juste|remplace)\b.*?(\d{1,2})[:h ](\d{2}).*?(\d{1,2})[:h ](\d{2})/);
  if (pr) {
    const a = parseInt(pr[2], 10) * 60 + parseInt(pr[3], 10), b = parseInt(pr[4], 10) * 60 + parseInt(pr[5], 10);
    if (b > a) return say(`🎯 Punch prêt : appuie sur REC, je repars 2 mesures avant ${pr[2]}:${pr[3]} et je ne remplace que jusqu'à ${pr[4]}:${pr[5]}.`, { action: 'SET_PUNCH', payload: { start: a, end: b } });
  }
  if (/\bpunch\b/.test(msg)) return say('🎯 Punch : je bascule le mode (la zone = la boucle).', { action: 'SET_PUNCH', payload: {} });
  // Repères de structure : « va au refrain », « boucle la partie 2 », « va à l'outro »
  const loopIt = /\b(boucle|loop|en boucle)\b/.test(msg);
  if (/\b(refrain|hook)\b/.test(msg) && /\b(va|aller|vas|saute|direction|boucle|loop|mets|amene|emmene|joue)\b/.test(msg)) {
    return say(loopIt ? '🔁 Je boucle la partie la plus pleine de la prod (souvent le refrain).' : '⏩ Je te mets sur la partie la plus pleine de la prod (souvent le refrain).', { action: 'GOTO_SECTION', payload: { target: 'full', loop: loopIt } });
  }
  const part = msg.match(/\b(partie|section)\s*(\d+)\b/);
  if (part) return say(loopIt ? `🔁 Je boucle la partie ${part[2]}.` : `⏩ Partie ${part[2]}.`, { action: 'GOTO_SECTION', payload: { target: `partie ${part[2]}`, loop: loopIt } });
  const io = msg.match(/\b(va|aller|vas|saute|direction|boucle).*\b(intro|outro)\b/);
  if (io) return say(`⏩ ${io[2] === 'intro' ? 'Intro' : 'Outro'}.`, { action: 'GOTO_SECTION', payload: { target: io[2], loop: loopIt } });
  // « reprends à 0:45 », « enregistre à partir de 1:10 » : refaire un passage précis
  const at = msg.match(/\b(reprends|refais|recommence|enregistre|rec|repars)\b.*\b(a|a partir de|depuis|des)\s*(\d{1,2})[:h ](\d{2})\b/);
  if (at) {
    const t = parseInt(at[3], 10) * 60 + parseInt(at[4], 10);
    return say(`🔴 Je me cale à ${at[3]}:${at[4]} et je relance l'enregistrement (décompte d'abord).`,
      { action: 'SEEK', payload: { time: t } }, { action: 'RECORD', payload: {} });
  }
  // « garde la prise 2 », « écoute la prise 1 » : choix de la meilleure prise
  const takeCmd = msg.match(/\b(garde|prends|reprends|choisis|remets|ecoute|ecouter|joue|mets)\b.*\bprise (\d+)\b/);
  if (takeCmd && voice) {
    const n = parseInt(takeCmd[2], 10);
    const acts = selectTakeActions(voice, n);
    const take = listTakes(voice).find(t => t.n === n);
    if (!acts || !take) return say(`Je ne trouve pas de prise ${n} sur ${voice.name}.`);
    const listen = /ecoute|joue/.test(takeCmd[1]);
    return say(listen ? `▶ J'écoute la prise ${n} (les autres prises au même endroit sont coupées).` : `✅ Prise ${n} gardée sur ${voice.name} (les autres sont coupées, pas effacées).`,
      ...acts,
      ...(listen ? [{ action: 'SEEK', payload: { time: take.start } } as AIAction, { action: 'PLAY', payload: {} } as AIAction] : []));
  }

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
  // « enregistre les backs / harmonies / ad-libs » prépare d'abord la bonne piste (règles plus bas).
  if (/\b(enregistre|enregistrer|rec|on enregistre|lance (l )?enregistrement|je suis pret)\b/.test(msg) && !/sauvegard/.test(msg) && !/\b(backs?|doubl|harmo|ad.?libs?)/.test(msg))
    return say('🔴 C\'est parti : décompte, puis enregistrement. Réappuie sur REC pour arrêter.', { action: 'RECORD', payload: {} });
  if (/^(lance|joue|play|lecture|ecoute|fais ecouter|vas y)\b/.test(msg) && !/\b(mix|analyse)\b/.test(msg))
    return say('▶ Lecture.', { action: 'PLAY', payload: {} });
  if (/\b(reviens|retour|retourne|va) au debut\b|^debut$/.test(msg)) return say('⏮ Retour au début.', { action: 'SEEK', payload: { time: 0 } });
  // Seulement une demande d'annulation explicite : « annule la boucle » ou
  // « annule l'autotune » déclenchaient Ctrl+Z (et pouvaient retirer une prise).
  if (/^(annule|annule ca|annule ca stp|annule la derniere (action|modif|modification)|ctrl z|reviens en arriere|defais|defais ca)[ !.?]*$/.test(msg)) return say('↩️ Annulé.', { action: 'UNDO', payload: {} });

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
    // « annule / désactive l'autotune » le retire (il en ajoutait un).
    if (/\b(sans|enleve|retire|coupe|supprime|pas d|annule|desactive|arrete)\b/.test(msg))
      return say('Auto-Tune retiré de ta voix.', { action: 'REMOVE_PLUGIN', payload: { trackId: voice.id, pluginType: 'AUTOTUNE' } });
    const hard = more || /robot|fort|serre|max/.test(msg);
    const soft = less || /naturel|leger|discret/.test(msg);
    const params = hard ? { speed: 0, humanize: 0, mix: 1 } : soft ? { speed: 0.45, humanize: 0.45, mix: 0.8 } : { speed: 0.15, humanize: 0.2, mix: 1 };
    return say(hard ? '🤖 Auto-Tune serré (effet robot) sur ta voix.' : soft ? '🎶 Auto-Tune plus naturel sur ta voix.' : 'Auto-Tune ajouté sur ta voix, calé sur la gamme du beat.',
      ...st.tracks.filter(isVoice).map(t => ({ action: 'UPDATE_PLUGIN', payload: { trackId: t.id, pluginType: 'AUTOTUNE', params } } as AIAction)));
  }

  // Défi du jour (même prod que Beat Swipe sur le site)
  if (/\bd[eé]fi\b/.test(msg)) return say('🎯 Je charge la prod du défi du jour : pose 4 mesures dessus !', { action: 'LOAD_DAILY_CHALLENGE', payload: {} });
  // Batterie Make Music
  if (/\b(batterie|drums?|percu\w*|rythmique|808)\b/.test(msg)) {
    if (/\b(enleve|retire|supprime|sans|coupe|vire)\b/.test(msg)) return say('Batterie retirée.', { action: 'REMOVE_DRUMS', payload: {} });
    const kits: [RegExp, string][] = [[/\btrap\b/, 'trap'], [/\bdrill\b/, 'drill'], [/boom ?bap|old ?school/, 'boombap'], [/\b(rnb|r ?&? ?b|soul)\b/, 'rnb'], [/\bafro/, 'afro'], [/amapiano/, 'amapiano'], [/reggaeton|dembow/, 'dembow'], [/dancehall/, 'dancehall'], [/\bpop\b/, 'pop'], [/house/, 'house'], [/garage|ukg/, 'ukg'], [/drum ?(and|&|n) ?bass|dnb/, 'dnb'], [/reggae/, 'reggae'], [/funk/, 'funk']];
    const hit = kits.find(([re]) => re.test(msg));
    if (/\b(ouvre|modifie|edite|montre)\b/.test(msg) && !hit) return say('🥁 Voici la batterie.', { action: 'OPEN_DRUMS', payload: {} });
    return say(hit ? `🥁 Je pose une batterie ${hit[1]} calée sur ton beat.` : '🥁 Je pose une batterie adaptée à ton morceau.', { action: 'ADD_DRUMS', payload: hit ? { kit: hit[1] } : {} });
  }
  // --- Styles de mix ---
  const styleWords: [RegExp, string][] = [
    [/\btrap\b/, 'trap-autotune'], [/\bdrill\b/, 'drill'], [/\b(chant|rnb|r ?n ?b|r&b|chante)\b/, 'chant-rnb'],
    [/\b(telephone|radio)\b/, 'telephone'], [/\b(brute|sans effet|naturelle?)\b/, 'voix-brute'], [/\b(rap clair|boom ?bap|old ?school|clair)\b/, 'rap-clair'],
    // G25 : demandes naturelles (« un mix propre pour ma voix », « mets de l'autotune »).
    [/\b(auto ?tune)\b/, 'trap-autotune'], [/\b(propre|net|nette|clean|pro)\b/, 'rap-clair'],
  ];
  const wantsProMix = /\b(faire mixer|fais mixer|par un pro|mixage pro|ingenieur|inge son)\b/.test(msg);
  if (!wantsProMix && (/\b(style|mix|mixe|son|effet)\b/.test(msg) || styleWords.some(([re]) => re.test(msg)))) {
    const hit = styleWords.find(([re]) => re.test(msg));
    if (hit) {
      const style = findVocalMixStyle(hit[1]);
      return say(`${style?.emoji || '🎚️'} Style « ${style?.name} » appliqué. Lance la lecture pour écouter, et dis-moi si tu veux plus ou moins de réverb.`,
        { action: 'APPLY_MIX_STYLE', payload: { style: hit[1] } });
    }
    if (/\b(mix auto|styles?|choisis un style|mixe ma voix|mix|mixe)\b/.test(msg) && !/\b(ecoute|analyse|verifie|check)\b|\bmon mix\b/.test(msg)) return say('Voici les styles de mix : choisis-en un, je règle tout.', { action: 'OPEN_MIX_STYLES', payload: {} });
  }

  // --- Session ---
  if (/\b(partage|partager|extrait|demo|tiktok|insta|instagram|story|clip)\b/.test(msg))
    return say('📲 Je t\'ouvre le partage : vidéo 30 s pour Insta / TikTok, extrait audio ou démo complète.', { action: 'OPEN_SHARE', payload: {} });
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
  if (/\b(battle|concours|competition|clash)\b/.test(msg)) return say('🏆 Je t\'ouvre la Battle de la semaine : envoie ton extrait audio et fais voter tes potes.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'battle' } });
  if (/\b(acheter|achete|licence|payer)\b/.test(msg)) return say('🛒 Je t\'ouvre la fiche d\'achat de l\'instru.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'beat' } });
  if (/\b(reserver|reservation|venir au studio|session au studio|studio en vrai)\b/.test(msg))
    return say('🎙️ Je t\'ouvre la réservation d\'une session au studio, avec un ingé son.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'session' } });
  if (/\b(faire mixer|mixage pro|ingenieur|inge son pro|par un pro)\b/.test(msg)) return say('🎚️ Je t\'ouvre la réservation d\'un mixage par nos ingés son.', { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'mix' } });

  return null;
}
