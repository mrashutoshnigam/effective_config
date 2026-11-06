import * as vscode from 'vscode';
import type { Ecosystem } from '../ecosystem';
import { currentSettings, osEnvironment } from '../hostServices';
import { pythonExcludeGlob, pythonMarkerGlob } from '../settings';
import { nodeFileSystem } from '../sources/fileSystem';
import { dropFallbackInDotnetRoots, findPythonProjects } from './projectDiscovery';
import { PythonProvider } from './pythonProvider';

/** Matches `.env` and `.env.*` file names (case-insensitive). */
const ENV_FILE_NAME = /^\.env(\..*)?$/i;

/** The Python ecosystem: `.env` layers, OS environment, launch.json. */
export const PYTHON_ECOSYSTEM: Ecosystem = {
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
