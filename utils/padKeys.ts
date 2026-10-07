/**
 * Pads jouables au clavier de l'ordinateur (comme le « typing keyboard » de
 * FL Studio). On lit la touche PHYSIQUE (`KeyboardEvent.code`) : la même
 * rangée sous les doigts en AZERTY et en QWERTY.
 * Rangée du milieu = pads 1 à 10, rangée du haut = 11 à 20, rangée du bas = 21 à 30.
 */
export const PAD_KEY_CODES: string[] = [
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon',
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP',
  'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash',
];

export const padKeyCodes = (n: number) => PAD_KEY_CODES.slice(0, n);

/** Index du pad pour une touche (ou -1). */
export const padIndexForCode = (code: string, padCount: number): number => {
  const i = PAD_KEY_CODES.indexOf(code);
  return i >= 0 && i < padCount ? i : -1;
};

/** Lettre affichée : disposition réelle si le navigateur la donne, sinon AZERTY (studio en France). */
const AZERTY: Record<string, string> = { KeyA: 'Q', KeyQ: 'A', KeyW: 'Z', KeyZ: 'W', Semicolon: 'M', KeyM: ',', Comma: ';', Period: ':', Slash: '!' };
export function padKeyLabel(code: string, layout?: Map<string, string> | null): string {
  const real = layout?.get(code);
  if (real) return real.toUpperCase();
  if (AZERTY[code]) return AZERTY[code];
  return code.replace(/^Key/, '');
}

/** Faut-il laisser la touche à un champ de saisie ? */
export const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'file'].includes(((el as HTMLInputElement).type || 'text').toLowerCase());
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
};
