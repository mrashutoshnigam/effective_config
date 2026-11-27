import * as path from 'node:path';
import type { Diagnostic } from '../engine/types';
import { parseDotenv, type DotenvEntry } from '../sources/dotenv';
import { VarMap } from '../sources/dotenvProviderBase';
import type { FileSystem } from '../sources/fileSystem';
import { interpolate, type InterpolationResult } from './interpolation';

/** Primary compose file names, in the order Compose looks for them. */
export const PRIMARY_COMPOSE_FILES: readonly string[] = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Override file names; each pairs with the primary file of its family (`compose.*` or `docker-compose.*`). */
export const OVERRIDE_COMPOSE_FILES: readonly string[] = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];

/** Env file Compose reads for interpolation when no `--env-file` is given. */
export const DEFAULT_ENV_FILE = '.env';

/**
 * Compares two strings case-insensitively.
 * @param a First string.
 * @param b Second string.
 * @returns Negative, zero or positive, as for `Array.prototype.sort`.
 */
function compareIgnoreCase(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/**
 * Lists the env files offered in the dropdown.
 * @param fileNames File names in the project directory.
 * @returns `.env` first, then other `.env.*` and `*.env` files, sorted case-insensitively.
 */
export function listComposeEnvFiles(fileNames: string[]): string[] {
  const others = fileNames.filter((name) => {
    const lower = name.toLowerCase();
    return lower !== DEFAULT_ENV_FILE && (lower.startsWith(`${DEFAULT_ENV_FILE}.`) || (lower.endsWith(DEFAULT_ENV_FILE) && lower.length > DEFAULT_ENV_FILE.length));
  });
  return [DEFAULT_ENV_FILE, ...others.sort(compareIgnoreCase)];
}

/** One env file line after interpolation. */
export interface ExpandedEnvEntry {
  /** The parsed line. */
  entry: DotenvEntry;
  /** Its interpolation; single-quoted values are kept literally, with nothing read. */
  result: InterpolationResult;
}

/**
 * Interpolates the lines of an env file the way Compose v2 does. Unquoted and double-quoted values are
 * interpolated, single-quoted ones are literal (https://docs.docker.com/reference/compose-file/services/#env_file-format).
 * A reference is looked up in `scope` first and then in `parsed`, the values parsed so far: compose-go's
 * `dotenv.expandVariables` calls the lookup function before reading the vars map its parser writes
 * every line into, and a service passes one map through all of its env_files.
 * @param entries Parsed lines in source order.
 * @param scope Variables that win over the parsed lines.
 * @param parsed Values of earlier lines; each line's value is written into it, latest wins.
 * @returns Each line with its interpolation, in source order.
 */
export function expandEnvFileEntries(entries: DotenvEntry[], scope: (name: string) => string | undefined, parsed: VarMap = new VarMap()): ExpandedEnvEntry[] {
  return entries.map((entry) => {
    const result = entry.expand
      ? interpolate(entry.value, (name) => scope(name) ?? parsed.get(name))
      : { value: entry.value, references: [], unset: [], errors: [] };
    parsed.set(entry.name, result.value);
    return { entry, result };
  });
}

/** Interpolation scope of a project: the env file below the OS environment. */
export interface ComposeScope {
  /** Variables in scope, OS over env file. */
  vars: VarMap;
  /** Absolute path of the env file. */
  envFilePath: string;
  /** True when the env file exists. */
  envFileFound: boolean;
  /** Problems met reading the env file; messages never quote values. */
  diagnostics: Diagnostic[];
}

/**
 * Reads the interpolation scope, as for `docker compose --env-file <envFile>`. Compose documents the
 * shell as ranking above the env file (https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
 * @param fs File system to read from.
 * @param projectDir Directory the env file is relative to.
 * @param envFile Env file name or relative path.
 * @param osEnv OS environment variables.
 * @returns The scope. A missing `.env` is normal; another missing env file gives a warning. Unset
 * references inside the env file give no diagnostics, failed `:?` checks give errors at their line.
 */
export async function readComposeScope(fs: FileSystem, projectDir: string, envFile: string, osEnv: Record<string, string>): Promise<ComposeScope> {
  const envFilePath = path.join(projectDir, envFile);
  const os = VarMap.from(osEnv);
  const vars = new VarMap();
  const diagnostics: Diagnostic[] = [];
  const text = await fs.readFile(envFilePath);
  if (text === undefined) {
    if (envFile !== DEFAULT_ENV_FILE) {
      diagnostics.push({ severity: 'warning', message: `env file not found: ${envFile}` });
    }
  } else {
    const parsed = parseDotenv(text, envFilePath);
    // A bare `KEY` line inherits the shell value in Compose, which the OS layer of the scope already gives,
    // so the parser's python-dotenv note about it does not apply.
    diagnostics.push(...parsed.diagnostics.filter((d) => d.severity !== 'info'));
    for (const { entry, result } of expandEnvFileEntries(parsed.entries, (name) => os.get(name))) {
      vars.set(entry.name, result.value);
      diagnostics.push(...result.errors.map((message): Diagnostic => ({ severity: 'error', message, location: entry.location })));
    }
  }
  vars.merge(os);
  return { vars, envFilePath, envFileFound: text !== undefined, diagnostics };
}

/** Compose files to load and the directory they are relative to. */
export interface ComposeFileSet {
  /** Absolute paths in load order, base file first. */
  files: string[];
  /** Absolute paths of every file listed or found, whether it exists or not; watched for changes. */
  considered: string[];
  /** Project directory: the directory of the first file, as in Compose. */
  projectDir: string;
  /** Problems met finding the files. */
  diagnostics: Diagnostic[];
}

/**
 * Resolves a path written in a setting, a variable or a compose file.
 * @param baseDir Directory relative paths start from.
 * @param file Path as written.
 * @returns The absolute, normalized path.
 */
export function resolveFrom(baseDir: string, file: string): string {
  return path.isAbsolute(file) ? path.normalize(file) : path.join(baseDir, file);
}

/**
 * Finds the directory the env file and the env-file dropdown resolve from. compose-go's `WithEnvFiles`
 * (cli/options.go) looks for the default `.env` in `ProjectOptions.GetWorkingDir()`: the directory of
 * the first `-f` file, else the working directory. `COMPOSE_FILE` is applied later (`WithConfigFileEnv`),
 * so it never moves the env file it may itself come from; the primary compose file's directory stands
 * in for the working directory.
 * @param primaryFile The project's primary compose file.
 * @param settingFiles Files from `effectiveConfig.compose.files`, which act like `-f`.
 * @returns The directory of the first setting file, else the primary file's directory.
 */
export function envFileDir(primaryFile: string, settingFiles: string[]): string {
  const baseDir = path.dirname(primaryFile);
  return settingFiles.length > 0 ? path.dirname(resolveFrom(baseDir, settingFiles[0])) : baseDir;
}

/**
 * Keeps the listed files that exist.
 * @param fs File system to read from.
 * @param baseDir Directory relative paths start from.
 * @param listed Paths as listed.
 * @returns The existing files, every listed path and an error per missing one.
 */
async function existingFiles(fs: FileSystem, baseDir: string, listed: string[]): Promise<Omit<ComposeFileSet, 'projectDir'>> {
  const files: string[] = [];
  const considered: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const file of listed) {
    const absolute = resolveFrom(baseDir, file);
    considered.push(absolute);
    if ((await fs.readFile(absolute)) === undefined) {
      diagnostics.push({ severity: 'error', message: `compose file not found: ${file.replace(/\\/g, '/')}` });
    } else {
      files.push(absolute);
    }
  }
  return { files, considered, diagnostics };
}

