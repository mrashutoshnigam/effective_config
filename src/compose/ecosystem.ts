import * as vscode from 'vscode';
import type { Ecosystem } from '../ecosystem';
import { osEnvironment, settingsSource } from '../hostServices';
import { nodeFileSystem } from '../sources/fileSystem';
import { ComposeProvider } from './composeProvider';
import { COMPOSE_EXCLUDE_GLOB, COMPOSE_KIND, COMPOSE_MARKER_GLOB, findComposeProjects, ownsComposeFileName } from './projectDiscovery';
import { readComposeSettings } from './settings';

/**
 * The Docker Compose ecosystem: the environment one service's container receives. Registered before
 * Python, so a workspace root holding `compose.yaml` and `.env` gets no Python fallback project.
 */
export const COMPOSE_ECOSYSTEM: Ecosystem = {
  kind: COMPOSE_KIND,
  tag: '[Compose]',
  /** @inheritdoc */
  async discover() {
    const markers = await vscode.workspace.findFiles(COMPOSE_MARKER_GLOB, COMPOSE_EXCLUDE_GLOB);
    return findComposeProjects(markers.map((u) => u.fsPath));
  },
  /** @inheritdoc */
  createProvider(project) {
    const { files } = readComposeSettings(settingsSource(vscode.Uri.file(project.dir)));
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return new ComposeProvider({ fs: nodeFileSystem, osEnv: osEnvironment(), files, workspaceRoots });
  },
  /** @inheritdoc */
  ownsFileName: ownsComposeFileName,
};
