import { describe, it, expect } from 'vitest';
import { parseDotenv, expandDotenvValue } from '../../src/sources/dotenv';

const P = '/p/.env';
const pairs = (text: string) => parseDotenv(text, P).entries.map((e) => [e.name, e.value]);

describe('parseDotenv', () => {
  it('parses export prefix, spacing, comments, quotes and multi-line values; skips bare KEY', () => {
    const { entries } = parseDotenv('export A=1\nB = two words # c\nC=\'lit ${A}\'\nD="x\\ny ${A}"\nE="multi\nline"\nF\n', P);
    expect(entries.map((e) => [e.name, e.value, e.expand])).toEqual([
      ['A', '1', true], ['B', 'two words', true], ['C', 'lit ${A}', false], ['D', 'x\ny ${A}', true], ['E', 'multi\nline', true]]);
    expect(entries[1].location).toEqual({ filePath: P, line: 1, column: 4 });
  });

  it('parses CRLF, CR-only and missing final newline like LF — same entries', () => {
    const lf = pairs('A=1\nB="x\ny"\nC=3');
    expect(pairs('A=1\r\nB="x\r\ny"\r\nC=3')).toEqual(lf);
    expect(pairs('A=1\rB="x\ry"\rC=3')).toEqual(lf);
    expect(lf).toEqual([['A', '1'], ['B', 'x\ny'], ['C', '3']]);
  });

  it('warns "Cannot parse line n" for an unparseable line and still loads later lines', () => {
    const r = parseDotenv('A=1\n=oops\nB=2\n', P);
    expect(r.entries.map((e) => e.name)).toEqual(['A', 'B']);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', message: 'Cannot parse line 2', location: { filePath: P, line: 1 } });
  });

  it('skips a bare KEY and reports an info diagnostic with location and no value', () => {
    const r = parseDotenv('A=1\nFOO\n', P);
    expect(r.entries.map((e) => e.name)).toEqual(['A']);
    expect(r.diagnostics).toEqual([{
      severity: 'info',
      message: "'FOO' has no value; python-dotenv does not set it",
      location: { filePath: P, line: 1, column: 0 },
    }]);
  });

  it('does not treat # inside quotes as a comment — value keeps it', () => {
    expect(pairs('A="x # y"\nB=\'p # q\'\nC="v" # real comment\n')).toEqual([['A', 'x # y'], ['B', 'p # q'], ['C', 'v']]);
  });

  it('strips a leading BOM so the first key is intact', () => {
    expect(pairs('﻿A=1\nB=2')).toEqual([['A', '1'], ['B', '2']]);
  });

  it('warns on an unterminated double quote and stops parsing at end of file — earlier entries kept', () => {
    const r = parseDotenv('A=1\nB="never closed\nC=3\n', P);
    expect(r.entries.map((e) => e.name)).toEqual(['A']);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', message: 'Cannot parse line 2: unterminated quote' });
  });

  it('warns on an unterminated single quote and stops parsing', () => {
    const r = parseDotenv("A='oops\nB=2\n", P);
    expect(r.entries).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', message: 'Cannot parse line 1: unterminated quote' });
  });

  it('keeps a hash without leading whitespace inside an unquoted value', () => {
    expect(pairs('A=a#b\nB=a #b\nC=#x')).toEqual([['A', 'a#b'], ['B', 'a'], ['C', '#x']]);
  });

  it('ignores blank lines and comment lines, including indented comments', () => {
    expect(pairs('\n# c\n   # d\nA=1\n\n')).toEqual([['A', '1']]);
  });

  it('treats export as a key when not followed by whitespace', () => {
    expect(pairs('export=1\nexport X=2')).toEqual([['export', '1'], ['X', '2']]);
  });

  it('parses an empty value as empty string with column right after = and spaces', () => {
    const r = parseDotenv('A=\nB =  \nC= # c', P);
    expect(r.entries.map((e) => [e.name, e.value])).toEqual([['A', ''], ['B', ''], ['C', '']]);
    expect(r.entries[0].location.column).toBe(2);
    expect(r.entries[1].location.column).toBe(5);
  });

  it('locates quoted values at the first char after the opening quote and multi-line on the start line', () => {
    const r = parseDotenv('A="v"\nB = \'w\'\n', P);
    expect(r.entries[0].location).toEqual({ filePath: P, line: 0, column: 3 });
    expect(r.entries[1].location).toEqual({ filePath: P, line: 1, column: 5 });
  });

  it('handles double-quote escapes and keeps unknown escapes as backslash plus char', () => {
    expect(pairs('A="a\\tb\\rc\\\\d\\"e\\\'f\\qg"')).toEqual([['A', 'a\tb\rc\\d"e\'f\\qg']]);
  });

  it('does not process escapes in single quotes and marks expand false', () => {
    const r = parseDotenv("A='a\\nb'", P);
    expect(r.entries[0]).toMatchObject({ value: 'a\\nb', expand: false });
  });

  it('allows a comment after a closing quote but warns and skips when other text follows', () => {
    const r = parseDotenv('A="x" # ok\nB="y" junk\nC=3\n', P);
    expect(r.entries.map((e) => e.name)).toEqual(['A', 'C']);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', message: 'Cannot parse line 2' });
  });

  it('keeps duplicate keys in order with no diagnostic', () => {
    const r = parseDotenv('A=1\nA=2\n', P);
    expect(r.entries.map((e) => [e.name, e.value])).toEqual([['A', '1'], ['A', '2']]);
    expect(r.diagnostics).toEqual([]);
  });

  it('never includes values in diagnostics', () => {
    const r = parseDotenv('=sekret\nB="sekret2" sekret3\nC="sekret4', P);
    expect(JSON.stringify(r.diagnostics)).not.toMatch(/sekret/);
  });

  it('returns nothing for empty text', () => {
    expect(parseDotenv('', P)).toEqual({ entries: [], diagnostics: [] });
  });

  it('locates a multi-line double-quoted value at its start and the following entry on its own line', () => {
    const r = parseDotenv('A="a\nb"\nC=3', P);
    expect(r.entries[0].location).toEqual({ filePath: P, line: 0, column: 3 });
    expect(r.entries[1].location).toEqual({ filePath: P, line: 2, column: 2 });
  });

  it('keeps = characters inside values: A=b=c, A==x and A="x=y"', () => {
    expect(pairs('A=b=c\nB==x\nC="x=y"')).toEqual([['A', 'b=c'], ['B', '=x'], ['C', 'x=y']]);
  });

  it('warns "Cannot parse line n" for export followed only by whitespace', () => {
    const r = parseDotenv('A=1\nexport   \nB=2', P);
    expect(r.entries.map((e) => e.name)).toEqual(['A', 'B']);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', message: 'Cannot parse line 2' });
  });

  it('numbers the warning line by the entry start line for multi-line entries', () => {
    const r = parseDotenv('A="a\nb"\nC="c" x\n', P);
    expect(r.diagnostics[0].message).toBe('Cannot parse line 3');
  });
});

