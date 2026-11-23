import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { NodeProvider, type NodeProviderOptions } from '../../src/node/nodeProvider';
import { mergeLayers } from '../../src/engine/merge';
import { nodeFileSystem } from '../../src/sources/fileSystem';
import type { ProjectInfo } from '../../src/provider';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const VITE_DIR = path.join(FIXTURES, 'ViteApp');
const NEXT_DIR = path.join(FIXTURES, 'NextApp');

/** The Node project of a fixture directory. */
const project = (dir: string): ProjectInfo => ({
  id: path.join(dir, 'package.json'), name: path.basename(dir), dir, projectFile: path.join(dir, 'package.json'), kind: 'node',
});

/** Provider against the real fixtures with an empty OS environment; `options` override defaults. */
const make = (options: Partial<NodeProviderOptions> = {}): NodeProvider =>
  new NodeProvider({ fs: nodeFileSystem, osEnv: {}, framework: 'auto', ...options });

describe('NodeProvider.describe', () => {
  /**
   * A Vite project without launch profiles offers the modes named by its `.env.*` files and
   * preselects `development`. Expected: the Vite merge label, the dotenv environment list, the
   * `.env` watch globs and no profiles.
   */
  it('describes a Vite project — ViteApp', async () => {
    const d = await make().describe(project(VITE_DIR));
    expect(d.profiles).toEqual([]);
    expect(d.environments).toEqual(['development', 'staging', 'production']);
    expect(d.defaultSelection).toEqual({ environment: 'development' });
    expect(d.mergeLabel).toBe('Simulated — Vite .env order (OS variables win)');
    expect(d.watchGlobs).toEqual(['.env', '.env.*', 'package.json']);
  });

  /**
   * Next.js only knows three `NODE_ENV` values and ignores `MODE`. Expected: the fixed environment
   * list, the Next merge label and `test` preselected from `NODE_ENV` even though `MODE` is set.
   */
  it('describes a Next project with fixed modes from NODE_ENV — NextApp', async () => {
    const d = await make({ osEnv: { MODE: 'staging', NODE_ENV: 'test' } }).describe(project(NEXT_DIR));
    expect(d.environments).toEqual(['development', 'production', 'test']);
    expect(d.mergeLabel).toBe('Simulated — Next.js .env order (OS variables win)');
    expect(d.defaultSelection).toEqual({ environment: 'test' });
  });

  /**
   * Vite reads the mode from `MODE` before `NODE_ENV`. Expected: `MODE` wins when both are set,
   * `NODE_ENV` is used alone, `development` when neither is.
   */
  it('detects the Vite mode from MODE, then NODE_ENV', async () => {
    const mode = async (osEnv: Record<string, string>) => (await make({ osEnv }).describe(project(VITE_DIR))).defaultSelection.environment;
    expect(await mode({ MODE: 'staging', NODE_ENV: 'production' })).toBe('staging');
    expect(await mode({ NODE_ENV: 'production' })).toBe('production');
    expect(await mode({})).toBe('development');
  });
});

/** Merges the layers of a build and indexes the effective entries by key. */
const merged = async (provider: NodeProvider, dir: string, environment: string) => {
  const build = await provider.buildLayers(project(dir), { environment });
  return { build, byKey: new Map(mergeLayers(build.layers, []).map((e) => [e.key, e])) };
};

