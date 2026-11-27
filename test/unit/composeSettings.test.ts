import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { readComposeSettings } from '../../src/compose/settings';
import type { SettingsSource } from '../../src/settings';

/**
 * Builds a settings source over a plain map.
 * @param values Values by key relative to the `effectiveConfig` section.
 * @returns The source.
 */
const source = (values: Record<string, unknown>): SettingsSource => ({ get: <T>(key: string) => values[key] as T | undefined });

describe('readComposeSettings', () => {
  /**
   * Validates the default and bad input. Expected: `[]` when unset or not an array; non-string items
   * dropped, strings kept in order.
   */
  it('reads compose.files, dropping invalid values', () => {
    expect(readComposeSettings(source({}))).toEqual({ files: [] });
    expect(readComposeSettings(source({ 'compose.files': 'compose.yaml' }))).toEqual({ files: [] });
    expect(readComposeSettings(source({ 'compose.files': [1, 'a.yaml', null, 'b.yaml'] }))).toEqual({ files: ['a.yaml', 'b.yaml'] });
  });

  /**
   * Validates the manifest declaration. Expected: an array of strings defaulting to `[]`, scoped per
   * resource so each folder may list its own files.
   */
  it('matches the compose.files declaration in package.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; scope?: string; type?: string }> } };
    };
    expect(manifest.contributes.configuration.properties['effectiveConfig.compose.files']).toMatchObject({ type: 'array', default: [], scope: 'resource' });
  });
});
