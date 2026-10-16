import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  GUIDES, NEXT_GUIDES, PREREQ_LABELS, applicableSteps, doItCalls, guideById, guideCard, guidesForPrompt, howToIntro,
  isHowToQuestion, matchHowToQuestion, projectFacts, searchGuides, stepsFor, type GuideStep,
} from '../utils/guides';
import { keymapActions, type PaletteAction } from '../utils/commandPalette';
import { KEYMAP } from '../utils/keymap';
import { buildChatCatalog, KNOWN_ACTIONS, planChatCalls } from '../utils/chatTools';
import { buildUserContent } from '../api/chat';
import { TrackType } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

/**
 * « Comment faire ? » : la base des parcours ne doit JAMAIS montrer un bouton qui n'existe pas.
 * Chaque action est cherchée dans la palette réelle (App.tsx buildPaletteActions + utils/keymap),
 * chaque sélecteur dans le code des composants : renommer une action ou un attribut fait échouer ce test.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf-8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, f);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(f)) out.push(rel);
  }
  return out;
}
/** Le code de l'interface (fichier par fichier, pour vérifier un attribut et sa valeur au même endroit). */
const UI_FILES = ['App.tsx', ...sources('components'), ...sources('hooks')].map(f => ({ f, src: read(f) }));
// Les écrans des parcours eux-mêmes ne comptent pas (sinon un sélecteur se validerait tout seul).
const SCREENS = UI_FILES.filter(x => !/HowTo(Coach|Panel|Host)\.tsx$/.test(x.f));

