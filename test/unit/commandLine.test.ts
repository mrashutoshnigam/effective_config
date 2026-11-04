import { describe, it, expect } from 'vitest';
import { parseCommandLineArgs } from '../../src/sources/commandLine';

const pairs = (s: string) => parseCommandLineArgs(s).entries.map((e) => [e.key, e.value]);

describe('parseCommandLineArgs', () => {
  it('parses --k=v, quoted --k "v w" and __ keys — [A:B=1, C="two words", D:E=3]', () => {
    expect(pairs('--A:B=1 --C "two words" --D__E=3')).toEqual([['A:B', '1'], ['C', 'two words'], ['D:E', '3']]);
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

  it('warns for --k followed by another --x, and still parses --x', () => {
    const r = parseCommandLineArgs('--k --x=1');
    expect(r.diagnostics.map((d) => d.message)).toEqual(['missing value for argument: --k']);
    expect(r.entries.map((e) => [e.key, e.value])).toEqual([['x', '1']]);
  });

  it('redacts the value of an unsupported argument — diagnostic never contains the secret', () => {
    const r = parseCommandLineArgs('/Db:Password=hunter2');
    expect(r.diagnostics[0].message).toBe('unsupported argument form: /Db:Password=***');
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
