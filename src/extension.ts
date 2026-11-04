import * as path from 'node:path';
import * as vscode from 'vscode';
import { nodeFileSystem } from './dotnet/fileSystem';
import { findOwningProject } from './dotnet/projectDiscovery';
import { findPythonProjects } from './python/projectDiscovery';
import type { ProjectInfo } from './provider';
import { ConfigPanel } from './panel/ConfigPanel';
import type { ViewState, WebviewMessage } from './panel/messages';

/** The API returned from {@link activate}, used by integration tests. */
export interface ExtensionApi {
  /** The view state of the most recently active panel, if any. */
  getPanelState(): ViewState | undefined;
  /**
   * Test hook: delivers a webview message to the most recent panel.
   * @param message The message the webview would post.
   * @returns Resolves after the resulting render and post completed.
   */
  sendMessage(message: WebviewMessage): Promise<void>;
}

/** Matches `.env` and `.env.*` file names (case-insensitive). */
const ENV_FILE_NAME = /^\.env(\..*)?$/i;

/** Glob of files marking a Python project. */
const PYTHON_MARKER_GLOB = '**/{pyproject.toml,requirements.txt,setup.py,setup.cfg,Pipfile}';

/** Glob of folders ignored when looking for Python project markers. */
const PYTHON_EXCLUDE_GLOB = '**/{node_modules,.venv,venv,env,__pycache__,site-packages,.git,bin,obj}/**';

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

/**
 * Discovers Python projects: directories with a marker file (pyproject.toml, ...) and a `.env*` file.
 * @returns The discovered projects (`kind: 'python'`).
 */
async function discoverPythonProjects(): Promise<ProjectInfo[]> {
  const markers = await vscode.workspace.findFiles(PYTHON_MARKER_GLOB, PYTHON_EXCLUDE_GLOB);
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return findPythonProjects(markers.map((u) => u.fsPath), roots, nodeFileSystem);
}

/**
 * Discovers .NET and Python projects in the workspace.
 * @returns All projects, sorted by name and then kind.
 */
async function discoverProjects(): Promise<ProjectInfo[]> {
  const [dotnet, python] = await Promise.all([discoverDotnetProjects(), discoverPythonProjects()]);
  return [...dotnet, ...python].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/** Label of a project in the project picker, tagged by kind. */
function pickerLabel(project: ProjectInfo): string {
  return `${project.kind === 'python' ? '[Python]' : '[.NET]'} ${project.name}`;
}

/**
 * Implements the `effectiveConfig.show` command.
 * @param context Extension context.
 * @param uri File the command was invoked on (explorer / editor title), if any.
 */
async function showCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const projects = await discoverProjects();
  if (uri) {
    const owner = findOwningProject(uri.fsPath, projects, ENV_FILE_NAME.test(path.basename(uri.fsPath)) ? 'python' : 'dotnet');
    if (!owner) {
      void vscode.window.showErrorMessage('No .NET or Python project owns this file.');
      return;
    }
    ConfigPanel.show(context, owner, projects);
    return;
  }
  if (projects.length === 0) {
    void vscode.window.showInformationMessage('No .NET or Python projects found in this workspace.');
    return;
  }
  if (projects.length === 1) {
    ConfigPanel.show(context, projects[0], projects);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: pickerLabel(p), description: p.dir, project: p })),
    { placeHolder: 'Select a project' },
  );
  if (picked) {
    ConfigPanel.show(context, picked.project, projects);
  }
}

/**
 * Called by VS Code when the extension is activated.
 * @param context The extension context provided by VS Code.
 * @returns API used by integration tests.
 */
export function activate(context: vscode.ExtensionContext): ExtensionApi {
  context.subscriptions.push(
    vscode.commands.registerCommand('effectiveConfig.show', (uri?: vscode.Uri) => showCommand(context, uri)),
  );
  return { getPanelState: () => ConfigPanel.activeState, sendMessage: (message) => ConfigPanel.sendMessage(message) };
}

/**
 * Called by VS Code when the extension is deactivated.
 */
export function deactivate(): void {
  // Intentionally empty.
}
