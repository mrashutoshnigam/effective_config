import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { FileSystem } from '../../src/sources/fileSystem';
import { matchLayerFiles, readFileLayers, type FileLayerRequest } from '../../src/sources/fileLayers';
import type { LayerEntry } from '../../src/engine/types';

/** Builds an in-memory {@link FileSystem} over a name → content map rooted at `/p`. */
function memoryFs(files: Record<string, string>): FileSystem {
  return {
    async readFile(p) {
      return files[path.basename(p)];
    },
    async listDir() {
      return Object.keys(files);
    },
  };
}

/** Parser stub: every non-empty line `K=V` becomes an entry; a line `!bad` raises an error diagnostic. */
function lineParser(text: string, filePath: string): { entries: LayerEntry[]; diagnostics: { severity: 'error'; message: string }[] } {
  const entries: LayerEntry[] = [];
  const diagnostics: { severity: 'error'; message: string }[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    if (line.startsWith('!')) {
      diagnostics.push({ severity: 'error', message: `bad line in ${path.basename(filePath)}` });
      continue;
    }
    const [key, value] = line.split('=');
    entries.push({ key, value });
  }
  return { entries, diagnostics };
}

/** Builds a request over the in-memory file system with the line parser. */
function request(files: Record<string, string>, patterns: string[], environment = 'Development', over: Partial<FileLayerRequest> = {}): FileLayerRequest {
  return { fs: memoryFs(files), dir: '/p', patterns, environment, kind: 'json', parse: lineParser, ...over };
}

describe('matchLayerFiles', () => {
  const patterns = ['appsettings.json', 'appsettings.{env}.json', 'appsettings.secrets.json'];

  it('resolves exact-case files without a case mismatch', () => {
    expect(matchLayerFiles(['appsettings.json', 'appsettings.Development.json'], patterns, 'Development')).toEqual([
      { pattern: 'appsettings.json', fileName: 'appsettings.json', caseMismatch: false },
      { pattern: 'appsettings.{env}.json', fileName: 'appsettings.Development.json', caseMismatch: false },
      { pattern: 'appsettings.secrets.json', fileName: undefined, caseMismatch: false },
    ]);
  });

  it('finds a differently-cased file and flags caseMismatch — returns the found name', () => {
    expect(matchLayerFiles(['appsettings.staging.json'], patterns, 'Staging')[1]).toEqual({
      pattern: 'appsettings.{env}.json', fileName: 'appsettings.staging.json', caseMismatch: true,
    });
  });

  it('leaves fileName undefined for missing files with no mismatch', () => {
    expect(matchLayerFiles([], ['appsettings.json'], 'Development')).toEqual([{ pattern: 'appsettings.json', fileName: undefined, caseMismatch: false }]);
  });
});

describe('readFileLayers', () => {
  it('returns one layer per existing file in pattern order — missing files are skipped', async () => {
    const r = await readFileLayers(request({ 'a.json': 'x=1', 'a.Development.json': 'x=2' }, ['a.json', 'a.{env}.json', 'a.local.json']));
    expect(r.layers.map((l) => l.id)).toEqual(['a.json', 'a.Development.json']);
    expect(r.layers[1]).toMatchObject({ label: 'a.Development.json', kind: 'json', sensitive: false, filePath: path.join('/p', 'a.Development.json') });
    expect(r.layers[1].entries).toEqual([{ key: 'x', value: '2' }]);
  });

  it('watches the expected path of every pattern, existing or not', async () => {
    const r = await readFileLayers(request({ 'a.json': 'x=1' }, ['a.json', 'a.{env}.json']));
    expect(r.watchPaths).toEqual([path.join('/p', 'a.json'), path.join('/p', 'a.Development.json')]);
  });

  it('warns on a case mismatch and watches the actual file too', async () => {
    const r = await readFileLayers(request({ 'a.development.json': 'x=1' }, ['a.{env}.json']));
    expect(r.layers.map((l) => l.id)).toEqual(['a.development.json']);
    expect(r.diagnostics).toEqual([
      { severity: 'warning', message: "'a.development.json' matches 'a.Development.json' only ignoring case; it would not load on case-sensitive file systems" },
    ]);
    expect(r.watchPaths).toContain(path.join('/p', 'a.development.json'));
  });

  it('marks a layer sensitive when its pattern contains "secret" (case-insensitive) — by default', async () => {
    const r = await readFileLayers(request({ 'a.Secrets.json': 'x=1', 'a.json': 'y=1' }, ['a.json', 'a.Secrets.json']));
    expect(r.layers.map((l) => l.sensitive)).toEqual([false, true]);
  });

  it('uses the caller sensitivity rule when one is given', async () => {
    const r = await readFileLayers(request({ 'a.json': 'x=1' }, ['a.json'], 'Development', { isSensitive: (pattern) => pattern === 'a.json' }));
    expect(r.layers[0].sensitive).toBe(true);
  });

  it('stamps the requested layer kind', async () => {
    const r = await readFileLayers(request({ '.env': 'x=1' }, ['.env'], 'Development', { kind: 'dotenv' }));
    expect(r.layers[0].kind).toBe('dotenv');
  });

  it('forwards parser diagnostics in file order, after the case warning of the same file', async () => {
    const r = await readFileLayers(request({ 'a.development.json': '!bad\nx=1' }, ['a.{env}.json']));
    expect(r.diagnostics.map((d) => d.severity)).toEqual(['warning', 'error']);
    expect(r.layers[0].entries).toEqual([{ key: 'x', value: '1' }]);
  });

  it('parses files sequentially in pattern order so a parser may keep state between files', async () => {
    const seen: string[] = [];
    await readFileLayers(request({ 'a.json': 'x=1', 'b.json': 'y=1' }, ['a.json', 'b.json'], 'Development', {
      parse: (text, filePath) => {
        seen.push(path.basename(filePath));
        return lineParser(text, filePath);
      },
    }));
    expect(seen).toEqual(['a.json', 'b.json']);
  });

  it('skips a file that disappears between listing and reading', async () => {
    const fs: FileSystem = { async listDir() { return ['a.json']; }, async readFile() { return undefined; } };
    const r = await readFileLayers({ ...request({}, ['a.json']), fs });
    expect(r.layers).toEqual([]);
    expect(r.watchPaths).toEqual([path.join('/p', 'a.json')]);
  });
});
