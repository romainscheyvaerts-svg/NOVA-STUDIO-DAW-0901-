/**
 * Réglages de l'effet NOVA « Mastering Transient » : valeurs par défaut,
 * bornes, préréglages, réglages automatisables et conversion vers le cœur.
 */
import type { MasterTransientParams } from './masterTransientCore';
import { MASTER_TRANSIENT_PROFILE } from './masterTransientProfile';

export const MT_BANDS = 26;
/** Centres des 26 bandes auditives (Hz, échelle MEL). */
export const MT_CENTERS: number[] = MASTER_TRANSIENT_PROFILE.centers;

export interface MtSpec { id: string; label: string; min: number; max: number; step: number; unit: string; hint: string; auto?: boolean }

export const MT_SPECS: MtSpec[] = [
  { id: 'emphasis', label: 'Emphase des transitoires', min: 0, max: 100, step: 0.5, unit: '%', auto: true,
    hint: "Fait ressortir les attaques (caisse claire, consonnes, cordes pincées) bande par bande, sans toucher au reste. 27 % : léger ; 100 % : jusqu'à +13,7 dB sur l'attaque." },
  { id: 'adaptive', label: 'Emphase adaptative', min: 0, max: 100, step: 1, unit: '%', auto: true,
    hint: "Adapte l'emphase au morceau : moins d'emphase quand la bande est déjà dense, attaques un peu plus longues sur les sons isolés." },
  { id: 'limitGain', label: 'Gain du limiteur', min: 0, max: 12, step: 0.05, unit: 'dB', auto: true,
    hint: "Pousse le son dans le limiteur multibande : plus fort, sans dépasser le plafond. 0 dB = limiteur au repos." },
  { id: 'speed', label: 'Vitesse', min: 0, max: 10, step: 0.05, unit: 'ms',
    hint: "Temps de réaction du limiteur. Court = plus fort et plus « serré » ; long = plus doux." },
  { id: 'adaptiveGain', label: 'Gain adaptatif', min: 0, max: 12, step: 0.05, unit: 'dB',
    hint: "Écart maximal de réduction entre les bandes : les bandes qui touchent le plafond (souvent le grave) sont plus réduites que les autres. 0 = toutes les bandes ensemble." },
  { id: 'adaptiveSpeed', label: 'Vitesse adaptative', min: 0, max: 100, step: 1, unit: '%',
    hint: "Relâchement adapté à chaque bande : plus lent dans le grave (moins de distorsion), plus vif dans l'aigu." },
  { id: 'ceiling', label: 'Plafond', min: -12, max: 0, step: 0.05, unit: 'dB', auto: true,
    hint: "Niveau de crête maximal en sortie. −0,1 dBTP : la valeur de Romain sur son PRE MASTER ; −1 dBTP : la plus sûre pour les plateformes." },
  { id: 'clipDrive', label: 'Clipper : poussée', min: 0, max: 12, step: 0.05, unit: 'dB', auto: true,
    hint: "Écrêtage doux en bout de chaîne pour gagner encore en niveau. 0 = clipper au repos (transparent)." },
  { id: 'clipShape', label: 'Clipper : forme', min: 0, max: 100, step: 1, unit: '%',
    hint: "0 % = coude très doux (saturation) ; 100 % = écrêtage net." },
  { id: 'inputGain', label: "Gain d'entrée", min: -24, max: 24, step: 0.1, unit: 'dB', hint: "Niveau qui entre dans l'effet." },
  { id: 'outputGain', label: 'Gain de sortie', min: -24, max: 24, step: 0.1, unit: 'dB', auto: true, hint: "Niveau en sortie de l'effet (après le plafond)." },
];

export const MT_TOGGLES = [
  { id: 'transientOn', label: 'Transitoires', hint: "Active le façonneur de transitoires." },
  { id: 'limiterOn', label: 'Limiteur', hint: "Active le limiteur multibande et le plafond (coupé : simple protection à 0 dBTP)." },
  { id: 'clipperOn', label: 'Clipper', hint: "Active le clipper doux de fin de chaîne." },
  { id: 'truePeak', label: 'Crête vraie', hint: "Plafond mesuré entre les échantillons (dBTP), comme les plateformes de streaming." },
];

/** Courbe d'emphase par bande de Romain (PRE MASTER, lue dans la fenêtre du plugin d'origine le 08/10/2026). */
export const ROMAIN_BAND_TRANSIENT = [0, 43, 65, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 89, 57, 35, 15, 9];

function bands(prefix: string, vals: number[]) {
  const o: Record<string, number> = {};
  vals.forEach((v, i) => { o[`${prefix}${i + 1}`] = v; });
  return o;
}

export const MT_DEFAULTS: Record<string, number> = {
  emphasis: 27, adaptive: 50, limitGain: 0, speed: 1, adaptiveGain: 6, adaptiveSpeed: 100, ceiling: -0.1,
  clipDrive: 0, clipShape: 0, inputGain: 0, outputGain: 0,
  transientOn: 1, limiterOn: 1, clipperOn: 1, truePeak: 1, soloBand: -1,
  ...bands('bt', new Array(MT_BANDS).fill(100)),
  ...bands('bg', new Array(MT_BANDS).fill(0)),
};

