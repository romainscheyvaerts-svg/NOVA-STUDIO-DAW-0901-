/**
 * Fenêtre d'un effet DANS une branche du rack parallèle (engine/fxRack.ts) : la même façade que
 * dans la console, reliée au nœud que le rack a créé. Chargée à la demande (aucun effet importé
 * tant qu'on n'en ouvre pas un).
 */
import React, { Suspense, lazy } from 'react';
import { getRegisteredPlugin } from '../engine/pluginRegistry';

type UiProps = { node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void; trackId?: string };

const BUILTIN: Record<string, React.LazyExoticComponent<React.ComponentType<UiProps>>> = {
  PROEQ12: lazy(() => import('./ProEQ12Plugin').then(m => ({ default: m.ProEQ12UI as any }))),
  COMPRESSOR: lazy(() => import('./CompressorPlugin').then(m => ({ default: m.VocalCompressorUI as any }))),
  REVERB: lazy(() => import('./ReverbPlugin').then(m => ({ default: m.ProfessionalReverbUI as any }))),
  DELAY: lazy(() => import('./DelayPlugin').then(m => ({ default: m.SyncDelayUI as any }))),
  VOCALSATURATOR: lazy(() => import('./VocalSaturatorPlugin').then(m => ({ default: m.VocalSaturatorUI as any }))),
  DEESSER: lazy(() => import('./DeEsserPlugin').then(m => ({ default: m.VocalDeEsserUI as any }))),
  CHORUS: lazy(() => import('./ChorusPlugin').then(m => ({ default: m.VocalChorusUI as any }))),
  FLANGER: lazy(() => import('./FlangerPlugin').then(m => ({ default: m.StudioFlangerUI as any }))),
  DOUBLER: lazy(() => import('./DoublerPlugin').then(m => ({ default: m.VocalDoublerUI as any }))),
  STEREOSPREADER: lazy(() => import('./StereoSpreaderPlugin').then(m => ({ default: m.StereoSpreaderUI as any }))),
};

export const RackChildUI: React.FC<UiProps & { type: string }> = ({ type, ...props }) => {
  if (!props.node) return <p className="hw-rack-empty">Effet en cours de chargement…</p>;
  const B = BUILTIN[type];
  const UI = B || getRegisteredPlugin(type)?.ui;
  if (!UI) return <p className="hw-rack-empty">Cet effet n’a pas de fenêtre.</p>;
  return (
    <Suspense fallback={<p className="hw-rack-empty">Ouverture de l’effet…</p>}>
      <UI {...props} />
    </Suspense>
  );
};
