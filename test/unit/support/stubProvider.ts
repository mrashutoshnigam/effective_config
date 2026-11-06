import type { ProjectDescription, ProjectInfo } from '../../../src/provider';
import { DotenvProviderBase, type DotenvProviderOptions } from '../../../src/sources/dotenvProviderBase';
import { DOTENV_WATCH_GLOBS, listDotenvEnvironments } from '../../../src/sources/dotenvEnvironments';
import type { FileSystem } from '../../../src/sources/fileSystem';

/** Kind of the stub language; nothing in the host knows it. */
export const STUB_KIND = 'stub-language';

/** Merge label of the stub language. */
export const STUB_LABEL = 'Simulated — stub language order';

/** Project directory used by the in-memory tests. */
export const STUB_DIR = '/stub';

/** The project read by the in-memory tests. */
export const STUB_PROJECT: ProjectInfo = { id: `${STUB_DIR}/stub.toml`, name: 'stub', dir: STUB_DIR, projectFile: `${STUB_DIR}/stub.toml`, kind: STUB_KIND };

/** Minimal provider built on the base: all that a new dotenv-style language has to supply. */
export class StubProvider extends DotenvProviderBase {
  /** @inheritdoc */
  async describe(project: ProjectInfo): Promise<ProjectDescription> {
    const files = await this.options.fs.listDir(project.dir);
    return {
      profiles: [],
      environments: listDotenvEnvironments(files),
      profileEnvironments: {},
      defaultSelection: { environment: await this.detectEnvironment(project, files) },
      mergeLabel: STUB_LABEL,
      envVarSeparator: '__',
      watchGlobs: [...DOTENV_WATCH_GLOBS],
    };
  }
}

/**
 * Builds an in-memory file system.
 * @param files File contents by file name inside {@link STUB_DIR}.
 * @returns The file system.
 */
export function memFs(files: Record<string, string>): FileSystem {
  return {
    readFile: async (p) => files[p.replace(/\\/g, '/').slice(STUB_DIR.length + 1)],
    listDir: async () => Object.keys(files),
  };
}

/**
 * Builds provider options with neutral defaults.
 * @param fs File system to read from.
 * @param overrides Options replacing the defaults.
 * @returns The options.
 */
export function stubOptions(fs: FileSystem, overrides: Partial<DotenvProviderOptions> = {}): DotenvProviderOptions {
  return {
    fs, osEnv: {}, envFiles: ['.env', '.env.{env}'], fileOverridesOs: false,
    envPrefixes: [], nestedDelimiter: '__', environmentVariables: ['APP_ENV', 'ENV'], ...overrides,
  };
}
