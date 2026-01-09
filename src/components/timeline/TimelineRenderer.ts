
import { Track, TrackType, Clip, AutomationLane } from '../../types';
import { UI_CONFIG } from '../../utils/constants';

interface RendererState {
  tracks: Track[];
  currentTime: number;
  zoomH: number;
  zoomV: number;
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
  bpm: number;
  gridSize: string;
  isRecording: boolean;
  activeClipId: string | null;
  hoveredTrackId: string | null;
  dragAction: string | null;
  loopStart: number;
  loopEnd: number;
  isLoopActive: boolean;
  theme: 'dark' | 'light';
}

export class TimelineRenderer {
  private ctx: CanvasRenderingContext2D;
  private state: RendererState;

  // Cache pour les couleurs et fonts
  private styles = {
    dark: { bg: '#0c0d10', grid: 'rgba(255,255,255,0.08)', gridSub: 'rgba(255,255,255,0.03)', text: '#64748b' },
    light: { bg: '#334155', grid: 'rgba(255,255,255,0.1)', gridSub: 'rgba(255,255,255,0.05)', text: '#94a3b8' }
  };

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.state = {
      tracks: [], currentTime: 0, zoomH: 40, zoomV: 120,
      scrollLeft: 0, scrollTop: 0, width: 0, height: 0,
      bpm: 120, gridSize: '1/4', isRecording: false,
      activeClipId: null, hoveredTrackId: null, dragAction: null,
      loopStart: 0, loopEnd: 0, isLoopActive: false, theme: 'dark'
    };
  }

  public updateState(newState: Partial<RendererState>) {
    this.state = { ...this.state, ...newState };
  }

  public render() {
    const { width, height, theme } = this.state;
    // Clear
    this.ctx.fillStyle = this.styles[theme].bg;
    this.ctx.fillRect(0, 0, width, height);

    this.drawGrid();
    this.drawLoopRegion();
    this.drawTracks();
    this.drawRuler(); // Dessiné en dernier pour rester au dessus (si pas sticky via CSS)
    this.drawPlayhead();
  }

  private drawGrid() {
    const { zoomH, scrollLeft, width, height, bpm, gridSize, theme } = this.state;
    const style = this.styles[theme];
    
    // Calcul de la densité dynamique
    const beatPx = (60 / bpm) * zoomH;
    
    // Déterminer le sous-diviseur visuel optimal
    // Si les lignes sont trop serrées (< 10px), on réduit la densité
    let subDivs = 4; // Default 1/16
    if (gridSize === '1/1') subDivs = 1;
    else if (gridSize === '1/8') subDivs = 2;
    
    // Adaptive reduction
    if (beatPx / subDivs < 15) subDivs = 1;
    if (beatPx < 15) subDivs = 0.25; // 1 bar only

    const startTime = this.pixelsToTime(scrollLeft);
    const endTime = this.pixelsToTime(scrollLeft + width);
    const startBar = Math.floor(startTime * (bpm / 60) / 4);
    const endBar = Math.ceil(endTime * (bpm / 60) / 4);

    this.ctx.lineWidth = 1;

    for (let i = startBar; i <= endBar; i++) {
      const time = i * 4 * (60 / bpm);
      const x = this.timeToPixels(time) - scrollLeft;
      
      // Bar Lines
      this.ctx.strokeStyle = style.grid;
      this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, height); this.ctx.stroke();

      // Beat Lines
      if (subDivs >= 1) {
          this.ctx.strokeStyle = style.gridSub;
          const barDuration = 4 * (60/bpm);
          const subStepTime = barDuration / (4 * subDivs); // 4 beats * subdivisions
          const subStepPx = subStepTime * zoomH;

          for (let j = 1; j < (4 * subDivs); j++) {
             const sx = x + j * subStepPx;
             if (sx > x && sx < x + (barDuration * zoomH)) {
                this.ctx.beginPath(); this.ctx.moveTo(sx, 0); this.ctx.lineTo(sx, height); this.ctx.stroke();
             }
          }
      }
    }
  }

  private drawLoopRegion() {
    const { isLoopActive, loopStart, loopEnd, scrollLeft, zoomH, height, width } = this.state;
    if (!isLoopActive || loopEnd <= loopStart) return;

    const lx = (loopStart * zoomH) - scrollLeft;
    const lw = (loopEnd - loopStart) * zoomH;

    if (lx + lw > 0 && lx < width) {
        this.ctx.fillStyle = 'rgba(0, 242, 255, 0.03)';
        this.ctx.fillRect(Math.max(0, lx), 0, Math.min(width, lw), height);
        
        this.ctx.strokeStyle = '#00f2ff';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 5]);
        this.ctx.beginPath(); this.ctx.moveTo(lx, 0); this.ctx.lineTo(lx, height); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.moveTo(lx + lw, 0); this.ctx.lineTo(lx + lw, height); this.ctx.stroke();
        this.ctx.setLineDash([]);
    }
  }

  private drawTracks() {
    const { tracks, scrollTop, scrollLeft, width, height, zoomV, zoomH, activeClipId, hoveredTrackId, dragAction, theme } = this.state;
    
    this.ctx.save();
    this.ctx.translate(0, -scrollTop);

    let currentY = 40; // Header Offset

    // Filtrer les pistes visibles (logique simplifiée ici, le parent doit passer les tracks filtrées si besoin)
    // Ici on assume que `tracks` contient toutes les pistes et on clip au rendu
    
    // Optimisation: trouver le range d'index visible
    
    tracks.forEach(track => {
      // Skip if completely out of view
      if (currentY > scrollTop + height) return;
      if (currentY + zoomV < scrollTop) {
          currentY += zoomV + (track.automationLanes.filter(l => l.isExpanded).length * 80);
          return;
      }

      // Track Background/Selection
      if (hoveredTrackId === track.id && dragAction === 'MOVE') {
          this.ctx.fillStyle = 'rgba(0, 242, 255, 0.05)';
          this.ctx.fillRect(0, currentY, width, zoomV);
      }

      // Separator
      this.ctx.strokeStyle = theme === 'light' ? '#cbd5e1' : '#1e2229';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(0, currentY + zoomV); this.ctx.lineTo(width, currentY + zoomV); this.ctx.stroke();

      // Clips
      track.clips.forEach(clip => {
          const cx = (clip.start * zoomH) - scrollLeft;
          const cw = clip.duration * zoomH;
          
          if (cx + cw > 0 && cx < width) {
             this.drawClip(clip, track.color, cx, currentY + 2, cw, zoomV - 4, activeClipId === clip.id);
          }
      });
      
      // Automation Lanes (Placeholder visual)
      track.automationLanes.forEach(lane => {
          if (lane.isExpanded) {
              this.ctx.fillStyle = theme === 'light' ? 'rgba(0,0,0,0.05)' : '#111316';
              this.ctx.fillRect(0, currentY + zoomV, width, 80);
              // Draw simplified curve
              this.drawAutomationCurve(lane, scrollLeft, width, currentY + zoomV, 80);
              currentY += 80;
          }
      });

      currentY += zoomV;
    });

    this.ctx.restore();
  }

  private drawClip(clip: Clip, color: string, x: number, y: number, w: number, h: number, isSelected: boolean) {
    // Background
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, 6);
    this.ctx.clip();

    this.ctx.fillStyle = clip.isMuted ? '#111' : '#1e2229';
    this.ctx.fill();
    this.ctx.fillStyle = (clip.color || color) + (clip.isMuted ? '11' : '33');
    this.ctx.fill();

    // Waveform or MIDI pattern
    if (clip.buffer) {
       this.drawWaveform(clip, x, y, w, h, isSelected ? '#fff' : (clip.color || color));
    } else if (clip.type === TrackType.MIDI && clip.notes) {
       this.drawMidiNotes(clip, x, y, w, h, isSelected ? '#fff' : (clip.color || color));
    }

    // Border
    this.ctx.strokeStyle = isSelected ? '#ffffff' : (clip.color || color);
    this.ctx.lineWidth = isSelected ? 2 : 1;
    this.ctx.strokeRect(x, y, w, h);

    // Name
    this.ctx.restore();
    this.ctx.fillStyle = '#fff';
    this.ctx.font = 'bold 10px Inter';
    this.ctx.fillText(clip.name, x + 6, y + 14);
  }

  private drawWaveform(clip: Clip, x: number, y: number, w: number, h: number, color: string) {
    if (!clip.buffer) return;
    const data = clip.buffer.getChannelData(0);
    const step = Math.ceil(data.length / (w * (clip.buffer.duration/clip.duration))); // Approx
    const amp = h / 2;
    const centerY = y + h / 2;
    
    // Calculate start/end sample indices based on offset
    const startSample = Math.floor(clip.offset * clip.buffer.sampleRate);
    const endSample = Math.floor((clip.offset + clip.duration) * clip.buffer.sampleRate);
    
    // Pixel step relative to buffer
    const samplesPerPixel = (clip.buffer.sampleRate / this.state.zoomH);
    
    this.ctx.beginPath();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;

    for (let i = 0; i < w; i++) {
        const sampleIdx = startSample + Math.floor(i * samplesPerPixel);
        if (sampleIdx >= endSample || sampleIdx >= data.length) break;
        
        // Simple decimation for speed (max of chunk)
        let min = 1.0, max = -1.0;
        const chunk = 32; // Check limited points
        for(let j=0; j<chunk; j++) {
            const idx = sampleIdx + j;
            if(idx < data.length) {
                const v = data[idx];
                if(v < min) min = v;
                if(v > max) max = v;
            }
        }
        
        this.ctx.moveTo(x + i, centerY + min * amp);
        this.ctx.lineTo(x + i, centerY + max * amp);
    }
    this.ctx.stroke();
  }

  private drawMidiNotes(clip: Clip, x: number, y: number, w: number, h: number, color: string) {
      if (!clip.notes) return;
      const pxPerSec = this.state.zoomH;
      
      this.ctx.fillStyle = color;
      clip.notes.forEach(note => {
          const nx = x + note.start * pxPerSec;
          const nw = note.duration * pxPerSec;
          // Map 0-127 pitch to 0-h height
          const nh = 3;
          const ny = y + h - ((note.pitch / 127) * h);
          
          if (nx + nw > x && nx < x + w) {
             this.ctx.fillRect(Math.max(x, nx), ny, Math.min(w, nw), nh);
          }
      });
  }

  private drawAutomationCurve(lane: AutomationLane, scrollLeft: number, width: number, y: number, h: number) {
      if (!lane.points || lane.points.length === 0) return;
      
      const { zoomH } = this.state;
      const points = [...lane.points].sort((a,b) => a.time - b.time);
      const valToY = (v: number) => y + h - ((v - lane.min)/(lane.max - lane.min)) * h;
      
      this.ctx.beginPath();
      this.ctx.strokeStyle = lane.color;
      this.ctx.lineWidth = 2;
      
      const startX = (points[0].time * zoomH) - scrollLeft;
      this.ctx.moveTo(startX, valToY(points[0].value));
      
      for(let i=1; i<points.length; i++) {
          const px = (points[i].time * zoomH) - scrollLeft;
          const py = valToY(points[i].value);
          this.ctx.lineTo(px, py);
      }
      this.ctx.stroke();
      
      // Points
      this.ctx.fillStyle = '#fff';
      points.forEach(p => {
         const px = (p.time * zoomH) - scrollLeft;
         if (px >= 0 && px <= width) {
             this.ctx.beginPath();
             this.ctx.arc(px, valToY(p.value), 3, 0, Math.PI*2);
             this.ctx.fill();
         }
      });
  }

  private drawRuler() {
      // Only drawn if we want it part of the canvas, 
      // but usually ArrangementView has a separate div for sticky header.
      // We will skip this to keep it sticky in CSS.
  }

  private drawPlayhead() {
      const { currentTime, zoomH, scrollLeft, height, isRecording } = this.state;
      const x = (currentTime * zoomH) - scrollLeft;
      
      if (x >= 0 && x <= this.state.width) {
          this.ctx.strokeStyle = isRecording ? '#ef4444' : '#00f2ff';
          this.ctx.lineWidth = 1;
          this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, height); this.ctx.stroke();
          
          this.ctx.fillStyle = isRecording ? '#ef4444' : '#00f2ff';
          this.ctx.beginPath(); 
          this.ctx.moveTo(x - 6, 0); 
          this.ctx.lineTo(x + 6, 0); 
          this.ctx.lineTo(x, 12); 
          this.ctx.fill();
      }
  }

  private timeToPixels(time: number): number { return time * this.state.zoomH; }
  private pixelsToTime(px: number): number { return px / this.state.zoomH; }
}
