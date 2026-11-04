import { describe, it, expect } from 'vitest';
import { parseCommandLineArgs } from '../../src/sources/commandLine';

const pairs = (s: string) => parseCommandLineArgs(s).entries.map((e) => [e.key, e.value]);

describe('parseCommandLineArgs', () => {
  it('parses --k=v and quoted --k "v w" — [A:B=1, C="two words"]', () => {
    expect(pairs('--A:B=1 --C "two words"')).toEqual([['A:B', '1'], ['C', 'two words']]);
  });

  it('keeps __ in keys as typed — --D__E=3 gives key D__E (the .NET provider does not map it)', () => {
    expect(pairs('--D__E=3 --F__G v')).toEqual([['D__E', '3'], ['F__G', 'v']]);
  });

  it('parses --k v with an unquoted next token', () => {
    expect(pairs('--A v')).toEqual([['A', 'v']]);
  });

  it('treats "" as an empty string value', () => {
    expect(pairs('--A ""')).toEqual([['A', '']]);
  });

  it('keeps = inside values — --A=x=y gives x=y', () => {
    expect(pairs('--A=x=y')).toEqual([['A', 'x=y']]);
  });

  it('warns "missing value" for a trailing --k with no value', () => {
    const r = parseCommandLineArgs('--k');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics).toEqual([{ severity: 'warning', message: 'missing value for argument: --k' }]);
  });

  it('takes the next token as the value even when it starts with -- — "--a --b" gives a="--b"', () => {
    const r = parseCommandLineArgs('--a --b');
    expect(r.diagnostics).toEqual([]);
    expect(pairs('--a --b')).toEqual([['a', '--b']]);
  });

  it('redacts the value of an unsupported argument — diagnostic never contains the secret', () => {
    const r = parseCommandLineArgs('/Db:Password=hunter2');
    expect(r.diagnostics[0].message).toBe('unsupported argument form: /Db:Password=***');
  });

  it('shows bare unsupported tokens as <value> — a stray secret is never echoed', () => {
    const r = parseCommandLineArgs('hunter2');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics[0].message).toBe('unsupported argument form: <value>');
  });

  it('shows only the key part of a malformed -- token — "--=secret" gives "--=***"', () => {
    expect(parseCommandLineArgs('--=secret').diagnostics[0].message).toBe('unsupported argument form: --=***');
  });

  it('warns "unsupported argument form" for /x=1', () => {
    const r = parseCommandLineArgs('/x=1');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics[0].severity).toBe('warning');
    expect(r.diagnostics[0].message).toBe('unsupported argument form: /x=***');
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(parseCommandLineArgs('')).toEqual({ entries: [], diagnostics: [] });
    expect(parseCommandLineArgs('   ')).toEqual({ entries: [], diagnostics: [] });
  });

  it('omits location on entries', () => {
    expect(parseCommandLineArgs('--A=1').entries[0].location).toBeUndefined();
  });
});
