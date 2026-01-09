
export class TransportManager {
  private ctx: AudioContext;
  
  // State
  private isPlaying: boolean = false;
  private currentBpm: number = 120;
  
  // Scheduling
  private nextScheduleTime: number = 0;
  private playbackStartTime: number = 0; 
  private pausedAt: number = 0; 
  private schedulerTimer: number | null = null;
  
  // Configuration
  private LOOKAHEAD_MS = 25.0; 
  private SCHEDULE_AHEAD_SEC = 0.1;

  // Callback pour demander au moteur de jouer les sources
  private onScheduleCallback: (startTime: number, endTime: number, contextTime: number) => void;

  constructor(ctx: AudioContext, onSchedule: (s: number, e: number, w: number) => void) {
    this.ctx = ctx;
    this.onScheduleCallback = onSchedule;
  }

  public start(startOffset: number) {
    if (this.isPlaying) this.stop();

    this.isPlaying = true;
    this.pausedAt = startOffset;
    this.nextScheduleTime = this.ctx.currentTime + 0.05; 
    this.playbackStartTime = this.ctx.currentTime - startOffset; 

    // Démarrage de la boucle de scheduling
    this.schedulerTimer = window.setInterval(() => {
      this.scheduler();
    }, this.LOOKAHEAD_MS);
  }

  public stop() {
    this.isPlaying = false;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  public seek(time: number) {
    const wasPlaying = this.isPlaying;
    this.stop();
    this.pausedAt = time;
    if (wasPlaying) {
      this.start(time);
    }
  }

  private scheduler() {
    // Tant que le prochain temps à planifier est dans la fenêtre de lookahead
    while (this.nextScheduleTime < this.ctx.currentTime + this.SCHEDULE_AHEAD_SEC) {
      const scheduleUntil = this.nextScheduleTime + this.SCHEDULE_AHEAD_SEC;
      
      // Conversion Temps AudioContext -> Temps Projet
      const projectTimeStart = this.nextScheduleTime - this.playbackStartTime;
      const projectTimeEnd = scheduleUntil - this.playbackStartTime;
      
      // Délégation au moteur principal pour jouer les clips/midi/automation dans cet intervalle
      this.onScheduleCallback(projectTimeStart, projectTimeEnd, this.nextScheduleTime);
      
      this.nextScheduleTime += this.SCHEDULE_AHEAD_SEC; 
    }
  }

  public getCurrentTime(): number {
    if (this.isPlaying) {
        return Math.max(0, this.ctx.currentTime - this.playbackStartTime);
    }
    return this.pausedAt;
  }

  public setBpm(bpm: number) {
      this.currentBpm = bpm;
  }
  
  public getBpm() { return this.currentBpm; }
  public getIsPlaying() { return this.isPlaying; }

  public setLatencyMode(mode: 'low' | 'balanced' | 'high') {
      if (mode === 'low') { this.LOOKAHEAD_MS = 15.0; this.SCHEDULE_AHEAD_SEC = 0.04; } 
      else if (mode === 'balanced') { this.LOOKAHEAD_MS = 25.0; this.SCHEDULE_AHEAD_SEC = 0.1; } 
      else { this.LOOKAHEAD_MS = 50.0; this.SCHEDULE_AHEAD_SEC = 0.2; }
  }
}
