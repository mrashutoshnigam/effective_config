import { describe, it, expect } from 'vitest';
import { VarMap, type DotenvProviderOptions, type ProcessEnvironment } from '../../src/sources/dotenvProviderBase';
import type { Diagnostic } from '../../src/engine/types';
import type { ProjectInfo } from '../../src/provider';
import { mergeLayers } from '../../src/engine/merge';
import { STUB_DIR as DIR, STUB_PROJECT as PROJECT, StubProvider, memFs, stubOptions } from './support/stubProvider';

/** Builds a stub provider over in-memory files; `options` override the defaults. */
function make(files: Record<string, string>, options: Partial<DotenvProviderOptions> = {}): StubProvider {
  return new StubProvider(stubOptions(memFs(files), options));
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
    /** Reads the expanded `URL` value with the given precedence setting. */
    const urlOf = async (fileOverridesOs: boolean): Promise<string | null | undefined> => {
      const build = await make(files, { osEnv, fileOverridesOs }).buildLayers(PROJECT, { environment: 'dev' });
      return build.layers.find((l) => l.id === '.env')?.entries.find((e) => e.key === 'URL')?.value;
    };
    expect(await urlOf(false)).toBe('os');
    expect(await urlOf(true)).toBe('file');
  });

  /** Validates that an empty delimiter keeps keys flat: `DB__HOST` stays one key, and so do its references. */
  it('keeps keys flat when the delimiter is empty', async () => {
    const build = await make({ '.env': 'DB__HOST=h\nURL=${DB__HOST}\n' }, { nestedDelimiter: '' }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers[0].entries.map((e) => e.key)).toEqual(['DB__HOST', 'URL']);
    expect(build.layers[0].entries[1].references).toEqual(['DB__HOST']);
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

  /** Validates that an empty prefix selects nothing, rather than matching every OS variable. */
  it('ignores an empty prefix', async () => {
    const build = await make(files, { osEnv: { UNRELATED: 'z' }, envPrefixes: [''] }).buildLayers(PROJECT, { environment: 'dev' });
    expect(build.layers.map((l) => l.id)).toEqual(['.env']);
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
    new ProcessLayerProvider(stubOptions(memFs(files), { osEnv, envFiles: ['.env'], fileOverridesOs }))
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

/** Provider that reads one extra env file through the base, as a launch configuration's `envFile` would. */
class ExtraFileProvider extends StubProvider {
  /** @inheritdoc */
  protected override async readProcessEnvironment(): Promise<ProcessEnvironment> {
    const vars = this.osVars();
    const diagnostics: Diagnostic[] = [];
    const read = await this.readExpandedFile(`${DIR}/extra.env`, vars);
    if (read) {
      vars.merge(read.vars);
    } else {
      diagnostics.push({ severity: 'warning', message: 'extra.env missing' });
    }
    return { vars, layers: [], diagnostics, watchPaths: [] };
  }
}

describe('DotenvProviderBase.readExpandedFile', () => {
  /** Builds the extra-file provider over the given files and OS variables. */
  const build = (files: Record<string, string>, osEnv: Record<string, string> = {}) =>
    new ExtraFileProvider(stubOptions(memFs(files), { osEnv })).buildLayers(PROJECT, { environment: 'dev' });

  /** Validates the error path: a missing file yields undefined, so the caller can report it. */
  it('returns undefined for a missing file', async () => {
    const { diagnostics } = await build({});
    expect(diagnostics.map((d) => d.message)).toEqual(['extra.env missing']);
  });

  /** Validates expansion order inside one file: the base (`HOST` from the OS) beats the file's own earlier `HOST`. */
  it('expands against the base first, then the earlier entries of the file', async () => {
    const files = { 'extra.env': 'HOST=own\nPORT=1\nA=${HOST}:${PORT}\n', '.env': 'OUT=${A}\n' };
    const { layers } = await build(files, { HOST: 'os' });
    expect(layers.find((l) => l.id === '.env')?.entries[0].value).toBe('os:1');
  });
});

/** Provider with a higher-priority variable source, as a launch profile would supply. */
class OverrideProvider extends StubProvider {
  /** Detects the environment with `{ ENV: 'override' }` ranked above the files and the OS. */
  detect(files: string[]): Promise<string> {
    return this.detectEnvironment(PROJECT, files, [VarMap.from({ ENV: 'override' })]);
  }
}

describe('DotenvProviderBase environment detection', () => {
  /** Reads the default selection's environment for the given files and OS variables. */
  const detected = async (files: Record<string, string>, osEnv: Record<string, string> = {}): Promise<string> =>
    (await make(files, { osEnv }).describe(PROJECT)).defaultSelection.environment;

  /** Validates source priority: `.env` beats the OS even for a lower-priority variable name. */
  it('prefers .env over the OS', async () => {
    expect(await detected({ '.env': 'ENV=fromfile\n' }, { APP_ENV: 'fromos' })).toBe('fromfile');
  });

  /** Validates the fallback to the OS when `.env` names no environment. */
  it('falls back to the OS', async () => {
    expect(await detected({ '.env': 'A=1\n' }, { ENV: 'fromos' })).toBe('fromos');
  });

  /** Validates name priority inside one source, and that a blank value does not count. */
  it('honours variable order and skips blank values', async () => {
    expect(await detected({ '.env': 'ENV=second\nAPP_ENV=first\n' })).toBe('first');
    expect(await detected({ '.env': 'APP_ENV="  "\nENV=second\n' })).toBe('second');
  });

  /** Validates the default when no source names an environment. */
  it('defaults to development', async () => {
    expect(await detected({})).toBe('development');
  });

  /** Validates that sources a subclass passes in rank above `.env` and the OS. */
  it('ranks subclass sources above .env and the OS', async () => {
    const provider = new OverrideProvider(stubOptions(memFs({ '.env': 'APP_ENV=fromfile\n' }), { osEnv: { APP_ENV: 'fromos' } }));
    expect(await provider.detect(['.env'])).toBe('override');
  });

  /** Validates the shared helpers a subclass uses to describe a project: environment names from `.env.*` files, and watch globs. */
  it('lists environments from .env.* files and watches them', async () => {
    const description = await make({ '.env': '', '.env.qa': '' }).describe(PROJECT);
    expect(description.environments).toEqual(['development', 'staging', 'production', 'qa']);
    expect(description.watchGlobs).toEqual(['.env', '.env.*']);
  });
});

describe('VarMap', () => {
  /** Validates case-insensitive reads from a store built with `from`. */
  it('compares names ignoring case', () => {
    expect(VarMap.from({ Host: 'h' }).get('HOST')).toBe('h');
  });

  /** Validates `merge`: the other store's values replace same-named ones, whatever their case, and the rest stay. */
  it('merges another store over its own values', () => {
    const vars = VarMap.from({ a: '1', b: '2' });
    vars.merge(VarMap.from({ B: 'new' }));
    expect([vars.get('a'), vars.get('b')]).toEqual(['1', 'new']);
  });
});
