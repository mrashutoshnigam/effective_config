import { describe, expect, it } from 'vitest';
import { mergeLayers } from '../../src/engine/merge';
import type { Layer, LayerEntry } from '../../src/engine/types';

/** Builds a layer from a key/value record (insertion order = source order). */
function L(
  id: string,
  record: Record<string, string | null>,
  opts: { sensitive?: boolean; label?: string } = {},
): Layer {
  const entries: LayerEntry[] = Object.entries(record).map(([key, value]) => ({ key, value }));
  return { id, label: opts.label ?? id.toUpperCase(), kind: 'json', sensitive: opts.sensitive ?? false, entries };
}

describe('mergeLayers', () => {
  it('overrides lower layer value — winner is dev, base in overridden', () => {
    const r = mergeLayers([L('base', { 'A:B': '1' }), L('dev', { 'a:b': '2' })], []);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      key: 'A:B',
      value: '2',
      winner: { layerId: 'dev' },
      overridden: [{ layerId: 'base', value: '1' }],
    });
  });

  it('keeps lowest-layer display casing when an env var differs only in case', () => {
    const r = mergeLayers(
      [L('base', { 'Logging:LogLevel:Default': 'Info' }), L('env', { 'LOGGING:LOGLEVEL:DEFAULT': 'Debug' })],
      [],
    );
    expect(r).toHaveLength(1);
    expect(r[0].key).toBe('Logging:LogLevel:Default');
    expect(r[0].value).toBe('Debug');
  });

  it('merges arrays by index — values x,b,c', () => {
    const r = mergeLayers(
      [L('base', { 'Arr:0': 'a', 'Arr:1': 'b', 'Arr:2': 'c' }), L('dev', { 'Arr:0': 'x' })],
      [],
    );
    expect(r.map((e) => e.value)).toEqual(['x', 'b', 'c']);
  });

  it('returns [] for an empty layer list', () => {
    expect(mergeLayers([], ['*Key*'])).toEqual([]);
  });

  it('returns [] when layers have no entries', () => {
    expect(mergeLayers([L('a', {})], [])).toEqual([]);
  });

  it('marks entry sensitive when the winner layer is sensitive', () => {
    const r = mergeLayers([L('base', { Plain: '1' }), L('sec', { Plain: '2' }, { sensitive: true })], []);
    expect(r[0].sensitive).toBe(true);
  });

  it('overridden secret-layer value makes entry sensitive — entry and that contribution flagged', () => {
    const r = mergeLayers([L('sec', { Plain: '1' }, { sensitive: true }), L('dev', { Plain: '2' })], []);
    expect(r[0].sensitive).toBe(true);
    expect(r[0].overridden[0].sensitive).toBe(true);
    expect(r[0].winner.sensitive).toBe(false);
  });

  it('marks entry sensitive when the key matches a mask pattern', () => {
    const r = mergeLayers([L('base', { 'Db:Password': 'x', 'Db:Host': 'h' })], ['*Password*']);
    expect(r.find((e) => e.key === 'Db:Password')?.sensitive).toBe(true);
    expect(r.find((e) => e.key === 'Db:Host')?.sensitive).toBe(false);
  });

  it('orders overridden oldest first across three layers', () => {
    const r = mergeLayers([L('a', { K: '1' }), L('b', { K: '2' }), L('c', { K: '3' })], []);
    expect(r[0].winner.layerId).toBe('c');
    expect(r[0].overridden.map((o) => o.layerId)).toEqual(['a', 'b']);
  });

  it('copies layer label and entry location into contributions', () => {
    const location = { filePath: 'f.json', line: 1, column: 2 };
    const layer: Layer = {
      id: 'base',
      label: 'Base File',
      kind: 'json',
      sensitive: false,
      entries: [{ key: 'K', value: 'v', location }],
    };
    const r = mergeLayers([layer], []);
    expect(r[0].winner).toEqual({ layerId: 'base', layerLabel: 'Base File', layerIndex: 0, value: 'v', location, sensitive: false });
    expect(r[0].overridden).toEqual([]);
  });

  it('lets the later entry win within a single layer — earlier goes to overridden', () => {
    const r = mergeLayers([L('env', { 'A:B': '1', 'a:b': '2' })], []);
    expect(r).toHaveLength(1);
    expect(r[0].key).toBe('A:B');
    expect(r[0].value).toBe('2');
    expect(r[0].overridden).toMatchObject([{ layerId: 'env', value: '1' }]);
  });

  it('treats null as a normal value — it can win and be overridden', () => {
    const won = mergeLayers([L('a', { S: 'x' }), L('b', { S: null })], []);
    expect(won[0].value).toBeNull();
    expect(won[0].overridden[0].value).toBe('x');
    const lost = mergeLayers([L('a', { S: null }), L('b', { S: 'y' })], []);
    expect(lost[0].value).toBe('y');
    expect(lost[0].overridden[0].value).toBeNull();
  });

  it('sorts keys per segment — numeric by value, text case-insensitively, prefix first', () => {
    const r = mergeLayers(
      [L('a', { 'A:B': '1', 'Arr:10': '1', 'Arr:2': '1', A: '1', b: '1', 'Arr:x': '1' })],
      [],
    );
    expect(r.map((e) => e.key)).toEqual(['A', 'A:B', 'Arr:2', 'Arr:10', 'Arr:x', 'b']);
  });
});
