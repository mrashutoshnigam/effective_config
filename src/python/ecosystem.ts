import * as vscode from 'vscode';
import type { Ecosystem } from '../ecosystem';
import { currentSettings, osEnvironment } from '../hostServices';
import { pythonExcludeGlob, pythonMarkerGlob } from '../settings';
import { nodeFileSystem } from '../sources/fileSystem';
import { PYTHON_KIND, dropFallbackInClaimedRoots, findPythonProjects } from './projectDiscovery';
import { PythonProvider } from './pythonProvider';

/** Matches `.env` and `.env.*` file names (case-insensitive). */
const ENV_FILE_NAME = /^\.env(\..*)?$/i;

/**
 * The Python ecosystem: `.env` layers, OS environment, launch.json. Register it after the other
 * languages, because its fallback project gives way to the projects they found.
 */
export const PYTHON_ECOSYSTEM: Ecosystem = {
  kind: PYTHON_KIND,
  tag: '[Python]',
  /** @inheritdoc */
  async discover(found) {
    const markers = await vscode.workspace.findFiles(pythonMarkerGlob(), pythonExcludeGlob());
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const python = await findPythonProjects(markers.map((u) => u.fsPath), roots, nodeFileSystem);
    return dropFallbackInClaimedRoots(python, found, roots);
  },
  /** @inheritdoc */
  createProvider(project) {
    const python = currentSettings().python;
    return new PythonProvider({
      fs: nodeFileSystem,
      osEnv: osEnvironment(),
      workspaceRoot: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.dir))?.uri.fsPath ?? project.dir,
      ...python,
    });
  },
  /** @inheritdoc */
  ownsFileName: (fileName) => ENV_FILE_NAME.test(fileName),
};
