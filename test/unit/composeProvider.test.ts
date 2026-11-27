import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ComposeProvider, type ComposeProviderOptions } from '../../src/compose/composeProvider';
import { mergeLayers } from '../../src/engine/merge';
import type { LayerBuild, ProjectInfo, Selection } from '../../src/provider';
import { memoryFs } from './support/memoryFs';

/** Project directory of the in-memory fixture. */
const DIR = path.join('/p');

/** The in-memory copy of `test/fixtures/ComposeApp`. */
const FIXTURE: Record<string, string> = {
  '/p/compose.yaml': [
    'services:',
    '  api:',
    '    image: example/api:${IMAGE_TAG:-latest}',
    '    env_file: app.env',
    '    environment:',
    '      LOG_LEVEL: info',
    '      VERSION: ${IMAGE_TAG:-latest}',
    '      DB_PASSWORD: ${DB_PASSWORD}',
    '      HOME_DIR:',
    '  worker:',
    '    image: img:${WORKER_TAG:?set WORKER_TAG}',
    '    profiles: [jobs]',
    '',
  ].join('\n'),
  '/p/compose.override.yaml': 'services:\n  api:\n    environment:\n      - LOG_LEVEL=debug\n',
  '/p/app.env': 'LOG_LEVEL=warn\nFROM_FILE=yes\n',
  '/p/.env': 'IMAGE_TAG=1.2\nDB_PASSWORD=hunter2\n',
  '/p/.env.prod': 'IMAGE_TAG=2.0\n',
};

/** The Compose project of the fixture. */
const PROJECT: ProjectInfo = { id: path.join(DIR, 'compose.yaml'), name: 'p', dir: DIR, projectFile: path.join(DIR, 'compose.yaml'), kind: 'compose' };

/**
 * Builds a provider over the fixture.
 * @param files Files replacing or adding to the fixture; an empty string still counts as a file.
 * @param options Options replacing the defaults.
 * @returns The provider.
 */
const make = (files: Record<string, string> = {}, options: Partial<ComposeProviderOptions> = {}): ComposeProvider =>
  new ComposeProvider({ fs: memoryFs({ ...FIXTURE, ...files }), osEnv: {}, files: [], platform: 'linux', ...options });

/**
 * Builds the layers of a selection and merges them.
 * @param provider The provider.
 * @param selection Service and env file.
 * @returns The build and the merged entries by key.
 */
const build = async (provider: ComposeProvider, selection: Selection): Promise<{ build: LayerBuild; byKey: Map<string, ReturnType<typeof mergeLayers>[number]> }> => {
  const result = await provider.buildLayers(PROJECT, selection);
  return { build: result, byKey: new Map(mergeLayers(result.layers, ['*Password*']).map((e) => [e.key, e])) };
};

describe('ComposeProvider.describe', () => {
  /**
   * Validates the pickers: services act as profiles and env files as environments. Expected: services
   * in source order, the env files of the directory with `.env` first, `api` and `.env` preselected,
   * the merge label and the watch globs.
   */
  it('describes services and env files', async () => {
    const d = await make().describe(PROJECT);
    expect(d.profiles).toEqual(['api', 'worker']);
    expect(d.environments).toEqual(['.env', '.env.prod', 'app.env']);
    expect(d.defaultSelection).toEqual({ profile: 'api', environment: '.env' });
    expect(d.profileEnvironments).toEqual({});
    expect(d.envVarSeparator).toBe('__');
    expect(d.mergeLabel).toBe('Simulated — docker compose (environment: over env_file, OS variables win in interpolation)');
    expect(d.watchGlobs).toEqual([
      'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml',
      'compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml',
      '.env', '.env.*', '*.env',
    ]);
  });

  /**
   * Validates `COMPOSE_ENV_FILES` from the shell. Expected: its first listed file is preselected when
   * the dropdown offers it; otherwise `.env`.
   */
  it('preselects the first COMPOSE_ENV_FILES entry when it is listed', async () => {
    expect((await make({}, { osEnv: { COMPOSE_ENV_FILES: ' .env.prod ,.env' } }).describe(PROJECT)).defaultSelection.environment).toBe('.env.prod');
    expect((await make({}, { osEnv: { COMPOSE_ENV_FILES: 'nope.env' } }).describe(PROJECT)).defaultSelection.environment).toBe('.env');
  });

  /**
   * Validates other spellings of a `COMPOSE_ENV_FILES` entry naming a dropdown file. Expected: `./.env.prod`
   * and the absolute path of `.env.prod` preselect `.env.prod`; the same name in another folder does not.
   */
  it('normalises the COMPOSE_ENV_FILES entry before matching the dropdown', async () => {
    /**
     * Describes the fixture with `COMPOSE_ENV_FILES` set.
     * @param value The variable's value.
     * @returns The preselected env file.
     */
    const preselected = async (value: string): Promise<string> =>
      (await make({}, { osEnv: { COMPOSE_ENV_FILES: value } }).describe(PROJECT)).defaultSelection.environment;
    expect(await preselected('./.env.prod')).toBe('.env.prod');
    expect(await preselected(path.join(DIR, '.env.prod'))).toBe('.env.prod');
    expect(await preselected('../q/.env.prod')).toBe('.env');
  });
});

