import { describe, it, expect } from 'vitest';
import { DotenvProviderBase, type DotenvProviderOptions, type ProcessEnvironment } from '../../src/sources/dotenvProvider';
import type { FileSystem } from '../../src/sources/fileSystem';
import type { ProjectDescription, ProjectInfo } from '../../src/provider';
import { mergeLayers } from '../../src/engine/merge';

/** Minimal provider built on the base: all that a new dotenv-style ecosystem has to supply. */
class StubProvider extends DotenvProviderBase {
  /** @inheritdoc */
  async describe(): Promise<ProjectDescription> {
    return {
      profiles: [],
      environments: ['dev'],
      profileEnvironments: {},
      defaultSelection: { environment: 'dev' },
      mergeLabel: 'stub',
      envVarSeparator: '__',
      watchGlobs: ['.env*'],
    };
  }
}

const DIR = '/stub';
const PROJECT: ProjectInfo = { id: DIR, name: 'stub', dir: DIR, projectFile: `${DIR}/stub.toml`, kind: 'stub' };

/** In-memory file system keyed by file name inside {@link DIR}. */
function memFs(files: Record<string, string>): FileSystem {
  return {
    readFile: async (p) => files[p.replace(/\\/g, '/').slice(DIR.length + 1)],
    listDir: async () => Object.keys(files),
  };
}

/** Builds a stub provider over in-memory files; `options` override the defaults. */
function make(files: Record<string, string>, options: Partial<DotenvProviderOptions> = {}): StubProvider {
  return new StubProvider({
    fs: memFs(files), osEnv: {}, envFiles: ['.env', '.env.{env}'], fileOverridesOs: false,
    envPrefixes: [], nestedDelimiter: '__', ...options,
  });
}

describe('DotenvProviderBase file layers', () => {
  /** Validates pattern order and `{env}` substitution: `.env` then `.env.dev`, with the later file winning on merge. */
  it('loads env file layers lowest priority first and substitutes {env} — later file wins on merge', async () => {
    const build = await make({ '.env': 'A=base\nB=base\n', '.env.dev': 'B=dev\n' }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers.map((l) => l.label)).toEqual(['.env', '.env.dev']);
    expect(mergeLayers(build.layers, []).map((m) => [m.key, m.value])).toEqual([['A', 'base'], ['B', 'dev']]);
  });

  /** Validates that a pattern without a file adds no layer, yet its path is watched so creating the file triggers a rebuild. */
  it('skips patterns whose file is missing and watches them anyway', async () => {
    const build = await make({ '.env': 'A=1\n' }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers).toHaveLength(1);
    expect(build.watchPaths.map((p) => p.replace(/\\/g, '/'))).toContain(`${DIR}/.env.dev`);
  });

  /** Validates the configured delimiter: `DB__HOST` becomes the nested key `DB:HOST`. */
  it('splits names into nested keys with the configured delimiter', async () => {
    const build = await make({ '.env': 'DB__HOST=h\n' }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers[0].entries[0].key).toBe('DB:HOST');
  });
});

describe('DotenvProviderBase expansion', () => {
  /** Validates that `${HOST}` resolves from an earlier entry and the value records `HOST` as a reference. */
  it('expands ${VAR} references and records the referenced keys', async () => {
    const build = await make({ '.env': 'HOST=h\nURL=http://${HOST}/x\n' }).buildLayers(PROJECT, { environment: 'dev' });
    const url = build.layers[0].entries.find((e) => e.key === 'URL');
    expect(url?.value).toBe('http://h/x');
    expect(url?.references).toEqual(['HOST']);
  });

  /** Validates expansion across layers: a later file resolves a variable defined only by an earlier file. */
  it('resolves references against earlier files', async () => {
    const build = await make({ '.env': 'HOST=h\n', '.env.dev': 'URL=${HOST}\n' }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers[1].entries[0].value).toBe('h');
  });

  /** Validates precedence inside expansion: with default settings the OS value beats the file value; `fileOverridesOs` flips it. */
  it('prefers OS values by default and file values when fileOverridesOs is set', async () => {
    const files = { '.env': 'HOST=file\nURL=${HOST}\n' };
    const osEnv = { HOST: 'os' };
    const urlOf = async (fileOverridesOs: boolean): Promise<string | null | undefined> => {
      const build = await make(files, { osEnv, fileOverridesOs }).buildLayers(PROJECT, { environment: 'dev' });
      return build.layers.find((l) => l.id === '.env')?.entries.find((e) => e.key === 'URL')?.value;
    };
    expect(await urlOf(false)).toBe('os');
    expect(await urlOf(true)).toBe('file');
  });

  /** Validates that a single-quoted value stays literal: `${HOST}` is neither expanded nor recorded as a reference. */
  it('leaves single-quoted values unexpanded', async () => {
    const build = await make({ '.env': "HOST=h\nRAW='${HOST}'\n" }).buildLayers(PROJECT, { environment: 'dev' });
    const raw = build.layers[0].entries.find((e) => e.key === 'RAW');
    expect(raw?.value).toBe('${HOST}');
    expect(raw?.references).toBeUndefined();
  });
});

