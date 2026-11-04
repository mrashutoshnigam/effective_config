const INT_SEGMENT = /^[+-]?\d+$/;

/** Parses a segment as a .NET int32 (optional sign, digits only), or returns undefined. */
function tryParseInt32(segment: string): number | undefined {
  if (!INT_SEGMENT.test(segment)) {
    return undefined;
  }
  const n = Number(segment);
  return n >= -2147483648 && n <= 2147483647 ? n : undefined;
}

/**
 * Normalizes a configuration key for case-insensitive lookup.
 * @param key Key or key segment.
 * @returns The lower-cased key.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/**
 * Compares two single key segments the way .NET's `ConfigurationKeyComparer` does:
 * segments that parse as int32 (optional sign, digits only, within range) sort before
 * other segments and are compared by numeric value; all other segments are compared
 * ordinally after upper-casing (OrdinalIgnoreCase semantics, so `_` sorts after letters).
 * @param a First key segment.
 * @param b Second key segment.
 * @returns Negative, zero or positive number, usable with `Array.prototype.sort`.
 */
export function compareKeys(a: string, b: string): number {
  const x = tryParseInt32(a);
  const y = tryParseInt32(b);
  if (x !== undefined && y !== undefined) {
    return x - y;
  }
  if (x !== undefined) {
    return -1;
  }
  if (y !== undefined) {
    return 1;
  }
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/**
 * Converts an environment variable name to a configuration key (`__` becomes `:`).
 * @param name Environment variable name, e.g. `Logging__LogLevel__Default`.
 * @returns The configuration key, e.g. `Logging:LogLevel:Default`.
 */
export function envVarNameToKey(name: string): string {
  return name.split('__').join(':');
}

/**
 * Converts a configuration key to an environment variable name (`:` becomes `__`).
 * @param key Configuration key, e.g. `A:B:0`.
 * @returns The environment variable name, e.g. `A__B__0`.
 */
export function keyToEnvVarName(key: string): string {
  return key.split(':').join('__');
}

/**
 * Splits a configuration key into its segments.
 * @param key Configuration key.
 * @returns The `:`-separated segments (an empty key yields one empty segment).
 */
export function splitKey(key: string): string[] {
  return key.split(':');
}
