import * as path from 'node:path';
import type { Diagnostic, Layer, LayerEntry } from '../engine/types';
import { delimitedNameToKey, normalizeKey } from '../engine/keys';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../provider';
import type { FileSystem } from '../sources/fileSystem';
import { readFileLayers } from '../sources/fileLayers';
import { expandDotenvValue, parseDotenv, type DotenvEntry } from '../sources/dotenv';
import { listPythonEnvironments } from './environments';
import { parsePythonLaunchConfigs, type PythonLaunchConfig } from './launchJson';

/** Construction options of {@link PythonProvider}. */
export interface PythonProviderOptions {
  /** File system used for all reads. */
  fs: FileSystem;
  /** OS environment variables (undefined values already dropped). */
  osEnv: Record<string, string>;
  /** Workspace folder; the upper bound of the launch.json search and the base of relative `envFile` paths. */
  workspaceRoot: string;
  /** Env file patterns, lowest priority first; `{env}` is the environment placeholder. */
  envFiles: string[];
  /** When true, file layers rank above the OS/launch.json layers (python-dotenv `override=True`). */
  fileOverridesOs: boolean;
  /** Case-insensitive name prefixes that keep OS variables even when no file defines them. */
  envPrefixes: string[];
  /** Delimiter splitting variable names into key segments; empty keeps keys flat. */
  nestedDelimiter: string;
  /** Names of the variables that select the environment, in priority order. */
  environmentVariables: string[];
}

const LABEL_OS_WINS = 'Simulated — python-dotenv order (OS variables win)';
const LABEL_FILES_WIN = 'Simulated — python-dotenv order (files override OS)';
const WATCH_GLOBS = ['.env', '.env.*'];
const DEFAULT_ENVIRONMENT = 'development';

/** Case-insensitive variable store (names compared lower-cased). */
class VarMap {
  private readonly map = new Map<string, string>();

  /** Stores a value, replacing any earlier one with the same (case-insensitive) name. */
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }

  /** Returns the value stored for a name, or undefined. */
  get(name: string): string | undefined {
    return this.map.get(name.toLowerCase());
  }
}