describe('NodeProvider.buildLayers', () => {
  /**
   * Vite ranks the mode files above `.env.local`. Expected in `development`: SHARED comes from
   * `.env.development` (beating `.env.local` and `.env`), VITE_API_URL from `.env.local`,
   * VITE_FEATURE from `.env.development.local`, each winner pointing at its file and line.
   */
  it('applies the Vite order with file provenance — ViteApp development', async () => {
    const { build, byKey } = await merged(make(), VITE_DIR, 'development');
    expect(build.layers.map((l) => path.basename(l.filePath ?? ''))).toEqual(['.env', '.env.local', '.env.development', '.env.development.local']);

    const shared = byKey.get('SHARED');
    expect(shared?.value).toBe('from-development');
    expect(shared?.winner.location).toEqual({ filePath: path.join(VITE_DIR, '.env.development'), line: 0, column: 7 });
    expect(shared?.overridden.map((c) => c.value).sort()).toEqual(['from-env', 'from-env-local']);

    expect(byKey.get('VITE_API_URL')?.value).toBe('http://localhost:4000');
    expect(byKey.get('VITE_API_URL')?.winner.location?.filePath).toBe(path.join(VITE_DIR, '.env.local'));
    expect(byKey.get('VITE_FEATURE')?.value).toBe('dev-local');
    expect(byKey.get('VITE_APP_TITLE')?.value).toBe('Vite fixture');
  });

  /**
   * Next.js ranks `.env.local` above the mode file, but does not load `.env.local` under `test`.
   * Expected: SHARED from `.env.local` in `development`; from `.env.test` in `test`, with no
   * `.env.local` layer and API_TOKEN falling back to `.env`.
   */
  it('applies the Next order and skips .env.local under test — NextApp', async () => {
    const dev = await merged(make(), NEXT_DIR, 'development');
    expect(dev.byKey.get('SHARED')?.value).toBe('from-env-local');
    expect(dev.byKey.get('SHARED')?.winner.location?.filePath).toBe(path.join(NEXT_DIR, '.env.local'));
    expect(dev.byKey.get('NEXT_PUBLIC_SITE')?.value).toBe('Next dev');

    const test = await merged(make(), NEXT_DIR, 'test');
    expect(test.build.layers.map((l) => path.basename(l.filePath ?? ''))).toEqual(['.env', '.env.test']);
    expect(test.byKey.get('SHARED')?.value).toBe('from-test');
    expect(test.byKey.get('API_TOKEN')?.value).toBe('base-token');
  });

  /**
   * Shell variables beat every file, and the preset's client prefix shows shell variables no file
   * defines. Expected: OS SHARED wins over `.env.development`; VITE_SHELL_ONLY appears from the OS
   * layer; PATH (unprefixed, in no file) stays hidden; keys stay flat (no `__` nesting).
   */
  it('ranks OS variables highest and shows prefixed OS-only variables — ViteApp', async () => {
    const osEnv = { SHARED: 'from-shell', VITE_SHELL_ONLY: 'shell', PATH: '/usr/bin', VITE_A__B: 'flat' };
    const { build, byKey } = await merged(make({ osEnv }), VITE_DIR, 'development');
    expect(build.layers.at(-1)?.kind).toBe('envOs');
    expect(byKey.get('SHARED')?.value).toBe('from-shell');
    expect(byKey.get('VITE_SHELL_ONLY')?.value).toBe('shell');
    expect(byKey.get('VITE_A__B')?.value).toBe('flat');
    expect(byKey.has('PATH')).toBe(false);
  });

  /**
   * Editing `package.json` can change the framework, and a broken one must be reported. Expected:
   * package.json is a watch path; an unparsable package.json yields the generic order plus a warning.
   */
  it('watches package.json and reports an unusable one', async () => {
    const pkgFile = path.join(VITE_DIR, 'package.json');
    const good = await make().buildLayers(project(VITE_DIR), { environment: 'development' });
    expect(good.watchPaths).toContain(pkgFile);
    expect(good.diagnostics).toEqual([]);

    const brokenFs = { ...nodeFileSystem, readFile: async (p: string) => (p === pkgFile ? '{' : nodeFileSystem.readFile(p)) };
    const broken = await make({ fs: brokenFs }).buildLayers(project(VITE_DIR), { environment: 'development' });
    expect(broken.diagnostics).toEqual([{ severity: 'warning', message: `${pkgFile} is not a JSON object; using the generic .env order` }]);
    expect(broken.layers.map((l) => path.basename(l.filePath ?? ''))).toEqual(['.env', '.env.development', '.env.local', '.env.development.local']);
  });

  /**
   * The framework setting overrides detection. Expected: forcing `next` on the Vite fixture applies
   * the Next order, so `.env.local` beats `.env.development` for SHARED.
   */
  it('applies a forced framework', async () => {
    const { byKey } = await merged(make({ framework: 'next' }), VITE_DIR, 'development');
    expect(byKey.get('SHARED')?.value).toBe('from-env-local');
  });
});
