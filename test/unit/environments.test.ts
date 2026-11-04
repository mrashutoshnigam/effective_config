import { describe, it, expect } from 'vitest';
import { DEFAULT_JSON_LAYERS, listEnvironments, resolveJsonLayerFiles } from '../../src/dotnet/environments';

describe('listEnvironments', () => {
  it('adds found custom env to the defaults and excludes the secrets layer — Development, Staging, Production, QA', () => {
    expect(listEnvironments(['appsettings.json', 'appsettings.QA.json', 'appsettings.secrets.json'], DEFAULT_JSON_LAYERS))
      .toEqual(['Development', 'Staging', 'Production', 'QA']);
  });

  it('de-duplicates case-insensitively — found casing wins over the default', () => {
    expect(listEnvironments(['appsettings.staging.json'], DEFAULT_JSON_LAYERS)).toEqual(['Development', 'staging', 'Production']);
  });

  it('sorts remaining found names case-insensitively after the defaults', () => {
    expect(listEnvironments(['appsettings.qa.json', 'appsettings.Alpha.json', 'appsettings.Zed.json'], DEFAULT_JSON_LAYERS))
      .toEqual(['Development', 'Staging', 'Production', 'Alpha', 'qa', 'Zed']);
  });

  it('returns only the defaults when no env files exist', () => {
    expect(listEnvironments([], DEFAULT_JSON_LAYERS)).toEqual(['Development', 'Staging', 'Production']);
  });

  it('ignores files that do not match appsettings.<X>.json', () => {
    expect(listEnvironments(['appsettings.json', 'other.QA.json', 'appsettings.QA.txt'], DEFAULT_JSON_LAYERS))
      .toEqual(['Development', 'Staging', 'Production']);
  });
});

describe('resolveJsonLayerFiles', () => {
  it('resolves exact-case files without a case mismatch', () => {
    const r = resolveJsonLayerFiles(['appsettings.json', 'appsettings.Development.json'], DEFAULT_JSON_LAYERS, 'Development');
    expect(r).toEqual([
      { pattern: 'appsettings.json', fileName: 'appsettings.json', caseMismatch: false },
      { pattern: 'appsettings.{env}.json', fileName: 'appsettings.Development.json', caseMismatch: false },
      { pattern: 'appsettings.secrets.json', fileName: undefined, caseMismatch: false },
    ]);
  });

  it('finds a differently-cased file and flags caseMismatch — returns the found name', () => {
    const r = resolveJsonLayerFiles(['appsettings.staging.json'], DEFAULT_JSON_LAYERS, 'Staging');
    expect(r[1]).toEqual({ pattern: 'appsettings.{env}.json', fileName: 'appsettings.staging.json', caseMismatch: true });
  });

  it('leaves fileName undefined for missing files with no mismatch', () => {
    const r = resolveJsonLayerFiles([], ['appsettings.json'], 'Development');
    expect(r).toEqual([{ pattern: 'appsettings.json', fileName: undefined, caseMismatch: false }]);
  });
});