export interface MtPreset { id: string; name: string; hint: string; params: Record<string, number> }

export const MT_PRESETS: MtPreset[] = [
  { id: 'romain', name: 'PRE MASTER Romain', hint: "Les réglages de Romain sur son PRE MASTER : emphase 27 %, adaptative 50 %, courbe par bande, limiteur 26 bandes +8 dB, vitesse 1 ms, plafond −0,1 dBTP, gain adaptatif 6 dB, vitesse adaptative 100 %, clipper à 0.",
    params: { emphasis: 27, adaptive: 50, limitGain: 8, speed: 1, adaptiveGain: 6, adaptiveSpeed: 100, ceiling: -0.1, truePeak: 1,
      clipDrive: 0, clipShape: 0, transientOn: 1, limiterOn: 1, clipperOn: 1, inputGain: 0, outputGain: 0,
      ...bands('bt', ROMAIN_BAND_TRANSIENT), ...bands('bg', new Array(MT_BANDS).fill(0)) } },
  { id: 'transitoires', name: 'Transitoires seules', hint: "Emphase des attaques sans limiteur (pour une piste ou un bus de batterie).",
    params: { emphasis: 40, adaptive: 0, limitGain: 0, limiterOn: 0, clipDrive: 0, transientOn: 1, ...bands('bt', new Array(MT_BANDS).fill(100)) } },
  { id: 'batterie', name: 'Batterie qui claque', hint: "Emphase forte dans le haut-médium (attaque des fûts et de la caisse claire), grave et extrême aigu épargnés.",
    params: { emphasis: 60, adaptive: 25, limitGain: 0, limiterOn: 0, transientOn: 1,
      ...bands('bt', [20, 40, 60, 80, 100, 100, 100, 120, 140, 150, 150, 150, 140, 130, 120, 110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10]) } },
  { id: 'master_doux', name: 'Master doux', hint: "Limiteur discret (+4 dB), emphase légère pour garder le punch, plafond −1 dBTP pour les plateformes.",
    params: { emphasis: 20, adaptive: 50, limitGain: 4, speed: 2, adaptiveGain: 4, adaptiveSpeed: 100, ceiling: -1, truePeak: 1, limiterOn: 1, transientOn: 1,
      ...bands('bt', new Array(MT_BANDS).fill(100)) } },
  { id: 'neutre', name: 'Neutre', hint: "Tout au repos : le son passe sans changement (reconstruction parfaite du banc de filtres).",
    params: { emphasis: 0, adaptive: 0, limitGain: 0, clipDrive: 0, ...bands('bt', new Array(MT_BANDS).fill(100)), ...bands('bg', new Array(MT_BANDS).fill(0)) } },
];

export const MT_AUTOMATABLE = MT_SPECS.filter(s => s.auto).map(s => ({ id: s.id, label: s.label, min: s.min, max: s.max, unit: s.unit }));

/** Garde les réglages connus, bornés. */
export function sanitizeMt(p: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p || {})) {
    const x = typeof v === 'boolean' ? (v ? 1 : 0) : +v;
    if (!Number.isFinite(x)) continue;
    const sp = MT_SPECS.find(s => s.id === k);
    if (sp) out[k] = Math.min(sp.max, Math.max(sp.min, x));
    else if (/^bt\d+$/.test(k)) out[k] = Math.min(200, Math.max(0, x));
    else if (/^bg\d+$/.test(k)) out[k] = Math.min(6, Math.max(-6, x));
    else if (k === 'soloBand') out[k] = Math.round(Math.min(MT_BANDS - 1, Math.max(-1, x)));
    else if (k in MT_DEFAULTS) out[k] = x >= 0.5 ? 1 : 0;
  }
  return out;
}

/** Réglages NOVA (à plat) -> paramètres du cœur. Fonction autonome (sérialisée dans l'AudioWorklet). */
export function mtToCore(p: Record<string, number>): Partial<MasterTransientParams> {
  var bt: number[] = [], bg: number[] = [];
  for (var i = 1; i <= 26; i++) {
    var a = +p['bt' + i], b = +p['bg' + i];
    bt.push(a === a ? a : 100); bg.push(b === b ? b : 0);
  }
  function n(k: string, d: number) { var x = +p[k]; return x === x ? x : d; }
  return {
    emphasis: n('emphasis', 27), adaptive: n('adaptive', 50), bandTransient: bt, bandGainDb: bg,
    limitGainDb: n('limitGain', 0), speedMs: n('speed', 1), adaptiveGainDb: n('adaptiveGain', 6), adaptiveSpeed: n('adaptiveSpeed', 100),
    ceilingDb: n('ceiling', -0.1), truePeak: n('truePeak', 1) >= 0.5, clipDriveDb: n('clipDrive', 0), clipShape: n('clipShape', 0),
    inputDb: n('inputGain', 0), outputDb: n('outputGain', 0), transientOn: n('transientOn', 1) >= 0.5,
    limiterOn: n('limiterOn', 1) >= 0.5, clipperOn: n('clipperOn', 1) >= 0.5, soloBand: Math.round(n('soloBand', -1)),
  };
}
