import * as vscode from 'vscode';
import type { Ecosystem } from '../ecosystem';
import { osEnvironment, settingsSource } from '../hostServices';
import { nodeFileSystem } from '../sources/fileSystem';
import { NodeProvider } from './nodeProvider';
import { IGNORED_FOLDERS, NODE_KIND, NODE_MARKER, findNodeProjects } from './projectDiscovery';
import { readNodeSettings } from './settings';

/**
 * The Node ecosystem: `.env` layers in the order of the framework found in `package.json`, and the
 * OS environment. Registered before Python, so a workspace root holding `package.json` and `.env`
 * gets no Python fallback project.
 */
export const NODE_ECOSYSTEM: Ecosystem = {
  kind: NODE_KIND,
  tag: '[Node]',
  /** @inheritdoc */
  async discover() {
    const markers = await vscode.workspace.findFiles(`**/${NODE_MARKER}`, `**/{${IGNORED_FOLDERS.join(',')}}/**`);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return findNodeProjects(markers.map((u) => u.fsPath), roots, nodeFileSystem);
  },
  /** @inheritdoc */
  createProvider() {
    return new NodeProvider({ fs: nodeFileSystem, osEnv: osEnvironment(), ...readNodeSettings(settingsSource()) });
  },
  /** @inheritdoc */
  ownsFileName: (fileName) => fileName.toLowerCase() === NODE_MARKER,
};
