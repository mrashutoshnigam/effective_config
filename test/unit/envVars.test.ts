import { describe, it, expect } from 'vitest';
import { envVarEntries, filterOsEnv } from '../../src/sources/envVars';

describe('envVarEntries', () => {
  it('maps __ to : in names — Logging__Level becomes key Logging:Level', () => {
    expect(envVarEntries({ Logging__Level: 'd' }).map((e) => [e.key, e.value])).toEqual([['Logging:Level', 'd']]);
  });

  it('keeps insertion order and omits location', () => {
    const entries = envVarEntries({ B: '1', A: '2' });
    expect(entries.map((e) => e.key)).toEqual(['B', 'A']);
    expect(entries[0].location).toBeUndefined();
  });

  it('returns no entries for an empty record', () => {
    expect(envVarEntries({})).toEqual([]);
  });
});

describe('filterOsEnv', () => {
  it('keeps vars whose first segment is a known top-level key or ASPNETCORE_ prefixed — PATH dropped', () => {
    expect(filterOsEnv({ PATH: 'x', Logging__Level: 'd', ASPNETCORE_URLS: 'u' }, new Set(['logging'])))
      .toEqual({ Logging__Level: 'd', ASPNETCORE_URLS: 'u' });
  });

  it('matches top-level keys case-insensitively — LOGGING__X kept for "logging"', () => {
    expect(filterOsEnv({ LOGGING__X: '1' }, new Set(['logging']))).toEqual({ LOGGING__X: '1' });
  });

  it('matches a var with no separator by its whole name — Logging kept', () => {
    expect(filterOsEnv({ Logging: '1' }, new Set(['logging']))).toEqual({ Logging: '1' });
  });

  it('matches ASPNETCORE_/DOTNET_ prefixes case-insensitively — lowercase names kept', () => {
    expect(filterOsEnv({ dotnet_environment: 'Dev', aspnetcore_x: '1' }, new Set()))
      .toEqual({ dotnet_environment: 'Dev', aspnetcore_x: '1' });
  });

  it('drops everything when no keys match and no prefix applies', () => {
    expect(filterOsEnv({ HOME: 'h' }, new Set(['logging']))).toEqual({});
  });
});
