import type { LayerEntry } from '../engine/types';
import { envVarNameToKey, normalizeKey, splitKey } from '../engine/keys';

const RESERVED_PREFIX = /^(ASPNETCORE_|DOTNET_)/i;

/**
 * Converts environment variables into configuration layer entries (`__` becomes `:`).
 * @param vars Variable names and values.
 * @returns One entry per variable, in insertion order, without a source location.
 */
export function envVarEntries(vars: Record<string, string>): LayerEntry[] {
  return Object.entries(vars).map(([name, value]) => ({ key: envVarNameToKey(name), value }));
}

/**
 * Narrows OS environment variables to those relevant to the configuration: variables whose
 * first key segment (case-insensitive) is a known top-level key, plus `ASPNETCORE_*` and
 * `DOTNET_*` variables (case-insensitive prefix).
 * @param vars All OS environment variables.
 * @param topLevelKeys Normalized (lower-cased) top-level configuration keys.
 * @returns The relevant subset, preserving order.
 */
export function filterOsEnv(vars: Record<string, string>, topLevelKeys: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    const first = normalizeKey(splitKey(envVarNameToKey(name))[0]);
    if (RESERVED_PREFIX.test(name) || topLevelKeys.has(first)) {
      result[name] = value;
    }
  }
  return result;
}
