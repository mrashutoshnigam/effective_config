import * as path from 'node:path';
import type { Diagnostic, Layer } from '../engine/types';
import type { ProjectDescription, ProjectInfo, Selection } from '../provider';
import { DotenvProviderBase, VarMap, type DotenvProviderOptions, type ProcessEnvironment } from '../sources/dotenvProviderBase';
import { listPythonEnvironments } from './environments';
import { parsePythonLaunchConfigs, type PythonLaunchConfig } from './launchJson';

/** Construction options of {@link PythonProvider}. */
export interface PythonProviderOptions extends DotenvProviderOptions {
  /** Workspace folder; the upper bound of the launch.json search and the base of relative `envFile` paths. */
  workspaceRoot: string;
  /** Names of the variables that select the environment, in priority order. */
  environmentVariables: string[];
}

const LABEL_OS_WINS = 'Simulated — python-dotenv order (OS variables win)';
const LABEL_FILES_WIN = 'Simulated — python-dotenv order (files override OS)';
const WATCH_GLOBS = ['.env', '.env.*'];
const DEFAULT_ENVIRONMENT = 'development';

/** Normalizes a path for containment comparison: forward slashes, lower case, no trailing slash. */
function normPath(p: string): string {
  const s = p.replace(/\\/g, '/').toLowerCase();
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
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
export class PythonProvider extends DotenvProviderBase<PythonProviderOptions> {
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
   * Determines the environment name: sources outer (profile env, profile envFile, `.env`, OS), the
   * configured variable names inner; the first source that defines one of them with a non-empty value wins.
   */
  private async detectEnvironment(project: ProjectInfo, files: string[], profile?: PythonLaunchConfig): Promise<string> {
    const os = this.osVars();
    const sources: VarMap[] = [];
    if (profile) {
      sources.push(VarMap.from(profile.env));
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
    return (await this.readExpandedFile(file, os))?.vars ?? new VarMap();
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

  /** Adds the selected launch.json profile to the process environment: its envFile, then its env (later wins). */
  protected override async readProcessEnvironment(project: ProjectInfo, selection: Selection): Promise<ProcessEnvironment> {
    const diagnostics: Diagnostic[] = [];
    const watchPaths: string[] = [];

    const launch = await this.readLaunch(project);
    watchPaths.push(launch.file, project.projectFile);
    for (const candidate of [...launch.candidates, path.join(this.options.workspaceRoot, '.vscode', 'launch.json')]) {
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

    const vars = this.osVars();
    const layers: Layer[] = [];
    if (profile?.envFile !== undefined) {
      watchPaths.push(profile.envFile);
      const read = await this.readExpandedFile(profile.envFile, vars);
      if (read === undefined) {
        diagnostics.push({ severity: 'warning', message: `envFile not found: ${profile.envFile}` });
      } else {
        diagnostics.push(...read.diagnostics);
        vars.merge(read.vars);
        layers.push({
          id: 'envFile', label: `Env file (launch.json: ${profile.name})`, kind: 'envFile',
          sensitive: path.basename(profile.envFile).toLowerCase().includes('secret'),
          filePath: profile.envFile, entries: read.entries,
        });
      }
    }
    if (profile && Object.keys(profile.env).length > 0) {
      vars.merge(VarMap.from(profile.env));
      layers.push({
        id: 'envProfile', label: `Environment (launch.json: ${profile.name})`, kind: 'envProfile', sensitive: false,
        entries: Object.entries(profile.env).map(([name, value]) => ({ key: this.key(name), value })),
      });
    }
    return { vars, layers, diagnostics, watchPaths };
  }
}
