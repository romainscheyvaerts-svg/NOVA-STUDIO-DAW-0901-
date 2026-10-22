import React, { useEffect, useRef } from 'react';
import { useV21Params } from './v21Ui';
import { Faceplate, HwPresets, HwSection, HwWindow, Knob, PushButton, SegmentMeter, ToggleSwitch, type KnobProps } from './hw';
import { fmtHzFr, hwCtx, useHwCanvas } from './hw/screens';
import { DYN_BANDS, DYN_DEFAULTS, DYN_PRESETS, DYN_SPECS, MB_DEFAULTS, MB_PRESETS, MB_SPECS, dynBandDb, mbEffectiveCrossovers, type MixFxSpec } from '../engine/mixfx/mixFxParams';

/** Fréquence d'échantillonnage du son (celle du nœud ; 48 kHz si inconnue) : courbes et coupures affichées = celles du son. */
const srOf = (node: any) => (Number.isFinite(+node?.sampleRate) && +node.sampleRate > 0 ? +node.sampleRate : 48000);

/**
 * Fenêtres du « Compresseur multibande » et de l'« EQ dynamique » NOVA, dessinées comme du
 * matériel (kit plugins/hw) : écran des bandes (vivant, hors React), une tranche par bande
 * avec son mètre de réduction à LED, boutons rotatifs gradués, solo / contournement à LED.
 * Aide : infobulles + ligne d'info en bas (jamais de phrase sur la façade).
 */
interface Props { node: any; initialParams: Record<string, any>; onParamsChange: (p: Record<string, any>) => void; trackId?: string }

const fr = (v: number, d = 1) => (Number.isFinite(v) ? v : 0).toFixed(d).replace('.', ',');
const signed = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + fr(Math.abs(v), d);
const msText = (ms: number) => (ms >= 1000 ? `${fr(ms / 1000, 2)} s` : `${fr(ms, ms < 10 ? 1 : 0)} ms`);
const BAND_COLORS = ['#fb923c', '#facc15', '#22d3ee', '#c084fc'];
const MB_NAMES3 = ['Grave', 'Médium', 'Aigu'];
const MB_NAMES4 = ['Grave', 'Bas-médium', 'Haut-médium', 'Aigu'];

function fmtSpec(s: MixFxSpec, v: number): string {
  switch (s.unit) {
    case 'Hz': return fmtHzFr(v);
    case 'dB': return `${signed(v)} dB`;
    case ':1': return `${fr(v)}:1`;
    case 'ms': return msText(v);
    default: return fr(v, s.step >= 1 ? 0 : 2);
  }
}

const marks = (vals: number[], fmt: (v: number) => string = v => String(v)) => vals.map(v => ({ v, label: fmt(v) }));
const kHz = (v: number) => (v >= 1000 ? `${v / 1000}k` : String(v));

/** Axe des fréquences (log, 20 Hz – 20 kHz) d'un écran de largeur w. */
const xOf = (f: number, w: number) => (Math.log10(Math.max(20, Math.min(20000, f)) / 20) / 3) * w;

function drawGrid(c: CanvasRenderingContext2D, w: number, h: number, ink: string) {
  c.strokeStyle = 'rgba(255,255,255,0.07)';
  c.lineWidth = 1;
  c.fillStyle = ink;
  c.font = '9px "JetBrains Mono", monospace';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f, w)) + 0.5;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    c.fillText(kHz(f), x + 2, h - 3);
  }
}

/** Mesures du nœud lues dans une boucle rAF : la façade ne se redessine jamais pour elles. */
function useLiveCanvas(draw: (c: CanvasRenderingContext2D, w: number, h: number, meters: any) => void, node: any) {
  const { wrapRef, canvasRef, size } = useHwCanvas();
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      const c = hwCtx(canvasRef.current, size);
      if (!c) return;
      let m: any = null;
      try { m = node?.getMeters?.() || null; } catch { m = null; }
      c.clearRect(0, 0, size.w, size.h);
      drawRef.current(c, size.w, size.h, m);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node, size, canvasRef]);
  return { wrapRef, canvasRef };
}

// ─── Compresseur multibande ─────────────────────────────────────────────────────────────

const mbSpec = (id: string) => MB_SPECS.find(s => s.id === id)!;

