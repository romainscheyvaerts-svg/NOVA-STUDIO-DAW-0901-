/**
 * Loop Record au clavier (Pro Tools : Alt+L sous Windows, pavé 5) : avec une
 * plage sélectionnée, la boucle se pose sur la plage et s'allume (chaque tour
 * devient une prise) ; sans plage, ou si la boucle est déjà sur cette plage,
 * on allume / éteint simplement.
 */
export interface LoopRecordPlan { on: boolean; start: number; end: number; onSelection: boolean }

export function loopRecordToggle(
  sel: { start: number; end: number } | null | undefined,
  st: { isLoopActive: boolean; loopStart: number; loopEnd: number },
): LoopRecordPlan {
  const same = !!sel && Math.abs(st.loopStart - sel.start) < 1e-3 && Math.abs(st.loopEnd - sel.end) < 1e-3;
  if (sel && sel.end - sel.start > 0.05 && !(st.isLoopActive && same)) {
    return { on: true, start: sel.start, end: sel.end, onSelection: true };
  }
  return { on: !st.isLoopActive, start: st.loopStart, end: st.loopEnd, onSelection: false };
}
