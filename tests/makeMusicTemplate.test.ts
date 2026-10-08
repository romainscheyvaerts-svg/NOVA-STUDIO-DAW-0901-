// @vitest-environment jsdom
/**
 * Modèle livré à TOUS les utilisateurs : « Session voix · Make Music ».
 * Seulement des effets NOVA (marche sur le site comme dans Nova Studio), règles
 * de mix du studio, visible sans compte, et le modèle LENNON reste privé.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TrackType } from '../types';
import { canAccessTemplate, instantiateTemplate, parseTemplate, templateInfo } from '../utils/sessionTemplate';
import { buildTemplateFromSpec, checkMixRules, TemplateSpec } from '../utils/templateSpec';
import { bundledFileGroup, listTemplates, memoryBackend, setBundledLoader, setTemplateBackend } from '../services/TemplateStore';

const ROOT = path.resolve(__dirname, '..');
const TEXT = fs.readFileSync(path.join(ROOT, 'templates/make-music-voix.novatemplate'), 'utf-8');
const tpl = parseTemplate(TEXT);
const track = (id: string) => tpl.session.tracks.find(t => t.id === id)!;
const band = (pl: any, type: string) => pl.params.bands.find((b: any) => b.type === type && b.isEnabled);

afterEach(() => { setTemplateBackend(null); setBundledLoader(null); });

describe('modèle livré « Session voix · Make Music »', () => {
  it('visible par tous (aucun groupe privé), y compris un invité', () => {
    expect(tpl.privateTo).toBeUndefined();
    expect(canAccessTemplate(tpl, null)).toBe(true);
    expect(canAccessTemplate(tpl, 'artiste@exemple.com')).toBe(true);
  });

  it('seulement des effets NOVA (aucun VST) : rien à remplacer, rien d’inactif', () => {
    const info = templateInfo(tpl);
    expect(info.vst).toBe(0);
    expect(info.inactive).toBe(0);
    expect(tpl.session.tracks.flatMap(t => t.plugins).every(p => p.type !== 'VST3')).toBe(true);
    const { report, state } = instantiateTemplate(tpl, { plugins: null });
    expect(report.messages).toEqual([]);
    expect(report.waitingBridge).toBe(0);
    expect(state.tracks.map(t => t.name)).toEqual(['Beat', 'Voix lead', 'Voix double', 'Backs', 'Bus voix', 'Reverb courte', 'Reverb longue', 'Écho 1/4', 'Master']);
  });

  it('voix lead + double + backs → bus voix ; retours Reverb courte, Reverb longue, Écho 1/4', () => {
    for (const id of ['voix-lead', 'voix-double', 'backs']) {
      expect(track(id).type).toBe(TrackType.AUDIO);
      expect(track(id).outputTrackId).toBe('bus-vox');
      expect(track(id).sends.map(s => s.id).sort()).toEqual(['send-delay', 'send-verb-long', 'send-verb-short']);
    }
    expect(track('bus-vox').type).toBe(TrackType.BUS);
    for (const id of ['send-verb-short', 'send-verb-long', 'send-delay']) expect(track(id).type).toBe(TrackType.SEND);
    expect(track('send-delay').plugins[0].params.division).toBe('1/4');
    expect(track('voix-lead').sends.find(s => s.id === 'send-verb-short')!.level).toBeGreaterThan(0.1);
  });

  it('règles de mix : coupe-bas 80 Hz (lead), 200 Hz + coupe-haut 15 kHz (double, backs), 2:1, de-esser 8 kHz', () => {
    const lead = track('voix-lead').plugins;
    expect(band(lead[0], 'highpass').frequency).toBe(80);
    expect(band(lead[0], 'lowpass')).toBeUndefined();
    for (const id of ['voix-double', 'backs']) {
      const eq = track(id).plugins.find(p => p.type === 'PROEQ12')!;
      expect(band(eq, 'highpass').frequency).toBe(200);
      expect(band(eq, 'lowpass').frequency).toBe(15000);
    }
    for (const id of ['voix-lead', 'voix-double', 'backs']) {
      const pl = track(id).plugins;
      expect(pl.find(p => p.type === 'OPTO_VINTAGE')!.params.ratio).toBe(2);
      expect(pl.find(p => p.type === 'DEESSER')!.params.frequency).toBe(8000);
    }
    // 2e étage sur le bus : autre type (FET), 2:1.
    expect(track('bus-vox').plugins[0].type).toBe('FET76');
    expect(track('bus-vox').plugins[0].params.ratio).toBe(2);
  });

  it('master avec la chaîne Master Nova (EQ, compression, limiteur à −1 dB), reconnue par Master Nova', () => {
    const m = track('master').plugins;
    expect(m.map(p => p.type)).toEqual(['PROEQ12', 'COMPRESSOR', 'LIMITER']);
    expect(m.every(p => p.params.masterNova === true)).toBe(true);
    expect(m[2].params.ceiling).toBe(-1);
  });

  it('la fiche reconstruit le même modèle et passe le contrôle des règles du studio', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/specs/make-music-voix.spec.json'), 'utf-8')) as TemplateSpec;
    const { template, report } = buildTemplateFromSpec(spec, { plugins: [] });
    expect(template.session.tracks.map(x => x.id)).toEqual(tpl.session.tracks.map(x => x.id));
    expect(report.warnings).toEqual([]);
    expect(checkMixRules(template)).toEqual([]);
  });

  it('livré : listé en premier pour un compte quelconque, le modèle LENNON (privé) jamais téléchargé', async () => {
    setTemplateBackend(memoryBackend());
    expect(bundledFileGroup('../templates/romain-lennon-depart.novatemplate')).toBe('romain');
    expect(bundledFileGroup('../templates/make-music-voix.novatemplate')).toBeNull();
    const asked: (string | null | undefined)[] = [];
    setBundledLoader(async (email) => { asked.push(email); return [{ ...tpl, bundled: true }]; });
    const list = await listTemplates('artiste@exemple.com');
    expect(list[0].id).toBe('tpl-make-music-voix');
    expect(asked).toEqual(['artiste@exemple.com']);
  });
});