/**
 * Finds the default compose files of a directory, as `docker compose` without `-f` does.
 * @param fs File system to list the directory with.
 * @param dir Directory to look in.
 * @returns The first primary file present and the override file of its family, when present.
 */
async function defaultFiles(fs: FileSystem, dir: string): Promise<string[]> {
  const names = await fs.listDir(dir);
  /**
   * Finds a name in the listing, ignoring case.
   * @param wanted Name to find.
   * @returns The name as listed, or undefined.
   */
  const find = (wanted: string): string | undefined => names.find((n) => n.toLowerCase() === wanted);
  const primary = PRIMARY_COMPOSE_FILES.find((name) => find(name) !== undefined);
  if (primary === undefined) {
    return [];
  }
  const family = primary.startsWith('docker-') ? 'docker-compose.' : 'compose.';
  const override = OVERRIDE_COMPOSE_FILES.find((name) => name.startsWith(family) && find(name) !== undefined);
  return [primary, ...(override === undefined ? [] : [override])].map((name) => path.join(dir, find(name) as string));
}

/**
 * Picks the compose files to load, in Compose's order of precedence: the setting (like `-f`), else
 * `COMPOSE_FILE` split on `COMPOSE_PATH_SEPARATOR` (`;` on Windows, `:` elsewhere, per
 * https://docs.docker.com/compose/how-tos/environment-variables/envvars/), else the default files.
 * @param fs File system to read from.
 * @param primaryFile The project's primary compose file; relative paths start from its directory.
 * @param settingFiles Files from `effectiveConfig.compose.files`, lowest priority first.
 * @param scope Interpolation scope, which may set `COMPOSE_FILE`.
 * @param platform Platform deciding the default separator.
 * @returns The files, every path considered, the project directory and an error per listed file that does not exist.
 */
