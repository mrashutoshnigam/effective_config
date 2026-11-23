import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { readNodeSettings } from '../../src/node/settings';
import type { SettingsSource } from '../../src/settings';

/** Builds a settings source over a plain key → value map (keys relative to the `effectiveConfig` section). */
const source = (values: Record<string, unknown>): SettingsSource => ({ get: <T>(key: string) => values[key] as T | undefined });

describe('readNodeSettings', () => {
  /**
   * The framework setting is optional and must survive bad user input. Expected: `auto` when unset
   * or not one of the known values; a known value is returned as is.
   */
  it('reads node.framework, defaulting to auto for missing or unknown values', () => {
    expect(readNodeSettings(source({}))).toEqual({ framework: 'auto' });
    expect(readNodeSettings(source({ 'node.framework': 'vite' }))).toEqual({ framework: 'vite' });
    expect(readNodeSettings(source({ 'node.framework': 'angular' }))).toEqual({ framework: 'auto' });
    expect(readNodeSettings(source({ 'node.framework': 3 }))).toEqual({ framework: 'auto' });
  });

  /**
   * The VS Code manifest must offer exactly the values the code accepts. Expected: the declared
   * default is `auto` and the declared enum lists every framework setting.
   */
  it('matches the node.framework declaration in package.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default: unknown; enum?: unknown[] }> } };
    };
    const declared = manifest.contributes.configuration.properties['effectiveConfig.node.framework'];
    expect(declared?.default).toBe('auto');
    expect(declared?.enum).toEqual(['auto', 'vite', 'next', 'cra', 'dotenv-flow', 'generic']);
  });
});