const MbScreen: React.FC<{ node: any; p: Record<string, number> }> = ({ node, p }) => {
  const pr = useRef(p);
  pr.current = p;
  const { wrapRef, canvasRef } = useLiveCanvas((c, w, h, m) => {
    const q = pr.current;
    const nb = +q.bands >= 4 ? 4 : 3;
    // Coupures RÉELLES (celles du son : écart minimal d'1/3 d'octave, plafond 0,45 × fs).
    const xe = mbEffectiveCrossovers(q, srOf(node));
    const xs = [20, xe[0], xe[1], ...(nb === 4 ? [xe[2]] : []), 20000];
    const soloOn = Array.from({ length: nb }, (_, i) => +q[`b${i + 1}Solo`] >= 0.5);
    for (let b = 0; b < nb; b++) {
      const x0 = xOf(xs[b], w), x1 = xOf(xs[b + 1], w);
      const dim = (soloOn.some(Boolean) && !soloOn[b]) || +q[`b${b + 1}Byp`] >= 0.5;
      c.fillStyle = BAND_COLORS[b] + (dim ? '14' : '30');
      c.fillRect(x0, 0, x1 - x0, h);
      // Réduction en cours : barre qui descend du haut (échelle 0 à 24 dB).
      const gr = m?.grNow?.[b] || 0;
      if (gr > 0.05) {
        c.fillStyle = BAND_COLORS[b] + 'cc';
        c.fillRect(x0 + 3, 0, x1 - x0 - 6, Math.min(1, gr / 24) * (h - 14));
      }
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.font = '700 10px Inter, sans-serif';
      const label = `${b + 1}`;
      c.fillText(label, (x0 + x1) / 2 - 3, h / 2 + 4);
    }
    drawGrid(c, w, h, 'rgba(220,230,255,0.55)');
    c.strokeStyle = '#e2e8f0';
    c.lineWidth = 1.5;
    for (let k = 1; k < nb; k++) { const x = Math.round(xOf(xs[k], w)) + 0.5; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h - 12); c.stroke(); }
  }, node);
  return (
    <div className="hw-screen" data-nova-mb-screen>
      <div ref={wrapRef} className="hw-screen-glass" style={{ height: 92 }} role="img"
        aria-label="Écran des bandes : zones de fréquences et réduction en cours de chaque bande">
        <canvas ref={canvasRef} className="hw-screen-canvas" style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
    </div>
  );
};