describe('ComposeProvider project directory', () => {
  /** A compose project in another folder, with its own env files. */
  const OTHER: Record<string, string> = {
    '/other/compose.yaml': 'services:\n  web:\n    environment:\n      TAG: ${IMAGE_TAG}\n',
    '/other/.env': 'IMAGE_TAG=9\n',
    '/other/.env.stage': 'IMAGE_TAG=stage\n',
  };

  /**
   * Validates `effectiveConfig.compose.files` naming a file in another folder, which acts like `-f`:
   * Compose's project directory is then that file's folder. Expected: the dropdown lists that folder's
   * env files, `.env` is read from there, and its env files are watched.
   */
  it('reads env files from the folder of the first compose.files entry', async () => {
    const provider = make(OTHER, { files: ['../other/compose.yaml'] });
    const d = await provider.describe(PROJECT);
    expect(d.environments).toEqual(['.env', '.env.stage']);
    expect(d.profiles).toEqual(['web']);
    const { build: b, byKey } = await build(provider, { profile: 'web', environment: '.env.stage' });
    expect(byKey.get('TAG')?.value).toBe('stage');
    expect(b.watchPaths).toContain(path.join('/other', '.env'));
    expect(b.watchPaths).toContain(path.join('/other', '.env.stage'));
  });

  /**
   * Validates `COMPOSE_FILE` read from the env file, which cannot move the env file it came from:
   * compose-go locates the default `.env` before applying `COMPOSE_FILE`. Expected: the dropdown and the
   * scope stay in the primary file's folder while the services come from the other folder.
   */
  it('keeps the env file in the primary folder when COMPOSE_FILE points elsewhere', async () => {
    const provider = make({ ...OTHER, '/p/.env': 'IMAGE_TAG=p\nCOMPOSE_FILE=../other/compose.yaml\n' });
    expect((await provider.describe(PROJECT)).environments).toEqual(['.env', '.env.prod', 'app.env']);
    const { byKey } = await build(provider, { profile: 'web', environment: '.env' });
    expect(byKey.get('TAG')?.value).toBe('p');
  });
});