describe('expandDotenvValue', () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];

  it('expands ${VAR} and ${VAR:-default}, reporting references in first-seen order incl. unresolved', () => {
    expect(expandDotenvValue('pg://${U}:${P:-none}@h', env({ U: 'u' })))
      .toEqual({ value: 'pg://u:none@h', references: ['U', 'P'] });
  });

  it('uses the default when lookup returns an empty string', () => {
    expect(expandDotenvValue('${A:-d}', env({ A: '' })).value).toBe('d');
  });

  it('uses the lookup value over the default when defined', () => {
    expect(expandDotenvValue('${A:-d}', env({ A: 'x' })).value).toBe('x');
  });

  it('replaces an unresolved reference without default by empty string', () => {
    expect(expandDotenvValue('a${Z}b', env({}))).toEqual({ value: 'ab', references: ['Z'] });
  });

  it('leaves $NAME without braces literal', () => {
    expect(expandDotenvValue('$A and ${A}', env({ A: '1' }))).toEqual({ value: '$A and 1', references: ['A'] });
  });

  it('lists a repeated reference once', () => {
    expect(expandDotenvValue('${A}${B}${A}', env({ A: '1', B: '2' }))).toEqual({ value: '121', references: ['A', 'B'] });
  });

  it('does not expand the default text further', () => {
    const r = expandDotenvValue('${A:-${B}}', env({ B: 'x' }));
    expect(r.value).toBe('${B}');
    expect(r.references).toEqual(['A']);
  });

  it('returns the text unchanged with no references when there is nothing to expand', () => {
    expect(expandDotenvValue('plain', env({}))).toEqual({ value: 'plain', references: [] });
  });

  it('leaves an unclosed ${ literal', () => {
    expect(expandDotenvValue('a${B', env({ B: '1' }))).toEqual({ value: 'a${B', references: [] });
  });
});
