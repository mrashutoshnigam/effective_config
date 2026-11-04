import * as path from 'node:path';
import * as vscode from 'vscode';
import { findOwningProject } from './dotnet/projectDiscovery';
import type { ProjectInfo } from './provider';
import { ConfigPanel } from './panel/ConfigPanel';
import type { ViewState } from './panel/messages';

/** The API returned from {@link activate}, used by integration tests. */
export interface ExtensionApi {
  /** The view state of the most recently active panel, if any. */
  getPanelState(): ViewState | undefined;
}

/**
 * Discovers .NET projects in the workspace: `.csproj` files whose directory contains `appsettings.json`.
 * @returns The discovered projects, sorted by name.
 */
async function discoverProjects(): Promise<ProjectInfo[]> {
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
      });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Implements the `effectiveConfig.show` command.
 * @param context Extension context.
 * @param uri File the command was invoked on (explorer / editor title), if any.
 */
async function showCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const projects = await discoverProjects();
  if (uri) {
    const owner = findOwningProject(uri.fsPath, projects);
    if (!owner) {
      void vscode.window.showErrorMessage('No .NET project with appsettings.json owns this file.');
      return;
    }
    ConfigPanel.show(context, owner, projects);
    return;
  }
  if (projects.length === 0) {
    void vscode.window.showInformationMessage('No .NET projects with appsettings.json found in this workspace.');
    return;
  }
  if (projects.length === 1) {
    ConfigPanel.show(context, projects[0], projects);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.dir, project: p })),
    { placeHolder: 'Select a .NET project' },
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
  return { getPanelState: () => ConfigPanel.activeState };
}

/**
 * Called by VS Code when the extension is deactivated.
 */
export function deactivate(): void {
  // Intentionally empty.
}
