import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { PythonProvider, type PythonProviderOptions } from '../../src/python/pythonProvider';
import { DEFAULT_ENV_FILES, DEFAULT_ENV_NAME_VARIABLES } from '../../src/python/environments';
import { nodeFileSystem, type FileSystem } from '../../src/dotnet/fileSystem';
import { mergeLayers } from '../../src/engine/merge';
import type { ProjectInfo } from '../../src/provider';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PYAPP = path.join(FIXTURES, 'PyApp');
const project = (dir = PYAPP, name = 'PyApp'): ProjectInfo => ({
  id: path.join(dir, 'pyproject.toml'), name, dir, projectFile: path.join(dir, 'pyproject.toml'), kind: 'python',
});

/** Real fixture files with in-memory overlay content and overridden directory listings. */
const overlayFs = (overlay: Record<string, string> = {}, dirs: Record<string, string[]> = {}): FileSystem => ({
  readFile: async (p) => overlay[p] ?? nodeFileSystem.readFile(p),
  listDir: async (d) => dirs[d] ?? nodeFileSystem.listDir(d),
});

/** Provider with default settings against the PyApp fixture; `options` override defaults. */
const make = (options: Partial<PythonProviderOptions> = {}): PythonProvider =>
  new PythonProvider({
    fs: nodeFileSystem, osEnv: {}, workspaceRoot: FIXTURES, envFiles: DEFAULT_ENV_FILES, fileOverridesOs: false,
    envPrefixes: [], nestedDelimiter: '__', environmentVariables: DEFAULT_ENV_NAME_VARIABLES, ...options,
  });

const DEV = { profile: 'PyApp: dev', environment: 'development' };
const NO_PROFILE = { environment: 'development' };
const LAUNCH = path.join(PYAPP, '.vscode', 'launch.json');

describe('PythonProvider.describe', () => {
  it('lists profiles, per-profile environments and preselects the first profile — PyApp', async () => {
    const d = await make().describe(project());
    expect(d.profiles).toEqual(['PyApp: dev', 'PyApp: prod']);
    expect(d.profileEnvironments).toEqual({ 'PyApp: dev': 'development', 'PyApp: prod': 'production' });
    expect(d.defaultSelection).toEqual({ profile: 'PyApp: dev', environment: 'development' });
    expect(d.environments).toEqual(['development', 'staging', 'production', 'profile']); // 'profile' comes from the .env.profile fixture file
    expect(d.watchGlobs).toEqual(['.env', '.env.*']);
    expect(d.envVarSeparator).toBe('__');
    expect(d.mergeLabel).toBe('Simulated — python-dotenv order (OS variables win)');
  });

  it('uses the files-override label when fileOverridesOs is set', async () => {
    const d = await make({ fileOverridesOs: true }).describe(project());
    expect(d.mergeLabel).toBe('Simulated — python-dotenv order (files override OS)');
  });

  it("falls back to '__' separator when nestedDelimiter is empty", async () => {
    expect((await make({ nestedDelimiter: '' }).describe(project())).envVarSeparator).toBe('__');
  });

  it('profile env sets environment — profileEnvironments value from APP_ENV', async () => {
    const d = await make().describe(project());
    expect(d.profileEnvironments['PyApp: prod']).toBe('production');
  });

  it('falls back to profile envFile, then .env, then OS, then development for the environment name', async () => {
    const dir = path.join(FIXTURES, 'Synthetic');
    const launch = path.join(dir, '.vscode', 'launch.json');
    const cfg = (extra: string): string => `{"configurations":[{"name":"p","type":"python",${extra}"env":{}}]}`;
    const prov = (launchText: string, dotenv: string | undefined, osEnv: Record<string, string> = {}): PythonProvider =>
      make({
        fs: overlayFs({
          [launch]: launchText,
          [path.join(dir, 'prof.env')]: 'ENV=fromprofilefile\n',
          ...(dotenv === undefined ? {} : { [path.join(dir, '.env')]: dotenv }),
        }, { [dir]: ['.env'] }),
        osEnv,
        workspaceRoot: dir,
      });
    const p = project(dir, 'Synthetic');

    const viaFile = await prov(cfg('"envFile":"prof.env",'), 'APP_ENV=fromdotenv\n', { APP_ENV: 'fromos' }).describe(p);
    expect(viaFile.profileEnvironments.p).toBe('fromprofilefile');
    const viaDotenv = await prov(cfg(''), 'ENVIRONMENT=fromdotenv\n', { APP_ENV: 'fromos' }).describe(p);
    expect(viaDotenv.profileEnvironments.p).toBe('fromdotenv');
    const viaOs = await prov(cfg(''), undefined, { PYTHON_ENV: 'fromos' }).describe(p);
    expect(viaOs.profileEnvironments.p).toBe('fromos');
    const none = await prov(cfg(''), undefined).describe(p);
    expect(none.profileEnvironments.p).toBe('development');
  });

  it('without launch.json derives the default environment from .env, then OS, then development', async () => {
    const dir = path.join(FIXTURES, 'Bare');
    const fsWith = (dotenv?: string): FileSystem =>
      overlayFs(dotenv === undefined ? {} : { [path.join(dir, '.env')]: dotenv }, { [dir]: ['.env'] });
    const p = project(dir, 'Bare');
    const a = await make({ workspaceRoot: dir, fs: fsWith('ENV=staging\n'), osEnv: { ENV: 'os' } }).describe(p);
    expect(a.profiles).toEqual([]);
    expect(a.defaultSelection).toEqual({ environment: 'staging' });
    const b = await make({ workspaceRoot: dir, fs: fsWith(), osEnv: { ENV: 'os' } }).describe(p);
    expect(b.defaultSelection).toEqual({ environment: 'os' });
    const c = await make({ workspaceRoot: dir, fs: fsWith() }).describe(p);
    expect(c.defaultSelection).toEqual({ environment: 'development' });
  });

  it('finds launch.json in a parent folder up to the workspace root — none above the root or outside it', async () => {
    const root = path.join(FIXTURES, 'Mono');
    const sub = path.join(root, 'svc');
    const launchText = '{"configurations":[{"name":"up","type":"debugpy","env":{"APP_ENV":"staging"}}]}';
    const fsx = overlayFs({ [path.join(root, '.vscode', 'launch.json')]: launchText });
    const found = await make({ fs: fsx, workspaceRoot: root }).describe(project(sub, 'svc'));
    expect(found.profiles).toEqual(['up']);
    expect(found.profileEnvironments.up).toBe('staging');
    const notFound = await make({ fs: fsx, workspaceRoot: sub }).describe(project(sub, 'svc'));
    expect(notFound.profiles).toEqual([]);
    const outside = await make({ fs: fsx, workspaceRoot: path.join(FIXTURES, 'Other') }).describe(project(sub, 'svc'));
    expect(outside.profiles).toEqual([]);
  });
});

