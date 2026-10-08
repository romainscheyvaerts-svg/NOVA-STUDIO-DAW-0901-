/**
 * Presets des VST3 du PC (R4), par le pont :
 *  - enregistrer : l'état binaire du plugin (GET_STATE) et ses paramètres en
 *    valeur texte (GET_PARAMS, pont v7) sont lus sur l'instance chargée ;
 *  - charger : l'état est posé (SET_STATE), puis les paramètres sont RELUS et
 *    comparés à ceux de l'enregistrement : le preset est rechargé à l'identique,
 *    ou NOVA dit précisément ce qui diffère.
 * Rien n'ouvre la fenêtre du plugin.
 */
import { liveVstNodes } from '../engine/VSTPluginNode';
import { novaBridge } from './NovaBridge';
import { compareReadback, ParamReadback } from '../utils/presets';

/** Emplacement du pont où tourne cet effet (null : pas chargé). */
export const slotOfPlugin = (pluginId: string): string | null => liveVstNodes.get(pluginId)?.getSlotId() || null;

/** Paramètres « techniques » sans intérêt pour la vérification (compteurs, MIDI CC…). */
const SKIP = /^(bypass|midi cc|program|preset|cc ?\d+|aftertouch|pitch ?bend)/i;

/** Paramètres du plugin en valeur texte (pont v7), triés par nom. */
export async function readVstParams(slotId: string): Promise<ParamReadback[]> {
  if (!novaBridge.getBridgeState().paramsText) return [];
  const ps = await novaBridge.getParams(slotId).catch(() => []);
  return ps
    .map((p: any) => ({ name: String(p.name ?? p.display_name ?? ''), text: String(p.text ?? (typeof p.value === 'number' ? p.value.toFixed(6) : '')) }))
    .filter(p => p.name && !SKIP.test(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** État complet + paramètres relus d'un VST chargé (pour un preset). */
export async function readVstSlot(slotId: string): Promise<{ stateB64: string | null; readback: ParamReadback[] }> {
  const stateB64 = await novaBridge.getPluginState(slotId);
  const readback = await readVstParams(slotId);
  return { stateB64, readback };
}

export interface VstApplyReport {
  ok: boolean;
  /** Paramètres comparés. */
  checked: number;
  diffs: { name: string; want: string; got: string }[];
  /** État relu après chargement. */
  stateAfter: string | null;
  message: string;
}

/** Pose l'état d'un preset sur l'instance chargée, relit et compare. */
export async function applyVstStateVerified(slotId: string, stateB64: string, want?: ParamReadback[]): Promise<VstApplyReport> {
  const set = await novaBridge.setPluginState(slotId, stateB64);
  const after = await readVstSlot(slotId);
  const cmp = compareReadback(want, after.readback);
  const ok = set && cmp.diffs.length === 0;
  const message = !set
    ? 'Le plugin a refusé ce réglage (état illisible pour cette version ?).'
    : cmp.checked === 0
      ? 'Réglage chargé (pas de relecture : mets à jour le pont pour la vérification).'
      : cmp.diffs.length === 0
        ? `Réglage chargé et vérifié : ${cmp.checked} paramètres relus identiques.`
        : `Réglage chargé, mais ${cmp.diffs.length} paramètre${cmp.diffs.length > 1 ? 's diffèrent' : ' diffère'} : ${cmp.diffs.slice(0, 3).map(d => `${d.name} ${d.got} au lieu de ${d.want}`).join(', ')}${cmp.diffs.length > 3 ? '…' : ''}.`;
  return { ok, checked: cmp.checked, diffs: cmp.diffs, stateAfter: after.stateB64, message };
}
