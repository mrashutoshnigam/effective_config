import type { SettingsSource } from '../settings';

/** The Compose settings of the `effectiveConfig` section, with defaults applied. */
export interface ComposeSettings {
  /** Compose files to load, lowest priority first, like `docker compose -f`; empty uses Compose's discovery. */
  files: string[];
}

/**
 * Reads the Compose settings.
 * @param source Where the raw values come from.
 * @returns The typed settings: `files` keeps the string items of an array, and is `[]` otherwise.
 */
export function readComposeSettings(source: SettingsSource): ComposeSettings {
  const files = source.get<unknown>('compose.files');
  return { files: Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [] };
}
