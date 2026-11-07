import { describe, it, expect } from 'vitest';
import { mergeLayers } from '../../src/engine/merge';
import type { Layer } from '../../src/engine/types';
import { parseYamlLayer } from '../../src/sources/yamlLayer';

/**
 * Parses YAML and lists its entries.
 * @param text File contents.
 * @returns The entries as `[key, value]` pairs.
 */
const pairs = (text: string) => parseYamlLayer(text, 'f.yaml').entries.map((e) => [e.key, e.value]);

describe('parseYamlLayer', () => {
  /**
   * Validates flattening of nested mappings and sequences. Expected: `:`-joined keys in source order
   * with sequence items addressed by index, the same key shape as JSON layers.
   */
  it('flattens nested mappings and sequences to A:B:C keys in source order', () => {
    expect(pairs('A:\n  B:\n    C: x\n  L:\n    - y\n    - D: z\n')).toEqual([
      ['A:B:C', 'x'], ['A:L:0', 'y'], ['A:L:1:D', 'z']]);
  });

  /**
   * Validates scalar conversion. Expected: plain scalars keep their source text, because each consumer
   * (Spring, Helm, .NET) parses config strings its own way; quoted and block scalars are decoded.
   */
  it('keeps plain scalars as written and decodes quoted and block scalars', () => {
    expect(pairs('N: 1.50\nH: 0x10\nT: true\nS: hello\nQ: "a\\nb"\nN2: "007"\nB: |\n  x\n  y\n')).toEqual([
      ['N', '1.50'], ['H', '0x10'], ['T', 'true'], ['S', 'hello'], ['Q', 'a\nb'], ['N2', '007'], ['B', 'x\ny\n']]);
  });

  /**
   * Validates empty values, mirroring JSON layers. Expected: `~`, `null` and a missing value become `""`;
   * empty collections become one entry with a `null` value; a value-less flow key also becomes `""`.
   */
  it('maps null and missing values to "" and empty collections to a null value', () => {
    expect(pairs('A: ~\nB: null\nC:\nM: {}\nL: []\nF: {x, y: 1}\n')).toEqual([
      ['A', ''], ['B', ''], ['C', ''], ['M', null], ['L', null], ['F:x', ''], ['F:y', '1']]);
  });

  /**
   * Validates that non-string keys use their source text. Expected: numeric and boolean keys stay as
   * written (`010` does not become `10`) and a key containing a colon is kept verbatim.
   */
  it('uses the source text of non-string keys and keeps colons in keys verbatim', () => {
    expect(pairs('010: a\ntrue: b\n"A:B": c\n')).toEqual([['010', 'a'], ['true', 'b'], ['A:B', 'c']]);
  });

  /**
   * Validates click-through positions. Expected: each entry points at its 0-based value token, past any
   * anchor, for scalars, sequence items and empty collections.
   */
  it('records the 0-based position of each value token', () => {
    const { entries } = parseYamlLayer('A:\n  B: 1\n  L:\n    - x\nC: &c 2\nE: &e {}\nN:\n', 'f.yaml');
    expect(entries.map((e) => [e.key, e.location])).toEqual([
      ['A:B', { filePath: 'f.yaml', line: 1, column: 5 }],
      ['A:L:0', { filePath: 'f.yaml', line: 3, column: 6 }],
      ['C', { filePath: 'f.yaml', line: 4, column: 6 }],
      ['E', { filePath: 'f.yaml', line: 5, column: 6 }],
      ['N', { filePath: 'f.yaml', line: 6, column: 2 }],
    ]);
  });

  /**
   * Validates positions on CRLF files, which Windows checkouts produce. Expected: the carriage return
   * does not shift the line or the column.
   */
  it('computes positions across CRLF line breaks', () => {
    const { entries } = parseYamlLayer('A: 1\r\nB:\r\n  C: 2\r\n', 'f.yaml');
    expect(entries[1].location).toEqual({ filePath: 'f.yaml', line: 2, column: 5 });
  });

  /**
   * Validates a leading BOM, as Windows editors write. Expected: it is not part of the first key and
   * positions refer to the text without it, as in JSON layers.
   */
  it('ignores a leading BOM', () => {
    const { entries } = parseYamlLayer('\ufeffA: 1\n', 'f.yaml');
    expect(entries).toEqual([{ key: 'A', value: '1', location: { filePath: 'f.yaml', line: 0, column: 3 } }]);
  });

  /**
   * Validates that files with nothing to read are not errors. Expected: no entries and one `empty file`
   * info, for empty text, a BOM alone, comments alone and bare document markers.
   */
  it.each([
    ['empty text', ''],
    ['whitespace', '  \n '],
    ['a BOM alone', '﻿'],
    ['comments alone', '# nothing here\n'],
    ['bare document markers', '---\n---\n'],
    ['an explicit null document', '~\n'],
  ])('treats %s as an empty file', (_name, text) => {
    expect(parseYamlLayer(text, 'f.yaml')).toMatchObject({
      entries: [],
      diagnostics: [{ severity: 'info', message: 'empty file', location: { filePath: 'f.yaml', line: 0, column: 0 } }],
    });
  });

  /**
   * Validates an empty root mapping, which is valid configuration. Expected: no entries, no diagnostics,
   * and no entry with an empty key.
   */
  it('accepts an empty root mapping without entries or diagnostics', () => {
    expect(parseYamlLayer('{}\n', 'f.yaml')).toMatchObject({ entries: [], diagnostics: [] });
  });

  /**
   * Validates the skip-with-banner contract for broken files. Expected: no entries even for keys read
   * before the problem, and exactly one error naming the 0-based line of the problem.
   */
  it('skips a broken file with one error at the line of the problem', () => {
    const r = parseYamlLayer('good: 1\nbad: "x" y\n', 'broken.yaml');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].severity).toBe('error');
    expect(r.diagnostics[0].message).toMatch(/^YAML parse error: /);
    expect(r.diagnostics[0].location).toMatchObject({ filePath: 'broken.yaml', line: 1 });
  });

  /**
   * Validates exact duplicate keys, which YAML forbids. Expected: the file is skipped with one error at
   * the second key, naming its full path.
   */
  it('rejects a duplicate key, naming its full path', () => {
    const r = parseYamlLayer('S:\n  A: 1\n  B: 2\n  A: 3\n', 'f.yaml');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics).toEqual([{
      severity: 'error',
      message: "Duplicate key 'S:A'",
      location: { filePath: 'f.yaml', line: 3, column: 2 },
    }]);
  });

  /**
   * Validates keys differing only by case, which YAML treats as distinct, unlike the .NET rule in JSON
   * layers; Kubernetes and Helm files may use both. Expected: the file loads with both entries.
   */
  it('accepts keys differing only by case', () => {
    expect(parseYamlLayer('A: 1\na: 2\n', 'f.yaml').diagnostics).toEqual([]);
    expect(pairs('A: 1\na: 2\n')).toEqual([['A', '1'], ['a', '2']]);
  });

  /**
   * Validates that a scalar spelled like the merge key is kept as text. Expected: as a value, `<<` is
   * the string `<<`, since the parser resolves it to an internal symbol.
   */
  it('keeps << as text when used as a value', () => {
    expect(pairs('A: <<\n')).toEqual([['A', '<<']]);
  });

  /**
   * Validates that diagnostics cannot leak values into the banner, which is shown even while values are
   * masked. An unquoted password can look like YAML syntax, so these are realistic typos. Expected: a
   * diagnostic is raised, and no message has text from the broken line.
   */
  it.each([
    ['an unterminated quote', 'password: "hunter2\nnext: 1\n'],
    ['a block scalar header', 'password: |hunter2\n'],
    ['a bad escape', 'password: "\\uhunter2"\n'],
    ['an alias', 'password: *hunter2\n'],
    ['a tag', 'password: !hunter2 x\n'],
    ['a directive', '%hunter2\n---\na: 1\n'],
  ])('does not echo source text when a value looks like %s', (_name, text) => {
    const { diagnostics } = parseYamlLayer(text, 'f.yaml');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).not.toContain('hunter2');
  });

  /**
   * Validates that unknown tags cannot flood the banner, which has one row per diagnostic; a CloudFormation
   * file can have hundreds. Expected: one warning at the first tag, counting the others.
   */
  it('collapses warnings into one diagnostic', () => {
    const { diagnostics } = parseYamlLayer('A: !x 1\nB: !x 2\nC: !x 3\n', 'f.yaml');
    expect(diagnostics).toEqual([{
      severity: 'warning',
      message: 'YAML warning: TAG_RESOLVE_FAILED (and 2 more)',
      location: { filePath: 'f.yaml', line: 0, column: 3 },
    }]);
  });

  /**
   * Validates that hostile nesting is contained. Expected: one error rather than a thrown stack overflow
   * or one row per nested level in the banner.
   */
  it('reports extreme flow nesting as a single error', () => {
    const r = parseYamlLayer('['.repeat(100000), 'f.yaml');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].severity).toBe('error');
  });

  /**
   * Validates errors outside any document, where the parser returns no document to carry them.
   * Expected: the error is reported instead of the file looking empty.
   */
  it('reports an error in a stream with no documents', () => {
    const { diagnostics } = parseYamlLayer('%TAG\n', 'f.yaml');
    expect(diagnostics.map((d) => d.severity)).toEqual(['error']);
  });

  /**
   * Validates that a root without keys is rejected like in JSON layers. Expected: no entries and one
   * error at the root token, since a scalar or sequence root would produce an empty or numeric key.
   */
  it.each([
    ['a sequence', '- 1\n'],
    ['a scalar', '# c\n42\n'],
  ])('rejects %s as root', (_name, text) => {
    const r = parseYamlLayer(text, 'f.yaml');
    expect(r.entries).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'root must be a mapping' });
  });

  /**
   * Validates unknown tags, common in CloudFormation-style files. Expected: the value still loads and
   * the unresolved tag surfaces as a located warning.
   */
  it('keeps the value of an unknown tag and warns about it', () => {
    const r = parseYamlLayer('A: 1\nB: !secret value\n', 'f.yaml');
    expect(r.entries.map((e) => [e.key, e.value])).toEqual([['A', '1'], ['B', 'value']]);
    expect(r.diagnostics).toEqual([{
      severity: 'warning',
      message: 'YAML warning: TAG_RESOLVE_FAILED',
      location: { filePath: 'f.yaml', line: 1, column: 3 },
    }]);
  });

  describe('anchors and aliases', () => {
    /**
     * Validates that an alias expands to the anchored content. Expected: scalar and collection aliases
     * produce entries under the alias's own key.
     */
    it('expands scalar and collection aliases under their own keys', () => {
      expect(pairs('a: &v 1\nb: *v\nm: &m\n  x: 2\nn: *m\nl: &l [3]\no: *l\n')).toEqual([
        ['a', '1'], ['b', '1'], ['m:x', '2'], ['n:x', '2'], ['l:0', '3'], ['o:0', '3']]);
    });

    /**
     * Validates click-through for aliased values. Expected: the location is the anchored token, where
     * the value can actually be edited, not the alias.
     */
    it('locates an aliased value at the anchored token', () => {
      const { entries } = parseYamlLayer('a: &v 1\nb: *v\n', 'f.yaml');
      expect(entries[1]).toMatchObject({ key: 'b', value: '1', location: { filePath: 'f.yaml', line: 0, column: 6 } });
    });

    /**
     * Validates masking through the real merge engine: a value reached through an alias or merge key is
     * the same secret under a key the mask patterns do not match. Expected: it is sensitive, while a
     * value that merely shares a document with it is not.
     */
    it.each([
      ['a scalar alias', 'db: {password: &pw hunter2}\nnote: *pw\n', 'note'],
      ['a collection alias', 'ConnectionStrings: &cs {main: hunter2}\nother: *cs\n', 'other:main'],
      ['a sequence alias', 'db: {password: &pw [hunter2]}\nother: *pw\n', 'other:0'],
      ['a merge key', 'ConnectionStrings: &cs {main: hunter2}\nother:\n  <<: *cs\n', 'other:main'],
      ['a merge list', 'ConnectionStrings: &cs {main: hunter2}\nother:\n  <<: [*cs]\n', 'other:main'],
      ['a merge chain', 'ConnectionStrings: &cs {main: hunter2}\nmid: &mid\n  <<: *cs\nother:\n  <<: *mid\n', 'other:main'],
      ['an alias inside a merge', 'db: {password: &pw hunter2}\nbase: &b {v: *pw}\nother:\n  <<: *b\n', 'other:v'],
      ['a merge beside its anchor', 'ConnectionStrings: &cs {main: hunter2}\n<<: *cs\n', 'main'],
      ['a merge above a nested anchor', 'db: {password: &p {main: hunter2}}\n<<: *p\n', 'main'],
      ['an alias to an anchor under a merge', 'ConnectionStrings:\n  <<: &cs {main: hunter2}\nother: *cs\n', 'other:main'],
      ['a merge of an anchor under a merge', 'ConnectionStrings:\n  <<: &cs {main: hunter2}\nother:\n  <<: *cs\n', 'other:main'],
      ['an anchor in a merge list', 'ConnectionStrings:\n  <<: [&cs {main: hunter2}]\nother:\n  <<: *cs\n', 'other:main'],
      ['an anchored sequence as merge sources', 'ConnectionStrings: &s [{main: hunter2}]\nother:\n  <<: *s\n', 'other:main'],
      ['an anchor in a shadowed merge value', 'ConnectionStrings:\n  <<: {main: &v hunter2}\n  main: x\nother: *v\n', 'other'],
    ])('keeps a secret masked through %s', (_name, text, key) => {
      const entries = parseYamlLayer(`${text}plain: 1\n`, 'f.yaml').entries;
      const layer: Layer = { id: 'f', label: 'f', kind: 'yaml', sensitive: false, entries };
      const merged = mergeLayers([layer], ['*Password*', 'ConnectionStrings:*']);
      expect(merged.find((m) => m.key === key)?.sensitive).toBe(true);
      expect(merged.find((m) => m.key === 'plain')?.sensitive).toBe(false);
    });

    /**
     * Validates that an anchor's source key does not depend on flattening order: the merge expands before
     * its sibling is flattened, yet the anchor is already defined. Expected: the merged entry names the
     * anchored key.
     */
    it('references an anchor defined beside the merge that uses it', () => {
      const { entries } = parseYamlLayer('ConnectionStrings: &cs {main: hunter2}\n<<: *cs\n', 'f.yaml');
      expect(entries.find((e) => e.key === 'main')?.references).toEqual(['ConnectionStrings:main']);
    });

    /**
     * Validates that a key does not reference itself: a mapping anchored directly under `<<` contributes
     * its keys at the path it was defined for, which the panel would otherwise show as "uses: u:x".
     * Expected: no references on either entry.
     */
    it.each([
      ['a nested mapping', 'u:\n  <<: &m {x: 1}\n', 'u:x'],
      ['the root', '<<: &m {x: 1}\n', 'x'],
    ])('records no self-reference for an anchor under a merge in %s', (_name, text, key) => {
      const { entries } = parseYamlLayer(text, 'f.yaml');
      expect(entries.map((e) => [e.key, e.references])).toEqual([[key, undefined]]);
    });

    /**
     * Validates that ordinary entries claim no source key, since the panel shows references. Expected:
     * only the aliased entry has `references`, naming the anchored key.
     */
    it('records references only on values reached through an alias', () => {
      const { entries } = parseYamlLayer('a: &v 1\nb: *v\n', 'f.yaml');
      expect(entries.map((e) => e.references)).toEqual([undefined, ['a']]);
    });

    /**
     * Validates anchor redefinition, which the YAML spec allows. Expected: an alias takes the most recent
     * anchor before it, so the two aliases differ.
     */
    it('resolves an alias to the most recent anchor of that name', () => {
      expect(pairs('a: &v 1\nb: *v\nc: &v 2\nd: *v\n')).toEqual([['a', '1'], ['b', '1'], ['c', '2'], ['d', '2']]);
    });

    /**
     * Validates that an alias used as a key resolves like any other. Expected: the anchored scalar names
     * the key.
     */
    it('resolves an alias used as a key', () => {
      expect(pairs('a: &k name\n*k : 1\n')).toEqual([['a', 'name'], ['name', '1']]);
    });

    /**
     * Validates aliases to an undefined anchor, which the parser accepts silently. Expected: the file is
     * skipped with an error at the alias naming the anchor.
     */
    it('rejects an alias with no anchor', () => {
      const r = parseYamlLayer('a: 1\nb: *nope\n', 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics).toEqual([{
        severity: 'error',
        message: 'Unresolved alias',
        location: { filePath: 'f.yaml', line: 1, column: 3 },
      }]);
    });

    /**
     * Validates that anchors do not cross documents, as the spec requires. Expected: an alias to an
     * anchor of the previous document is unresolved.
     */
    it('does not resolve an alias to an anchor in an earlier document', () => {
      const r = parseYamlLayer('a: &v 1\n---\nb: *v\n', 'f.yaml');
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'Unresolved alias', location: { line: 2, column: 3 } });
    });

    /**
     * Validates a collection aliasing itself, which would recurse forever if expanded. Expected: one
     * error at the alias instead of a hang or stack overflow.
     */
    it('rejects an alias to a collection containing it', () => {
      const r = parseYamlLayer('a: &a\n  b: *a\n', 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'Alias refers to a collection containing it', location: { line: 1, column: 5 } });
    });

    /**
     * Validates that a repeated, non-recursive alias is not mistaken for a cycle. Expected: both uses
     * expand.
     */
    it('expands the same collection alias twice', () => {
      expect(pairs('a: &a {x: 1}\nb: *a\nc: *a\n')).toEqual([['a:x', '1'], ['b:x', '1'], ['c:x', '1']]);
    });

    /**
     * Validates a non-scalar key, which has no flat form. Expected: the file is skipped with an error at
     * the key.
     */
    it('rejects a collection used as a key', () => {
      const r = parseYamlLayer('a: 1\n? [x, y]\n: 2\n', 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'Mapping keys must be scalars', location: { line: 1, column: 2 } });
    });

    /**
     * Validates null keys, which would otherwise yield `A:` with an empty segment. Expected: the file is
     * skipped with an error.
     */
    it.each([['~ key', '~: 1\n'], ['missing key', ': 1\n']])('rejects a %s', (_name, text) => {
      const r = parseYamlLayer(text, 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'Mapping keys must not be null', location: { line: 0, column: 0 } });
    });
  });

  describe('merge keys', () => {
    /**
     * Validates the basic merge. Expected: keys of the aliased mapping appear under the merging mapping,
     * at the position of `<<`, and each points at its definition.
     */
    it('merges an aliased mapping, locating values at their definition', () => {
      const { entries } = parseYamlLayer('base: &b\n  x: 1\nuse:\n  <<: *b\n  y: 2\n', 'f.yaml');
      expect(entries.map((e) => [e.key, e.value, e.location?.line])).toEqual([
        ['base:x', '1', 1], ['use:x', '1', 1], ['use:y', '2', 4]]);
    });

    /**
     * Validates precedence over the merge. Expected: an explicit key wins whether written before or after
     * `<<`, and the merged value leaves no entry.
     */
    it('lets explicit keys win wherever they are written', () => {
      expect(pairs('b: &b {x: 1, y: 2}\nu:\n  x: 9\n  <<: *b\nv:\n  <<: *b\n  y: 8\n')).toEqual([
        ['b:x', '1'], ['b:y', '2'], ['u:x', '9'], ['u:y', '2'], ['v:x', '1'], ['v:y', '8']]);
    });

    /**
     * Validates a merge list. Expected: an earlier source wins over a later one, per the merge-key spec,
     * and inline mappings count as sources.
     */
    it('lets earlier sources win in a merge list', () => {
      expect(pairs('a: &a {x: 1}\nb: &b {x: 2, y: 3}\nu:\n  <<: [*a, *b, {z: 4}]\n')).toEqual([
        ['a:x', '1'], ['b:x', '2'], ['b:y', '3'], ['u:x', '1'], ['u:y', '3'], ['u:z', '4']]);
    });

    /**
     * Validates that the merge is shallow. Expected: an explicit nested mapping replaces the merged one
     * entirely, so `u:n:p` is absent.
     */
    it('replaces rather than deep-merges a nested mapping', () => {
      expect(pairs('b: &b\n  n: {p: 1}\nu:\n  <<: *b\n  n: {q: 2}\n')).toEqual([['b:n:p', '1'], ['u:n:q', '2']]);
    });

    /**
     * Validates merges through a merge. Expected: keys come through a chain of two merges.
     */
    it('follows a merge inside a merged mapping', () => {
      expect(pairs('a: &a {x: 1}\nb: &b\n  <<: *a\nu:\n  <<: *b\n')).toEqual([['a:x', '1'], ['b:x', '1'], ['u:x', '1']]);
    });

    /**
     * Validates that only a plain `<<` merges. Expected: a quoted `"<<"` is an ordinary key.
     */
    it('treats a quoted << as an ordinary key', () => {
      expect(pairs('"<<": 1\n')).toEqual([['<<', '1']]);
    });

    /**
     * Validates that a merge which contributes nothing is still reported as an empty collection, so the
     * key does not vanish from the panel. Expected: one null entry.
     */
    it('yields a null entry when the merged result is empty', () => {
      expect(pairs('a: &a {}\nu:\n  <<: *a\n')).toEqual([['a', null], ['u', null]]);
    });

    /**
     * Validates merge sources that have no keys to merge. Expected: the file is skipped with an error at
     * the source, for a scalar and for a scalar inside a list.
     */
    it.each([
      ['a scalar', 'u:\n  <<: 3\n', 1, 6],
      ['a scalar in a list', 'u:\n  <<: [3]\n', 1, 7],
    ])('rejects %s as a merge source', (_name, text, line, column) => {
      const r = parseYamlLayer(text as string, 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'Merge sources must be mappings', location: { line, column } });
    });

    /**
     * Validates a mapping merging itself. Expected: one error instead of a hang or stack overflow.
     */
    it('rejects a mapping merging itself', () => {
      const r = parseYamlLayer('a: &a\n  <<: *a\n', 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', message: 'Alias refers to a collection containing it', location: { line: 1, column: 6 } });
    });
  });

  describe('expansion limits', () => {
    /**
     * Builds a "billion laughs" file, whose expansion triples per level.
     * @param levels Number of levels.
     * @returns The file text.
     */
    const laughs = (levels: number): string => {
      const lines = ['l0: &l0 x'];
      for (let i = 1; i <= levels; i++) {
        lines.push(`l${i}: &l${i} [*l${i - 1}, *l${i - 1}, *l${i - 1}]`);
      }
      return lines.join('\n');
    };

    /**
     * Validates containment of exponential alias expansion from an untrusted workspace file, which would
     * otherwise freeze the extension host. Expected: a prompt, single error and no entries.
     */
    it('stops a billion-laughs file with one error', () => {
      const r = parseYamlLayer(laughs(30), 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0].severity).toBe('error');
    });

    /**
     * Validates the same attack through merge keys, whose duplicates vanish and so produce no entries.
     * Expected: the work done is still bounded and reported as one error.
     */
    it('stops exponential merge expansion with one error', () => {
      const lines = ['m0: &m0 {x: 1}'];
      for (let i = 1; i <= 30; i++) {
        lines.push(`m${i}: &m${i} {<<: [*m${i - 1}, *m${i - 1}, *m${i - 1}]}`);
      }
      const r = parseYamlLayer(lines.join('\n'), 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics.map((d) => d.severity)).toEqual(['error']);
    });

    /**
     * Validates that a chain of aliases cannot overflow the stack, though each level looks shallow to the
     * parser. Expected: one error for both nested collections and merges, not a thrown RangeError.
     */
    it.each([
      ['collections', (i: number) => `a${i}: &a${i} [*a${i - 1}]`],
      ['merges', (i: number) => `a${i}: &a${i} {<<: *a${i - 1}}`],
    ])('reports a very long alias chain through %s as one error', (_name, line) => {
      const lines = ['a0: &a0 {x: 1}'];
      for (let i = 1; i <= 20000; i++) {
        lines.push(line(i));
      }
      const r = parseYamlLayer(lines.join('\n'), 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics.map((d) => d.severity)).toEqual(['error']);
    });

    /**
     * Validates that a large file with no aliases is not mistaken for an attack: the limits exist for
     * expansion, not for size. Expected: 60000 flat keys load without diagnostics.
     */
    it('loads a large flat file', () => {
      const lines = Array.from({ length: 60000 }, (_, i) => `k${i}: ${i}`);
      const r = parseYamlLayer(lines.join('\n'), 'f.yaml');
      expect(r.diagnostics).toEqual([]);
      expect(r.entries).toHaveLength(60000);
    });

    /**
     * Validates memory amplification by key length, which no node limit catches: every flattened key
     * repeats its parents, and the merge engine then copies each one when lower-casing it. The explicit
     * `?` form is what allows a key past YAML's 1024-character limit on implicit keys. Expected: a 1 MB
     * parent over 1000 children, a 1 GB expansion from a 1 MB file, is one error from the limit, not the
     * parser.
     */
    it('stops a long key repeated across many children with one error', () => {
      const children = Array.from({ length: 1000 }, (_, i) => `  c${i}: 1`).join('\n');
      const r = parseYamlLayer(`? ${'k'.repeat(1_000_000)}\n:\n${children}\n`, 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0].severity).toBe('error');
      expect(r.diagnostics[0].message).not.toMatch(/^YAML parse error/);
    });

    /**
     * Validates memory amplification through references, which a limit on keys alone misses: the aliased
     * entries have short keys, yet each one's reference repeats the long anchored key, and the merge
     * engine reads every reference. Expected: a 500 KB key reached from 200,000 entries, a 100 GB
     * expansion from a 600 KB file, is one error from the limit.
     */
    it.each([
      ['an alias', (i: number) => `o${i}: *a`],
      ['a merge key', (i: number) => `o${i}: {<<: *a}`],
    ])('stops a long anchored key repeated through %s with one error', (_name, use) => {
      const leaves = Array.from({ length: 20 }, (_, i) => `k${i}: 1`).join(', ');
      const uses = Array.from({ length: 10_000 }, (_, i) => use(i)).join('\n');
      const r = parseYamlLayer(`? ${'k'.repeat(500_000)}\n: &a {${leaves}}\n${uses}\n`, 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error' });
      expect(r.diagnostics[0].message).toMatch(/characters when flattened$/);
    });

    /**
     * Validates that the single-pass alias resolution stays linear, since the library's own resolver
     * rescans the document per alias. Expected: 20000 aliases load, each with its value.
     */
    it('loads many aliases to one anchor', () => {
      const lines = ['a: &a 1'];
      for (let i = 0; i < 20000; i++) {
        lines.push(`k${i}: *a`);
      }
      const r = parseYamlLayer(lines.join('\n'), 'f.yaml');
      expect(r.diagnostics).toEqual([]);
      expect(r.entries).toHaveLength(20001);
      expect(r.entries[20000]).toMatchObject({ key: 'k19999', value: '1' });
    });
  });

  describe('multiple documents', () => {
    /**
     * Validates the flat view. Expected: entries of all documents in file order, so a later document
     * overrides an earlier one through the merge engine's later-entry-wins rule, with positions
     * relative to the whole file.
     */
    it('concatenates documents in file order with file-relative positions', () => {
      const { entries } = parseYamlLayer('A: 1\nB: 2\n---\nA: 3\n', 'f.yaml');
      expect(entries.map((e) => [e.key, e.value, e.location?.line])).toEqual([
        ['A', '1', 0], ['B', '2', 1], ['A', '3', 3]]);
    });

    /**
     * Validates the per-document view that profile gating and Kubernetes manifests need. Expected: one
     * list per document by file position, with an empty document kept as an empty list.
     */
    it('exposes entries per document, keeping empty documents in place', () => {
      const { documents } = parseYamlLayer('A: 1\n---\n---\nB: 2\n', 'f.yaml');
      expect(documents.map((d) => d.map((e) => e.key))).toEqual([['A'], [], ['B']]);
    });

    /**
     * Validates the per-document view when every document is empty, the same contract as above.
     * Expected: one empty list per document.
     */
    it('keeps empty documents in place when all of them are empty', () => {
      expect(parseYamlLayer('---\n---\n', 'f.yaml').documents).toEqual([[], []]);
    });

    /**
     * Validates that keys may repeat between documents, unlike inside one mapping. Expected: no
     * diagnostics.
     */
    it('does not treat a key repeated across documents as a duplicate', () => {
      expect(parseYamlLayer('A: 1\n---\nA: 2\n', 'f.yaml').diagnostics).toEqual([]);
    });

    /**
     * Validates that a broken document skips the whole file, not only itself. Expected: no entries in
     * either view and the error located in the second document.
     */
    it('skips the whole file when a later document is broken', () => {
      const r = parseYamlLayer('A: 1\n---\nB: 2\nB: 3\n', 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.documents).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ severity: 'error', location: { line: 3, column: 0 } });
    });

    /**
     * Validates the root rule per document. Expected: a sequence root in a later document is rejected
     * at its own line.
     */
    it('rejects a non-mapping root in a later document', () => {
      const r = parseYamlLayer('A: 1\n---\n- 1\n', 'f.yaml');
      expect(r.entries).toEqual([]);
      expect(r.diagnostics[0]).toMatchObject({ message: 'root must be a mapping', location: { line: 2, column: 0 } });
    });
  });
});
