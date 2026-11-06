import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ecosystem } from '../ecosystem';
import { currentSettings, osEnvironment } from '../hostServices';
import type { ProjectInfo } from '../provider';
import { nodeFileSystem } from '../sources/fileSystem';
import { DotnetProvider } from './dotnetProvider';

/** Kind of a .NET project. */
const DOTNET_KIND = 'dotnet';

/**
 * Discovers .NET projects in the workspace: `.csproj` files whose directory contains `appsettings.json`.
 * @returns The discovered projects, sorted by name.
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
        kind: DOTNET_KIND,
      });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** The .NET ecosystem: `appsettings*.json`, user secrets, environment variables, launchSettings. */
export const DOTNET_ECOSYSTEM: Ecosystem = {
  kind: DOTNET_KIND,
  tag: '[.NET]',
  /** @inheritdoc */
  discover: () => discoverDotnetProjects(),
  /** @inheritdoc */
  createProvider: () =>
    new DotnetProvider({
      fs: nodeFileSystem,
      osEnv: osEnvironment(),
      platform: process.platform,
      homeDir: os.homedir(),
      jsonLayers: currentSettings().dotnet.jsonLayers,
    }),
};
