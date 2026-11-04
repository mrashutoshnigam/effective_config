import { describe, it, expect } from 'vitest';
import { toNestedJson, toEnvLines } from '../../src/engine/export';
import type { MergedEntry } from '../../src/engine/types';

/** Builds a MergedEntry with the given key and value. */
function E(key: string, value: string | null): MergedEntry {
  return { key, value, winner: { layerId: 'base', layerLabel: 'base', layerIndex: 0, value, sensitive: false }, overridden: [], sensitive: false };
}
const val = (e: MergedEntry) => e.value;

describe('toNestedJson', () => {
  it('numeric children become arrays, others objects — {A:[x,y], B:{C:z}}', () => {
    const json = toNestedJson([E('A:0', 'x'), E('A:1', 'y'), E('B:C', 'z')], val);
    expect(JSON.parse(json)).toEqual({ A: ['x', 'y'], B: { C: 'z' } });
  });

  it('uses 2-space indentation — output matches JSON.stringify with indent 2', () => {
    expect(toNestedJson([E('A:B', '1')], val)).toBe('{\n  "A": {\n    "B": "1"\n  }\n}');
  });

  it('value-and-children key emits object and drops scalar — {"Foo":{"Bar":"1"}}', () => {
    const json = toNestedJson([E('Foo', 'x'), E('Foo:Bar', '1')], val);
    expect(JSON.parse(json)).toEqual({ Foo: { Bar: '1' } });
  });

  it('direct value with dense numeric children emits an object — Arr=v, Arr:0=a gives {"Arr":{"0":"a"}}', () => {
    const json = toNestedJson([E('Arr', 'v'), E('Arr:0', 'a')], val);
    expect(JSON.parse(json)).toEqual({ Arr: { '0': 'a' } });
  });

  it('numeric children with a gap are emitted as an object — keys 0 and 2 kept', () => {
    const json = toNestedJson([E('A:0', 'x'), E('A:2', 'y')], val);
    expect(JSON.parse(json)).toEqual({ A: { '0': 'x', '2': 'y' } });
  });

  it('numeric children not starting at 0 are emitted as an object', () => {
    const json = toNestedJson([E('A:1', 'x')], val);
    expect(JSON.parse(json)).toEqual({ A: { '1': 'x' } });
  });

  it('leaf with null value (empty section) emits an empty object', () => {
    expect(JSON.parse(toNestedJson([E('A', null)], val))).toEqual({ A: {} });
  });

  it('valueOf returning null for a non-null leaf (masked) emits null', () => {
    const json = toNestedJson([E('A', 'secret')], () => null);
    expect(JSON.parse(json)).toEqual({ A: null });
  });

  it('uses valueOf result instead of raw value — masked text appears in output', () => {
    const json = toNestedJson([E('A', 'secret')], () => '***');
    expect(JSON.parse(json)).toEqual({ A: '***' });
  });

  it('nested arrays of objects — A:0:N and A:1:N form an array of objects', () => {
    const json = toNestedJson([E('A:0:N', 'p'), E('A:1:N', 'q')], val);
    expect(JSON.parse(json)).toEqual({ A: [{ N: 'p' }, { N: 'q' }] });
  });

  it('empty entry list yields an empty object', () => {
    expect(toNestedJson([], val)).toBe('{}');
  });
});

describe('toEnvLines', () => {
  it('converts ":" to "__" — A:B=1 becomes A__B=1', () => {
    expect(toEnvLines([E('A:B', '1')], e => e.value)).toBe('A__B=1');
  });

  it('joins lines with newline and no trailing newline', () => {
    expect(toEnvLines([E('A', '1'), E('B', '2')], val)).toBe('A=1\nB=2');
  });

  it('skips entries with null value (empty sections)', () => {
    expect(toEnvLines([E('A', null), E('B', '2')], val)).toBe('B=2');
  });

  it('valueOf returning null yields an empty value — A= for a masked entry', () => {
    expect(toEnvLines([E('A', 'x')], () => null)).toBe('A=');
  });

  it('empty entry list yields an empty string', () => {
    expect(toEnvLines([], val)).toBe('');
  });
});

describe('toEnvLines separator', () => {
  it('env lines joined with given separator — A:B=1 with "_" becomes A_B=1', () => {
    expect(toEnvLines([E('A:B', '1')], val, '_')).toBe('A_B=1');
  });
});
