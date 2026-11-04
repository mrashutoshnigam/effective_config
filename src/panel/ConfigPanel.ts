import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DotnetProvider } from '../dotnet/dotnetProvider';
import { DEFAULT_JSON_LAYERS } from '../dotnet/environments';
import { nodeFileSystem } from '../dotnet/fileSystem';
import { parseLaunchSettings } from '../dotnet/launchSettings';
import { normalizeKey } from '../engine/keys';
import { mergeLayers } from '../engine/merge';
import { buildTree } from '../engine/tree';
import type { Diagnostic, MergedEntry, SourceLocation } from '../engine/types';
import type { ProjectInfo, Selection } from '../provider';
import type { HostMessage, ViewNode, ViewState, WebviewMessage } from './messages';
import { RevealState, toViewModel } from './viewModel';

/** Default mask patterns (glob, case-insensitive). */
const DEFAULT_MASK_PATTERNS = ['*Password*', '*Secret*', '*Key*', 'ConnectionStrings:*'];

/** Label shown in the UI describing the simulated merge order. */
const MERGE_LABEL = 'Simulated — default WebApplication.CreateBuilder order';

/** The view type of the configuration webview panel. */
const VIEW_TYPE = 'effectiveConfig';

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

/** Creates a random nonce for the webview content security policy. */
function createNonce(): string {
  return randomBytes(16).toString('hex');
}

/** An editor-tab webview showing the merged configuration of one project. */
export class ConfigPanel {
  private static readonly panels = new Map<string, ConfigPanel>();
  private static mostRecent: ConfigPanel | undefined;

  /** The most recently posted view state (undefined before the first render completes). */
  lastState?: ViewState;

