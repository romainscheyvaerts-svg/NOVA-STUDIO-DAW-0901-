import { Clip, DAWState, ProjectPhase, Track, TrackType } from '../../types';

/** Fabriques de pistes / clips / états de projet pour les tests. */

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

export function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: uid('clip'),
    start: 0,
    duration: 4,
    offset: 0,
    fadeIn: 0,
    fadeOut: 0,
    name: 'Clip',
    color: '#ff0000',
    type: TrackType.AUDIO,
    ...over,
  };
}

export function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: uid('track'),
    name: 'Piste',
    type: TrackType.AUDIO,
    color: '#00ff00',
    isMuted: false,
    isSolo: false,
    isTrackArmed: false,
    isFrozen: false,
    volume: 0.8,
    pan: 0,
    outputTrackId: 'master',
    sends: [
      { id: 'send-verb-short', level: 0.1, isEnabled: true },
      { id: 'send-delay', level: 0, isEnabled: true },
    ],
    clips: [],
    plugins: [],
    automationLanes: [],
    totalLatency: 0,
    ...over,
  };
}

export function makeState(tracks: Track[], over: Partial<DAWState> = {}): DAWState {
  return {
    id: 'proj-1',
    name: 'Projet test',
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    isPlaying: false,
    isRecording: false,
    currentTime: 0,
    isLoopActive: false,
    loopStart: 0,
    loopEnd: 8,
    tracks,
    trackGroups: [],
    markers: [],
    selectedTrackId: null,
    currentView: 'ARRANGEMENT',
    projectPhase: ProjectPhase.RECORDING,
    isLowLatencyMode: false,
    isRecModeActive: false,
    systemMaxLatency: 0,
    recStartTime: null,
    isDelayCompEnabled: true,
    metronome: { enabled: false, volume: 0.5, countIn: 1, accentDownbeat: true, sound: 'CLICK' },
    punch: { enabled: false, punchIn: 0, punchOut: 0, preRoll: 2, postRoll: 1 },
    ...over,
  };
}
