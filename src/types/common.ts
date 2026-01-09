
/**
 * COMMON REUSABLE TYPES
 *
 * Shared TypeScript types used across the application.
 */

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type DeepRequired<T> = {
  [P in keyof T]-?: T[P] extends object ? DeepRequired<T[P]> : T[P];
};

export type ValueOf<T> = T[keyof T];

export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

// ============================================================================
// FUNCTION TYPES
// ============================================================================

export type Callback<T = void> = () => T;
export type Handler<T = unknown> = (value: T) => void;
export type AsyncCallback<T = void> = () => Promise<T>;
export type AsyncHandler<T = unknown> = (value: T) => Promise<void>;
export type Predicate<T> = (value: T) => boolean;
export type Comparator<T> = (a: T, b: T) => number;

// ============================================================================
// TYPE GUARDS
// ============================================================================

export const isDefined = <T>(value: T | undefined | null): value is T => {
  return value !== undefined && value !== null;
};

export const isString = (value: unknown): value is string => {
  return typeof value === 'string';
};

export const isNumber = (value: unknown): value is number => {
  return typeof value === 'number' && !isNaN(value);
};

export const isBoolean = (value: unknown): value is boolean => {
  return typeof value === 'boolean';
};

export const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const isArray = <T>(value: unknown): value is T[] => {
  return Array.isArray(value);
};

export const isFunction = (value: unknown): value is Function => {
  return typeof value === 'function';
};