describe('ComposeProvider.buildLayers', () => {
  /**
   * Validates the container precedence: env files below `environment`, base file below override.
   * Expected: layer labels and kinds in that order.
   */
  it('orders env_file layers below environment layers, base first', async () => {
    const { build: b } = await build(make(), { profile: 'api', environment: '.env' });
    expect(b.layers.map((l) => [l.label, l.kind])).toEqual([
      ['app.env', 'composeEnvFile'],
      ['environment (compose.yaml)', 'composeEnvironment'],
      ['environment (compose.override.yaml)', 'composeEnvironment'],
    ]);
  });

  /**
   * Validates the override chain the acceptance criteria ask for. Expected: LOG_LEVEL `debug` won by the
   * override's environment over the base environment and `app.env`; VERSION interpolated from `.env`;
   * FROM_FILE from `app.env`; DB_PASSWORD masked.
   */
  it('shows the winner and override chain per variable', async () => {
    const { byKey } = await build(make(), { profile: 'api', environment: '.env' });
    const log = byKey.get('LOG_LEVEL');
    expect(log?.value).toBe('debug');
    expect(log?.winner.layerLabel).toBe('environment (compose.override.yaml)');
    expect(log?.overridden.map((o) => o.layerLabel)).toEqual(['app.env', 'environment (compose.yaml)']);
    expect(byKey.get('VERSION')?.value).toBe('1.2');
    expect(byKey.get('FROM_FILE')?.winner.layerLabel).toBe('app.env');
    expect(byKey.get('DB_PASSWORD')?.sensitive).toBe(true);
  });

  /**
   * Validates the env-file dropdown as `--env-file`. Expected: `.env.prod` changes the IMAGE_TAG used
   * for VERSION.
   */
  it('interpolates against the selected env file', async () => {
    const { byKey } = await build(make(), { profile: 'api', environment: '.env.prod' });
    expect(byKey.get('VERSION')?.value).toBe('2.0');
  });

  /**
   * Validates the second acceptance criterion: a missing `:?` variable in any loaded file is an error,
   * even for a service not selected. Expected: the error with the author's message at its line, and no
   * diagnostic quoting a value.
   */
  it('reports a missing required variable from any service', async () => {
    const { build: b } = await build(make(), { profile: 'api', environment: '.env' });
    expect(b.diagnostics).toContainEqual({
      severity: 'error',
      message: 'required variable WORKER_TAG is missing a value: set WORKER_TAG',
      location: { filePath: path.join(DIR, 'compose.yaml'), line: 10, column: 11 },
    });
    expect(JSON.stringify(b.diagnostics)).not.toContain('hunter2');
  });

  /**
   * Validates that a value-less variable takes the shell value (Review Focus 1). Expected: HOME_DIR
   * gets the OS value, won by the environment layer, for both the map form and a bare list item.
   */
  it('passes a value-less variable through from the shell', async () => {
    const osEnv = { HOME_DIR: '/home/u' };
    const map = await build(make({}, { osEnv }), { profile: 'api', environment: '.env' });
    expect(map.byKey.get('HOME_DIR')?.value).toBe('/home/u');
    expect(map.byKey.get('HOME_DIR')?.winner.layerLabel).toBe('environment (compose.yaml)');

    const list = await build(make({ '/p/compose.override.yaml': 'services:\n  api:\n    environment:\n      - SHELL_ONLY\n' }, { osEnv: { SHELL_ONLY: 'x' } }), { profile: 'api', environment: '.env' });
    expect(list.byKey.get('SHELL_ONLY')?.value).toBe('x');
    expect(list.byKey.get('SHELL_ONLY')?.winner.layerLabel).toBe('environment (compose.override.yaml)');
  });

  /**
   * Validates a value-less variable the scope does not define. Expected: no entry, as Compose leaves it
   * unset in the container, and an info naming it.
   */
  it('leaves a value-less variable unset when neither the shell nor the env file has it', async () => {
    const { build: b, byKey } = await build(make(), { profile: 'api', environment: '.env' });
    expect(byKey.has('HOME_DIR')).toBe(false);
    expect(b.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info',
      message: 'HOME_DIR is not set in the shell or the env file; Compose leaves it unset',
    }));
  });

  /**
   * Validates a selected service the loaded files do not define, e.g. after `COMPOSE_FILE` changed.
   * Expected: one error naming it and no layers.
   */
  it('reports a service missing from the loaded files', async () => {
    const { build: b } = await build(make(), { profile: 'web', environment: '.env' });
    expect(b.layers).toEqual([]);
    expect(b.diagnostics).toContainEqual({ severity: 'error', message: "service 'web' is not defined in the loaded compose files" });
  });

  /**
   * Validates profile gating, which never changes values. Expected: an info naming the needed and active
   * profiles when none is active, and no info once `COMPOSE_PROFILES` activates `jobs`.
   */
  it('notes a service gated by an inactive profile', async () => {
    const note = "service 'worker' starts only with profile(s) jobs; active: none";
    const off = await build(make(), { profile: 'worker', environment: '.env' });
    expect(off.build.diagnostics).toContainEqual({ severity: 'info', message: note });
    const on = await build(make({}, { osEnv: { COMPOSE_PROFILES: 'jobs', WORKER_TAG: '1' } }), { profile: 'worker', environment: '.env' });
    expect(on.build.diagnostics.map((d) => d.message)).not.toContain(note);
  });

  /**
   * Validates missing env files. Expected: an info for `required: false`, which Compose silently skips,
   * and an error for a required one; neither gives a layer.
   */
  it('reports missing optional and required env files', async () => {
    const compose = 'services:\n  api:\n    env_file:\n      - path: opt.env\n        required: false\n      - must.env\n';
    const { build: b } = await build(make({ '/p/compose.yaml': compose, '/p/compose.override.yaml': 'services: {}\n' }), { profile: 'api', environment: '.env' });
    expect(b.layers).toEqual([]);
    expect(b.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', message: 'env file not found: opt.env' }));
    expect(b.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', message: 'env file not found: must.env' }));
  });

  /**
   * Validates references, which keep a value built from a secret masked. Expected: the DB_PASSWORD entry
   * of the base environment names DB_PASSWORD.
   */
  it('records the variables an entry was interpolated from', async () => {
    const { build: b } = await build(make(), { profile: 'api', environment: '.env' });
    const entry = b.layers[1].entries.find((e) => e.key === 'DB_PASSWORD');
    expect(entry?.references).toEqual(['DB_PASSWORD']);
    expect(entry?.location).toEqual({ filePath: path.join(DIR, 'compose.yaml'), line: 7, column: 19 });
  });

  /**
   * Validates env file values, which Compose v2 interpolates against the scope. Expected: an `app.env`
   * line using `${IMAGE_TAG}` gets the `.env` value.
   */
  it('interpolates env_file values against the scope', async () => {
    const { byKey } = await build(make({ '/p/app.env': 'TAG_COPY=${IMAGE_TAG}\n' }), { profile: 'api', environment: '.env' });
    expect(byKey.get('TAG_COPY')?.value).toBe('1.2');
  });

  /**
   * Validates the lookup order inside env_file values, taken from compose-go's `resolveEnvironment`
   * (types/project.go) and `dotenv.expandVariables`: the project scope first, then the service's merged
   * `environment`, then the values of earlier env_files and earlier lines. Expected: `${IMAGE_TAG}` gets
   * the `.env` value over the service's; `${LOG_LEVEL}` gets the override's `debug` over app.env's
   * `warn`; `${FIRST}` gets the earlier env_file's value.
   */
  it('looks up env_file values in the scope, then environment, then earlier env_files', async () => {
    const compose = [
      'services:',
      '  api:',
      '    env_file: [app.env, b.env]',
      '    environment:',
      '      IMAGE_TAG: svc',
      '      LOG_LEVEL: info',
      '',
    ].join('\n');
    const files = {
      '/p/compose.yaml': compose,
      '/p/app.env': 'LOG_LEVEL=warn\nFIRST=one\n',
      '/p/b.env': 'T=${IMAGE_TAG}\nL=${LOG_LEVEL}\nF=${FIRST}\n',
    };
    const { byKey } = await build(make(files), { profile: 'api', environment: '.env' });
    expect(byKey.get('T')?.value).toBe('1.2');
    expect(byKey.get('L')?.value).toBe('debug');
    expect(byKey.get('F')?.value).toBe('one');
  });

  /**
   * Validates rebuild triggers. Expected: the compose files, the dropdown's env files and every
   * `env_file` path are watched.
   */
  it('watches compose files, env files and env_file paths', async () => {
    const { build: b } = await build(make(), { profile: 'api', environment: '.env' });
    for (const name of ['compose.yaml', 'compose.override.yaml', 'docker-compose.yml', '.env', '.env.prod', 'app.env']) {
      expect(b.watchPaths).toContain(path.join(DIR, name));
    }
  });

  /**
   * Validates that a `COMPOSE_FILE` entry that does not exist yet is watched, so creating it rebuilds
   * the panel. Expected: both listed paths are watched, the missing one included.
   */
  it('watches COMPOSE_FILE entries that do not exist', async () => {
    const { build: b } = await build(make({ '/p/.env': 'COMPOSE_FILE=compose.yaml:sub/later.yaml\n' }), { profile: 'api', environment: '.env' });
    expect(b.watchPaths).toContain(path.join(DIR, 'compose.yaml'));
    expect(b.watchPaths).toContain(path.join(DIR, 'sub', 'later.yaml'));
  });
});
