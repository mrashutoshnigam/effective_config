import { delimitedNameToKey, normalizeKey } from '../engine/keys';
import type { Diagnostic, Layer, LayerEntry } from '../engine/types';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../provider';
import { expandDotenvValue, parseDotenv, type DotenvEntry } from './dotenv';
import { readFileLayers } from './fileLayers';
import type { FileSystem } from './fileSystem';

/** Construction options shared by every provider built on {@link DotenvProviderBase}. */
export interface DotenvProviderOptions {
  /** File system used for all reads. */
  fs: FileSystem;
  /** OS environment variables (undefined values already dropped). */
  osEnv: Record<string, string>;
  /** Env file patterns, lowest priority first; `{env}` is the environment placeholder. */
  envFiles: string[];
  /** When true, file layers rank above the OS layer. */
  fileOverridesOs: boolean;
  /** Case-insensitive name prefixes that keep OS variables even when no file defines them. */
  envPrefixes: string[];
  /** Delimiter splitting variable names into key segments; empty keeps keys flat. */
  nestedDelimiter: string;
}

/** Case-insensitive variable store (names compared lower-cased). */
export class VarMap {
  private readonly map = new Map<string, string>();

  /**
   * Stores a value, replacing any earlier one with the same (case-insensitive) name.
   * @param name Variable name.
   * @param value Variable value.
   */
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }

  /**
   * Reads a value.
   * @param name Variable name.
   * @returns The value stored for the name, or undefined.
   */
  get(name: string): string | undefined {
    return this.map.get(name.toLowerCase());
  }
}

/** An env file read and expanded; `entries` are in source order. */
export interface ExpandedFile {
  /** The expanded entries, each with its original variable name. */
  entries: { name: string; entry: LayerEntry }[];
  /** Problems found while parsing. */
  diagnostics: Diagnostic[];
}

/** The process environment a project runs with, as supplied by {@link DotenvProviderBase.readProcessEnvironment}. */
export interface ProcessEnvironment {
  /** Variables visible to the running process (OS included); env file values expand against them. */
  vars: VarMap;
  /** Layers injecting those variables, lowest priority first; they rank directly above the OS layer. */
  layers: Layer[];
  /** Problems found while reading the injecting sources. */
  diagnostics: Diagnostic[];
  /** Absolute paths of the injecting sources whose changes should trigger a rebuild. */
  watchPaths: string[];
}

/**
 * Builds the layers of a dotenv-style project: env file layers from `{env}` patterns, variable
 * expansion and a filtered OS layer. An ecosystem subclasses it and supplies {@link describe}; it
 * overrides {@link readProcessEnvironment} when something other than the OS sets process variables.
 * @typeParam O Options of the concrete provider.
 */
export abstract class DotenvProviderBase<O extends DotenvProviderOptions = DotenvProviderOptions> implements ConfigProvider {
  /**
   * Creates the provider.
   * @param options Environment access and layer configuration.
   */
  constructor(protected readonly options: O) {}

  /** @inheritdoc */
  abstract describe(project: ProjectInfo): Promise<ProjectDescription>;

  /**
   * Converts a variable name to a configuration key with the configured delimiter.
   * @param name Variable name.
   * @returns The `:`-separated configuration key.
   */
  protected key(name: string): string {
    return delimitedNameToKey(name, this.options.nestedDelimiter);
  }

  /**
   * Builds a case-insensitive store of the OS environment.
   * @returns A new store, safe for the caller to modify.
   */
  protected osVars(): VarMap {
    const vars = new VarMap();
    for (const [name, value] of Object.entries(this.options.osEnv)) {
      vars.set(name, value);
    }
    return vars;
  }

  /**
   * Expands one parsed entry (when its quoting allows it) into a layer entry.
   * @param e The parsed entry.
   * @param lookup Resolves a referenced variable name.
   * @returns The layer entry, carrying its location and any references.
   */
  protected expandEntry(e: DotenvEntry, lookup: (name: string) => string | undefined): LayerEntry {
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
   * Reads and parses an env file, expanding each value against `base` and then the file's own earlier entries.
   * @param file Absolute path of the env file.
   * @param base Variables that take precedence over the file's own values during expansion.
   * @returns The expanded entries and parse diagnostics, or undefined when the file does not exist.
   */
  protected async readExpandedFile(file: string, base: VarMap): Promise<ExpandedFile | undefined> {
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

  /**
   * Reads what the project's process runs with besides its env files. Defaults to the bare OS environment.
   * @param _project Project being read.
   * @param _selection Profile and environment to simulate.
   * @returns The process variables and the layers injecting them.
   */
  protected async readProcessEnvironment(_project: ProjectInfo, _selection: Selection): Promise<ProcessEnvironment> {
    return { vars: this.osVars(), layers: [], diagnostics: [], watchPaths: [] };
  }

  /** @inheritdoc */
  async buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    const { fs, envFiles, fileOverridesOs } = this.options;
    const processEnv = await this.readProcessEnvironment(project, selection);
    const processVars = processEnv.vars;
    const fileValues = new VarMap();
    const lookup = (name: string): string | undefined =>
      fileOverridesOs ? fileValues.get(name) ?? processVars.get(name) : processVars.get(name) ?? fileValues.get(name);
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

    const osLayer = this.buildOsLayer([...read.layers, ...processEnv.layers]);
    const upper = [...(osLayer ? [osLayer] : []), ...processEnv.layers];
    return {
      layers: fileOverridesOs ? [...upper, ...read.layers] : [...read.layers, ...upper],
      diagnostics: [...processEnv.diagnostics, ...read.diagnostics],
      watchPaths: [...processEnv.watchPaths, ...read.watchPaths],
    };
  }

  /**
   * Builds the OS layer, filtered to variables another layer defines or an allowed prefix selects.
   * @param others The layers whose keys keep a matching OS variable.
   * @returns The layer, or undefined when no OS variable qualifies.
   */
  private buildOsLayer(others: Layer[]): Layer | undefined {
    const { osEnv, envPrefixes } = this.options;
    const knownKeys = new Set<string>();
    for (const layer of others) {
      for (const e of layer.entries) {
        knownKeys.add(normalizeKey(e.key));
      }
    }
    const prefixes = envPrefixes.map((p) => p.toLowerCase());
    const entries: LayerEntry[] = [];
    for (const [name, value] of Object.entries(osEnv)) {
      const key = this.key(name);
      if (knownKeys.has(normalizeKey(key)) || prefixes.some((p) => p !== '' && name.toLowerCase().startsWith(p))) {
        entries.push({ key, value });
      }
    }
    return entries.length > 0 ? { id: 'envOs', label: 'Environment (OS)', kind: 'envOs', sensitive: false, entries } : undefined;
  }
}