export const NovaMultibandCompUI: React.FC<Props> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params<Record<string, any>>({ ...MB_DEFAULTS }, initialParams, node, onParamsChange);
  const nb = +p.bands >= 4 ? 4 : 3;
  const names = nb === 4 ? MB_NAMES4 : MB_NAMES3;
  /** Coupure affichée = coupure du son ; si le réglage est trop près de la précédente, la vraie valeur est montrée. */
  const xFmt = (k: number, v: number) => {
    const real = mbEffectiveCrossovers({ ...p, [`x${k + 1}`]: v }, srOf(node))[k];
    return Math.abs(real - v) > 0.5 ? `${fmtHzFr(real)} (réel)` : fmtHzFr(v);
  };
  const K = (id: string, label: string, o: Partial<KnobProps> = {}) => {
    const s = mbSpec(id);
    return (
      <Knob key={id} paramId={id} label={label} ariaLabel={s.label} hint={s.hint} min={s.min} max={s.max} step={s.step}
        curve={s.log ? 'log' : 'lin'} value={+p[id]} defaultValue={MB_DEFAULTS[id]} onChange={v => set({ [id]: v })}
        format={v => fmtSpec(s, v)} size="S" cap="graphite" arc="#a3e635" {...o} />
    );
  };
  const flag = (id: string, text: string, led: string) => {
    const s = mbSpec(id);
    const on = +p[id] >= 0.5;
    return (
      <span data-nova-param={id}>
        <PushButton role="checkbox" active={on} onClick={() => set({ [id]: on ? 0 : 1 })} text={text} led={led} dark hint={s.hint}
          ariaLabel={s.label} valueText={on ? 'oui' : 'non'} className="hw-push-sm" />
      </span>
    );
  };
  const strip = (b: number) => {
    const color = BAND_COLORS[b - 1];
    const xe = mbEffectiveCrossovers(p, srOf(node));
    const lo = b === 1 ? 20 : xe[b - 2];
    const hi = b === nb ? 20000 : xe[b - 1];
    return (
      <HwSection key={b} title={`${b} · ${names[b - 1]}`} className="min-w-0" style={{ ['--hw-accent' as any]: color }}>
        <p className="text-center font-mono" style={{ fontSize: 10, color: 'var(--hw-ink-soft)', marginTop: -2 }}>{fmtHzFr(lo)} – {fmtHzFr(hi)}</p>
        <div className="flex items-start justify-center gap-2 mt-1">
          <div className="flex flex-col items-center">
            <SegmentMeter read={() => node?.getMeters?.()?.grNow?.[b - 1] || 0} max={24} segments={16} orientation="vertical" reverse length={118}
              colorAt={v => (v > 12 ? '#ef4444' : v > 6 ? '#f59e0b' : color)} holdMs={1200}
              format={(v, hold) => (hold > 0.05 ? `−${fr(hold)}` : '0,0')} readoutAttrs={{ 'data-nova-mb-gr': String(b) }}
              label="Réduction" hint={`Réduction de gain de la bande ${b} (dB), maximum tenu.`} />
          </div>
          <div className="flex flex-col items-center gap-1">
            {K(`b${b}Thr`, 'Seuil', { size: 'M', scale: marks([-60, -40, -20, 0], v => (v === 0 ? '0' : `−${Math.abs(v)}`)) })}
            {K(`b${b}Ratio`, 'Taux', { scale: marks([1, 2, 4, 20]) })}
          </div>
        </div>
        <div className="flex flex-wrap items-start justify-center gap-x-1 gap-y-1 mt-1">
          {K(`b${b}Att`, 'Attaque', { ticks: 7 })}
          {K(`b${b}Rel`, 'Relâch.', { ticks: 7 })}
          {K(`b${b}Gain`, 'Gain', { bipolar: true, ticks: 9 })}
        </div>
        <div className="flex items-center justify-center gap-2 mt-2">
          {flag(`b${b}Solo`, 'Solo', '#facc15')}
          {flag(`b${b}Byp`, 'Contourner', '#94a3b8')}
        </div>
      </HwSection>
    );
  };

  return (
    <HwWindow type="MBCOMP" width={nb === 4 ? 860 : 700} accent="#a3e635" accentInk="#0d1405" latencyMs={0} fallback={!!node?.isFallback?.()}
      toolbar={<HwPresets presets={MB_PRESETS as any[]} current={p} onApply={pr => set(pr.params)} />}
      idleHelp={<>Compresseur multibande : le son est séparé en {nb} bandes (filtres Linkwitz-Riley 24 dB/oct, somme plate), chacune avec son propre compresseur. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="navy" model="Multibande" kicker={`Compresseur ${nb} bandes · Linkwitz-Riley 24 dB/oct`} modelStyle="wide">
        <MbScreen node={node} p={p} />
        <div className={`mt-3 grid gap-2 grid-cols-1 min-[420px]:grid-cols-2 ${nb === 4 ? 'md:grid-cols-4' : 'sm:grid-cols-3'}`}>
          {Array.from({ length: nb }, (_, i) => strip(i + 1))}
        </div>
        <HwSection title="Bandes et sortie" className="mt-2">
          <div className="flex flex-wrap items-start justify-around gap-x-3 gap-y-2">
            <div className="self-center">
              <ToggleSwitch paramId="bands" label="Bandes" hint={mbSpec('bands').hint} value={nb} onChange={v => set({ bands: v })}
                options={[{ v: 3, label: '3' }, { v: 4, label: '4' }]} />
            </div>
            {K('x1', 'Coupure 1', { size: 'M', scale: marks([30, 200, 2000], kHz), format: v => xFmt(0, v) })}
            {K('x2', 'Coupure 2', { size: 'M', scale: marks([150, 1000, 12000], kHz), format: v => xFmt(1, v) })}
            {nb === 4 && K('x3', 'Coupure 3', { size: 'M', scale: marks([1000, 5000, 18000], kHz), format: v => xFmt(2, v) })}
            {K('knee', 'Genou', { size: 'M', ticks: 7 })}
            {K('output', 'Sortie', { size: 'M', bipolar: true, scale: marks([-24, 0, 24], v => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0')) })}
          </div>
        </HwSection>
      </Faceplate>
    </HwWindow>
  );
};

// ─── EQ dynamique ─────────────────────────────────────────────────────────────────────

const dynSpec = (id: string) => DYN_SPECS.find(s => s.id === id)!;

/** Réponse (dB) d'une bande : même filtre que le cœur (largeur préwarpée), à la fréquence d'échantillonnage du son. */
const bellDb = (f: number, fc: number, q: number, gDb: number, sr: number) => dynBandDb(f, fc, q, gDb, sr);

const DynScreen: React.FC<{ node: any; p: Record<string, number> }> = ({ node, p }) => {
  const pr = useRef(p);
  pr.current = p;
  const { wrapRef, canvasRef } = useLiveCanvas((c, w, h, m) => {
    const q = pr.current;
    const sr = srOf(node);
    // ±24 dB sur la hauteur ; au-delà (plusieurs bandes qui s'additionnent), la courbe reste dans l'écran.
    const yOf = (db: number) => Math.max(2, Math.min(h - 14, h / 2 - 6 - (db / 24) * (h / 2 - 10)));
    drawGrid(c, w, h, 'rgba(200,220,240,0.55)');
    c.strokeStyle = 'rgba(255,255,255,0.22)';
    c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(0, yOf(0)); c.lineTo(w, yOf(0)); c.stroke();
    c.setLineDash([]);
    const bands = Array.from({ length: DYN_BANDS }, (_, i) => ({
      on: +q[`d${i + 1}On`] >= 0.5, f: +q[`d${i + 1}Freq`], q: +q[`d${i + 1}Q`], range: +q[`d${i + 1}Range`], now: m?.gainNow?.[i] || 0,
    }));
    // Plage maximale de chaque bande (pointillés), puis la courbe réelle en cours.
    bands.forEach((b, i) => {
      if (!b.on || !b.range) return;
      c.strokeStyle = BAND_COLORS[i] + '99';
      c.setLineDash([4, 3]);
      c.beginPath();
      for (let x = 0; x <= w; x += 2) { const f = 20 * Math.pow(1000, x / w); const y = yOf(bellDb(f, b.f, b.q, b.range, sr)); if (x === 0) c.moveTo(x, y); else c.lineTo(x, y); }
      c.stroke();
      c.setLineDash([]);
    });
    c.strokeStyle = '#e0f2fe';
    c.lineWidth = 2;
    c.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = 20 * Math.pow(1000, x / w);
      let db = 0;
      for (const b of bands) if (b.on && b.now) db += bellDb(f, b.f, b.q, b.now, sr);
      const y = yOf(db);
      if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    c.lineWidth = 1;
    bands.forEach((b, i) => {
      const x = xOf(b.f, w), y = yOf(b.now);
      c.fillStyle = b.on ? BAND_COLORS[i] : 'rgba(255,255,255,0.25)';
      c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#05070a';
      c.font = '800 9px Inter, sans-serif';
      c.fillText(String(i + 1), x - 2.6, y + 3.2);
    });
  }, node);
  return (
    <div className="hw-screen" data-nova-dyn-screen>
      <div ref={wrapRef} className="hw-screen-glass" style={{ height: 120 }} role="img"
        aria-label="Écran de l'égaliseur : plage de chaque bande en pointillés, courbe réelle en cours en trait plein">
        <canvas ref={canvasRef} className="hw-screen-canvas" style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
    </div>
  );
};

export const NovaDynamicEqUI: React.FC<Props> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params<Record<string, any>>({ ...DYN_DEFAULTS }, initialParams, node, onParamsChange);
  const listen = Math.round(+p.listen || 0);
  const K = (id: string, label: string, o: Partial<KnobProps> = {}) => {
    const s = dynSpec(id);
    return (
      <Knob key={id} paramId={id} label={label} ariaLabel={s.label} hint={s.hint} min={s.min} max={s.max} step={s.step}
        curve={s.log ? 'log' : 'lin'} value={+p[id]} defaultValue={DYN_DEFAULTS[id]} onChange={v => set({ [id]: v })}
        format={v => fmtSpec(s, v)} size="S" cap="black" {...o} />
    );
  };
  const strip = (b: number) => {
    const color = BAND_COLORS[b - 1];
    const on = +p[`d${b}On`] >= 0.5;
    const range = +p[`d${b}Range`];
    return (
      <HwSection key={b} title={`Bande ${b}`} className="min-w-0" style={{ ['--hw-accent' as any]: color }}
        aside={<span data-nova-param={`d${b}On`}><PushButton role="checkbox" active={on} onClick={() => set({ [`d${b}On`]: on ? 0 : 1 })} text="Active" led="#16a34a"
          hint={dynSpec(`d${b}On`).hint} ariaLabel={dynSpec(`d${b}On`).label} valueText={on ? 'active' : 'coupée'} className="hw-push-sm" /></span>}>
        <div className="flex items-start justify-center gap-2">
          <div className="flex flex-col items-center gap-1">
            {K(`d${b}Freq`, 'Fréquence', { size: 'M', arc: color, scale: marks([20, 200, 2000, 20000], kHz) })}
            {K(`d${b}Q`, 'Q', { ticks: 7 })}
          </div>
          <SegmentMeter read={() => Math.abs(node?.getMeters?.()?.gainNow?.[b - 1] || 0)} max={24} segments={16} orientation="vertical" reverse length={118}
            colorAt={() => (range > 0 ? '#22c55e' : color)} holdMs={1200}
            format={(_v, hold) => (hold > 0.05 ? `${range > 0 ? '+' : '−'}${fr(hold)}` : '0,0')} readoutAttrs={{ 'data-nova-dyn-gain': String(b) }}
            label="Gain" hint={`Gain dynamique appliqué en ce moment par la bande ${b} (dB), maximum tenu.`} />
        </div>
        <div className="grid grid-cols-2 justify-items-center gap-x-1 gap-y-1 mt-1">
          {K(`d${b}Thr`, 'Seuil', { ticks: 7 })}
          {K(`d${b}Range`, 'Plage', { bipolar: true, arc: color, ticks: 9 })}
          {K(`d${b}Att`, 'Attaque', { ticks: 7 })}
          {K(`d${b}Rel`, 'Relâch.', { ticks: 7 })}
        </div>
        <div className="flex justify-center mt-2" data-nova-param="listen">
          <PushButton role="checkbox" active={listen === b} onClick={() => set({ listen: listen === b ? 0 : b })} text="Écouter" led="#facc15"
            hint={`N'entendre que la bande ${b} (ce que surveille le détecteur) : balaie la fréquence jusqu'à entendre la résonance.`}
            ariaLabel={`Écouter la bande ${b}`} valueText={listen === b ? 'oui' : 'non'} className="hw-push-sm" />
        </div>
      </HwSection>
    );
  };
  return (
    <HwWindow type="DYNEQ" width={860} accent="#c026d3" accentInk="#ffffff" latencyMs={0} fallback={!!node?.isFallback?.()}
      toolbar={<HwPresets presets={DYN_PRESETS as any[]} current={p} onApply={pr => set(pr.params)} />}
      idleHelp={<>EQ dynamique : 4 cloches dont le gain ne bouge que quand la bande dépasse son seuil (une résonance de voix calmée seulement quand elle ressort). Sous le seuil, le son passe intact. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="ice" model="EQ dynamique" kicker="4 bandes · anti-résonances" modelStyle="wide">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-[1_1_260px]"><DynScreen node={node} p={p} /></div>
          <div className="flex-none mx-auto">
            {K('output', 'Sortie', { size: 'M', bipolar: true, scale: marks([-24, 0, 24], v => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0')) })}
          </div>
        </div>
        {listen > 0 && <p className="mt-1 text-[10.5px] font-bold" role="status" style={{ color: '#a21caf' }}>Écoute de la bande {listen} seule : clique à nouveau sur « Écouter » pour revenir.</p>}
        <div className="mt-3 grid gap-2 grid-cols-1 min-[420px]:grid-cols-2 md:grid-cols-4">
          {Array.from({ length: DYN_BANDS }, (_, i) => strip(i + 1))}
        </div>
      </Faceplate>
    </HwWindow>
  );
};

