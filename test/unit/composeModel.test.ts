import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { mergeService, readComposeFile, serviceNames, type ComposeFileModel } from '../../src/compose/composeModel';

/** Base compose file of the in-memory tests. */
const BASE = path.join('/p', 'compose.yaml');

/** Override compose file of the in-memory tests. */
const OVERRIDE = path.join('/p', 'compose.override.yaml');

/** A lookup where nothing is set. */
const none = (): string | undefined => undefined;

/**
 * Lists the environment items of a service as `[name, raw]` pairs.
 * @param model Parsed compose file.
 * @param service Service name.
 * @returns The pairs, or undefined when the service has no `environment`.
 */
const env = (model: ComposeFileModel, service: string) =>
  model.services.find((s) => s.name === service)?.environment?.map((i) => [i.name, i.raw]);

describe('readComposeFile', () => {
  /**
   * Validates both `environment` forms. Expected: map entries and `NAME=value` list items give their
   * raw text; `FOO:` and a bare `- FOO` give `raw: null` (taken from the scope later); `FOO: ""` and
   * `FOO=` give `''`; a value holding `=` keeps it.
   */
  it('reads map and list environment forms', () => {
    const text = [
      'services:',
      '  a:',
      '    environment:',
      '      X: "1"',
      '      FOO:',
      '      BAR: ""',
      '  b:',
      '    environment:',
      '      - X=1=2',
      '      - EMPTY=',
      '      - BARE',
      '',
    ].join('\n');
    const model = readComposeFile(text, BASE, none);
    expect(env(model, 'a')).toEqual([['X', '1'], ['FOO', null], ['BAR', '']]);
    expect(env(model, 'b')).toEqual([['X', '1=2'], ['EMPTY', ''], ['BARE', null]]);
    expect(model.services.find((s) => s.name === 'b')?.environment?.[0].location).toEqual({ filePath: BASE, line: 8, column: 8 });
    expect(model.diagnostics).toEqual([]);
  });

  /**
   * Validates the three `env_file` forms. Expected: a string, a list of strings and a list of
   * `{ path, required }` all give absolute paths next to the declaring file; `required` defaults to
   * true and `required: false` is kept.
   */
  it('reads the env_file string, list and long forms', () => {
    const text = [
      'services:',
      '  s1:',
      '    env_file: a.env',
      '  s2:',
      '    env_file: [a.env, sub/b.env]',
      '  s3:',
      '    env_file:',
      '      - path: c.env',
      '      - path: d.env',
      '        required: false',
      '',
    ].join('\n');
    const model = readComposeFile(text, BASE, none);
    const files = (name: string) => model.services.find((s) => s.name === name)?.envFiles?.map((f) => [f.path, f.required]);
    expect(files('s1')).toEqual([[path.join('/p', 'a.env'), true]]);
    expect(files('s2')).toEqual([[path.join('/p', 'a.env'), true], [path.join('/p', 'sub/b.env'), true]]);
    expect(files('s3')).toEqual([[path.join('/p', 'c.env'), true], [path.join('/p', 'd.env'), false]]);
    expect(model.services.find((s) => s.name === 's3')?.envFiles?.[1].location).toEqual({ filePath: BASE, line: 8, column: 14 });
  });

  /**
   * Validates that required variables are checked across the whole file, as Compose rejects the
   * configuration otherwise. Expected: an error with the author's message at the `image:` scalar of
   * another service.
   */
  it('reports a missing :? variable anywhere in the file at its location', () => {
    const text = 'services:\n  api:\n    image: x\n  worker:\n    image: img:${DB_PASS:?set DB_PASS}\n';
    const model = readComposeFile(text, BASE, none);
    expect(model.diagnostics).toEqual([{
      severity: 'error',
      message: 'required variable DB_PASS is missing a value: set DB_PASS',
      location: { filePath: BASE, line: 4, column: 11 },
    }]);
  });

  /**
   * Validates the warning Compose prints for an unset variable. Expected: one warning per name per
   * file, at its first use, though the name is used twice; a set name gives none.
   */
  it('warns once per unset variable per file', () => {
    const text = 'services:\n  api:\n    image: ${TAG}\n    command: ${TAG} ${SET}\n';
    const model = readComposeFile(text, BASE, (n) => (n === 'SET' ? '1' : undefined));
    expect(model.diagnostics).toEqual([{
      severity: 'warning',
      message: 'variable TAG is not set; Compose uses an empty string',
      location: { filePath: BASE, line: 2, column: 11 },
    }]);
  });

  /**
   * Validates the non-goals note. Expected: one info diagnostic for a file using both `extends` and a
   * top-level `include`.
   */
  it('notes once that extends and include are not simulated', () => {
    const text = 'include:\n  - other.yaml\nservices:\n  api:\n    extends:\n      service: base\n';
    const infos = readComposeFile(text, BASE, none).diagnostics.filter((d) => d.severity === 'info');
    expect(infos.map((d) => d.message)).toEqual(['extends and include are not simulated']);
  });

  /**
   * Validates merge keys inside `environment`. Expected: merged variables come first, at the `<<`
   * position, and are located at the anchored definition, where they can be edited.
   */
  it('locates variables merged with << at the anchor', () => {
    const text = 'x-common: &common\n  SHARED: "1"\nservices:\n  api:\n    environment:\n      <<: *common\n      OWN: "2"\n';
    const items = readComposeFile(text, BASE, none).services[0].environment;
    expect(items?.map((i) => [i.name, i.raw, i.location.line])).toEqual([['SHARED', '1', 1], ['OWN', '2', 6]]);
  });

  /**
   * Validates Windows checkouts (Review Focus 5). Expected: a CRLF file with a BOM gives the same
   * locations as its LF version.
   */
  it('gives CRLF files with a BOM the same locations as LF files', () => {
    const lf = 'services:\n  api:\n    environment:\n      A: "1"\n    env_file: a.env\n';
    const crlf = `﻿${lf.replace(/\n/g, '\r\n')}`;
    const a = readComposeFile(lf, BASE, none).services[0];
    const b = readComposeFile(crlf, BASE, none).services[0];
    expect(b.environment?.map((i) => i.location)).toEqual(a.environment?.map((i) => i.location));
    expect(b.envFiles?.map((f) => f.location)).toEqual(a.envFiles?.map((f) => f.location));
    expect(b.environment?.[0].location).toEqual({ filePath: BASE, line: 3, column: 9 });
  });

  /**
   * Validates that the merge tags are recognised. Expected: the tag is recorded on the fragment and no
   * unknown-tag warning is raised.
   */
  it('records !reset and !override tags', () => {
    const text = 'services:\n  api:\n    environment: !reset {}\n    env_file: !override\n      - b.env\n';
    const model = readComposeFile(text, OVERRIDE, none);
    expect(model.services[0]).toMatchObject({ environmentTag: '!reset', envFilesTag: '!override', environment: [] });
    expect(model.diagnostics).toEqual([]);
  });

  /**
   * Validates profiles and services without a body. Expected: profiles in order, and an empty service
   * still listed.
   */
  it('reads profiles and keeps services without a body', () => {
    const model = readComposeFile('services:\n  worker:\n    profiles: [jobs, debug]\n  empty:\n', BASE, none);
    expect(model.services.map((s) => [s.name, s.profiles])).toEqual([['worker', ['jobs', 'debug']], ['empty', []]]);
  });
});