  private readonly panel: vscode.WebviewPanel;
  private reveals = new RevealState();
  private selectionReady = false;
  private locations = new Map<string, SourceLocation>();
  private entries: MergedEntry[] = [];
  private selection: Selection = { environment: 'Development' };
  private renderCounter = 0;
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private project: ProjectInfo,
    private projects: ProjectInfo[],
  ) {
    const distUri = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      ConfigPanel.titleFor(project),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [distUri] },
    );
    this.panel.webview.html = this.buildHtml(distUri);
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message).catch((err: unknown) => {
        void vscode.window.showErrorMessage(`Effective Config: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, undefined, context.subscriptions);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        ConfigPanel.mostRecent = this;
      }
    }, undefined, context.subscriptions);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (ConfigPanel.panels.get(this.project.id) === this) {
        ConfigPanel.panels.delete(this.project.id);
      }
      if (ConfigPanel.mostRecent === this) {
        ConfigPanel.mostRecent = undefined;
      }
    }, undefined, context.subscriptions);
  }

  /**
   * Shows the panel for a project, reusing and revealing an already open one.
   * @param context Extension context.
   * @param project Project to show.
   * @param projects All discovered projects (for the project switcher).
   * @returns The panel.
   */
  static show(context: vscode.ExtensionContext, project: ProjectInfo, projects: ProjectInfo[]): ConfigPanel {
    const existing = ConfigPanel.panels.get(project.id);
    if (existing) {
      existing.projects = projects;
      existing.panel.reveal(undefined, false);
      ConfigPanel.mostRecent = existing;
      void existing.render();
      return existing;
    }
    const created = new ConfigPanel(context, project, projects);
    ConfigPanel.panels.set(project.id, created);
    ConfigPanel.mostRecent = created;
    return created;
  }

  /** The view state of the most recently active panel, if any. */
  static get activeState(): ViewState | undefined {
    return ConfigPanel.mostRecent?.lastState;
  }

  /** Builds the panel title for a project. */
  private static titleFor(project: ProjectInfo): string {
    return `Effective Config: ${project.name}`;
  }

  /** Builds the provider from the current settings. */
  private createProvider(): DotnetProvider {
    const config = vscode.workspace.getConfiguration('effectiveConfig');
    return new DotnetProvider({
      fs: nodeFileSystem,
      osEnv: osEnvironment(),
      platform: process.platform,
      homeDir: os.homedir(),
      jsonLayers: config.get<string[]>('dotnet.jsonLayers') ?? DEFAULT_JSON_LAYERS,
    });
  }

  /** Reads the mask patterns setting. */
  private maskPatterns(): string[] {
    return vscode.workspace.getConfiguration('effectiveConfig').get<string[]>('maskPatterns') ?? DEFAULT_MASK_PATTERNS;
  }

  /** Builds the full HTML document of the webview. */
  private buildHtml(distUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Effective Config</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  /** Dispatches a message from the webview. */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.render();
        break;
      case 'select':
        await this.handleSelect(message);
        break;
      case 'reveal': {
        if (message.revealed) {
          const norm = normalizeKey(message.path);
          const entry = this.entries.find((e) => normalizeKey(e.key) === norm);
          if (entry) {
            this.reveals.reveal(message.path, entry.winner.layerId);
          }
        } else {
          this.reveals.hide(message.path);
        }
        await this.render();
        break;
      }
      case 'openSource':
        await this.openSource(message.locationId);
        break;
      case 'copy':
        // Task 9
        break;
      case 'export':
        // Task 9
        break;
      case 'refresh':
        // Task 9
        break;
    }
  }

  /** Applies a selection change (project, profile, environment) and re-renders. */
  private async handleSelect(message: Extract<WebviewMessage, { type: 'select' }>): Promise<void> {
    const provider = this.createProvider();
    if (message.projectId !== undefined && message.projectId !== this.project.id) {
      const target = this.projects.find((p) => p.id === message.projectId);
      if (target) {
        const other = ConfigPanel.panels.get(target.id);
        if (other && other !== this) {
          other.panel.reveal(undefined, false);
          await this.render();
          return;
        }
        if (ConfigPanel.panels.get(this.project.id) === this) {
          ConfigPanel.panels.delete(this.project.id);
        }
        this.project = target;
        ConfigPanel.panels.set(target.id, this);
        this.panel.title = ConfigPanel.titleFor(target);
        this.reveals = new RevealState();
        this.selection = { ...(await provider.describe(target)).defaultSelection };
        this.selectionReady = true;
      }
    }
    if (message.profile !== undefined) {
      if (message.profile === null) {
        this.selection = { environment: this.selection.environment };
      } else {
        this.selection = { profile: message.profile, environment: await this.profileEnvironment(message.profile) };
      }
    }
    if (message.environment !== undefined) {
      this.selection = { ...this.selection, environment: message.environment };
    }
    await this.render();
  }

  /** Looks up the environment a launch profile selects (default `Development`). */
  private async profileEnvironment(profileName: string): Promise<string> {
    const file = path.join(this.project.dir, 'Properties', 'launchSettings.json');
    const text = await nodeFileSystem.readFile(file);
    if (text === undefined) {
      return 'Development';
    }
    const profile = parseLaunchSettings(text, file).profiles.find((p) => p.name === profileName);
    return profile?.environmentName ?? 'Development';
  }

  /** Opens the source file of a location id at its line and column. */
  private async openSource(locationId: string): Promise<void> {
    const location = this.locations.get(locationId);
    if (!location) {
      return;
    }
    const position = new vscode.Position(location.line, location.column);
    await vscode.window.showTextDocument(vscode.Uri.file(location.filePath), {
      selection: new vscode.Range(position, position),
      preview: false,
    });
  }

  /** Builds an empty root node used when configuration could not be read. */
  private static emptyRoot(): ViewNode {
    return { segment: '', path: '', masked: false, revealed: false, sensitive: false, overridden: [], isArray: false, flags: [], children: [] };
  }

  /**
   * Computes the view state for the current selection and posts it to the webview.
   * Never throws: failures are reported as an error diagnostic with an empty tree.
   */
  async render(): Promise<void> {
    const token = ++this.renderCounter;
    const projectsInfo = this.projects.map((p) => ({ id: p.id, name: p.name }));
    let state: ViewState;
    let locations = new Map<string, SourceLocation>();
    let entries: MergedEntry[] = [];
    try {
      const provider = this.createProvider();
      const description = await provider.describe(this.project);
      if (!this.selectionReady) {
        this.selection = { ...description.defaultSelection };
        this.selectionReady = true;
      }
      const build = await provider.buildLayers(this.project, this.selection);
      entries = mergeLayers(build.layers, this.maskPatterns());
      const root = toViewModel(buildTree(entries), this.reveals.current(entries), locations);
      state = {
        projects: projectsInfo,
        projectId: this.project.id,
        profiles: description.profiles,
        profile: this.selection.profile,
        environments: description.environments,
        environment: this.selection.environment,
        root,
        diagnostics: build.diagnostics,
        label: MERGE_LABEL,
      };
    } catch (err) {
      locations = new Map();
      entries = [];
      const diagnostic: Diagnostic = {
        severity: 'error',
        message: `Failed to read configuration: ${err instanceof Error ? err.message : String(err)}`,
      };
      state = {
        projects: projectsInfo,
        projectId: this.project.id,
        profiles: [],
        profile: this.selection.profile,
        environments: [this.selection.environment],
        environment: this.selection.environment,
        root: ConfigPanel.emptyRoot(),
        diagnostics: [diagnostic],
        label: MERGE_LABEL,
      };
    }
    if (this.disposed || token !== this.renderCounter) {
      return;
    }
    this.locations = locations;
    this.entries = entries;
    this.lastState = state;
    const message: HostMessage = { type: 'state', state };
    await this.panel.webview.postMessage(message);
  }
}
