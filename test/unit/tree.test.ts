import { describe, it, expect } from 'vitest';
import { buildTree, flattenTree } from '../../src/engine/tree';
import type { MergedEntry } from '../../src/engine/types';

/** Builds a MergedEntry whose winner comes from the given layer. */
function E(key: string, value: string | null, layerId = 'base', layerIndex = 0): MergedEntry {
  return {
    key,
    value,
    winner: { layerId, layerLabel: layerId, layerIndex, value, sensitive: false },
    overridden: [],
    sensitive: false,
  };
}

describe('buildTree', () => {
  it('empty input yields a root with no children — segment and path are empty', () => {
    const t = buildTree([]);
    expect(t).toEqual({ segment: '', path: '', children: [], isArray: false, flags: [] });
  });

  it('builds nested nodes — intermediate section has no entry, leaf carries entry and full path', () => {
    const t = buildTree([E('A:B:C', '1')]);
    const a = t.children[0];
    expect(a).toMatchObject({ segment: 'A', path: 'A', flags: [] });
    expect(a.entry).toBeUndefined();
    expect(a.children[0].children[0]).toMatchObject({ segment: 'C', path: 'A:B:C', entry: { value: '1' } });
  });

  it('node with value and children is flagged valueAndChildren', () => {
    const t = buildTree([E('Foo', 'x'), E('Foo:Bar', '1')]);
    expect(t.children[0]).toMatchObject({ segment: 'Foo', entry: { value: 'x' }, flags: ['valueAndChildren'] });
  });

  it('node with null value and children (empty section) is not flagged — flags stay empty', () => {
    const t = buildTree([E('Foo', null), E('Foo:Bar', '1')]);
    expect(t.children[0].flags).toEqual([]);
    expect(t.children[0].entry).toBeDefined();
  });

  it('array with items from two layers flagged mixedArray — isArray true', () => {
    const t = buildTree([E('Arr:0', 'a', 'dev'), E('Arr:1', 'b', 'base')]);
    expect(t.children[0].isArray).toBe(true);
    expect(t.children[0].flags).toEqual(['mixedArray']);
  });

  it('single-layer array is not flagged — isArray true, flags empty', () => {
    const t = buildTree([E('Arr:0', 'a'), E('Arr:1', 'b')]);
    expect(t.children[0].isArray).toBe(true);
    expect(t.children[0].flags).toEqual([]);
  });

  it('mixedArray considers nested descendants — object items from different layers flag the array', () => {
    const t = buildTree([E('Arr:0:Name', 'a', 'dev'), E('Arr:1:Name', 'b', 'base')]);
    expect(t.children[0].flags).toEqual(['mixedArray']);
  });

  it('node with mixed numeric and named children is not an array — isArray false', () => {
    const t = buildTree([E('X:0', 'a'), E('X:Name', 'b')]);
    expect(t.children[0].isArray).toBe(false);
  });

  it('leaf node is not an array — isArray false', () => {
    const t = buildTree([E('X', 'a')]);
    expect(t.children[0].isArray).toBe(false);
  });

  it('numeric segment beyond int32 is not array-like — isArray false', () => {
    const t = buildTree([E('X:99999999999', 'a')]);
    expect(t.children[0].isArray).toBe(false);
  });

  it('children are sorted with compareKeys — 2 before 10, numbers before names', () => {
    const t = buildTree([E('A:b', '1'), E('A:10', '2'), E('A:2', '3')]);
    expect(t.children[0].children.map(c => c.segment)).toEqual(['2', '10', 'b']);
  });

  it('both flags set in fixed order — mixedArray then valueAndChildren', () => {
    const t = buildTree([E('Arr', 'v', 'base'), E('Arr:0', 'a', 'dev'), E('Arr:1', 'b', 'base')]);
    expect(t.children[0].flags).toEqual(['mixedArray', 'valueAndChildren']);
  });

  it("array node's own value layer is ignored for mixedArray — Arr=v (base) with items both from dev flags only valueAndChildren", () => {
    const t = buildTree([E('Arr', 'v', 'base'), E('Arr:0', 'a', 'dev'), E('Arr:1', 'b', 'dev')]);
    expect(t.children[0].flags).toEqual(['valueAndChildren']);
  });

  it('segments differing only by case share a node — first-seen casing kept', () => {
    const t = buildTree([E('Foo:A', '1'), E('foo:B', '2')]);
    expect(t.children).toHaveLength(1);
    expect(t.children[0].segment).toBe('Foo');
    expect(t.children[0].children).toHaveLength(2);
  });
  it('section casing comes from the lowest layer under it — json Logging wins over OS env LOGGING even when listed second', () => {
    const t = buildTree([E('LOGGING:Console', 'x', 'envOs', 5), E('Logging:LogLevel:Default', 'Info', 'appsettings.json', 0)]);
    expect(t.children).toHaveLength(1);
    expect(t.children[0]).toMatchObject({ segment: 'Logging', path: 'Logging' });
    expect(t.children[0].children.map((c) => c.path)).toEqual(['Logging:Console', 'Logging:LogLevel']);
  });

  it('section casing considers overridden contributions — lowest overridden layer decides', () => {
    const high = E('A:B:C', '2', 'envOs', 5);
    high.overridden = [{ layerId: 'base', layerLabel: 'base', layerIndex: 0, value: '1', sensitive: false }];
    const t = buildTree([E('a:x', 'v', 'dev', 3), high]);
    expect(t.children[0].segment).toBe('A');
  });

  it('equal layer rank keeps the first-seen casing — ties are stable', () => {
    const t = buildTree([E('Foo:A', '1', 'base', 0), E('FOO:B', '2', 'base', 0)]);
    expect(t.children[0].segment).toBe('Foo');
  });
});

describe('flattenTree', () => {
  it('returns value nodes in compareKeys order — A:2, A:10, b', () => {
    const t = buildTree([E('b', '1'), E('A:10', '2'), E('A:2', '3')]);
    expect(flattenTree(t).map(n => n.path)).toEqual(['A:2', 'A:10', 'b']);
  });

  it('skips nodes without entry — intermediate sections are omitted', () => {
    const t = buildTree([E('A:B', '1')]);
    expect(flattenTree(t).map(n => n.path)).toEqual(['A:B']);
  });

  it('parent with entry precedes its children — Foo then Foo:Bar', () => {
    const t = buildTree([E('Foo:Bar', '1'), E('Foo', 'x')]);
    expect(flattenTree(t).map(n => n.path)).toEqual(['Foo', 'Foo:Bar']);
  });

  it('empty tree yields an empty list', () => {
    expect(flattenTree(buildTree([]))).toEqual([]);
  });
});