describe('mergeService', () => {
  /**
   * Validates an override file without tags (Review Focus 3): `environment` merges by variable name,
   * which separate layers express. Expected: two layers, base first, so `B` is in both and `A` only in
   * the base, where it survives.
   */
  it('stacks environment layers per file without tags', () => {
    const base = readComposeFile('services:\n  api:\n    environment:\n      A: a\n      B: b\n', BASE, none);
    const override = readComposeFile('services:\n  api:\n    environment:\n      B: o\n', OVERRIDE, none);
    const merged = mergeService([base, override], 'api');
    expect(merged?.environmentLayers.map((l) => [l.filePath, l.items.map((i) => [i.name, i.raw])])).toEqual([
      [BASE, [['A', 'a'], ['B', 'b']]],
      [OVERRIDE, [['B', 'o']]],
    ]);
  });

  /**
   * Validates `!reset` on `environment`. Expected: the base layer is dropped and only the override's
   * own, empty layer remains.
   */
  it('drops lower environment layers under !reset', () => {
    const base = readComposeFile('services:\n  api:\n    environment:\n      A: a\n', BASE, none);
    const override = readComposeFile('services:\n  api:\n    environment: !reset {}\n', OVERRIDE, none);
    expect(mergeService([base, override], 'api')?.environmentLayers).toEqual([{ filePath: OVERRIDE, items: [] }]);
  });

  /**
   * Validates the documented per-variable `!reset` (`FOO: !reset null`). Expected: the variable is
   * removed from the lower layers and not set by the override, while other variables stay.
   */
  it('removes one variable from lower layers under FOO: !reset null', () => {
    const base = readComposeFile('services:\n  api:\n    environment:\n      A: a\n      B: b\n', BASE, none);
    const override = readComposeFile('services:\n  api:\n    environment:\n      A: !reset null\n', OVERRIDE, none);
    expect(mergeService([base, override], 'api')?.environmentLayers.map((l) => l.items.map((i) => i.name))).toEqual([['B'], []]);
  });

  /**
   * Validates `env_file` across files, a sequence that Compose appends (compose-spec merge rules).
   * Expected: base files first, then the override's; with `!override` only the override's.
   */
  it('appends env_file lists across files, and replaces them under !override', () => {
    const base = readComposeFile('services:\n  api:\n    env_file: a.env\n', BASE, none);
    const plain = readComposeFile('services:\n  api:\n    env_file: b.env\n', OVERRIDE, none);
    const tagged = readComposeFile('services:\n  api:\n    env_file: !override [b.env]\n', OVERRIDE, none);
    expect(mergeService([base, plain], 'api')?.envFiles.map((f) => path.basename(f.path))).toEqual(['a.env', 'b.env']);
    expect(mergeService([base, tagged], 'api')?.envFiles.map((f) => path.basename(f.path))).toEqual(['b.env']);
  });

  /**
   * Validates a service no file defines. Expected: undefined.
   */
  it('returns undefined for an unknown service', () => {
    expect(mergeService([readComposeFile('services:\n  api: {}\n', BASE, none)], 'web')).toBeUndefined();
  });
});

describe('serviceNames', () => {
  /**
   * Validates the service picker order. Expected: services in first-seen order across files, an
   * override-only service last and no duplicates.
   */
  it('lists services in first-seen order across files', () => {
    const base = readComposeFile('services:\n  api: {}\n  worker: {}\n', BASE, none);
    const override = readComposeFile('services:\n  worker: {}\n  debug: {}\n  api: {}\n', OVERRIDE, none);
    expect(serviceNames([base, override])).toEqual(['api', 'worker', 'debug']);
  });
});
