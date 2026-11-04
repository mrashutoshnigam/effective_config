import { describe, it, expect } from 'vitest';
import { parseLaunchSettings } from '../../src/dotnet/launchSettings';

const FILE = 'Properties/launchSettings.json';

describe('parseLaunchSettings', () => {
  it('tolerates comments and trailing commas and includes every profile — IIS Express kept', () => {
    const text = `{ // c
      "profiles": {
        "Dev": { "commandName": "Project", "commandLineArgs": "--A=1", "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development", }, },
        "IIS Express": { "commandName": "IISExpress", "environmentVariables": { "X": "1" } },
      } }`;
    const { profiles, diagnostics } = parseLaunchSettings(text, FILE);
    expect(diagnostics).toEqual([]);
    expect(profiles.map((p) => p.name)).toEqual(['Dev', 'IIS Express']);
    expect(profiles[0]).toEqual({
      name: 'Dev', environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
      commandLineArgs: '--A=1', environmentName: 'Development',
    });
  });

  it('gives a profile without environmentVariables {} and undefined environmentName', () => {
    const { profiles } = parseLaunchSettings('{"profiles":{"P":{"commandName":"Project"}}}', FILE);
    expect(profiles[0].environmentVariables).toEqual({});
    expect(profiles[0].environmentName).toBeUndefined();
    expect(profiles[0].commandLineArgs).toBeUndefined();
  });

  it('uses DOTNET_ENVIRONMENT only when ASPNETCORE_ENVIRONMENT is absent', () => {
    const only = parseLaunchSettings('{"profiles":{"P":{"environmentVariables":{"DOTNET_ENVIRONMENT":"Staging"}}}}', FILE);
    expect(only.profiles[0].environmentName).toBe('Staging');
    const both = parseLaunchSettings('{"profiles":{"P":{"environmentVariables":{"DOTNET_ENVIRONMENT":"Staging","aspnetcore_environment":"Prod"}}}}', FILE);
    expect(both.profiles[0].environmentName).toBe('Prod');
  });

  it('converts non-string env values with String() — true becomes "true", 5 becomes "5"', () => {
    const { profiles } = parseLaunchSettings('{"profiles":{"P":{"environmentVariables":{"A":true,"B":5}}}}', FILE);
    expect(profiles[0].environmentVariables).toEqual({ A: 'true', B: '5' });
  });

  it('returns [] without diagnostics when profiles is missing', () => {
    expect(parseLaunchSettings('{"iisSettings":{}}', FILE)).toEqual({ profiles: [], diagnostics: [] });
  });

  it('returns [] with an error diagnostic located in the file for invalid JSON', () => {
    const r = parseLaunchSettings('{"profiles": ', FILE);
    expect(r.profiles).toEqual([]);
    expect(r.diagnostics[0].severity).toBe('error');
    expect(r.diagnostics[0].location?.filePath).toBe(FILE);
  });

  it('returns [] with an error when the root is not an object', () => {
    const r = parseLaunchSettings('[1]', FILE);
    expect(r.profiles).toEqual([]);
    expect(r.diagnostics[0].severity).toBe('error');
  });

  it('returns [] without error for empty text and strips a BOM', () => {
    expect(parseLaunchSettings('', FILE)).toEqual({ profiles: [], diagnostics: [] });
    expect(parseLaunchSettings('﻿{"profiles":{"P":{}}}', FILE).profiles.map((p) => p.name)).toEqual(['P']);
  });

  it('skips non-object profiles', () => {
    expect(parseLaunchSettings('{"profiles":{"P":5,"Q":{}}}', FILE).profiles.map((p) => p.name)).toEqual(['Q']);
  });
});
