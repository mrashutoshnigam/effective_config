import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { DotnetProvider } from '../../src/dotnet/dotnetProvider';
import { DEFAULT_JSON_LAYERS } from '../../src/dotnet/environments';
import { nodeFileSystem, type FileSystem } from '../../src/dotnet/fileSystem';
import type { ProjectInfo } from '../../src/provider';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const project = (name: string): ProjectInfo => {
  const dir = path.join(FIXTURES, name);
  return { id: name, name, dir, projectFile: path.join(dir, `${name}.csproj`), kind: 'dotnet' };
};

const SECRETS_PATH = 'C:\\A\\Microsoft\\UserSecrets\\test-webapp-0001\\secrets.json';

/** Real fixture files plus an in-memory overlay (for the user secrets file). */
const overlayFs = (overlay: Record<string, string>): FileSystem => ({
  readFile: async (p) => overlay[p] ?? nodeFileSystem.readFile(p),
  listDir: (d) => nodeFileSystem.listDir(d),
});

/** Provider on a simulated Windows host with APPDATA=C:\A; `osEnv` is merged over it. */
const make = (overlay: Record<string, string> = {}, osEnv: Record<string, string> = {}): DotnetProvider =>
  new DotnetProvider({
    fs: overlayFs(overlay),
    osEnv: { APPDATA: 'C:\\A', ...osEnv },
    platform: 'win32',
    homeDir: 'C:\\H',
    jsonLayers: DEFAULT_JSON_LAYERS,
  });

/** OS var matching the top-level key "Logging" so the envOs layer is present. */
const LOGGING_OS = { Logging__LogLevel__Default: 'Critical' };

