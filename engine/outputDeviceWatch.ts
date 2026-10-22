/**
 * Sortie audio choisie (carte son, casque USB…) débranchée puis rebranchée, comme dans un DAW :
 *  - débranchée : le son passe tout de suite par la sortie par défaut de Windows (avant : le
 *    moteur restait accroché à une sortie disparue, plus aucun son, sans rien dire) ;
 *  - rebranchée : le son y revient tout seul, le réglage de l'artiste n'est jamais perdu.
 * Un message court dit ce qui se passe. Sortie « par défaut » choisie : rien à faire (le
 * navigateur suit déjà la sortie par défaut de Windows).
 */
export interface MediaDevicesLike {
  enumerateDevices(): Promise<{ kind: string; deviceId: string; label: string }[]>;
  addEventListener?(type: 'devicechange', fn: () => void): void;
  removeEventListener?(type: 'devicechange', fn: () => void): void;
}

export interface OutputDeviceWatchOptions {
  media: MediaDevicesLike | null | undefined;
  /** Sortie choisie par l'artiste ('default' ou '' : celle de Windows). */
  wanted: () => string;
  /** Branche le moteur sur une sortie ('' = sortie par défaut). */
  apply: (deviceId: string) => Promise<void>;
  notify: (message: string) => void;
  /** Attente après « devicechange » (Windows annonce parfois la liste en plusieurs fois). */
  settleMs?: number;
}

export type OutputWatchResult = 'idle' | 'ok' | 'lost' | 'back';

export function createOutputDeviceWatch(o: OutputDeviceWatchOptions) {
  let lost = false;
  let label = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy: Promise<OutputWatchResult> | null = null;

  const run = async (): Promise<OutputWatchResult> => {
    const want = o.wanted();
    if (!o.media || !want || want === 'default') { lost = false; return 'idle'; }
    let outs: { deviceId: string; label: string }[];
    try {
      outs = (await o.media.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    } catch { return 'ok'; }
    if (!outs.length) return 'ok'; // liste vide (autorisation, liste en cours) : on ne conclut rien
    const dev = outs.find(d => d.deviceId === want);
    if (dev) {
      if (dev.label) label = dev.label;
      if (!lost) return 'ok';
      lost = false;
      try { await o.apply(want); } catch { /* rebranchée mais pas encore prête : prochain changement */ }
      o.notify(`🔌 ${label ? `« ${label} »` : 'Ta sortie audio'} rebranchée : le son repasse dessus.`);
      return 'back';
    }
    if (lost) return 'lost';
    lost = true;
    try { await o.apply(''); } catch { /* sortie par défaut indisponible : le message le dit quand même */ }
    o.notify(`🔌 ${label ? `« ${label} »` : 'Ta sortie audio'} débranchée : le son passe par la sortie par défaut de Windows. Il y reviendra dès qu'elle sera rebranchée.`);
    return 'lost';
  };

  /** Vérifie maintenant (les appels qui se chevauchent attendent le même résultat). */
  const check = (): Promise<OutputWatchResult> => {
    if (!busy) busy = run().finally(() => { busy = null; });
    return busy;
  };
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void check(); }, o.settleMs ?? 500);
  };
  o.media?.addEventListener?.('devicechange', onChange);
  // Le nom de la sortie choisie est relevé tout de suite (message clair si elle disparaît).
  void check();

  return {
    check,
    isLost: () => lost,
    dispose() {
      if (timer) clearTimeout(timer);
      o.media?.removeEventListener?.('devicechange', onChange);
    },
  };
}
