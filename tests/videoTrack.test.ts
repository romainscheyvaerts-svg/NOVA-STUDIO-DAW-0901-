/**
 * Vidéo à l'image (écart 24) : calage image ↔ tête de lecture (≤ 1 image), vignettes
 * ancrées, images d'export à cadence fixe, taille d'export paire, rangement par projet.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetVideoForTests, currentVideo, exportFrameTimes, exportSize, isVideoFile, nudgeOffset, setVideoMeta, setVideoProject, syncAction, thumbSlots,
  updateVideoMeta, videoTimeAt, type VideoTrackMeta,
} from '../utils/videoTrack';

const meta = (o: Partial<VideoTrackMeta> = {}): VideoTrackMeta => ({ id: 'v', name: 'clip.mp4', offset: 2, duration: 10, width: 1920, height: 1080, size: 1, fps: 30, addedAt: 0, ...o });

describe('calage', () => {
  it('instant de la vidéo pour la tête de lecture ; hors de la vidéo : null', () => {
    expect(videoTimeAt(5, meta())).toBe(3);
    expect(videoTimeAt(1.5, meta())).toBeNull();
    expect(videoTimeAt(12.5, meta())).toBeNull();
    expect(videoTimeAt(12, meta())).toBe(10);
  });

  it('en lecture : joue, recale seulement au-delà d\'une image (33 ms)', () => {
    const m = meta();
    expect(syncAction({ playhead: 5, playing: true, videoTime: 0, videoPaused: true, meta: m })).toEqual({ kind: 'play', from: 3 });
    expect(syncAction({ playhead: 5, playing: true, videoTime: 3.002, videoPaused: false, meta: m })).toEqual({ kind: 'none' });
    // Petit écart : rattrapé en douceur (en avance de 20 ms → 6 % plus lent ; en retard → plus vite).
    expect(syncAction({ playhead: 5, playing: true, videoTime: 3.02, videoPaused: false, meta: m })).toEqual({ kind: 'rate', rate: 0.94 });
    expect(syncAction({ playhead: 5, playing: true, videoTime: 2.98, videoPaused: false, meta: m })).toEqual({ kind: 'rate', rate: 1.06 });
    expect(syncAction({ playhead: 5, playing: true, videoTime: 3.02, videoPaused: false, rate: 0.94, meta: m })).toEqual({ kind: 'none' });
    expect(syncAction({ playhead: 5, playing: true, videoTime: 3.001, videoPaused: false, rate: 0.94, meta: m })).toEqual({ kind: 'rate', rate: 1 });
    expect(syncAction({ playhead: 5, playing: true, videoTime: 3.05, videoPaused: false, meta: m })).toEqual({ kind: 'seek', to: 3 });
  });

  it('à l\'arrêt : l\'image exacte de la tête de lecture ; avant / après la vidéo', () => {
    const m = meta();
    expect(syncAction({ playhead: 7.25, playing: false, videoTime: 5.25, videoPaused: true, meta: m })).toEqual({ kind: 'none' });
    expect(syncAction({ playhead: 7.25, playing: false, videoTime: 1, videoPaused: true, meta: m })).toEqual({ kind: 'seek', to: 5.25 });
    expect(syncAction({ playhead: 7.25, playing: false, videoTime: 5.25, videoPaused: false, meta: m })).toEqual({ kind: 'pause', at: 5.25 });
    expect(syncAction({ playhead: 1, playing: true, videoTime: 4, videoPaused: false, meta: m })).toEqual({ kind: 'pause', at: 0 });
    expect(syncAction({ playhead: 1, playing: false, videoTime: 0, videoPaused: true, meta: m })).toEqual({ kind: 'hide' });
  });

  it('décaler d\'une image : arrondi à l\'image', () => {
    expect(nudgeOffset(2, 1)).toBeCloseTo(2 + 1 / 30, 12);
    expect(nudgeOffset(2, -3)).toBeCloseTo(1.9, 12);
    expect(Math.round(nudgeOffset(0.5, 1, 25) * 25 * 1000) / 1000).toBe(13.5);
  });
});

describe('vignettes et export', () => {
  it('vignettes ancrées au début de la vidéo (elles ne glissent pas en défilant)', () => {
    const m = meta({ offset: 2, duration: 10 });
    const a = thumbSlots({ t0: 0, t1: 6, pxPerSec: 40, thumbW: 80, meta: m });
    expect(a.map(s => s.x)).toEqual([80, 160]);
    expect(a.map(s => s.videoT)).toEqual([0, 2]);
    const b = thumbSlots({ t0: 5, t1: 9, pxPerSec: 40, thumbW: 80, meta: m });
    expect(b.map(s => s.x)).toEqual([160, 240, 320]);
    expect(thumbSlots({ t0: 20, t1: 30, pxPerSec: 40, thumbW: 80, meta: m })).toEqual([]);
  });

  it('images d\'export à 30 images/s ; taille paire, 1920 au plus', () => {
    const t = exportFrameTimes(2);
    expect(t.length).toBe(60);
    expect(t[59]).toBeCloseTo(59 / 30, 12);
    expect(exportSize(3840, 2160)).toEqual({ w: 1920, h: 1080 });
    expect(exportSize(1081, 1921)).toEqual({ w: 1080, h: 1920 });
    expect(exportSize(641, 359)).toEqual({ w: 642, h: 360 });
    expect(isVideoFile({ name: 'clip.MOV' })).toBe(true);
    expect(isVideoFile({ name: 'son.wav', type: 'audio/wav' })).toBe(false);
  });
});

describe('rangement', () => {
  beforeEach(() => __resetVideoForTests());
  it('une vidéo par projet ; mise à jour ; retrait', () => {
    setVideoProject('p1');
    setVideoMeta(meta());
    updateVideoMeta({ offset: 3.5 });
    expect(currentVideo()!.offset).toBe(3.5);
    setVideoProject('p2');
    expect(currentVideo()).toBeNull();
    setVideoProject('p1');
    setVideoMeta(null);
    expect(currentVideo()).toBeNull();
  });
});
