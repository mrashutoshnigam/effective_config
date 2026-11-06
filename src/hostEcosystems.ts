import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DotnetProvider } from './dotnet/dotnetProvider';
import type { Ecosystem } from './ecosystem';
import type { ProjectInfo } from './provider';
import { dropFallbackInDotnetRoots, findPythonProjects } from './python/projectDiscovery';
import { PythonProvider } from './python/pythonProvider';
import { readSettings, pythonExcludeGlob, pythonMarkerGlob, type Settings } from './settings';
import { nodeFileSystem } from './sources/fileSystem';

/** Matches `.env` and `.env.*` file names (case-insensitive). */
const ENV_FILE_NAME = /^\.env(\..*)?$/i;

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

/** Reads the current extension settings with defaults applied. */
export function currentSettings(): Settings {
  const section = vscode.workspace.getConfiguration('effectiveConfig');
  return readSettings({ get: <T>(key: string) => section.get<T>(key) });
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
      jsonLayers: currentSettings().dotnet.jsonLayers,
    }),
};

/** The Python ecosystem: `.env` layers, OS environment, launch.json. */
const PYTHON: Ecosystem = {
  kind: 'python',
  tag: '[Python]',
  async discover(found) {
    const markers = await vscode.workspace.findFiles(pythonMarkerGlob(), pythonExcludeGlob());
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const python = await findPythonProjects(markers.map((u) => u.fsPath), roots, nodeFileSystem);
    return dropFallbackInDotnetRoots(python, found.filter((p) => p.kind === 'dotnet'), roots);
  },
  createProvider(project) {
    const python = currentSettings().python;
    return new PythonProvider({
      fs: nodeFileSystem,
      osEnv: osEnvironment(),
      workspaceRoot: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.dir))?.uri.fsPath ?? project.dir,
      ...python,
    });
  },
  ownsFileName: (fileName) => ENV_FILE_NAME.test(fileName),
};

/**
 * The ecosystems this extension supports, in discovery order. The first entry is also the default
 * for files no ecosystem claims. Add a new ecosystem here.
 */
export const ECOSYSTEMS: readonly Ecosystem[] = [DOTNET, PYTHON];
