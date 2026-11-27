import * as path from 'node:path';
import type { Diagnostic, Layer, LayerEntry } from '../engine/types';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../provider';
import { parseDotenv } from '../sources/dotenv';
import { VarMap } from '../sources/dotenvProviderBase';
import type { FileSystem } from '../sources/fileSystem';
import {
  DEFAULT_ENV_FILE,
  OVERRIDE_COMPOSE_FILES,
  PRIMARY_COMPOSE_FILES,
  activeProfiles,
  envFileDir,
  expandEnvFileEntries,
  listComposeEnvFiles,
  readComposeScope,
  resolveComposeFiles,
  type ComposeScope,
} from './composeFiles';
import { mergeService, readComposeFile, serviceNames, type ComposeFileModel, type EnvFileRef, type EnvironmentItem } from './composeModel';
import { interpolate } from './interpolation';

/** Construction options of {@link ComposeProvider}. */
export interface ComposeProviderOptions {
  /** File system used for all reads. */
  fs: FileSystem;
  /** OS environment variables (undefined values already dropped). */
  osEnv: Record<string, string>;
  /** Compose files from `effectiveConfig.compose.files`, lowest priority first; empty uses Compose's discovery. */
  files: string[];
  /** Platform deciding the `COMPOSE_FILE` separator; defaults to the running one. */
  platform?: NodeJS.Platform;
}

/** Merge label shown in the panel. */
const MERGE_LABEL = 'Simulated — docker compose (environment: over env_file, OS variables win in interpolation)';

/** Files whose changes rebuild the panel, relative to the project directory. */
const WATCH_GLOBS: readonly string[] = [...PRIMARY_COMPOSE_FILES, ...OVERRIDE_COMPOSE_FILES, '.env', '.env.*', '*.env'];

/** Compose files loaded for one env file. */
interface LoadedProject {
  /** The interpolation scope. */
  scope: ComposeScope;
  /** Project directory: the first loaded file's directory. */
  projectDir: string;
  /** Absolute paths of the files loaded, base first. */
  files: string[];
  /** Absolute paths of every compose file listed or found, whether it exists or not. */
  considered: string[];
  /** The parsed files, in the same order. */
  models: ComposeFileModel[];
  /** Problems met reading the scope and the files. */
  diagnostics: Diagnostic[];
}

/**
 * Simulates the environment `docker compose up` gives one service's container. The service picker is
 * the profile and the environment dropdown is `--env-file`.
 */
export class ComposeProvider implements ConfigProvider {
  /**
   * Creates the provider.
   * @param options Environment access and the compose files setting.
   */
  constructor(private readonly options: ComposeProviderOptions) {}

  /**
   * Reads the scope of an env file and the compose files it selects.
   * @param project Project being read.
   * @param envDir Directory the env file resolves from, see {@link envFileDir}.
   * @param envFile Env file simulating `--env-file`.
   * @returns The scope, the files and their models.
   */
  private async load(project: ProjectInfo, envDir: string, envFile: string): Promise<LoadedProject> {
    const { fs, osEnv, files: settingFiles, platform } = this.options;
    const scope = await readComposeScope(fs, envDir, envFile, osEnv);
    const set = await resolveComposeFiles(fs, project.projectFile, settingFiles, scope.vars, platform);
    const lookup = (name: string): string | undefined => scope.vars.get(name);
    const models: ComposeFileModel[] = [];
    for (const file of set.files) {
      models.push(readComposeFile((await fs.readFile(file)) ?? '', file, lookup));
    }
    return {
      scope,
      projectDir: set.projectDir,
      files: set.files,
      considered: set.considered,
      models,
      diagnostics: [...scope.diagnostics, ...set.diagnostics, ...models.flatMap((m) => m.diagnostics)],
    };
  }

  /**
   * Picks the env file preselected in the dropdown.
   * @param environments The dropdown's env files.
   * @returns The first `COMPOSE_ENV_FILES` entry (comma separated) when listed, else `.env`.
   */
  private defaultEnvFile(environments: string[]): string {
    const first = (this.options.osEnv.COMPOSE_ENV_FILES ?? '').split(',')[0].trim();
    return environments.includes(first) ? first : DEFAULT_ENV_FILE;
  }

  /** @inheritdoc */
  async describe(project: ProjectInfo): Promise<ProjectDescription> {
    const envDir = envFileDir(project.projectFile, this.options.files);
    const environments = listComposeEnvFiles(await this.options.fs.listDir(envDir));
    const environment = this.defaultEnvFile(environments);
    const services = serviceNames((await this.load(project, envDir, environment)).models);
    return {
      profiles: services,
      environments,
      profileEnvironments: {},
      defaultSelection: services.length > 0 ? { profile: services[0], environment } : { environment },
      mergeLabel: MERGE_LABEL,
      envVarSeparator: '__',
      watchGlobs: [...WATCH_GLOBS],
    };
  }

  /** @inheritdoc */
  async buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    const { fs, files: settingFiles } = this.options;
    const envDir = envFileDir(project.projectFile, settingFiles);
    const loaded = await this.load(project, envDir, selection.environment);
    const diagnostics = [...loaded.diagnostics];
    const environments = listComposeEnvFiles(await fs.listDir(envDir));
    const watchPaths = new Set<string>([
      ...WATCH_GLOBS.filter((g) => !g.includes('*')).map((name) => path.join(project.dir, name)),
      ...loaded.considered,
      ...environments.map((name) => path.join(envDir, name)),
      loaded.scope.envFilePath,
    ]);
    /** Builds the result from what has been gathered. */
    const result = (layers: Layer[]): LayerBuild => ({ layers, diagnostics, watchPaths: [...watchPaths] });

