import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { escapeGlobSegment, watchTargetFor, watchTargetsFor, watchTargetKey } from '../../src/panel/watchTargets';

const root = path.resolve('/r');
const dirs = (...existing: string[]) => (d: string) => existing.includes(d);

describe('watchTargetFor', () => {
  it('watches the file directly when its folder exists — base is the folder, pattern the file name', () => {
    const file = path.join(root, 'proj', 'appsettings.json');
    expect(watchTargetFor(file, dirs(path.join(root, 'proj')))).toEqual({ base: path.join(root, 'proj'), pattern: 'appsettings.json' });
  });

  it('walks up to the nearest existing ancestor when folders are missing — pattern is abc/secrets.json', () => {
    const file = path.join(root, 'UserSecrets', 'abc', 'secrets.json');
    expect(watchTargetFor(file, dirs(root, path.join(root, 'UserSecrets')))).toEqual({ base: path.join(root, 'UserSecrets'), pattern: 'abc/secrets.json' });
  });

  it('spans several missing folders with "/" separators', () => {
    const file = path.join(root, 'a', 'b', 'c.json');
    expect(watchTargetFor(file, dirs(root))).toEqual({ base: root, pattern: 'a/b/c.json' });
  });

  it('stops at the filesystem root when nothing exists — no infinite loop', () => {
    const t = watchTargetFor(path.join(root, 'x', 'y.json'), () => false);
    expect(path.dirname(t.base)).toBe(t.base);
  });

  it('escapes glob metacharacters in segments — wildcards cannot widen the pattern', () => {
    expect(escapeGlobSegment('a*b?c{d}e[f]')).toBe('a[*]b[?]c[{]d[}]e?f?');
    const file = path.join(root, 'x[1]', 'se*.json');
    expect(watchTargetFor(file, dirs(root)).pattern).toBe('x?1?/se[*].json');
  });
});

describe('watchTargetsFor / watchTargetKey', () => {
  it('de-duplicates identical targets', () => {
    const f = path.join(root, 'a.json');
    expect(watchTargetsFor([f, f], dirs(root))).toHaveLength(1);
  });

  it('key changes when the nearest existing ancestor changes — lets the panel rebuild watchers', () => {
    const file = path.join(root, 'UserSecrets', 'abc', 'secrets.json');
    const before = watchTargetKey(watchTargetFor(file, dirs(root)));
    const after = watchTargetKey(watchTargetFor(file, dirs(root, path.join(root, 'UserSecrets'))));
    expect(before).not.toBe(after);
  });
});
