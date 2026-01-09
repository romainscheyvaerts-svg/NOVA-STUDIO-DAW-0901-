
/**
 * CENTRALIZED CONSTANTS
 */

// ============================================================================
// MUSIC THEORY
// ============================================================================

export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = ['CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC', 'TRAP_DARK'];

// ============================================================================
// AUDIO CONFIGURATION
// ============================================================================

export const AUDIO_CONFIG = {
  MAX_TRACKS: 64,
  MAX_PLUGINS_PER_TRACK: 16,
  SAMPLE_RATES: [44100, 48000, 88200, 96000] as const,
  BUFFER_SIZES: [128, 256, 512, 1024, 2048, 4096] as const,
  DEFAULT_SAMPLE_RATE: 48000,
  DEFAULT_BUFFER_SIZE: 512,
  DEFAULT_BPM: 120,
  BPM_RANGE: { min: 20, max: 999 },
  MAX_CLIPS_PER_TRACK: 1000,
  DEFAULT_TRACK_VOLUME: 0.8,
  DEFAULT_MASTER_VOLUME: 0.8,
  FADE_TIME: 0.01, // 10ms fade to prevent clicks
} as const;

// ============================================================================
// UI CONFIGURATION
// ============================================================================

export const UI_CONFIG = {
  // Layout
  TRACK_HEADER_WIDTH: 272,
  FADER_WIDTH: 40,
  CLIP_MIN_WIDTH: 20,
  GRID_SNAP_VALUES: [0, 0.25, 0.5, 1] as const,

  // Breakpoints
  MOBILE_BREAKPOINT: 768,
  TABLET_BREAKPOINT: 1024,
  DESKTOP_BREAKPOINT: 1440,

  // Zoom
  MIN_ZOOM: 10,
  MAX_ZOOM: 1000,
  DEFAULT_ZOOM: 50,
  ZOOM_STEP: 10,

  // Colors
  TRACK_COLORS: [
    '#ff0000', // Red
    '#00f2ff', // Cyan
    '#fbbf24', // Yellow
    '#a855f7', // Purple
    '#10b981', // Green
    '#f97316', // Orange
    '#3b82f6', // Blue
    '#ec4899', // Pink
  ] as const,

  // Animation
  ANIMATION_DURATION: 200, // ms
  DEBOUNCE_DELAY: 300, // ms
  AUTOSAVE_INTERVAL: 30000, // 30 seconds
} as const;

// ============================================================================
// ERROR MESSAGES
// ============================================================================

export const ERROR_MESSAGES = {
  AUDIO_CONTEXT_FAILED: 'Failed to initialize audio context. Please check your browser settings.',
  TRACK_LIMIT_REACHED: `Maximum of ${AUDIO_CONFIG.MAX_TRACKS} tracks reached.`,
  PLUGIN_LIMIT_REACHED: `Maximum of ${AUDIO_CONFIG.MAX_PLUGINS_PER_TRACK} plugins per track reached.`,
  FILE_LOAD_FAILED: 'Failed to load audio file. Please try a different file.',
  SAVE_FAILED: 'Failed to save project. Please try again.',
  INVALID_PRESET: 'Invalid preset format.',
  BROWSER_NOT_SUPPORTED: 'Your browser does not support Web Audio API.',
} as const;
