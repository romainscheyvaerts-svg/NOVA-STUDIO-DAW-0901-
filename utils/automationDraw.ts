import type { Track } from '../types';
import { automationModeInfo, automationModeOf, laneDisplayName, normalize, paramSpec, sortedPoints, valueAtPoints } from './automationWrite';

/** Hauteur d'une voie d'automation ouverte sous la piste (même valeur que l'arrangement). */
export const LANE_HEIGHT = 80;

/**
 * Dessine les voies d'automation ouvertes d'une piste dans le canevas de
 * l'arrangement (sous la bande des clips) : on voit la courbe qu'on vient
 * d'écrire au fader, dans la couleur du mode (Read vert, Touch/Latch jaune,
 * Write rouge).
 */
export function drawExpandedLanes(
  ctx: CanvasRenderingContext2D, track: Track, top: number, width: number, viewH: number, zoomH: number, scrollX: number,
) {
  const lanes = (track.automationLanes || []).filter(l => l.isExpanded);
  if (!lanes.length) return;
  const mode = automationModeOf(track);
  const modeColor = automationModeInfo(mode).color;
  let y = top;
  for (const lane of lanes) {
    if (y + LANE_HEIGHT > 40 && y < viewH) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, Math.max(40, y), width, LANE_HEIGHT);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, y, width, LANE_HEIGHT);
      const pts = sortedPoints(lane.points);
      const spec = { ...paramSpec(lane.parameterName), min: lane.min, max: lane.max };
      const toY = (v: number) => {
        const n = spec.kind === 'gain' ? normalize({ ...spec, min: 0 }, v) : (v - lane.min) / ((lane.max - lane.min) || 1);
        return y + 8 + (1 - Math.max(0, Math.min(1, n))) * (LANE_HEIGHT - 16);
      };
      const stat = lane.parameterName === 'volume' ? track.volume : lane.parameterName === 'pan' ? track.pan : (lane.min + lane.max) / 2;
      ctx.strokeStyle = mode === 'off' ? 'rgba(148,163,184,0.5)' : (pts.length ? modeColor : 'rgba(148,163,184,0.35)');
      ctx.lineWidth = 2;
      ctx.beginPath();
      // Une valeur tous les 2 px : courbes comprises, sans parcourir des milliers de points.
      for (let x = 0; x <= width; x += 2) {
        const t = (x + scrollX) / zoomH;
        const yy = toY(valueAtPoints(pts, t, stat));
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      ctx.fillStyle = mode === 'off' ? '#94a3b8' : modeColor;
      for (const p of pts) {
        const x = p.time * zoomH - scrollX;
        if (x < -4 || x > width + 4) continue;
        ctx.fillRect(x - 1.5, toY(p.value) - 1.5, 3, 3);
      }
      ctx.font = '600 10px Inter, sans-serif';
      ctx.fillStyle = 'rgba(226,232,240,0.55)';
      ctx.fillText(`${laneDisplayName(lane.parameterName, track)}${pts.length ? '' : ' · aucun point'}`, 8, y + 14);
      ctx.restore();
    }
    y += LANE_HEIGHT;
  }
}
