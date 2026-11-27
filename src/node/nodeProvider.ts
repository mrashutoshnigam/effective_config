import type { Diagnostic } from '../engine/types';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../provider';
import { DOTENV_WATCH_GLOBS, listDotenvEnvironments } from '../sources/dotenvEnvironments';
import { DotenvProviderBase, type DotenvProviderOptions } from '../sources/dotenvProviderBase';
import type { FileSystem } from '../sources/fileSystem';
import { selectNodePreset, type NodeFrameworkSetting, type NodePreset } from './presets';

/** Construction options of {@link NodeProvider}. */
export interface NodeProviderOptions {
  /** File system used for all reads. */
  fs: FileSystem;
  /** OS environment variables (undefined values already dropped). */
  osEnv: Record<string, string>;
  /** Framework forced by the user; `auto` detects it from `package.json`. */
  framework: NodeFrameworkSetting;
}

/** The mode in which presets with {@link NodePreset.skipLocalInTest} ignore {@link LOCAL_FILE}. */
const TEST_MODE = 'test';

/** The mode-independent local override file. */
const LOCAL_FILE = '.env.local';

/** Simulates one framework's `.env` loading with the shared dotenv machinery. */
class PresetDotenvProvider extends DotenvProviderBase {
  /**
   * Creates the provider.
   * @param options Environment access and the preset's layer configuration.
   * @param preset The framework preset being simulated.
   */
  constructor(options: DotenvProviderOptions, private readonly preset: NodePreset) {
    super(options);
  }

  /** @inheritdoc */
  async describe(project: ProjectInfo): Promise<ProjectDescription> {
    const files = await this.options.fs.listDir(project.dir);
    return {
      profiles: [],
      environments: this.preset.environments ? [...this.preset.environments] : listDotenvEnvironments(files),
      profileEnvironments: {},
      // The shell's mode picks the files to load, so the OS ranks above `.env` here.
      defaultSelection: { environment: await this.detectEnvironment(project, files, [this.osVars()]) },
      mergeLabel: `Simulated — ${this.preset.label} .env order (OS variables win)`,
      envVarSeparator: '__',
      watchGlobs: [...DOTENV_WATCH_GLOBS, 'package.json'],
    };
  }
}

/**
 * Simulates the `.env` loading of a Node project. The framework preset is chosen from
 * `package.json` on every call, so editing the dependencies takes effect on the next rebuild.
 */
export class NodeProvider implements ConfigProvider {
  /**
   * Creates the provider.
   * @param options Environment access and the framework setting.
   */
  constructor(private readonly options: NodeProviderOptions) {}

  /**
   * Reads `package.json` and builds the dotenv provider of the matching preset.
   * @param project Project being read.
   * @param environment Mode being simulated; under `test` a preset may drop `.env.local`.
   * @returns The provider and the problems met while reading `package.json`.
   */
  private async presetProvider(project: ProjectInfo, environment?: string): Promise<{ provider: PresetDotenvProvider; diagnostics: Diagnostic[] }> {
    const { fs, osEnv, framework } = this.options;
    const text = (await fs.readFile(project.projectFile)) ?? '';
    const { preset, diagnostics } = selectNodePreset(text, { filePath: project.projectFile, framework });
    const provider = new PresetDotenvProvider(
      {
        fs,
        osEnv,
        envFiles: preset.envFiles.filter((p) => !(preset.skipLocalInTest && environment === TEST_MODE && p === LOCAL_FILE)),
        fileOverridesOs: false,
        envPrefixes: preset.clientPrefix === undefined ? [] : [preset.clientPrefix],
        nestedDelimiter: '',
        environmentVariables: [...preset.environmentVariables],
      },
      preset,
    );
    return { provider, diagnostics };
  }

  /** @inheritdoc */
  async describe(project: ProjectInfo): Promise<ProjectDescription> {
    return (await this.presetProvider(project)).provider.describe(project);
  }

  /** @inheritdoc */
  async buildLayers(project: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    const { provider, diagnostics } = await this.presetProvider(project, selection.environment);
    const build = await provider.buildLayers(project, selection);
    return {
      layers: build.layers,
      diagnostics: [...diagnostics, ...build.diagnostics],
      watchPaths: [project.projectFile, ...build.watchPaths],
    };
  }
}
