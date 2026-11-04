const NUMERIC = /^\d+$/;

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
 * all-digit segments sort before other segments and are compared by numeric value;
 * other segments are compared case-insensitively and ordinally.
 * @param a First key segment.
 * @param b Second key segment.
 * @returns Negative, zero or positive number, usable with `Array.prototype.sort`.
 */
export function compareKeys(a: string, b: string): number {
  const aNum = NUMERIC.test(a);
  const bNum = NUMERIC.test(b);
  if (aNum && bNum) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (aNum) {
    return -1;
  }
  if (bNum) {
    return 1;
  }
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
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
