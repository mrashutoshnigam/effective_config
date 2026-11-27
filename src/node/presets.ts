import type { Diagnostic } from '../engine/types';

/** A Node framework whose `.env` loading rules the viewer can simulate. */
export type NodeFramework = 'vite' | 'next' | 'cra' | 'dotenv-flow' | 'generic';

/** Values of the `effectiveConfig.node.framework` setting: `auto` detects from `package.json`. */
export const NODE_FRAMEWORK_SETTINGS = ['auto', 'vite', 'next', 'cra', 'dotenv-flow', 'generic'] as const;

/** A value of the `effectiveConfig.node.framework` setting. */
export type NodeFrameworkSetting = (typeof NODE_FRAMEWORK_SETTINGS)[number];

/** How one framework loads `.env` files. */
export interface NodePreset {
  /** The framework this preset simulates. */
  framework: NodeFramework;
  /** Display name of the framework, used in the merge label. */
  label: string;
  /** Env file patterns, lowest priority first; `{env}` is the mode placeholder. */
  envFiles: string[];
  /** Prefix of the variables exposed to client code, when the framework has one. */
  clientPrefix?: string;
  /** Names of the variables that select the mode, in priority order. */
  environmentVariables: string[];
  /** The only modes the framework supports; undefined when modes come from the `.env.*` file names. */
  environments?: string[];
  /** True when the framework does not load `.env.local` in the `test` mode. */
  skipLocalInTest?: boolean;
}

/** The preset chosen for a project and the problems met while choosing it. */
export interface PresetSelection {
  /** The chosen preset. */
  preset: NodePreset;
  /** Problems found while reading `package.json`. */
  diagnostics: Diagnostic[];
}

/** Vite: `loadEnv` order, `VITE_` client prefix, mode from `MODE` then `NODE_ENV`. */
const VITE: NodePreset = {
  framework: 'vite',
  label: 'Vite',
  envFiles: ['.env', '.env.local', '.env.{env}', '.env.{env}.local'],
  clientPrefix: 'VITE_',
  environmentVariables: ['MODE', 'NODE_ENV'],
};

/** Next.js: `@next/env` order, `NEXT_PUBLIC_` client prefix, `.env.local` skipped under `test`. */
const NEXT: NodePreset = {
  framework: 'next',
  label: 'Next.js',
  envFiles: ['.env', '.env.{env}', '.env.local', '.env.{env}.local'],
  clientPrefix: 'NEXT_PUBLIC_',
  environmentVariables: ['NODE_ENV'],
  environments: ['development', 'production', 'test'],
  skipLocalInTest: true,
};

/** Create React App: the Next file order with the `REACT_APP_` client prefix. */
const CRA: NodePreset = {
  framework: 'cra',
  label: 'Create React App',
  envFiles: ['.env', '.env.{env}', '.env.local', '.env.{env}.local'],
  clientPrefix: 'REACT_APP_',
  environmentVariables: ['NODE_ENV'],
  environments: ['development', 'production', 'test'],
  skipLocalInTest: true,
};

/** dotenv-flow: `.env.local` below the mode files and skipped under `test`; no client prefix. */
const DOTENV_FLOW: NodePreset = {
  framework: 'dotenv-flow',
  label: 'dotenv-flow',
  envFiles: ['.env', '.env.local', '.env.{env}', '.env.{env}.local'],
  environmentVariables: ['NODE_ENV'],
  skipLocalInTest: true,
};

/** Fallback for unknown frameworks: the common Next/CRA file order, mode from `NODE_ENV`, no client prefix. */
const GENERIC: NodePreset = {
  framework: 'generic',
  label: 'generic',
  envFiles: ['.env', '.env.{env}', '.env.local', '.env.{env}.local'],
  environmentVariables: ['NODE_ENV'],
};

/** Every preset by framework. */
const PRESETS: Readonly<Record<NodeFramework, NodePreset>> = {
  vite: VITE,
  next: NEXT,
  cra: CRA,
  'dotenv-flow': DOTENV_FLOW,
  generic: GENERIC,
};

/** Options of {@link selectNodePreset}. */
export interface PresetSelectionOptions {
  /** Path of the `package.json`, named in diagnostics. */
  filePath?: string;
  /** Framework forced by the user; `auto` (the default) detects it from the dependencies. */
  framework?: NodeFrameworkSetting;
}

/** Dependency sections of `package.json` searched for framework packages. */
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'];

/** Framework packages in detection order; the first one a project depends on wins. */
const DETECTION_ORDER: ReadonlyArray<[pkg: string, preset: NodePreset]> = [
  ['next', NEXT],
  ['react-scripts', CRA],
  ['vite', VITE],
  ['dotenv-flow', DOTENV_FLOW],
];

/**
 * Collects the names of every package a `package.json` depends on.
 * @param manifest The parsed `package.json`.
 * @returns The dependency names of all {@link DEPENDENCY_SECTIONS}.
 */
function dependencyNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section];
    if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const name of Object.keys(deps)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Parses a `package.json` into an object.
 * @param text The file text.
 * @returns The manifest, or undefined when the text is not a JSON object.
 */
function parseManifest(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chooses the preset for a project: the forced framework when one is set, otherwise the first
 * framework of {@link DETECTION_ORDER} the `package.json` depends on, otherwise the generic preset.
 * @param packageJson Text of the project's `package.json`.
 * @param options Where the file lives and which framework the user forced.
 * @returns The preset, with a warning when `package.json` is not a JSON object.
 */
export function selectNodePreset(packageJson: string, options: PresetSelectionOptions = {}): PresetSelection {
  const { filePath = 'package.json', framework = 'auto' } = options;
  if (framework !== 'auto') {
    return { preset: PRESETS[framework], diagnostics: [] };
  }
  const manifest = parseManifest(packageJson);
  if (manifest === undefined) {
    return {
      preset: GENERIC,
      diagnostics: [{ severity: 'warning', message: `${filePath} is not a JSON object; using the generic .env order` }],
    };
  }
  const deps = dependencyNames(manifest);
  const found = DETECTION_ORDER.find(([name]) => deps.has(name));
  return { preset: found?.[1] ?? GENERIC, diagnostics: [] };
}