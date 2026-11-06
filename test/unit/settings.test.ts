import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, pythonExcludeGlob, pythonMarkerGlob, readSettings, type SettingsSource } from '../../src/settings';
import { IGNORED_FOLDERS, PYTHON_MARKERS } from '../../src/python/projectDiscovery';

/** Builds a settings source over a plain key → value map (keys relative to the `effectiveConfig` section). */
function source(values: Record<string, unknown>): SettingsSource {
  return { get: <T>(key: string) => values[key] as T | undefined };
}

describe('readSettings', () => {
  it('returns the defaults when nothing is configured', () => {
    expect(readSettings(source({}))).toEqual(DEFAULT_SETTINGS);
  });

  it('reads every configured value into its place', () => {
    const s = readSettings(source({
      maskPatterns: ['*pw*'],
      'dotnet.jsonLayers': ['a.json'],
      'python.envFiles': ['.env'],
      'python.fileOverridesOs': true,
      'python.envPrefixes': ['APP_'],
      'python.nestedDelimiter': '.',
      'python.environmentVariables': ['MODE'],
    }));
    expect(s).toEqual({
      maskPatterns: ['*pw*'],
      dotnet: { jsonLayers: ['a.json'] },
      python: { envFiles: ['.env'], fileOverridesOs: true, envPrefixes: ['APP_'], nestedDelimiter: '.', environmentVariables: ['MODE'] },
    });
  });

  it('keeps an explicitly empty list — an empty list is a valid choice, not a missing value', () => {
    expect(readSettings(source({ 'python.envPrefixes': [], maskPatterns: [] })).maskPatterns).toEqual([]);
  });

  it('falls back to the default when a value has the wrong type', () => {
    const s = readSettings(source({ maskPatterns: 'oops', 'python.fileOverridesOs': 'yes', 'python.nestedDelimiter': 3, 'dotnet.jsonLayers': [1, 2] }));
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('does not share default arrays with the caller — mutating a result leaves the defaults intact', () => {
    readSettings(source({})).maskPatterns.push('x');
    expect(readSettings(source({})).maskPatterns).toEqual(DEFAULT_SETTINGS.maskPatterns);
    expect(DEFAULT_SETTINGS.maskPatterns).not.toContain('x');
  });
});

describe('package.json contribution defaults', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  const declared = (key: string): unknown => manifest.contributes.configuration.properties[`effectiveConfig.${key}`]?.default;

  it('matches the defaults in code — one source of truth, no drift', () => {
    expect(declared('maskPatterns')).toEqual(DEFAULT_SETTINGS.maskPatterns);
    expect(declared('dotnet.jsonLayers')).toEqual(DEFAULT_SETTINGS.dotnet.jsonLayers);
    expect(declared('python.envFiles')).toEqual(DEFAULT_SETTINGS.python.envFiles);
    expect(declared('python.fileOverridesOs')).toEqual(DEFAULT_SETTINGS.python.fileOverridesOs);
    expect(declared('python.envPrefixes')).toEqual(DEFAULT_SETTINGS.python.envPrefixes);
    expect(declared('python.nestedDelimiter')).toEqual(DEFAULT_SETTINGS.python.nestedDelimiter);
    expect(declared('python.environmentVariables')).toEqual(DEFAULT_SETTINGS.python.environmentVariables);
  });

  it('declares every setting the code reads', () => {
    const keys = Object.keys(manifest.contributes.configuration.properties).sort();
    expect(keys).toEqual([
      'effectiveConfig.dotnet.jsonLayers',
      'effectiveConfig.maskPatterns',
      'effectiveConfig.python.envFiles',
      'effectiveConfig.python.environmentVariables',
      'effectiveConfig.python.envPrefixes',
      'effectiveConfig.python.fileOverridesOs',
      'effectiveConfig.python.nestedDelimiter',
    ].sort());
  });
});

describe('discovery globs', () => {
  it('builds the marker glob from the marker file list', () => {
    expect(pythonMarkerGlob()).toBe(`**/{${PYTHON_MARKERS.join(',')}}`);
    expect(pythonMarkerGlob()).toBe('**/{pyproject.toml,requirements.txt,setup.py,setup.cfg,Pipfile}');
  });

  it('builds the exclude glob from the ignored folder list', () => {
    expect(pythonExcludeGlob()).toBe(`**/{${IGNORED_FOLDERS.join(',')}}/**`);
    expect(pythonExcludeGlob()).toBe('**/{node_modules,.venv,venv,env,__pycache__,site-packages,.git,bin,obj}/**');
  });
});