export async function resolveComposeFiles(
  fs: FileSystem,
  primaryFile: string,
  settingFiles: string[],
  scope: VarMap,
  platform: NodeJS.Platform = process.platform,
): Promise<ComposeFileSet> {
  const baseDir = path.dirname(primaryFile);
  let found: Omit<ComposeFileSet, 'projectDir'>;
  const composeFile = scope.get('COMPOSE_FILE');
  if (settingFiles.length > 0) {
    found = await existingFiles(fs, baseDir, settingFiles);
  } else if (composeFile) {
    const separator = scope.get('COMPOSE_PATH_SEPARATOR') || (platform === 'win32' ? ';' : ':');
    const listed = composeFile.split(separator).map((f) => f.trim()).filter((f) => f !== '');
    found = await existingFiles(fs, baseDir, listed);
  } else {
    const files = await defaultFiles(fs, baseDir);
    found = { files, considered: files, diagnostics: [] };
  }
  const projectDir = found.files.length > 0 ? path.dirname(found.files[0]) : baseDir;
  return { ...found, projectDir };
}

/**
 * Wraps a file system to record the files it reads.
 * @param fs File system to read from.
 * @param read Receives the absolute path of every file read that exists.
 * @returns The recording file system.
 */
export function recordingFileSystem(fs: FileSystem, read: Set<string>): FileSystem {
  return {
    /**
     * Reads a file and records its path when it exists.
     * @param file Absolute file path.
     * @returns The contents, or undefined when the file does not exist.
     */
    async readFile(file: string): Promise<string | undefined> {
      const text = await fs.readFile(file);
      if (text !== undefined) {
        read.add(file);
      }
      return text;
    },
    listDir: (dir) => fs.listDir(dir),
  };
}

/**
 * Tells whether a path lies inside a directory or is that directory.
 * @param dir Absolute directory path.
 * @param file Absolute path to check.
 * @returns True when `file` is `dir` or below it; case-insensitive on Windows, as `path.relative` is.
 */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Notes the files read outside the workspace. Compose reads them, so the simulation does too, but a
 * compose file in an untrusted workspace can point anywhere, so the user is told.
 * @param read Absolute paths of the files read.
 * @param workspaceRoots Absolute workspace folder paths; undefined skips the check.
 * @returns One info per path outside every workspace folder, in read order.
 */
export function outsideWorkspaceNotes(read: Iterable<string>, workspaceRoots: readonly string[] | undefined): Diagnostic[] {
  if (workspaceRoots === undefined) {
    return [];
  }
  return [...read]
    .filter((file) => !workspaceRoots.some((root) => isWithin(root, file)))
    .map((file): Diagnostic => ({ severity: 'info', message: `reads a file outside the workspace: ${file}` }));
}

/**
 * Reads the active profiles.
 * @param scope Interpolation scope.
 * @returns The names in `COMPOSE_PROFILES`, comma separated, trimmed, empties dropped.
 */
export function activeProfiles(scope: VarMap): string[] {
  return (scope.get('COMPOSE_PROFILES') ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
}
