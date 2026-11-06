import * as path from 'node:path';
import * as vscode from 'vscode';
import { findOwningProject } from './dotnet/projectDiscovery';
import { discoverProjects, preferredKindForFile, projectTag } from './ecosystem';
import { ECOSYSTEMS } from './hostEcosystems';
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

/** Discovers the projects of every registered ecosystem. */
function discoverAll(): Promise<ProjectInfo[]> {
  return discoverProjects(ECOSYSTEMS, (ecosystem, err) => console.error(`Effective Config: ${ecosystem.tag} project discovery failed`, err));
}

/**
 * Implements the `effectiveConfig.show` command.
 * @param context Extension context.
 * @param uri File the command was invoked on (explorer / editor title), if any.
 */
async function showCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const projects = await discoverAll();
  if (uri) {
    const owner = findOwningProject(uri.fsPath, projects, preferredKindForFile(ECOSYSTEMS, path.basename(uri.fsPath)));
    if (!owner) {
      void vscode.window.showErrorMessage('No supported project owns this file.');
      return;
    }
    ConfigPanel.show(context, owner, projects);
    return;
  }
  if (projects.length === 0) {
    void vscode.window.showInformationMessage('No supported projects found in this workspace.');
    return;
  }
  if (projects.length === 1) {
    ConfigPanel.show(context, projects[0], projects);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: `${projectTag(ECOSYSTEMS, p)} ${p.name}`, description: p.dir, project: p })),
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
