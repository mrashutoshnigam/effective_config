/**
 * Converts a glob pattern into an anchored, case-insensitive regular expression.
 * Regex metacharacters are escaped; `*` matches any characters (including `:`).
 * @param glob Glob pattern, e.g. `ConnectionStrings:*`.
 * @returns A regular expression matching the whole input.
 */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Tests whether a configuration key matches any of the mask patterns.
 * @param key Full flattened key.
 * @param patterns Glob patterns (case-insensitive, `*` = any characters).
 * @returns True when at least one pattern matches the full key.
 */
export function isSensitiveKey(key: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(key));
}
