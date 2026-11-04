import { describe, it, expect } from 'vitest';
import { parseJsonLayer } from '../../src/sources/jsonLayer';

const SAMPLE = '{ // c\n "A": { "B": true, "N": null, "X": 1.50, "Arr": ["x","y"], "E": {} }, }';
const pairs = (text: string) => parseJsonLayer(text, 'f.json').entries.map((e) => [e.key, e.value]);

describe('parseJsonLayer', () => {
  it('flattens objects, arrays and scalars with .NET value conversion — true→True, null→"", number raw, empty object→null', () => {
    expect(pairs(SAMPLE)).toEqual([
      ['A:B', 'True'], ['A:N', ''], ['A:X', '1.50'], ['A:Arr:0', 'x'], ['A:Arr:1', 'y'], ['A:E', null]]);
  });

  it('records the 0-based position of the value token — "true" on line 1 is at column 13', () => {
    const { entries } = parseJsonLayer(SAMPLE, 'f.json');
    expect(entries[0].location).toEqual({ filePath: 'f.json', line: 1, column: 13 });
  });

  it('converts false to "False"', () => {
    expect(pairs('{"A": false}')).toEqual([['A', 'False']]);
  });

  it('keeps number text exactly as written — 1e3, -0.0 and a huge integer are preserved', () => {
    expect(pairs('{"A": 1e3, "B": -0.0, "C": 12345678901234567890}')).toEqual([
      ['A', '1e3'], ['B', '-0.0'], ['C', '12345678901234567890']]);
  });

  it('yields one entry with null value for an empty array — "L": [] gives ["L", null]', () => {
    expect(pairs('{"L": []}')).toEqual([['L', null]]);
  });

  it('flattens nested arrays and objects inside arrays — A:0:B and A:1:0', () => {
    expect(pairs('{"A": [{"B": 1}, [2]]}')).toEqual([['A:0:B', '1'], ['A:1:0', '2']]);
  });

  it('decodes string escapes — \\u0041\\n becomes "A" + newline', () => {
    expect(pairs('{"A": "\\u0041\\n"}')).toEqual([['A', 'A\n']]);
  });

  it('keeps keys containing a colon verbatim — "A:B" yields key "A:B"', () => {
    expect(pairs('{"A:B": 1}')).toEqual([['A:B', '1']]);
  });

  it('keeps duplicate keys as separate entries in source order', () => {
    expect(pairs('{"A": 1, "A": 2}')).toEqual([['A', '1'], ['A', '2']]);
  });

  it('computes line/column across CRLF line breaks — value on line 1 is at column 7', () => {
    const { entries } = parseJsonLayer('{\r\n  "A": 5\r\n}', 'f.json');
    expect(entries[0].location).toEqual({ filePath: 'f.json', line: 1, column: 7 });
  });

  it('locates array items at their own value token — second item is at column 12', () => {
    const { entries } = parseJsonLayer('{"A": ["x", "y"]}', 'f.json');
    expect(entries[1].location).toEqual({ filePath: 'f.json', line: 0, column: 12 });
  });

  it('broken JSON yields no entries and one error diagnostic located at the first parse error', () => {
    const { entries, diagnostics } = parseJsonLayer('{\n "A": 1,\n "B": \n', 'broken.json');
    expect(entries).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].location?.filePath).toBe('broken.json');
    expect(diagnostics[0].location?.line).toBeGreaterThanOrEqual(2);
    expect(diagnostics[0].message).toMatch(/ValueExpected|CloseBraceExpected/);
  });

  it('broken JSON on the first line reports line 0', () => {
    const { diagnostics } = parseJsonLayer('{ "A" 1 }', 'b.json');
    expect(diagnostics[0].location?.line).toBe(0);
  });

  it('empty string yields no entries and one info diagnostic "empty file"', () => {
    const r = parseJsonLayer('', 'f.json');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics.map((d) => [d.severity, d.message])).toEqual([['info', 'empty file']]);
  });

  it('whitespace-only text yields no entries and one info diagnostic "empty file"', () => {
    const r = parseJsonLayer('   \n ', 'f.json');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics.map((d) => [d.severity, d.message])).toEqual([['info', 'empty file']]);
  });

  it('BOM followed by {} yields no entries and no diagnostics', () => {
    expect(parseJsonLayer('﻿{}', 'f.json')).toEqual({ entries: [], diagnostics: [] });
  });

  it('a BOM-only file counts as empty — one info diagnostic', () => {
    expect(parseJsonLayer('﻿', 'f.json').diagnostics.map((d) => d.message)).toEqual(['empty file']);
  });

  it('BOM before content does not break parsing — entries are produced', () => {
    expect(pairs('﻿{"A": 1}')).toEqual([['A', '1']]);
  });

  it('root {} yields no entries and no diagnostics', () => {
    expect(parseJsonLayer('{}', 'f.json')).toEqual({ entries: [], diagnostics: [] });
  });

  it('top-level array yields no entries and an error diagnostic "root must be an object"', () => {
    const r = parseJsonLayer('[1]', 'f.json');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].severity).toBe('error');
    expect(r.diagnostics[0].message).toBe('root must be an object');
  });

  it('top-level scalar yields an error diagnostic "root must be an object"', () => {
    const r = parseJsonLayer('42', 'f.json');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics[0].message).toBe('root must be an object');
  });

  it('accepts comments and trailing commas without diagnostics', () => {
    const r = parseJsonLayer('{ /* x */ "A": [1,], // y\n}', 'f.json');
    expect(r.diagnostics).toEqual([]);
    expect(r.entries.map((e) => e.key)).toEqual(['A:0']);
  });
});