describe('DotenvProviderBase OS layer', () => {
  const files = { '.env': 'A=file\n' };
  const osEnv = { A: 'os', MYAPP_X: '1', UNRELATED: 'z' };

  /** Validates filtering: `A` (a file defines it) and `MYAPP_X` (allowed prefix) stay, `UNRELATED` goes; the OS layer ranks last so it wins. */
  it('keeps only OS variables defined by a file or selected by a prefix — OS wins by default', async () => {
    const build = await make(files, { osEnv, envPrefixes: ['myapp_'] }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers.map((l) => l.id)).toEqual(['.env', 'envOs']);
    expect(build.layers[1].entries.map((e) => e.key)).toEqual(['A', 'MYAPP_X']);
    expect(mergeLayers(build.layers, []).find((m) => m.key === 'A')?.value).toBe('os');
  });

  /** Validates case-insensitive matching against nested keys: OS `db__host` is kept because a file defines `DB__HOST`. */
  it('matches OS variables to nested file keys ignoring case', async () => {
    const build = await make({ '.env': 'DB__HOST=h\n' }, { osEnv: { db__host: 'os' } }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers.find((l) => l.id === 'envOs')?.entries.map((e) => e.key)).toEqual(['db:host']);
  });

  /** Validates `fileOverridesOs`: the OS layer moves below the files, so the file value wins on merge. */
  it('ranks file layers above the OS layer when fileOverridesOs is set', async () => {
    const build = await make(files, { osEnv, fileOverridesOs: true }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers.map((l) => l.id)).toEqual(['envOs', '.env']);
    expect(mergeLayers(build.layers, []).find((m) => m.key === 'A')?.value).toBe('file');
  });

  /** Validates that an empty OS layer is omitted when no OS variable qualifies. */
  it('adds no OS layer when nothing qualifies', async () => {
    const build = await make(files, { osEnv: { UNRELATED: 'z' } }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers.map((l) => l.id)).toEqual(['.env']);
  });
});

/** Provider that injects one process layer (`INJECTED=process`) through the base's hook, as a launch configuration would. */
class ProcessLayerProvider extends StubProvider {
  /** @inheritdoc */
  protected override async readProcessEnvironment(): Promise<ProcessEnvironment> {
    const vars = this.osVars();
    vars.set('INJECTED', 'process');
    return {
      vars,
      layers: [{ id: 'injected', label: 'Injected', kind: 'envProfile', sensitive: false, entries: [{ key: 'INJECTED', value: 'process' }] }],
      diagnostics: [{ severity: 'info', message: 'from hook' }],
      watchPaths: ['/stub/hook.json'],
    };
  }
}

describe('DotenvProviderBase process environment hook', () => {
  /** Builds the hook provider over the given files and OS variables. */
  const build = (files: Record<string, string>, osEnv: Record<string, string>, fileOverridesOs = false) =>
    new ProcessLayerProvider({ fs: memFs(files), osEnv, envFiles: ['.env'], fileOverridesOs, envPrefixes: [], nestedDelimiter: '__' })
      .buildLayers(PROJECT, { environment: 'dev' });

  /** Validates ordering: files, then OS, then process layers; `fileOverridesOs` moves the files to the top. */
  it('ranks process layers above the OS layer and moves files to the top with fileOverridesOs', async () => {
    const files = { '.env': 'A=file\n' };
    expect((await build(files, { A: 'os' })).layers.map((l) => l.id)).toEqual(['.env', 'envOs', 'injected']);
    expect((await build(files, { A: 'os' }, true)).layers.map((l) => l.id)).toEqual(['envOs', 'injected', '.env']);
  });

  /** Validates that file values expand against the variables the hook returned, not only the OS. */
  it('expands file values against the process variables', async () => {
    const { layers } = await build({ '.env': 'URL=${INJECTED}\n' }, {});
    expect(layers.find((l) => l.id === '.env')?.entries[0].value).toBe('process');
  });

  /** Validates that an OS variable defined only by a process layer is kept in the OS layer. */
  it('keeps OS variables that only a process layer defines', async () => {
    const { layers } = await build({}, { INJECTED: 'os', UNRELATED: 'z' });
    expect(layers.find((l) => l.id === 'envOs')?.entries.map((e) => e.key)).toEqual(['INJECTED']);
  });

  /** Validates that the hook's diagnostics and watch paths come before those of the env files. */
  it('reports hook diagnostics and watch paths before the file ones', async () => {
    const { diagnostics, watchPaths } = await build({ '.env': 'bare\n' }, {});
    expect(diagnostics[0].message).toBe('from hook');
    expect(diagnostics.length).toBeGreaterThan(1);
    expect(watchPaths[0]).toBe('/stub/hook.json');
    expect(watchPaths.length).toBeGreaterThan(1);
  });
});
