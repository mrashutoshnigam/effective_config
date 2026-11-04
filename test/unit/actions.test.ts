import { describe, it, expect } from 'vitest';
import { copyText, exportText } from '../../src/panel/actions';
import type { MergedEntry } from '../../src/engine/types';

/** Builds a MergedEntry with the given key, value and optional sensitivity. */
function M(key: string, value: string | null, opts: { sensitive?: boolean } = {}): MergedEntry {
  const sensitive = opts.sensitive ?? false;
  return { key, value, winner: { layerId: 'base', layerLabel: 'base', value, sensitive }, overridden: [], sensitive };
}

describe('copyText', () => {
  it('returns undefined for a masked sensitive value — caller shows the reveal hint', () => {
    expect(copyText([M('Db:Password', 'x', { sensitive: true })], 'Db:Password', 'value', new Set())).toBeUndefined();
  });

  it('returns the value of a revealed sensitive entry — path match is case-insensitive', () => {
    expect(copyText([M('Db:Password', 'x', { sensitive: true })], 'db:password', 'value', new Set(['DB:PASSWORD']))).toBe('x');
  });

  it('returns the value of a non-sensitive entry without any reveal', () => {
    expect(copyText([M('A:B', '1')], 'a:b', 'value', new Set())).toBe('1');
  });

  it('returns an empty string for a null value — section entries copy as empty', () => {
    expect(copyText([M('A', null)], 'A', 'value', new Set())).toBe('');
  });

  it('returns the key path as stored in the entry — keyPath ignores masking', () => {
    expect(copyText([M('Db:Password', 'x', { sensitive: true })], 'db:password', 'keyPath', new Set())).toBe('Db:Password');
  });

  it('converts the key to an env var name — A:B becomes A__B', () => {
    expect(copyText([M('A:B', '1')], 'A:B', 'envVarName', new Set())).toBe('A__B');
  });

  it('returns undefined for an unknown path', () => {
    expect(copyText([M('A:B', '1')], 'Nope', 'value', new Set())).toBeUndefined();
  });
});

describe('exportText', () => {
  it('masks sensitive values as *** in env format when revealAll is false', () => {
    expect(exportText([M('Db:Password', 'x', { sensitive: true })], 'env', false)).toBe('Db__Password=***');
  });

  it('emits sensitive values in env format when revealAll is true', () => {
    expect(exportText([M('Db:Password', 'x', { sensitive: true })], 'env', true)).toBe('Db__Password=x');
  });

  it('masks sensitive values as "***" in json format and keeps others — nested object', () => {
    const json = exportText([M('Db:Password', 'x', { sensitive: true }), M('Db:Host', 'h')], 'json', false);
    expect(JSON.parse(json)).toEqual({ Db: { Password: '***', Host: 'h' } });
  });

  it('emits sensitive values in json format when revealAll is true', () => {
    expect(JSON.parse(exportText([M('Db:Password', 'x', { sensitive: true })], 'json', true))).toEqual({ Db: { Password: 'x' } });
  });

  it('returns an empty JSON object for no entries', () => {
    expect(JSON.parse(exportText([], 'json', false))).toEqual({});
  });

  it('returns an empty string for no entries in env format', () => {
    expect(exportText([], 'env', false)).toBe('');
  });
});
