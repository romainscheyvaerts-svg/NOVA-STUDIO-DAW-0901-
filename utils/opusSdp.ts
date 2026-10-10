/**
 * Réglages Opus par flux, dans le SDP d'une connexion WebRTC (services/CollabRtc).
 *
 * Une connexion entre deux personnes porte plusieurs sections audio (« m=audio ») :
 * le talkback de l'un, celui de l'autre, le mix de l'ingé… Chaque section a SA
 * ligne « a=fmtp » pour Opus. Les paramètres d'une section disent à l'autre
 * comment NOUS envoyer ce flux (RFC 7587) :
 *  - stereo=1 : on veut le recevoir en stéréo (sinon le décodeur est mono et
 *    l'émetteur code en mono) ; sprop-stereo=1 : on l'envoie en stéréo ;
 *  - maxaveragebitrate : débit maximal voulu en réception ;
 *  - useinbandfec : correction d'erreurs (paquets perdus reconstruits).
 *
 * Avant (1.4.4) seule la PREMIÈRE section était réglée : quand on s'était parlé
 * au talkback avant que l'ingé diffuse son mix, le mix partait sur la 2e section,
 * en mono et à débit de voix (mesuré : séparation gauche / droite 0 dB chez
 * l'artiste, piste reçue « channelCount: 1 »).
 */

export type OpusUse = 'music' | 'voice';

/** Mix : stéréo, 510 kb/s (le maximum d'Opus), correction d'erreurs, trames de 10 ms. */
export const MUSIC_FMTP: Record<string, string> = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', useinbandfec: '1', minptime: '10' };
/** Talkback : voix mono (réglage du navigateur), correction d'erreurs. */
export const VOICE_FMTP: Record<string, string> = { useinbandfec: '1', minptime: '10' };
/** Paramètres qu'on pilote (retirés d'une section de voix : elle redevient mono). */
const OWNED = ['stereo', 'sprop-stereo', 'maxaveragebitrate', 'useinbandfec', 'minptime'];

export interface SdpAudioSection {
  /** Rang de la section dans le SDP (0 = première section, tous médias confondus). */
  index: number;
  mid: string | null;
  /** Flux (MediaStream) annoncés par la section (a=msid, a=ssrc … msid). */
  streams: string[];
}

/** Coupe un SDP en en-tête + sections « m= » (séparateurs gardés : recoller = identique). */
export function splitSdp(sdp: string): { head: string; sections: string[] } {
  const parts = sdp.split(/(?=^m=)/m);
  if (!/^m=/.test(parts[0] || '')) return { head: parts[0] || '', sections: parts.slice(1) };
  return { head: '', sections: parts };
}

export function sectionMid(section: string): string | null {
  const m = /^a=mid:(\S+)/m.exec(section);
  return m ? m[1] : null;
}

export function sectionStreams(section: string): string[] {
  const out = new Set<string>();
  for (const m of section.matchAll(/^a=msid:(\S+)/gm)) if (m[1] !== '-') out.add(m[1]);
  for (const m of section.matchAll(/^a=ssrc:\d+ msid:(\S+)/gm)) if (m[1] !== '-') out.add(m[1]);
  return [...out];
}

/** Flux annoncés, par mid, dans un SDP (pour savoir ce que l'autre envoie sur chaque section). */
export function streamsByMid(sdp: string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!sdp) return out;
  for (const s of splitSdp(sdp).sections) {
    const mid = sectionMid(s);
    if (mid != null) out.set(mid, sectionStreams(s));
  }
  return out;
}

function eol(sdp: string) { return sdp.includes('\r\n') ? '\r\n' : '\n'; }

/** Règle la ligne fmtp d'Opus d'UNE section (ajoutée si absente) ; les autres paramètres sont gardés. */
export function tuneOpusSection(section: string, use: OpusUse, nl = '\r\n'): string {
  const m = /^a=rtpmap:(\d+) opus\/48000\/2[^\r\n]*/im.exec(section);
  if (!m) return section;
  const pt = m[1];
  const want = use === 'music' ? MUSIC_FMTP : VOICE_FMTP;
  const build = (params: string) => {
    const keep = params.split(';').map(s => s.trim()).filter(s => s && !OWNED.includes(s.split('=')[0].trim().toLowerCase()));
    return [...keep, ...Object.entries(want).map(([k, v]) => `${k}=${v}`)].join(';');
  };
  const re = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, 'm');
  if (re.test(section)) return section.replace(re, (_all, params: string) => `a=fmtp:${pt} ${build(params)}`);
  return section.replace(m[0], `${m[0]}${nl}a=fmtp:${pt} ${build('')}`);
}

/**
 * Règle Opus dans CHAQUE section audio du SDP. `useOf` dit, section par section,
 * si elle porte de la musique (mix) ou de la voix (talkback) ; par défaut : musique
 * (la qualité d'abord quand on ne sait pas).
 */
export function tuneOpusSdp(sdp: string, useOf: (s: SdpAudioSection) => OpusUse = () => 'music'): string {
  const nl = eol(sdp);
  const { head, sections } = splitSdp(sdp);
  if (!sections.length) {
    // Bout de SDP sans section (tests, fragments) : réglé comme une seule section de musique.
    return tuneOpusSection(sdp, useOf({ index: 0, mid: null, streams: [] }), nl);
  }
  return head + sections.map((s, index) => /^m=audio/.test(s)
    ? tuneOpusSection(s, useOf({ index, mid: sectionMid(s), streams: sectionStreams(s) }), nl)
    : s).join('');
}

/**
 * Ce que porte une section : musique dès que le mix y passe dans un sens ou dans
 * l'autre ; voix seulement si on n'y voit QUE du talkback ; musique si on ne sait pas.
 *  - localKinds : nos flux (identifiant de MediaStream → talk / mix) ;
 *  - remoteKinds : ceux de l'autre (annoncés dans la signalisation) ;
 *  - remoteStreams : flux annoncés par l'autre sur chaque section (par mid).
 */
export function opusUseFor(
  section: SdpAudioSection,
  localKinds: Record<string, 'talk' | 'mix'>,
  remoteKinds: Record<string, 'talk' | 'mix'>,
  remoteStreams: Map<string, string[]>,
): OpusUse {
  const kinds = new Set<string>();
  section.streams.forEach(s => { const k = localKinds[s] || remoteKinds[s]; if (k) kinds.add(k); });
  if (section.mid != null) (remoteStreams.get(section.mid) || []).forEach(s => { const k = remoteKinds[s]; if (k) kinds.add(k); });
  if (!kinds.size || kinds.has('mix')) return 'music';
  return 'voice';
}

/**
 * Qualité du mix reçu, en clair pour l'artiste (statut « en écoute ») :
 * « stéréo · 509 kb/s », ou un avertissement quand il arrive en mono.
 */
export function mixQualityLabel(q: { stereo: boolean | null; kbps: number | null } | null | undefined): { text: string; warn: boolean } | null {
  if (!q || (q.stereo === null && q.kbps == null)) return null;
  const parts: string[] = [];
  if (q.stereo !== null) parts.push(q.stereo ? 'stéréo' : 'mono');
  if (q.kbps != null && q.kbps > 0) parts.push(`${q.kbps} kb/s`);
  return parts.length ? { text: parts.join(' · '), warn: q.stereo === false } : null;
}