    const name = selection.profile ?? serviceNames(loaded.models)[0];
    if (name === undefined) {
      return result([]);
    }
    const service = mergeService(loaded.models, name);
    if (!service) {
      diagnostics.push({ severity: 'error', message: `service '${name}' is not defined in the loaded compose files` });
      return result([]);
    }
    const active = activeProfiles(loaded.scope.vars);
    if (service.profiles.length > 0 && !service.profiles.some((p) => active.includes(p))) {
      diagnostics.push({
        severity: 'info',
        message: `service '${name}' starts only with profile(s) ${service.profiles.join(', ')}; active: ${active.length > 0 ? active.join(', ') : 'none'}`,
      });
    }

    const environmentDiagnostics: Diagnostic[] = [];
    const environmentLayers = service.environmentLayers.map(({ filePath, items }, index): Layer => ({
      id: `composeEnvironment:${index}`,
      label: `environment (${path.basename(filePath)})`,
      kind: 'composeEnvironment',
      sensitive: false,
      filePath,
      entries: this.environmentEntries(items, loaded.scope.vars, environmentDiagnostics),
    }));
    // compose-go's `resolveEnvironment` (types/project.go) interpolates env_file values with the project
    // environment first, then the service's resolved `environment`, and its parser falls back to one vars
    // map that every env_file of the service is read into, in order.
    const serviceEnvironment = new VarMap();
    for (const entry of environmentLayers.flatMap((l) => l.entries)) {
      serviceEnvironment.set(entry.key, entry.value ?? '');
    }
    /**
     * Looks a variable up for env_file interpolation.
     * @param name Variable name.
     * @returns The project scope's value, else the service environment's.
     */
    const envFileScope = (name: string): string | undefined => loaded.scope.vars.get(name) ?? serviceEnvironment.get(name);
    const parsed = new VarMap();

    const layers: Layer[] = [];
    for (const [index, ref] of service.envFiles.entries()) {
      watchPaths.add(ref.path);
      const layer = await this.envFileLayer(ref, index, loaded, envFileScope, parsed, diagnostics);
      if (layer) {
        layers.push(layer);
      }
    }
    layers.push(...environmentLayers);
    diagnostics.push(...environmentDiagnostics);
    return result(layers);
  }

  /**
   * Builds the layer of one `env_file` entry.
   * @param ref The entry.
   * @param index Its position in the service's merged `env_file` list.
   * @param loaded The loaded project.
   * @param scope Variables that win over the env_files' own values.
   * @param parsed Values of the service's earlier env_files; this file's values are added to it.
   * @param diagnostics Receives problems met.
   * @returns The layer, or undefined when the file does not exist.
   */
  private async envFileLayer(
    ref: EnvFileRef,
    index: number,
    loaded: LoadedProject,
    scope: (name: string) => string | undefined,
    parsed: VarMap,
    diagnostics: Diagnostic[],
  ): Promise<Layer | undefined> {
    const label = path.relative(loaded.projectDir, ref.path).replace(/\\/g, '/');
    const text = await this.options.fs.readFile(ref.path);
    if (text === undefined) {
      diagnostics.push({ severity: ref.required ? 'error' : 'info', message: `env file not found: ${label}`, location: ref.location });
      return undefined;
    }
    const dotenv = parseDotenv(text, ref.path);
    // The parser's note on a bare `KEY` line names python-dotenv rules, which do not apply here.
    diagnostics.push(...dotenv.diagnostics.filter((d) => d.severity !== 'info'));
    const entries: LayerEntry[] = [];
    for (const { entry, result } of expandEnvFileEntries(dotenv.entries, scope, parsed)) {
      diagnostics.push(...result.errors.map((message): Diagnostic => ({ severity: 'error', message, location: entry.location })));
      entries.push({ key: entry.name, value: result.value, location: entry.location, ...(result.references.length > 0 ? { references: result.references } : {}) });
    }
    return { id: `composeEnvFile:${index}`, label, kind: 'composeEnvFile', sensitive: false, filePath: ref.path, entries };
  }

  /**
   * Builds the entries of one file's `environment`. A value-less variable takes the scope's value, or is
   * left out when the scope has none: Compose documents that such a variable "is unset and is removed
   * from the service container environment" (https://docs.docker.com/reference/compose-file/services/#environment).
   * A failed `:?` check keeps the key with an empty value; its error was raised when the file was read.
   * @param items The variables.
   * @param scope The interpolation scope.
   * @param diagnostics Receives an info per variable left unset.
   * @returns The layer entries.
   */
  private environmentEntries(items: EnvironmentItem[], scope: VarMap, diagnostics: Diagnostic[]): LayerEntry[] {
    const entries: LayerEntry[] = [];
    for (const item of items) {
      if (item.raw === null) {
        const value = scope.get(item.name);
        if (value === undefined) {
          diagnostics.push({ severity: 'info', message: `${item.name} is not set in the shell or the env file; Compose leaves it unset`, location: item.location });
        } else {
          // No reference: the value is read under the entry's own name, which masking already matches.
          entries.push({ key: item.name, value, location: item.location });
        }
        continue;
      }
      const result = interpolate(item.raw, (n) => scope.get(n));
      entries.push({ key: item.name, value: result.value, location: item.location, ...(result.references.length > 0 ? { references: result.references } : {}) });
    }
    return entries;
  }
}
