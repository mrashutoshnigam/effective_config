import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DotnetProvider } from './dotnet/dotnetProvider';
import { DEFAULT_JSON_LAYERS } from './dotnet/environments';
import type { Ecosystem } from './ecosystem';
import type { ProjectInfo } from './provider';
import { DEFAULT_ENV_FILES, DEFAULT_ENV_NAME_VARIABLES } from './python/environments';
import { dropFallbackInDotnetRoots, findPythonProjects } from './python/projectDiscovery';
import { PythonProvider } from './python/pythonProvider';
import { nodeFileSystem } from './sources/fileSystem';

/** Matches `.env` and `.env.*` file names (case-insensitive). */
const ENV_FILE_NAME = /^\.env(\..*)?$/i;

/** Glob of files marking a Python project. */
const PYTHON_MARKER_GLOB = '**/{pyproject.toml,requirements.txt,setup.py,setup.cfg,Pipfile}';

/** Glob of folders ignored when looking for Python project markers. */
const PYTHON_EXCLUDE_GLOB = '**/{node_modules,.venv,venv,env,__pycache__,site-packages,.git,bin,obj}/**';

/** Returns a copy of `process.env` without undefined values. */
function osEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Reads the `effectiveConfig` settings section. */
function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('effectiveConfig');
}

/**
 * Discovers .NET projects in the workspace: `.csproj` files whose directory contains `appsettings.json`.
 * @returns The discovered projects (`kind: 'dotnet'`), sorted by name.
 */
async function discoverDotnetProjects(): Promise<ProjectInfo[]> {
  const uris = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**');
  const projects: ProjectInfo[] = [];
  for (const uri of uris) {
    const dir = path.dirname(uri.fsPath);
    let names: [string, vscode.FileType][];
    try {
      names = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      continue;
    }
    if (names.some(([name]) => name.toLowerCase() === 'appsettings.json')) {
      projects.push({
        id: uri.fsPath,
        name: path.basename(uri.fsPath, path.extname(uri.fsPath)),
        dir,
        projectFile: uri.fsPath,
        kind: 'dotnet',
      });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** The .NET ecosystem: `appsettings*.json`, user secrets, environment variables, launchSettings. */
const DOTNET: Ecosystem = {
  kind: 'dotnet',
  tag: '[.NET]',
  discover: () => discoverDotnetProjects(),
  createProvider: () =>
    new DotnetProvider({
      fs: nodeFileSystem,
      osEnv: osEnvironment(),
      platform: process.platform,
      homeDir: os.homedir(),
      jsonLayers: settings().get<string[]>('dotnet.jsonLayers') ?? DEFAULT_JSON_LAYERS,
    }),
};

/** The Python ecosystem: `.env` layers, OS environment, launch.json. */
const PYTHON: Ecosystem = {
  kind: 'python',
  tag: '[Python]',
  async discover(found) {
    const markers = await vscode.workspace.findFiles(PYTHON_MARKER_GLOB, PYTHON_EXCLUDE_GLOB);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const python = await findPythonProjects(markers.map((u) => u.fsPath), roots, nodeFileSystem);
    return dropFallbackInDotnetRoots(python, found.filter((p) => p.kind === 'dotnet'), roots);
  },
  createProvider(project) {
    const config = settings();
    return new PythonProvider({
      fs: nodeFileSystem,
      osEnv: osEnvironment(),
      workspaceRoot: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.dir))?.uri.fsPath ?? project.dir,
      envFiles: config.get<string[]>('python.envFiles') ?? DEFAULT_ENV_FILES,
      fileOverridesOs: config.get<boolean>('python.fileOverridesOs') ?? false,
      envPrefixes: config.get<string[]>('python.envPrefixes') ?? [],
      nestedDelimiter: config.get<string>('python.nestedDelimiter') ?? '__',
      environmentVariables: config.get<string[]>('python.environmentVariables') ?? DEFAULT_ENV_NAME_VARIABLES,
    });
  },
  ownsFileName: (fileName) => ENV_FILE_NAME.test(fileName),
};

/**
 * The ecosystems this extension supports, in discovery order. The first entry is also the default
 * for files no ecosystem claims. Add a new ecosystem here.
 */
export const ECOSYSTEMS: readonly Ecosystem[] = [DOTNET, PYTHON];