describe('DotnetProvider.buildLayers', () => {
  it('Development selection yields layers in agreed order — 7 layers ending with command line', async () => {
    const build = await make({ [SECRETS_PATH]: '{"Api":{"Url":"x"}}' }, LOGGING_OS)
      .buildLayers(project('WebApp'), { profile: 'WebApp', environment: 'Development' });
    expect(build.layers.map((l) => l.id)).toEqual([
      'appsettings.json', 'appsettings.Development.json', 'appsettings.secrets.json',
      'userSecrets', 'envOs', 'envProfile', 'commandLine',
    ]);
    const byId = Object.fromEntries(build.layers.map((l) => [l.id, l]));
    expect(byId.userSecrets.label).toBe('User Secrets');
    expect(byId.envOs.label).toBe('Environment (OS)');
    expect(byId.envProfile.label).toBe('Environment (launchSettings: WebApp)');
    expect(byId.commandLine.label).toBe('Command line (WebApp)');
    expect(byId.commandLine.entries).toEqual([{ key: 'Feature:Enabled', value: 'true' }]);
    expect(byId.envProfile.entries.map((e) => e.key)).toContain('Logging:LogLevel:Default');
  });

  it('Staging selection skips user secrets and matches lower-case staging file — warns about case sensitivity', async () => {
    const build = await make({ [SECRETS_PATH]: '{"A":"b"}' }, LOGGING_OS)
      .buildLayers(project('WebApp'), { profile: 'Staging', environment: 'Staging' });
    const ids = build.layers.map((l) => l.id);
    expect(ids).not.toContain('userSecrets');
    expect(ids).toContain('appsettings.staging.json');
    expect(build.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', message: expect.stringContaining('case-sensitive'),
    }));
  });

  it('marks the secrets JSON layer and the user secrets layer sensitive — other layers are not', async () => {
    const build = await make({ [SECRETS_PATH]: '{"A":"b"}' }, LOGGING_OS)
      .buildLayers(project('WebApp'), { profile: 'WebApp', environment: 'Development' });
    const sens = Object.fromEntries(build.layers.map((l) => [l.id, l.sensitive]));
    expect(sens).toEqual({
      'appsettings.json': false, 'appsettings.Development.json': false, 'appsettings.secrets.json': true,
      userSecrets: true, envOs: false, envProfile: false, commandLine: false,
    });
  });

  it('silently skips missing appsettings.secrets.json — Worker has one layer and no diagnostics', async () => {
    const build = await make().buildLayers(project('Worker'), { environment: 'Development' });
    expect(build.layers.map((l) => l.id)).toEqual(['appsettings.json']);
    expect(build.diagnostics).toEqual([]);
  });

  it('records absolute file paths in JSON layer entry locations', async () => {
    const build = await make().buildLayers(project('Worker'), { environment: 'Development' });
    const p = path.join(project('Worker').dir, 'appsettings.json');
    expect(build.layers[0].filePath).toBe(p);
    expect(build.layers[0].entries[0].location?.filePath).toBe(p);
  });

  it('adds an info diagnostic and no layer when the user secrets file is missing', async () => {
    const build = await make().buildLayers(project('WebApp'), { environment: 'Development' });
    expect(build.layers.map((l) => l.id)).not.toContain('userSecrets');
    expect(build.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', message: expect.stringContaining('test-webapp-0001') }));
  });

  it('matches environment Development case-insensitively for user secrets', async () => {
    const build = await make({ [SECRETS_PATH]: '{"A":"b"}' }).buildLayers(project('WebApp'), { environment: 'development' });
    expect(build.layers.map((l) => l.id)).toContain('userSecrets');
  });

  it('skips user secrets for a project without UserSecretsId — Worker, no diagnostics', async () => {
    const build = await make().buildLayers(project('Worker'), { environment: 'Development' });
    expect(build.layers.map((l) => l.id)).not.toContain('userSecrets');
  });

  it('warns and proceeds without a profile when the selected profile is not in launchSettings', async () => {
    const build = await make().buildLayers(project('WebApp'), { profile: 'Nope', environment: 'Production' });
    expect(build.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('Nope') }));
    const ids = build.layers.map((l) => l.id);
    expect(ids).not.toContain('envProfile');
    expect(ids).not.toContain('commandLine');
  });

  it('omits envOs when no OS variable is relevant and envProfile when no profile is selected', async () => {
    const build = await make({}, { PATH: 'x' }).buildLayers(project('WebApp'), { environment: 'Production' });
    expect(build.layers.map((l) => l.id)).toEqual(['appsettings.json', 'appsettings.secrets.json']);
  });

  it('omits commandLine when the profile has no commandLineArgs — Staging profile has envProfile only', async () => {
    const build = await make().buildLayers(project('WebApp'), { profile: 'Staging', environment: 'Staging' });
    const ids = build.layers.map((l) => l.id);
    expect(ids).toContain('envProfile');
    expect(ids).not.toContain('commandLine');
  });

  it('surfaces parse errors of a broken JSON layer as diagnostics and keeps going', async () => {
    const bad = path.join(project('WebApp').dir, 'appsettings.json');
    const build = await make({ [bad]: '{ nope' }).buildLayers(project('WebApp'), { environment: 'Production' });
    expect(build.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(build.layers.map((l) => l.id)).toContain('appsettings.secrets.json');
  });

  it('reports every candidate path, launchSettings, project file and user secrets path to watch', async () => {
    const p = project('WebApp');
    const build = await make().buildLayers(p, { environment: 'Staging' });
    expect(build.watchPaths).toEqual(expect.arrayContaining([
      path.join(p.dir, 'appsettings.json'),
      path.join(p.dir, 'appsettings.Staging.json'),
      path.join(p.dir, 'appsettings.secrets.json'),
      path.join(p.dir, 'Properties', 'launchSettings.json'),
      p.projectFile,
      SECRETS_PATH,
    ]));
  });

  it('watches the actual case-mismatched file too — appsettings.staging.json plus expected name, no duplicates', async () => {
    const p = project('WebApp');
    const build = await make().buildLayers(p, { environment: 'Staging' });
    expect(build.watchPaths).toContain(path.join(p.dir, 'appsettings.staging.json'));
    expect(build.watchPaths).toContain(path.join(p.dir, 'appsettings.Staging.json'));
    expect(new Set(build.watchPaths).size).toBe(build.watchPaths.length);
  });

  it('filters OS env by top-level keys of JSON layers — unrelated variables dropped, ASPNETCORE_ kept', async () => {
    const build = await make({}, { Logging__X: '1', UNRELATED: '2', ASPNETCORE_URLS: 'u' })
      .buildLayers(project('Worker'), { environment: 'Development' });
    const os = build.layers.find((l) => l.id === 'envOs');
    expect(os?.entries.map((e) => e.key)).toEqual(['Logging:X', 'ASPNETCORE_URLS']);
  });
});

describe('DotnetProvider.describe', () => {
  it('lists profiles in source order and preselects the first profile with its environment — WebApp → Development', async () => {
    const d = await make().describe(project('WebApp'));
    expect(d.profiles).toEqual(['WebApp', 'Staging']);
    expect(d.defaultSelection).toEqual({ profile: 'WebApp', environment: 'Development' });
    expect(d.profileEnvironments).toEqual({ WebApp: 'Development', Staging: 'Staging' });
    expect(d.environments).toEqual(['Development', 'staging', 'Production']);
  });

  it('without launchSettings returns no profiles and Development — Worker', async () => {
    const d = await make().describe(project('Worker'));
    expect(d).toEqual({ profiles: [], environments: ['Development', 'Staging', 'Production'], profileEnvironments: {}, defaultSelection: { environment: 'Development' },
      mergeLabel: 'Simulated — default WebApplication.CreateBuilder order', envVarSeparator: '__', watchGlobs: ['appsettings*.json'] });
  });

  it("describe returns .NET label, '__' separator and appsettings glob", async () => {
    const d = await make().describe(project('WebApp'));
    expect(d.mergeLabel).toBe('Simulated — default WebApplication.CreateBuilder order');
    expect(d.envVarSeparator).toBe('__');
    expect(d.watchGlobs).toEqual(['appsettings*.json']);
  });
});
