import { describe, it, expect } from 'vitest';
import { recordChange, trackUserActions, type UndoHistory, type UserAction } from '../utils/undoHistory';

/** Historique d'annulation : une étape par GESTE (tour « édition et navigation », 22/10/2026). */
const opts = (user?: UserAction) => ({ debounceMs: 300, limit: 256, clean: (s: number) => s, user });

describe('annuler : une étape par geste', () => {
  it('un glisser avec une pause de 600 ms reste UNE étape', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    const drag: UserAction = { action: 1, gesture: true };
    h = recordChange(h, 1, 1000, opts(drag));
    h = recordChange(h, 2, 1100, opts(drag));
    h = recordChange(h, 3, 1800, opts(drag)); // pause de 700 ms, bouton toujours appuyé
    h = recordChange(h, 4, 1850, opts(drag));
    expect(h.past).toEqual([0]);
    expect(h.present).toBe(4);
  });

  it('deux commandes tapées en 60 ms = deux étapes', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    h = recordChange(h, 1, 1000, opts({ action: 5, gesture: false })); // S
    h = recordChange(h, 2, 1060, opts({ action: 6, gesture: false })); // Ctrl+D
    expect(h.past).toEqual([0, 1]);
  });

  it('touche maintenue (répétition) : les rafales se fondent encore', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    const held: UserAction = { action: 9, gesture: false };
    for (let i = 1; i <= 10; i++) h = recordChange(h, i, 1000 + i * 33, opts(held));
    expect(h.past).toEqual([0]);
    expect(h.present).toBe(10);
  });

  it('le lâcher d’un long glisser (après une pause) reste dans la même étape', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    h = recordChange(h, 1, 1000, opts({ action: 3, gesture: true }));
    h = recordChange(h, 2, 1900, opts({ action: 3, gesture: false, releasedAt: 1900 }));
    expect(h.past).toEqual([0]);
  });

  it('même geste relâché puis modification tardive (> 300 ms) : nouvelle étape', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    h = recordChange(h, 1, 1000, opts({ action: 2, gesture: true }));
    h = recordChange(h, 2, 2000, opts({ action: 2, gesture: false }));
    expect(h.past).toEqual([0, 1]);
  });

  it('sans suivi des gestes (anciens appels) : anti-rebond inchangé', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    h = recordChange(h, 1, 1000, opts());
    h = recordChange(h, 2, 1100, opts());
    h = recordChange(h, 3, 2000, opts());
    expect(h.past).toEqual([0, 2]);
  });

  it('un groupe ouvert (message du chat) passe avant les gestes', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [], group: 1 };
    h = recordChange(h, 1, 1000, opts({ action: 1, gesture: false }));
    h = recordChange(h, 2, 5000, opts({ action: 2, gesture: false }));
    expect(h.past).toEqual([0]);
    expect(h.present).toBe(2);
  });
});

describe('trackUserActions', () => {
  const target = () => {
    const ls = new Map<string, EventListener[]>();
    return {
      addEventListener: (n: string, f: EventListener) => { ls.set(n, [...(ls.get(n) || []), f]); },
      removeEventListener: (n: string, f: EventListener) => { ls.set(n, (ls.get(n) || []).filter(x => x !== f)); },
      fire: (n: string, ev: any = {}) => (ls.get(n) || []).forEach(f => f(ev)),
      count: () => [...ls.values()].reduce((a, l) => a + l.length, 0),
    };
  };
  it('appui = nouveau geste tenu jusqu’au relâché ; touches comptées hors texte et répétition', () => {
    const t = target();
    const u = trackUserActions(t as any);
    t.fire('pointerdown');
    expect(u.current()).toEqual({ action: 1, gesture: true });
    t.fire('pointerup');
    expect(u.current()).toMatchObject({ action: 1, gesture: false });
    expect(typeof u.current().releasedAt).toBe('number');
    t.fire('keydown', { key: 's', target: { tagName: 'DIV' } });
    expect(u.current().action).toBe(2);
    t.fire('keydown', { key: 's', repeat: true, target: { tagName: 'DIV' } });
    t.fire('keydown', { key: 'Control', target: { tagName: 'DIV' } });
    t.fire('keydown', { key: 'a', target: { tagName: 'INPUT', type: 'text' } });
    expect(u.current().action).toBe(2);
    t.fire('keydown', { key: 'ArrowRight', target: { tagName: 'INPUT', type: 'range' } });
    expect(u.current().action).toBe(3);
    u.dispose();
    expect(t.count()).toBe(0);
  });
});
