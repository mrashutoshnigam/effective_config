import { DEFAULT_JSON_LAYERS } from './dotnet/environments';
import { DEFAULT_ENV_FILES, DEFAULT_ENV_NAME_VARIABLES } from './python/environments';
import { IGNORED_FOLDERS, PYTHON_MARKERS } from './python/projectDiscovery';

/** Reads values of the `effectiveConfig` settings section by key relative to that section. */
export interface SettingsSource {
  /**
   * Reads one setting.
   * @param key Key relative to the `effectiveConfig` section, e.g. `python.envFiles`.
   * @returns The configured value, or undefined when none is set.
   */
  get<T>(key: string): T | undefined;
}

/** All extension settings with their defaults applied. */
export interface Settings {
  /** Glob patterns (case-insensitive) of keys whose values are masked. */
  maskPatterns: string[];
  /** .NET specific settings. */
  dotnet: {
    /** JSON layer patterns, lowest priority first; `{env}` is the environment placeholder. */
    jsonLayers: string[];
  };
  /** Python specific settings. */
  python: {
    /** Env file patterns, lowest priority first; `{env}` is the environment placeholder. */
    envFiles: string[];
    /** When true, file layers rank above the OS and launch.json layers. */
    fileOverridesOs: boolean;
    /** Case-insensitive name prefixes that keep OS variables even when no file defines them. */
    envPrefixes: string[];
    /** Delimiter splitting variable names into key segments; empty keeps keys flat. */
    nestedDelimiter: string;
    /** Names of the variables that select the environment, in priority order. */
    environmentVariables: string[];
  };
}

/** Default mask patterns (glob, case-insensitive). */
export const DEFAULT_MASK_PATTERNS: readonly string[] = ['*Password*', '*Secret*', '*Key*', '*TOKEN*', 'ConnectionStrings:*'];

/** The defaults of every setting. They must equal the defaults declared in `package.json` (a test enforces this). */
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  maskPatterns: [...DEFAULT_MASK_PATTERNS],
  dotnet: { jsonLayers: [...DEFAULT_JSON_LAYERS] },
  python: {
    envFiles: [...DEFAULT_ENV_FILES],
    fileOverridesOs: false,
    envPrefixes: [],
    nestedDelimiter: '__',
    environmentVariables: [...DEFAULT_ENV_NAME_VARIABLES],
  },
};

/** Reads a list of strings, falling back to a copy of the default when the value is not one. */
function stringList(source: SettingsSource, key: string, fallback: readonly string[]): string[] {
  const value = source.get<unknown>(key);
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...(value as string[])] : [...fallback];
}

/** Reads a value of the given primitive type, falling back to the default when the type differs. */
function primitive<T extends string | boolean>(source: SettingsSource, key: string, fallback: T): T {
  const value = source.get<unknown>(key);
  return typeof value === typeof fallback ? (value as T) : fallback;
}

/**
 * Reads all settings, applying defaults for missing or wrongly typed values.
 * @param source Where the raw values come from.
 * @returns A complete, typed settings object; arrays are copies the caller may mutate.
 */
export function readSettings(source: SettingsSource): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    maskPatterns: stringList(source, 'maskPatterns', d.maskPatterns),
    dotnet: { jsonLayers: stringList(source, 'dotnet.jsonLayers', d.dotnet.jsonLayers) },
    python: {
      envFiles: stringList(source, 'python.envFiles', d.python.envFiles),
      fileOverridesOs: primitive(source, 'python.fileOverridesOs', d.python.fileOverridesOs),
      envPrefixes: stringList(source, 'python.envPrefixes', d.python.envPrefixes),
      nestedDelimiter: primitive(source, 'python.nestedDelimiter', d.python.nestedDelimiter),
      environmentVariables: stringList(source, 'python.environmentVariables', d.python.environmentVariables),
    },
  };
}

/** Glob of files marking a Python project. */
export function pythonMarkerGlob(): string {
  return `**/{${PYTHON_MARKERS.join(',')}}`;
}

/** Glob of folders ignored when looking for Python project markers. */
export function pythonExcludeGlob(): string {
  return `**/{${IGNORED_FOLDERS.join(',')}}/**`;
}
