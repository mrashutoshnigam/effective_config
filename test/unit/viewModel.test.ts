import { describe, it, expect } from 'vitest';
import { buildTree } from '../../src/engine/tree';
import type { MergedEntry, SourceLocation } from '../../src/engine/types';
import { RevealState, toViewModel } from '../../src/panel/viewModel';

/** Builds a merged entry; `overriddenValues` become overridden contributions from layer `lower`. */
function M(
  key: string,
  value: string | null,
  layerId = 'appsettings.json',
  sensitive = false,
  overriddenValues: string[] = [],
  location?: SourceLocation,
  overriddenSensitive = sensitive,
): MergedEntry {
  return {
    key,
    value,
    winner: { layerId, layerLabel: layerId, layerIndex: 1, value, location, sensitive },
    overridden: overriddenValues.map((v) => ({ layerId: 'lower', layerLabel: 'lower', layerIndex: 0, value: v, location, sensitive: overriddenSensitive })),
    sensitive: sensitive || (overriddenValues.length > 0 && overriddenSensitive),
  };
}

describe('toViewModel', () => {
  it('sensitive value hidden until revealed — masked node has null value, revealed shows it', () => {
    const root = buildTree([M('Password', 'p@ss', 'a', true)]);
    const hidden = toViewModel(root, new Set(), new Map()).children[0];
    expect(hidden).toMatchObject({ masked: true, value: null, sensitive: true, revealed: false });
    const shown = toViewModel(root, new Set(['Password']), new Map()).children[0];
    expect(shown).toMatchObject({ masked: false, value: 'p@ss', sensitive: true, revealed: true });
  });

  it('overridden secret values also masked — contributions have null value and masked true', () => {
    const root = buildTree([M('Password', 'new', 'a', true, ['old'])]);
    const node = toViewModel(root, new Set(), new Map()).children[0];
    expect(node.overridden).toEqual([{ layerLabel: 'lower', value: null, masked: true, locationId: undefined }]);
    const shown = toViewModel(root, new Set(['Password']), new Map()).children[0];
    expect(shown.overridden[0]).toMatchObject({ value: 'old', masked: false });
  });

  it('overridden value from secret layer masked even when winner is non-sensitive — value null', () => {
    const root = buildTree([M('Plain', 'public', 'dev', false, ['s3cret'], undefined, true)]);
    const node = toViewModel(root, new Set(), new Map()).children[0];
    expect(node).toMatchObject({ masked: true, value: null });
    expect(node.overridden[0]).toMatchObject({ value: null, masked: true });
  });

  it('opaque id prefix is applied — ids start with the given prefix', () => {
    const locations = new Map<string, SourceLocation>();
    toViewModel(buildTree([M('A', '1', 'a', false, [], { filePath: 'f', line: 0, column: 0 })]), new Set(), locations, 'r2');
    expect([...locations.keys()]).toEqual(['r2l0']);
  });

  it('non-sensitive node shows its value and is not masked', () => {
    const root = buildTree([M('A', '1')]);
    expect(toViewModel(root, new Set(), new Map()).children[0]).toMatchObject({ masked: false, value: '1', sensitive: false });
  });

  it('node without entry has no value and is not masked or sensitive', () => {
    const root = buildTree([M('A:B', '1')]);
    const vm = toViewModel(root, new Set(), new Map());
    expect(vm).toMatchObject({ segment: '', path: '' });
    const a = vm.children[0];
    expect(a).toMatchObject({ masked: false, sensitive: false });
    expect(a.winner).toBeUndefined();
    expect(a.value).toBeUndefined();
    expect(a.children[0].path).toBe('A:B');
  });

  it('locations are registered as opaque ids — locationId resolves to the source location', () => {
    const loc: SourceLocation = { filePath: '/x/appsettings.json', line: 2, column: 4 };
    const locations = new Map<string, SourceLocation>();
    const root = buildTree([M('A', '1', 'a', false, ['0'], loc)]);
    const node = toViewModel(root, new Set(), locations).children[0];
    expect(node.winner?.locationId).toMatch(/^l\d+$/);
    expect(locations.get(node.winner!.locationId!)).toEqual(loc);
    expect(locations.get(node.overridden[0].locationId!)).toEqual(loc);
    expect(locations.size).toBe(2);
  });

  it('contribution without location has no locationId — nothing registered', () => {
    const locations = new Map<string, SourceLocation>();
    const node = toViewModel(buildTree([M('A', '1')]), new Set(), locations).children[0];
    expect(node.winner?.locationId).toBeUndefined();
    expect(locations.size).toBe(0);
  });

  it('revealed set matches paths case-insensitively — differently cased path reveals', () => {
    const root = buildTree([M('Db:Password', 'x', 'a', true)]);
    const node = toViewModel(root, new Set(['db:password']), new Map()).children[0].children[0];
    expect(node.masked).toBe(false);
  });
});

describe('RevealState', () => {
  it('drops a reveal when winner layer changed — path no longer in current set', () => {
    const rs = new RevealState();
    rs.reveal('Db:Password', 'appsettings.json');
    expect(rs.current([M('Db:Password', 'x', 'userSecrets')]).has('Db:Password')).toBe(false);
  });

  it('keeps a reveal while the winner layer is unchanged — path stays in current set', () => {
    const rs = new RevealState();
    rs.reveal('Db:Password', 'appsettings.json');
    expect(rs.current([M('db:password', 'x', 'appsettings.json')]).has('db:password')).toBe(true);
  });

  it('hide removes a reveal — path not in current set', () => {
    const rs = new RevealState();
    rs.reveal('A', 'l');
    rs.hide('a');
    expect(rs.current([M('A', 'x', 'l')]).size).toBe(0);
  });

  it('reveal of a path absent from entries — not in current set', () => {
    const rs = new RevealState();
    rs.reveal('Gone', 'l');
    expect(rs.current([]).size).toBe(0);
  });
});