/** Normalizes a path for containment comparison: forward slashes, lower case, no trailing slash. */
function normPath(p: string): string {
  const s = p.replace(/\\/g, '/').toLowerCase();
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/** An env file read and expanded; `entries` are in source order. */
interface ExpandedFile {
  entries: { name: string; entry: LayerEntry }[];
  diagnostics: Diagnostic[];
}

/** Launch.json lookup result. */
interface LaunchInfo {
  configs: PythonLaunchConfig[];
  diagnostics: Diagnostic[];
  file: string;
  /** Every launch.json location checked (watched so a newly created file is noticed). */
  candidates: string[];
}

/** Simulates python-dotenv loading plus VS Code launch.json environment injection for a Python project. */
export class PythonProvider implements ConfigProvider {
  /**
   * Creates the provider.
   * @param options Environment access and layer configuration.
   */
  constructor(private readonly options: PythonProviderOptions) {}

  /** Converts a variable name to a configuration key with the configured delimiter. */
  private key(name: string): string {
    return delimitedNameToKey(name, this.options.nestedDelimiter);
  }

  /** Case-insensitive store of the OS environment. */
  private osVars(): VarMap {
    const vars = new VarMap();
    for (const [name, value] of Object.entries(this.options.osEnv)) {
      vars.set(name, value);
    }
    return vars;
  }

  /**
   * Finds and parses the nearest `.vscode/launch.json`, searching from the project directory up to the
   * workspace root (inclusive); only the project directory when it is not under the root.
   */
  private async readLaunch(project: ProjectInfo): Promise<LaunchInfo> {
    const { fs, workspaceRoot } = this.options;
    const root = normPath(workspaceRoot);
    const under = (d: string): boolean => normPath(d) === root || normPath(d).startsWith(root + '/');
    const projectUnderRoot = under(project.dir);
    const candidates: string[] = [];
    let dir = project.dir;
    for (;;) {
      const file = path.join(dir, '.vscode', 'launch.json');
      candidates.push(file);
      const text = await fs.readFile(file);
      if (text !== undefined) {
        return { ...parsePythonLaunchConfigs(text, file, workspaceRoot), file, candidates };
      }
      const parent = path.dirname(dir);
      if (!projectUnderRoot || normPath(dir) === root || parent === dir) {
        break;
      }
      dir = parent;
    }
    return { configs: [], diagnostics: [], file: path.join(project.dir, '.vscode', 'launch.json'), candidates };
  }

  /**
   * Reads and parses an env file, expanding each value against `base` and then the file's own earlier entries.
   * @returns The expanded entries and parse diagnostics, or undefined when the file does not exist.
   */
  private async readExpandedFile(file: string, base: VarMap): Promise<ExpandedFile | undefined> {
    const text = await this.options.fs.readFile(file);
    if (text === undefined) {
      return undefined;
    }
    const parsed = parseDotenv(text, file);
    const own = new VarMap();
    const entries = parsed.entries.map((e) => {
      const entry = this.expandEntry(e, (n) => base.get(n) ?? own.get(n));
      own.set(e.name, entry.value ?? '');
      return { name: e.name, entry };
    });
    return { entries, diagnostics: parsed.diagnostics };
  }

  /** Expands one parsed entry (when allowed) into a layer entry carrying references and location. */
  private expandEntry(e: DotenvEntry, lookup: (name: string) => string | undefined): LayerEntry {
    if (!e.expand) {
      return { key: this.key(e.name), value: e.value, location: e.location };
    }
    const { value, references } = expandDotenvValue(e.value, lookup);
    const entry: LayerEntry = { key: this.key(e.name), value, location: e.location };
    if (references.length > 0) {
      entry.references = references.map((r) => this.key(r));
    }
    return entry;
  }

  /**
   * Determines the environment name: sources outer (profile env, profile envFile, `.env`, OS), the
   * configured variable names inner; the first source that defines one of them with a non-empty value wins.
   */
  private async detectEnvironment(project: ProjectInfo, files: string[], profile?: PythonLaunchConfig): Promise<string> {
    const os = this.osVars();
    const sources: VarMap[] = [];
    if (profile) {
      const env = new VarMap();
      for (const [k, v] of Object.entries(profile.env)) {
        env.set(k, v);
      }
      sources.push(env);
      if (profile.envFile !== undefined) {
        sources.push(await this.fileVars(profile.envFile, os));
      }
    }
    const dotenvName = files.find((f) => f.toLowerCase() === '.env');
    if (dotenvName !== undefined) {
      sources.push(await this.fileVars(path.join(project.dir, dotenvName), os));
    }
    sources.push(os);
    for (const source of sources) {
      for (const name of this.options.environmentVariables) {
        const value = source.get(name)?.trim();
        if (value) {
          return value;
        }
      }
    }
    return DEFAULT_ENVIRONMENT;
  }

  /** Reads an env file into a variable map (empty when missing), values expanded against `os`. */
  private async fileVars(file: string, os: VarMap): Promise<VarMap> {
    const vars = new VarMap();
    const read = await this.readExpandedFile(file, os);
    for (const { name, entry } of read?.entries ?? []) {
      vars.set(name, entry.value ?? '');
    }
    return vars;
  }

  /** @inheritdoc */
  async describe(project: ProjectInfo): Promise<ProjectDescription> {
    const { fs, fileOverridesOs, nestedDelimiter } = this.options;
    const files = await fs.listDir(project.dir);
    const launch = await this.readLaunch(project);
    const profileEnvironments: Record<string, string> = {};
    for (const config of launch.configs) {
      profileEnvironments[config.name] = await this.detectEnvironment(project, files, config);
    }
    const first = launch.configs[0];
    const defaultSelection: Selection = first
      ? { profile: first.name, environment: profileEnvironments[first.name] }
      : { environment: await this.detectEnvironment(project, files) };
    return {
      profiles: launch.configs.map((c) => c.name),
      environments: listPythonEnvironments(files),
      profileEnvironments,
      defaultSelection,
      mergeLabel: fileOverridesOs ? LABEL_FILES_WIN : LABEL_OS_WINS,
      envVarSeparator: nestedDelimiter || '__',
      watchGlobs: [...WATCH_GLOBS],
    };
  }

  /** @inheritdoc */
  async buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    const { fs, osEnv, envFiles, fileOverridesOs, envPrefixes, workspaceRoot } = this.options;
    const diagnostics: Diagnostic[] = [];
    const watchPaths: string[] = [];

    const launch = await this.readLaunch(project);
    watchPaths.push(launch.file, project.projectFile);
    for (const candidate of [...launch.candidates, path.join(workspaceRoot, '.vscode', 'launch.json')]) {
      if (!watchPaths.includes(candidate)) {
        watchPaths.push(candidate);
      }
    }
    diagnostics.push(...launch.diagnostics);
    let profile: PythonLaunchConfig | undefined;
    if (selection.profile !== undefined) {
      profile = launch.configs.find((c) => c.name === selection.profile);
      if (!profile) {
        diagnostics.push({ severity: 'warning', message: `Launch profile '${selection.profile}' not found in launch.json; ignoring it` });
      }
    }

    // Process environment: OS, then the profile envFile, then the profile env (later wins).
    const os = this.osVars();
    const processEnv = this.osVars();
    let envFileLayer: Layer | undefined;
    if (profile?.envFile !== undefined) {
      watchPaths.push(profile.envFile);
      const read = await this.readExpandedFile(profile.envFile, os);
      if (read === undefined) {
        diagnostics.push({ severity: 'warning', message: `envFile not found: ${profile.envFile}` });
      } else {
        diagnostics.push(...read.diagnostics);
        for (const { name, entry } of read.entries) {
          processEnv.set(name, entry.value ?? '');
        }
        envFileLayer = {
          id: 'envFile', label: `Env file (launch.json: ${profile.name})`, kind: 'envFile',
          sensitive: path.basename(profile.envFile).toLowerCase().includes('secret'),
          filePath: profile.envFile, entries: read.entries.map((r) => r.entry),
        };
      }
    }
    let envProfileLayer: Layer | undefined;
    if (profile && Object.keys(profile.env).length > 0) {
      for (const [name, value] of Object.entries(profile.env)) {
        processEnv.set(name, value);
      }
      envProfileLayer = {
        id: 'envProfile', label: `Environment (launch.json: ${profile.name})`, kind: 'envProfile', sensitive: false,
        entries: Object.entries(profile.env).map(([name, value]) => ({ key: this.key(name), value })),
      };
    }

    // File layers, expanded with the configured precedence between process and file values.
    const fileLayers: Layer[] = [];
    const fileValues = new VarMap();
    const lookup = (name: string): string | undefined =>
      fileOverridesOs ? fileValues.get(name) ?? processEnv.get(name) : processEnv.get(name) ?? fileValues.get(name);
    const read = await readFileLayers({
      fs,
      dir: project.dir,
      patterns: envFiles,
      environment: selection.environment,
      kind: 'dotenv',
      parse: (text, filePath) => {
        const parsed = parseDotenv(text, filePath);
        const entries = parsed.entries.map((e) => {
          const entry = this.expandEntry(e, lookup);
          fileValues.set(e.name, entry.value ?? '');
          return entry;
        });
        return { entries, diagnostics: parsed.diagnostics };
      },
    });
    diagnostics.push(...read.diagnostics);
    watchPaths.push(...read.watchPaths);
    fileLayers.push(...read.layers);

    // OS layer, filtered to variables a file/profile layer defines or an allowed prefix selects.
    const knownKeys = new Set<string>();
    for (const layer of [...fileLayers, envFileLayer, envProfileLayer]) {
      for (const e of layer?.entries ?? []) {
        knownKeys.add(normalizeKey(e.key));
      }
    }
    const prefixes = envPrefixes.map((p) => p.toLowerCase());
    const osEntries: LayerEntry[] = [];
    for (const [name, value] of Object.entries(osEnv)) {
      const key = this.key(name);
      if (knownKeys.has(normalizeKey(key)) || prefixes.some((p) => p !== '' && name.toLowerCase().startsWith(p))) {
        osEntries.push({ key, value });
      }
    }
    const osLayer: Layer | undefined = osEntries.length > 0
      ? { id: 'envOs', label: 'Environment (OS)', kind: 'envOs', sensitive: false, entries: osEntries }
      : undefined;

    const upper = [osLayer, envFileLayer, envProfileLayer].filter((l): l is Layer => l !== undefined);
    const layers = fileOverridesOs ? [...upper, ...fileLayers] : [...fileLayers, ...upper];
    return { layers, diagnostics, watchPaths };
  }
}
