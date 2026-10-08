/**
 * Préférences des vumètres (R11) : échelle choisie (Sample Peak Pro Tools,
 * dBFS, VU, K-20/14/12), gardée dans le navigateur. Le point de mesure
 * pré / post-fader est dans meterBank (il recâble le graphe).
 */
import { MeterScale, MeterScaleId, scaleById } from './scales';

const KEY = 'nova_meter_scale';
let current: MeterScale = (() => { try { return scaleById(localStorage.getItem(KEY)); } catch { return scaleById(null); } })();
const subs = new Set<() => void>();

export const meterPrefs = {
  scale(): MeterScale { return current; },
  setScale(id: MeterScaleId) {
    current = scaleById(id);
    try { localStorage.setItem(KEY, current.id); } catch { /* */ }
    subs.forEach(f => f());
  },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};