/** Ids des actions du studio, lus dans App.tsx (`a('Rubrique', 'id', …)`) : la palette réelle. */
const APP = read('App.tsx');
const STUDIO_IDS = new Set(Array.from(APP.matchAll(/\ba\('[^']+', '([a-zA-Z0-9._-]+)'/g)).map(m => m[1]));
const KEYMAP_IDS = new Set(keymapActions(new Set(), KEYMAP).map(a => a.id));
const PALETTE_IDS = new Set([...STUDIO_IDS, ...KEYMAP_IDS]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Un morceau de sélecteur `[attr]` / `[attr="valeur"]` existe-t-il dans le code de l'interface ? */
function attrExists(attr: string, value: string | undefined): boolean {
  if (value === undefined) return SCREENS.some(x => new RegExp(`${esc(attr)}[\\s=>/}]`).test(x.src));
  if (attr === 'data-bar-item') return SCREENS.some(x => x.src.includes(`barItem('${value}'`));
  const tok = value.search(/\{(voice|selected)\}/);
  if (tok >= 0) return SCREENS.some(x => x.src.includes(`${attr}={\`${value.slice(0, tok)}\${`));
  if (SCREENS.some(x => x.src.includes(`${attr}="${value}"`) || x.src.includes(`${attr}={'${value}'}`))) return true;
  // Composant qui transmet sa prop « testId » à data-testid (onglets du navigateur…).
  if (attr === 'data-testid' && SCREENS.some(x => x.src.includes(`testId="${value}"`) && x.src.includes('data-testid={testId}'))) return true;
  // Valeur fabriquée (« tab-${tab.id} ») : préfixe dans le gabarit ET suffixe écrit en dur dans le MÊME fichier.
  for (let i = value.lastIndexOf('-'); i > 0; i = value.lastIndexOf('-', i - 1)) {
    const prefix = value.slice(0, i + 1); const suffix = value.slice(i + 1);
    if (SCREENS.some(x => x.src.includes(`${attr}={\`${prefix}\${`) && x.src.includes(`'${suffix}'`))) return true;
  }
  return false;
}

/** Tous les morceaux `[…]` d'un sélecteur (listes séparées par des virgules comprises). */
function selectorParts(sel: string): { attr: string; value?: string }[] {
  const parts = Array.from(sel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)).map(m => ({ attr: m[1], value: m[2] }));
  return parts;
}

const stepSelectors = (s: GuideStep): string[] => [
  ...(s.target ? (Array.isArray(s.target) ? s.target : [s.target]) : []),
  ...(s.done && 'visible' in s.done ? [s.done.visible] : []),
];

describe('base des parcours : forme', () => {
  it('15 à 30 parcours, ids uniques, chaque fiche complète', () => {
    expect(GUIDES.length).toBeGreaterThanOrEqual(15);
    expect(GUIDES.length).toBeLessThanOrEqual(30); // 27 avec les lots 5 et 10 (sons-boucles, demarrer-beat)
    expect(new Set(GUIDES.map(g => g.id)).size).toBe(GUIDES.length);
    for (const g of GUIDES) {
      expect(g.title.length, g.id).toBeGreaterThan(5);
      expect(g.keywords.split(' ').length, g.id).toBeGreaterThanOrEqual(4);
      expect(g.summary.length, g.id).toBeGreaterThan(10);
      expect(g.result.length, g.id).toBeGreaterThan(10);
      expect(g.pitfalls.length, g.id).toBeGreaterThanOrEqual(1);
      expect(g.steps.length, g.id).toBeGreaterThanOrEqual(2);
      for (const p of g.prereqs) expect(PREREQ_LABELS[p], `${g.id} : prérequis ${p}`).toBeTruthy();
      // Textes courts : un parcours se lit d'un coup d'œil.
      for (const s of g.steps) expect(s.text.length, `${g.id} : « ${s.text} »`).toBeLessThanOrEqual(140);
    }
  });

  it('couvre les démarches demandées par Romain (voix, comp, autotune, mix, export, invitation, synthé, kits, Spotify)', () => {
    for (const id of ['enregistrer-voix', 'comp-prises', 'autotune', 'mixer-voix', 'exporter', 'collab', 'synthe', 'batterie-kits', 'spotify']) {
      expect(guideById(id), id).toBeTruthy();
    }
  });

  it('les suggestions « Et après ? » pointent vers des parcours qui existent', () => {
    for (const ids of Object.values(NEXT_GUIDES)) for (const id of ids) expect(guideById(id), id).toBeTruthy();
  });
});

describe('base des parcours : aucune étape inventée', () => {
  it('la palette réelle est bien lue (garde-fou du test lui-même)', () => {
    expect(STUDIO_IDS.has('pal.voiceTrack')).toBe(true);
    expect(STUDIO_IDS.has('nova.export')).toBe(true);
    expect(KEYMAP_IDS.has('nova.record')).toBe(true);
    expect(attrExists('data-nova-target', 'rec')).toBe(true);
    expect(attrExists('data-testid', 'bouton-qui-n-existe-pas')).toBe(false);
    expect(attrExists('data-bar-item', 'exporter')).toBe(true);
  });

  for (const g of GUIDES) {
    it(`${g.emoji} ${g.id} : chaque étape pointe vers une action de la palette ou un bouton qui existe`, () => {
      g.steps.forEach((s, i) => {
        const where = `${g.id}, étape ${i + 1} (« ${s.text.slice(0, 50)}… »)`;
        expect(!!s.action || !!s.target, `${where} : ni action ni bouton`).toBe(true);
        if (s.action) expect(PALETTE_IDS.has(s.action), `${where} : action « ${s.action} » absente de la palette Ctrl+K`).toBe(true);
        for (const sel of stepSelectors(s)) {
          const parts = selectorParts(sel);
          expect(parts.length, `${where} : sélecteur « ${sel} » illisible (attendu [data-…="…"])`).toBeGreaterThan(0);
          for (const p of parts) {
            expect(attrExists(p.attr, p.value), `${where} : ${p.attr}${p.value !== undefined ? `="${p.value}"` : ''} introuvable dans le code`).toBe(true);
          }
        }
        if (s.done && 'fact' in s.done) expect(s.done.fact in projectFacts(null)).toBe(true);
        if (s.skipIf) expect(s.skipIf in projectFacts(null)).toBe(true);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Adapté au projet
// ---------------------------------------------------------------------------
const beat = () => makeTrack({ id: 'instrumental', name: 'BEAT', instrumentId: 'cat-1', clips: [makeClip({ id: 'b1' })] });
const emptyStudio = () => makeState([makeTrack({ id: 'instrumental', name: 'BEAT', clips: [] })]);
const withVoice = (clips = 0) => makeState([beat(), makeTrack({ id: 'track-rec-main', name: 'REC', clips: Array.from({ length: clips }, (_, i) => makeClip({ id: `c${i}`, takeNumber: i + 1 } as any)) })]);

describe('étapes adaptées à l’état du projet et à l’appareil', () => {
  it('projet vide : on commence par l’instru, puis la piste voix ; rien de « déjà fait »', () => {
    const f = projectFacts(emptyStudio());
    const s = stepsFor(guideById('enregistrer-voix')!, f);
    expect(s[0].shown).toMatch(/instru/);
    expect(s.every(x => !x.skipped)).toBe(true);
    expect(howToIntro(guideById('enregistrer-voix')!, f)).toMatch(/On commence par : choisis une instru/);
  });

  it('instru et piste voix déjà là : ces étapes sont cochées « déjà fait », on démarre au REC', () => {
    const f = projectFacts(withVoice());
    const s = stepsFor(guideById('enregistrer-voix')!, f);
    expect(s.filter(x => x.skipped).map(x => x.shown)).toEqual([expect.stringMatching(/instru/), expect.stringMatching(/piste voix/)]);
    expect(howToIntro(guideById('enregistrer-voix')!, f)).toMatch(/2 déjà faites.*appuie sur REC/);
  });

  it('pas de piste voix : la carte du chat commence par en créer une', () => {
    const card = guideCard(guideById('enregistrer-voix')!, projectFacts(makeState([beat()])));
    const first = card.steps.find(s => !s.skipped)!;
    expect(first.text).toMatch(/Ajoute une piste voix/);
  });

  it('téléphone : les étapes « ordinateur » disparaissent, les textes « téléphone » sont pris', () => {
    const g = guideById('exporter')!;
    const tel = stepsFor(g, projectFacts(withVoice(), { mobile: true }));
    expect(tel[0].shown).toMatch(/☰/);
    const comp = guideById('comp-prises')!;
    expect(applicableSteps(comp, projectFacts(withVoice(), { mobile: true })).some(s => s.device === 'desktop')).toBe(false);
    expect(applicableSteps(comp, projectFacts(withVoice(), { mobile: false })).some(s => s.device === 'desktop')).toBe(true);
  });

  it('mode simple : les étapes réservées au mode avancé sont retirées', () => {
    const g = guideById('mixer-voix')!;
    expect(applicableSteps(g, projectFacts(withVoice(), { simple: true })).some(s => s.action === 'view.mixer')).toBe(false);
    expect(applicableSteps(g, projectFacts(withVoice(), { simple: false })).some(s => s.action === 'view.mixer')).toBe(true);
  });

  it('deux prises sur la même piste : la 1re étape du comp est faite', () => {
    expect(projectFacts(withVoice(1)).hasTwoTakes).toBe(false);
    expect(projectFacts(withVoice(2)).hasTwoTakes).toBe(true);
    expect(stepsFor(guideById('comp-prises')!, projectFacts(withVoice(2)))[0].skipped).toBe(true);
  });
});

describe('recherche et questions « comment faire »', () => {
  it('reconnaît les questions de Romain sans l’IA', () => {
    const q: [string, string][] = [
      ['comment je fais pour enregistrer ma voix sur une instru ?', 'enregistrer-voix'],
      ['comment on fait un comp de plusieurs prises', 'comp-prises'],
      ["comment je mets de l'autotune", 'autotune'],
      ['comment mixer ma voix ?', 'mixer-voix'],
      ['comment exporter mon son en mp3', 'exporter'],
      ['comment inviter un ingé son', 'collab'],
      ['comment composer avec le synthé', 'synthe'],
      ['comment faire une batterie avec les kits', 'batterie-kits'],
      ['comment je mets mon morceau sur spotify', 'spotify'],
      ['je veux filmer ma prise, comment ?', 'filmer'],
    ];
    for (const [msg, id] of q) expect(matchHowToQuestion(msg)?.id, msg).toBe(id);
  });

  it('un ordre de mix n’est pas une question « comment faire » (il reste aux commandes de Nova)', () => {
    expect(isHowToQuestion('monte ma voix de 3 dB')).toBe(false);
    expect(matchHowToQuestion('monte ma voix de 3 dB')).toBeNull();
    expect(matchHowToQuestion('comment ça va ?')).toBeNull();
  });

  it('la recherche de la liste trouve par mot-clé et synonyme', () => {
    expect(searchGuides('autotune')[0].id).toBe('autotune');
    expect(searchGuides('distrokid')[0].id).toBe('spotify');
    expect(searchGuides('feat')[0].id).toBe('collab');
    expect(searchGuides('').length).toBe(GUIDES.length);
  });

  it('prompt : rien pour un ordre, quelques lignes « id | titre » pour une question (paliers gratuits)', () => {
    expect(guidesForPrompt('baisse le beat')).toBe('');
    const s = guidesForPrompt('comment je fais pour sortir mon son sur deezer ?');
    expect(s.split('\n')[0]).toMatch(/^spotify \| /);
    expect(s.length).toBeLessThanOrEqual(600);
    const content = buildUserContent({ message: 'comment…', guides: s });
    expect(content).toContain('PARCOURS');
    expect(buildUserContent({ message: 'comment…', guides: 'x'.repeat(5000) }).length).toBeLessThan(1200);
    expect(buildUserContent({ message: 'monte la voix' })).not.toContain('PARCOURS');
  });
});

describe('chat : outil GUIDE et « Fais-le pour moi »', () => {
  const palette: PaletteAction[] = Array.from(STUDIO_IDS).map(id => ({ id, label: id === 'pal.collab' ? 'Collaborer à distance' : id, group: 'Studio', run: () => {} }));
  const ctx = () => ({ state: withVoice(2), commands: buildChatCatalog(palette) });

  it('GUIDE est un outil connu, validé : parcours inconnu refusé avec la raison', () => {
    expect(KNOWN_ACTIONS.has('GUIDE')).toBe(true);
    const plan = planChatCalls([{ action: 'GUIDE', payload: { id: 'autotune' } }, { action: 'GUIDE', payload: { id: 'teleporter' } }], ctx());
    expect(plan.run.map(c => c.label)).toEqual(['Parcours « Mettre de l’autotune »']);
    expect(plan.rejected[0].reason).toMatch(/parcours « teleporter » inconnu/);
  });

  it('les entrées « Comment faire : … » de la palette ne polluent pas le catalogue du modèle', () => {
    const cat = buildChatCatalog([...palette, { id: 'howto.autotune', label: '❓ Mettre de l’autotune', group: 'Comment faire', run: () => {} }]);
    expect(cat.some(c => c.id.startsWith('howto.'))).toBe(false);
  });

  it('« Fais-le pour moi » : chaque appel passe la validation ; export et collaboration demandent « Oui, fais-le »', () => {
    for (const g of GUIDES) {
      const calls = doItCalls(g, projectFacts(withVoice(2)));
      const plan = planChatCalls(calls, ctx());
      expect(plan.rejected, `${g.id} : ${JSON.stringify(plan.rejected)}`).toEqual([]);
    }
    expect(planChatCalls(doItCalls(guideById('exporter')!, projectFacts(withVoice(2))), ctx()).ask.length).toBe(1);
    expect(planChatCalls(doItCalls(guideById('collab')!, projectFacts(withVoice(2))), ctx()).ask.length).toBe(1);
    expect(planChatCalls(doItCalls(guideById('autotune')!, projectFacts(withVoice(2))), ctx()).run.length).toBe(1);
  });

  it('jamais de paiement ni d’achat dans « Fais-le pour moi »', () => {
    for (const g of GUIDES) for (const c of doItCalls(g, projectFacts(withVoice(2)))) {
      expect(JSON.stringify(c)).not.toMatch(/PAY|BUY|CHECKOUT|OPEN_STUDIO_OFFER/);
    }
  });

  it('Spotify : NOVA ne publie pas, le parcours le dit', () => {
    const g = guideById('spotify')!;
    expect(g.result).toMatch(/ne publie pas/);
    expect(g.prereqs).toContain('distributeur');
    expect(doItCalls(g, projectFacts(withVoice()))).toEqual([]);
  });
});

describe('types de pistes', () => {
  it('synthé, batterie, MIDI détectés', () => {
    const f = projectFacts(makeState([beat(), makeTrack({ id: 's', type: TrackType.MIDI, novaSynth: {} as any }), makeTrack({ id: 'd', type: TrackType.DRUM_RACK })]));
    expect(f.hasSynthTrack && f.hasDrumTrack && f.hasMidiTrack).toBe(true);
    expect(f.hasVoiceTrack).toBe(false);
  });
});
