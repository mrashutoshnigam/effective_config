import * as path from 'node:path';
import type { Diagnostic, Layer, LayerEntry } from '../engine/types';
import { normalizeKey, splitKey } from '../engine/keys';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../provider';
import { parseJsonLayer } from '../sources/jsonLayer';
import { envVarEntries, filterOsEnv } from '../sources/envVars';
import { parseCommandLineArgs } from '../sources/commandLine';
import { parseLaunchSettings, type LaunchProfile } from './launchSettings';
import { listEnvironments, resolveJsonLayerFiles } from './environments';
import type { FileSystem } from './fileSystem';
import { readUserSecretsId, userSecretsPath } from './userSecrets';

/** Construction options of {@link DotnetProvider}. */
export interface DotnetProviderOptions {
  /** File system used for all reads. */
  fs: FileSystem;
  /** OS environment variables (undefined values already dropped). */
  osEnv: Record<string, string>;
  /** Host platform, used to locate the user secrets file. */
  platform: NodeJS.Platform;
  /** The user's home directory. */
  homeDir: string;
  /** JSON layer patterns, lowest priority first; `{env}` is the environment placeholder. */
  jsonLayers: string[];
}

/** Simulates the default `WebApplication.CreateBuilder` configuration sources for a .NET project. */
export class DotnetProvider implements ConfigProvider {
  /**
   * Creates the provider.
   * @param options Environment access and layer configuration.
   */
  constructor(private readonly options: DotnetProviderOptions) {}

  /**
   * Reads and parses `Properties/launchSettings.json`.
   * @returns Profiles (empty when the file is missing) and parse diagnostics.
   */
  private async readLaunchSettings(project: ProjectInfo): Promise<{ profiles: LaunchProfile[]; diagnostics: Diagnostic[]; file: string }> {
    const file = path.join(project.dir, 'Properties', 'launchSettings.json');
    const text = await this.options.fs.readFile(file);
    if (text === undefined) {
      return { profiles: [], diagnostics: [], file };
    }
    return { ...parseLaunchSettings(text, file), file };
  }

  /** @inheritdoc */
  async describe(project: ProjectInfo): Promise<ProjectDescription> {
    const files = await this.options.fs.listDir(project.dir);
    const environments = listEnvironments(files, this.options.jsonLayers);
    const { profiles } = await this.readLaunchSettings(project);
    if (profiles.length === 0) {
      return { profiles: [], environments, profileEnvironments: {}, defaultSelection: { environment: 'Development' } };
    }
    const first = profiles[0];
    return {
      profiles: profiles.map((p) => p.name),
      environments,
      profileEnvironments: Object.fromEntries(profiles.map((p) => [p.name, p.environmentName])),
      defaultSelection: { profile: first.name, environment: first.environmentName ?? 'Development' },
    };
  }

  /** @inheritdoc */
  async buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    const { fs, osEnv, platform, homeDir, jsonLayers } = this.options;
    const layers: Layer[] = [];
    const diagnostics: Diagnostic[] = [];
    const watchPaths: string[] = [];
    const topLevelKeys = new Set<string>();
    const addTopLevel = (entries: LayerEntry[]): void => {
      for (const e of entries) {
        topLevelKeys.add(normalizeKey(splitKey(e.key)[0]));
      }
    };

    const files = await fs.listDir(project.dir);
    for (const resolved of resolveJsonLayerFiles(files, jsonLayers, selection.environment)) {
      const expected = resolved.pattern.split('{env}').join(selection.environment);
      watchPaths.push(path.join(project.dir, expected));
      if (resolved.fileName === undefined) {
        continue;
      }
      const filePath = path.join(project.dir, resolved.fileName);
      if (resolved.caseMismatch) {
        diagnostics.push({
          severity: 'warning',
          message: `'${resolved.fileName}' matches '${expected}' only ignoring case; it would not load on case-sensitive file systems`,
        });
      }
      const text = await fs.readFile(filePath);
      if (text === undefined) {
        continue;
      }
      const parsed = parseJsonLayer(text, filePath);
      diagnostics.push(...parsed.diagnostics);
      addTopLevel(parsed.entries);
      layers.push({
        id: resolved.fileName,
        label: resolved.fileName,
        kind: 'json',
        sensitive: resolved.pattern.toLowerCase().includes('secret'),
        filePath,
        entries: parsed.entries,
      });
    }

    const launch = await this.readLaunchSettings(project);
    watchPaths.push(launch.file, project.projectFile);
    diagnostics.push(...launch.diagnostics);

    const csproj = await fs.readFile(project.projectFile);
    const secretsId = csproj === undefined ? undefined : readUserSecretsId(csproj);
    if (secretsId !== undefined) {
      const secretsFile = userSecretsPath(secretsId, platform, osEnv, homeDir);
      watchPaths.push(secretsFile);
      if (selection.environment.toLowerCase() === 'development') {
        const text = await fs.readFile(secretsFile);
        if (text === undefined) {
          diagnostics.push({ severity: 'info', message: `User secrets file for id '${secretsId}' not found at ${secretsFile}` });
        } else {
          const parsed = parseJsonLayer(text, secretsFile);
          diagnostics.push(...parsed.diagnostics);
          addTopLevel(parsed.entries);
          layers.push({
            id: 'userSecrets', label: 'User Secrets', kind: 'userSecrets', sensitive: true,
            filePath: secretsFile, entries: parsed.entries,
          });
        }
      }
    }

    const osFiltered = filterOsEnv(osEnv, topLevelKeys);
    if (Object.keys(osFiltered).length > 0) {
      layers.push({ id: 'envOs', label: 'Environment (OS)', kind: 'envOs', sensitive: false, entries: envVarEntries(osFiltered) });
    }

    let profile: LaunchProfile | undefined;
    if (selection.profile !== undefined) {
      profile = launch.profiles.find((p) => p.name === selection.profile);
      if (!profile) {
        diagnostics.push({ severity: 'warning', message: `Launch profile '${selection.profile}' not found in launchSettings.json; ignoring it` });
      }
    }
    if (profile) {
      if (Object.keys(profile.environmentVariables).length > 0) {
        layers.push({
          id: 'envProfile', label: `Environment (launchSettings: ${profile.name})`, kind: 'envProfile',
          sensitive: false, entries: envVarEntries(profile.environmentVariables),
        });
      }
      if (profile.commandLineArgs && profile.commandLineArgs.trim() !== '') {
        const parsed = parseCommandLineArgs(profile.commandLineArgs);
        diagnostics.push(...parsed.diagnostics);
        layers.push({
          id: 'commandLine', label: `Command line (${profile.name})`, kind: 'commandLine',
          sensitive: false, entries: parsed.entries,
        });
      }
    }

    return { layers, diagnostics, watchPaths };
  }
}
