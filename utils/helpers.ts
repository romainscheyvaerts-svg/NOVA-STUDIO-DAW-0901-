
/**
 * COMMON UTILITY FUNCTIONS
 *
 * Reusable helper functions used throughout the application.
 * Prevents code duplication and improves maintainability.
 */

// ============================================================================
// AUDIO CONVERSION UTILITIES
// ============================================================================

/**
 * Convert decibels to linear gain (0-1 range)
 */
export const dbToLinear = (db: number): number => {
  return Math.pow(10, db / 20);
};

/**
 * Convert linear gain to decibels
 */
export const linearToDb = (linear: number): number => {
  return 20 * Math.log10(Math.max(linear, 0.0001)); // Prevent -Infinity
};

/**
 * Convert frequency to MIDI note number
 */
export const freqToMidi = (frequency: number): number => {
  return 69 + 12 * Math.log2(frequency / 440);
};

/**
 * Convert MIDI note number to frequency
 */
export const midiToFreq = (midi: number): number => {
  return 440 * Math.pow(2, (midi - 69) / 12);
};

// ============================================================================
// MATH UTILITIES
// ============================================================================

/**
 * Clamp a value between min and max
 */
export const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

/**
 * Linear interpolation between two values
 */
export const lerp = (a: number, b: number, t: number): number => {
  return a + (b - a) * clamp(t, 0, 1);
};

/**
 * Map a value from one range to another
 */
export const mapRange = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number => {
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
};

/**
 * Round to specified number of decimal places
 */
export const roundTo = (value: number, decimals: number): number => {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

// ============================================================================
// TIME UTILITIES
// ============================================================================

/**
 * Format seconds as MM:SS
 */
export const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

/**
 * Format seconds as MM:SS:MS (with milliseconds)
 */
export const formatTimeMs = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${mins}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};

/**
 * Calculate time from BPM and beat position
 */
export const beatToTime = (beat: number, bpm: number): number => {
  return (beat * 60) / bpm;
};

/**
 * Calculate beat position from time
 */
export const timeToBeat = (time: number, bpm: number): number => {
  return (time * bpm) / 60;
};

/**
 * Snap time to grid
 */
export const snapToGrid = (time: number, gridSize: number, bpm: number): number => {
  if (gridSize === 0) return time;
  const beat = timeToBeat(time, bpm);
  const snappedBeat = Math.round(beat / gridSize) * gridSize;
  return beatToTime(snappedBeat, bpm);
};

// ============================================================================
// STRING UTILITIES
// ============================================================================

/**
 * Generate a unique ID
 */
export const generateId = (prefix = 'id'): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Truncate string to maximum length
 */
export const truncate = (str: string, maxLength: number): string => {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
};

/**
 * Format file size in bytes to human-readable format
 */
export const formatFileSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${roundTo(size, 2)} ${units[unitIndex]}`;
};

// ============================================================================
// ARRAY UTILITIES
// ============================================================================

/**
 * Move an item in an array from one index to another
 */
export const arrayMove = <T>(arr: T[], fromIndex: number, toIndex: number): T[] => {
  const newArr = [...arr];
  const [item] = newArr.splice(fromIndex, 1);
  newArr.splice(toIndex, 0, item);
  return newArr;
};

/**
 * Remove duplicates from array
 */
export const unique = <T>(arr: T[]): T[] => {
  return Array.from(new Set(arr));
};

/**
 * Group array items by key
 */
export const groupBy = <T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> => {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {} as Record<string, T[]>);
};

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Check if value is a valid number
 */
export const isValidNumber = (value: unknown): value is number => {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
};

/**
 * Check if value is within range
 */
export const isInRange = (value: number, min: number, max: number): boolean => {
  return value >= min && value <= max;
};

/**
 * Validate frequency value
 */
export const isValidFrequency = (freq: number): boolean => {
  return isValidNumber(freq) && isInRange(freq, 20, 20000);
};

// ============================================================================
// DEBOUNCE / THROTTLE
// ============================================================================

/**
 * Debounce function calls
 */
export const debounce = <T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  let timeoutId: ReturnType<typeof setTimeout>;

  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};

/**
 * Throttle function calls
 */
export const throttle = <T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  let lastCall = 0;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  };
};

// ============================================================================
// COLOR UTILITIES
// ============================================================================

/**
 * Convert hex color to RGB
 */
export const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
};

/**
 * Convert RGB to hex color
 */
export const rgbToHex = (r: number, g: number, b: number): string => {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(clamp(x, 0, 255)).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
};

/**
 * Adjust color brightness
 */
export const adjustBrightness = (hex: string, percent: number): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const adjust = (value: number) => {
    return clamp(value + (value * percent / 100), 0, 255);
  };

  return rgbToHex(adjust(rgb.r), adjust(rgb.g), adjust(rgb.b));
};

// ============================================================================
// BROWSER / DEVICE DETECTION
// ============================================================================

/**
 * Check if running on mobile device
 */
export const isMobile = (): boolean => {
  return window.innerWidth < 768;
};

/**
 * Check if running on tablet
 */
export const isTablet = (): boolean => {
  return window.innerWidth >= 768 && window.innerWidth < 1024;
};

/**
 * Check if Web Audio API is supported
 */
export const isWebAudioSupported = (): boolean => {
  return 'AudioContext' in window || 'webkitAudioContext' in window;
};

/**
 * Get user's preferred color scheme
 */
export const getColorScheme = (): 'dark' | 'light' => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