describe('PythonProvider.buildLayers', () => {
  it('development selection layers in order — files, OS, envFile, profile env', async () => {
    const build = await make({ osEnv: { DB_HOST: 'os' } }).buildLayers(project(), DEV);
    expect(build.layers.map((l) => l.id)).toEqual(['.env', '.env.development', '.env.local', 'envOs', 'envFile', 'envProfile']);
    const byId = Object.fromEntries(build.layers.map((l) => [l.id, l]));
    expect(byId.envOs.label).toBe('Environment (OS)');
    expect(byId.envFile.label).toBe('Env file (launch.json: PyApp: dev)');
    expect(byId.envFile.kind).toBe('envFile');
    expect(byId.envFile.filePath).toBe(path.join(PYAPP, '.env.profile'));
    expect(byId.envProfile.label).toBe('Environment (launch.json: PyApp: dev)');
    expect(byId['.env'].kind).toBe('dotenv');
    expect(byId['.env'].label).toBe('.env');
    expect(byId['.env'].filePath).toBe(path.join(PYAPP, '.env'));
  });

  it('default order puts OS above files — OS value wins', async () => {
    const build = await make({ osEnv: { DB_HOST: 'os' } }).buildLayers(project(), NO_PROFILE);
    const host = mergeLayers(build.layers, []).find((e) => e.key === 'DB_HOST');
    expect(host?.value).toBe('os');
    expect(host?.winner.layerId).toBe('envOs');
  });

  it('fileOverridesOs moves files above OS — file wins', async () => {
    const build = await make({ osEnv: { DB_HOST: 'os' }, fileOverridesOs: true }).buildLayers(project(), NO_PROFILE);
    expect(build.layers.map((l) => l.id)).toEqual(['envOs', '.env', '.env.development', '.env.local']);
    const host = mergeLayers(build.layers, []).find((e) => e.key === 'DB_HOST');
    expect(host?.value).toBe('dev-db');
    expect(host?.winner.layerId).toBe('.env.development');
  });

  it('expanded DATABASE_URL references DB_PASSWORD and merges as sensitive', async () => {
    const build = await make().buildLayers(project(), NO_PROFILE);
    const entry = build.layers[0].entries.find((e) => e.key === 'DATABASE_URL');
    expect(entry?.value).toBe('postgres://app:dev-password-placeholder@localhost/app');
    expect(entry?.references).toEqual(['DB_USER', 'DB_PASSWORD', 'DB_HOST']);
    expect(entry?.location).toMatchObject({ filePath: path.join(PYAPP, '.env'), line: 4 });
    const merged = mergeLayers(build.layers, ['*Password*']).find((e) => e.key === 'DATABASE_URL');
    expect(merged?.sensitive).toBe(true);
    expect(merged?.winner.references).toEqual(['DB_USER', 'DB_PASSWORD', 'DB_HOST']);
  });

  it('expansion prefers OS values by default and file values when fileOverridesOs — DB_HOST in DATABASE_URL', async () => {
    const url = async (fileOverridesOs: boolean): Promise<string | null | undefined> => {
      const b = await make({ osEnv: { DB_HOST: 'os-host' }, fileOverridesOs }).buildLayers(project(), NO_PROFILE);
      return b.layers.find((l) => l.id === '.env')?.entries.find((e) => e.key === 'DATABASE_URL')?.value;
    };
    expect(await url(false)).toBe('postgres://app:dev-password-placeholder@os-host/app');
    expect(await url(true)).toBe('postgres://app:dev-password-placeholder@localhost/app');
  });

  it('expansion treats OS, envFile and profile env as one process environment — later source wins', async () => {
    const text = '{"configurations":[{"name":"p","type":"python","env":{"X":"profile"},"envFile":"${workspaceFolder}/PyApp/.env.profile"}]}';
    const fsx = overlayFs({
      [path.join(PYAPP, '.env')]: 'A=${X}-${Y}-${Z}\n',
      [LAUNCH]: text,
      [path.join(PYAPP, '.env.profile')]: 'X=file\nY=file\n',
    });
    const b = await make({ fs: fsx, osEnv: { X: 'os', Y: 'os', Z: 'os' } })
      .buildLayers(project(), { profile: 'p', environment: 'development' });
    expect(b.layers[0].entries[0].value).toBe('profile-file-os');
  });

  it('envFile entries expand against OS then themselves', async () => {
    const text = '{"configurations":[{"name":"p","type":"python","envFile":"${workspaceFolder}/PyApp/.env.profile"}]}';
    const fsx = overlayFs({ [LAUNCH]: text, [path.join(PYAPP, '.env.profile')]: 'BASE=b\nFULL=${BASE}-${HOME_X}\n' });
    const b = await make({ fs: fsx, osEnv: { HOME_X: 'h' } }).buildLayers(project(), { profile: 'p', environment: 'development' });
    const file = b.layers.find((l) => l.id === 'envFile');
    expect(file?.entries.map((e) => [e.key, e.value])).toEqual([['BASE', 'b'], ['FULL', 'b-h']]);
    expect(file?.entries[1].references).toEqual(['BASE', 'HOME_X']);
  });

  it('launch.json with non-python config ignored and missing envFile warns', async () => {
    const text = JSON.stringify({ configurations: [
      { name: 'Node helper', type: 'node', env: { A: '1' } },
      { name: 'py', type: 'python', envFile: '${workspaceFolder}/PyApp/.env.nothere', env: { B: '2' } },
    ] });
    const prov = make({ fs: overlayFs({ [LAUNCH]: text }) });
    expect((await prov.describe(project())).profiles).toEqual(['py']);
    const build = await prov.buildLayers(project(), { profile: 'py', environment: 'development' });
    expect(build.diagnostics).toContainEqual({
      severity: 'warning', message: `envFile not found: ${path.join(PYAPP, '.env.nothere')}`,
    });
    expect(build.layers.map((l) => l.id)).not.toContain('envFile');
    expect(build.layers.map((l) => l.id)).toContain('envProfile');
    expect(build.watchPaths).toContain(path.join(PYAPP, '.env.nothere'));
  });

  it('marks the envFile layer sensitive when its file name contains secret — case-insensitive', async () => {
    const text = '{"configurations":[{"name":"py","type":"python","envFile":"${workspaceFolder}/PyApp/.env.SECRETS"}]}';
    const b = await make({ fs: overlayFs({ [LAUNCH]: text, [path.join(PYAPP, '.env.SECRETS')]: 'K=v\n' }) })
      .buildLayers(project(), { profile: 'py', environment: 'development' });
    expect(b.layers.find((l) => l.id === 'envFile')?.sensitive).toBe(true);
    expect(b.layers.find((l) => l.id === '.env')?.sensitive).toBe(false);
  });

  it('marks a file layer sensitive when its pattern contains secret', async () => {
    const b = await make({
      envFiles: ['.env', '.env.secrets'],
      fs: overlayFs({ [path.join(PYAPP, '.env.secrets')]: 'S=1\n' }, { [PYAPP]: ['.env', '.env.secrets'] }),
    }).buildLayers(project(), NO_PROFILE);
    expect(b.layers.map((l) => [l.id, l.sensitive])).toEqual([['.env', false], ['.env.secrets', true]]);
  });

  it("nestedDelimiter '' keeps keys flat", async () => {
    const b = await make({ nestedDelimiter: '', osEnv: { LOG__LEVEL: 'os' } }).buildLayers(project(), NO_PROFILE);
    expect(b.layers[0].entries.map((e) => e.key)).toContain('LOG__LEVEL');
    expect(b.layers.find((l) => l.id === 'envOs')?.entries).toEqual([{ key: 'LOG__LEVEL', value: 'os' }]);
  });

  it("nestedDelimiter '__' splits names into key segments — LOG__LEVEL becomes LOG:LEVEL", async () => {
    const b = await make().buildLayers(project(), DEV);
    expect(b.layers.find((l) => l.id === 'envProfile')?.entries.map((e) => e.key)).toEqual(['APP_ENV', 'LOG:LEVEL']);
    expect(b.layers.find((l) => l.id === 'envFile')?.entries.map((e) => e.key)).toEqual(['API_TOKEN', 'CACHE_TTL']);
  });

  it('.env.example never loaded — its values do not appear and it is not watched', async () => {
    const b = await make().buildLayers(project(), NO_PROFILE);
    expect(b.layers.map((l) => l.id)).not.toContain('.env.example');
    const all = b.layers.flatMap((l) => l.entries.map((e) => e.value));
    expect(all).not.toContain('example-should-never-load');
    expect(b.watchPaths).not.toContain(path.join(PYAPP, '.env.example'));
  });

  it('OS var not in any layer is filtered out — only matching variables remain', async () => {
    const b = await make({ osEnv: { UNRELATED_VAR: 'x', db_host: 'os', CACHE_TTL: 'ttl' } }).buildLayers(project(), DEV);
    expect(b.layers.find((l) => l.id === 'envOs')?.entries.map((e) => e.key)).toEqual(['db_host', 'CACHE_TTL']);
  });

  it('OS var matching a nested file key is kept — log__level matches LOG:LEVEL case-insensitively', async () => {
    const b = await make({ osEnv: { log__level: 'os' } }).buildLayers(project(), NO_PROFILE);
    expect(b.layers.find((l) => l.id === 'envOs')?.entries).toEqual([{ key: 'log:level', value: 'os' }]);
  });

  it('OS var matching envPrefixes kept — case-insensitive prefix', async () => {
    const b = await make({ osEnv: { MYAPP_THING: 'x', Other: 'y' }, envPrefixes: ['myapp_'] }).buildLayers(project(), NO_PROFILE);
    expect(b.layers.find((l) => l.id === 'envOs')?.entries.map((e) => e.key)).toEqual(['MYAPP_THING']);
  });

  it('omits the OS layer when no OS variable is relevant', async () => {
    const b = await make({ osEnv: { UNRELATED: 'x' } }).buildLayers(project(), NO_PROFILE);
    expect(b.layers.map((l) => l.id)).not.toContain('envOs');
  });

  it('unknown selected profile warns and proceeds without profile layers', async () => {
    const b = await make().buildLayers(project(), { profile: 'nope', environment: 'development' });
    expect(b.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', message: expect.stringContaining("'nope'"),
    }));
    expect(b.layers.map((l) => l.id)).toEqual(['.env', '.env.development', '.env.local']);
  });

  it('passes parser diagnostics through — bare key reports info with location', async () => {
    const b = await make({ fs: overlayFs({ [path.join(PYAPP, '.env')]: 'BARE\nA=1\n' }) }).buildLayers(project(), NO_PROFILE);
    expect(b.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info', location: expect.objectContaining({ filePath: path.join(PYAPP, '.env'), line: 0 }),
    }));
    expect(b.layers[0].entries.map((e) => e.key)).toEqual(['A']);
  });

  it('single-quoted value is not expanded and has no references', async () => {
    const b = await make({ fs: overlayFs({ [path.join(PYAPP, '.env')]: "A='${DB_HOST}'\n" }) }).buildLayers(project(), NO_PROFILE);
    expect(b.layers[0].entries[0]).toMatchObject({ key: 'A', value: '${DB_HOST}' });
    expect(b.layers[0].entries[0].references).toBeUndefined();
  });

  it('watchPaths include candidate env files, launch.json, envFile and the project file', async () => {
    const b = await make().buildLayers(project(), DEV);
    expect(b.watchPaths).toEqual(expect.arrayContaining([
      path.join(PYAPP, '.env'), path.join(PYAPP, '.env.development'), path.join(PYAPP, '.env.local'),
      path.join(PYAPP, '.env.development.local'), LAUNCH,
      path.join(PYAPP, '.env.profile'), path.join(PYAPP, 'pyproject.toml'),
    ]));
  });

  it('watchPaths include the default launch.json location when none exists', async () => {
    const dir = path.join(FIXTURES, 'Bare');
    const b = await make({ fs: overlayFs({}, { [dir]: [] }), workspaceRoot: dir }).buildLayers(project(dir, 'Bare'), NO_PROFILE);
    expect(b.watchPaths).toContain(path.join(dir, '.vscode', 'launch.json'));
  });
});
