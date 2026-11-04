import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DotnetProvider } from '../dotnet/dotnetProvider';
import { DEFAULT_JSON_LAYERS } from '../dotnet/environments';
import { nodeFileSystem } from '../dotnet/fileSystem';
import { normalizeKey } from '../engine/keys';
import { mergeLayers } from '../engine/merge';
import { buildTree } from '../engine/tree';
import type { Diagnostic, MergedEntry, SourceLocation } from '../engine/types';
import type { ProjectDescription, ProjectInfo, Selection } from '../provider';
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

/** Type guard validating the shape of a message received from the webview. */
function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const m = value as Record<string, unknown>;
  const optString = (v: unknown): boolean => v === undefined || typeof v === 'string';
  switch (m.type) {
    case 'ready':
    case 'refresh':
      return true;
    case 'select':
      return optString(m.projectId) && (m.profile === null || optString(m.profile)) && optString(m.environment);
    case 'reveal':
      return typeof m.path === 'string' && typeof m.revealed === 'boolean';
    case 'openSource':
      return typeof m.locationId === 'string';
    case 'copy':
      return typeof m.path === 'string' && (m.what === 'value' || m.what === 'keyPath' || m.what === 'envVarName');
    case 'export':
      return (m.format === 'json' || m.format === 'env') && typeof m.revealAll === 'boolean';
    default:
      return false;
  }
}

/** An editor-tab webview showing the merged configuration of one project. */
export class ConfigPanel {
  private static readonly panels = new Map<string, ConfigPanel>();
  private static mostRecent: ConfigPanel | undefined;

  /** The most recently posted view state (undefined before the first render completes). */
  private latestState?: ViewState;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
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
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isWebviewMessage(message)) {
        return;
      }
      void this.handleMessage(message).catch((err: unknown) => {
        void vscode.window.showErrorMessage(`Effective Config: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, undefined, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        ConfigPanel.mostRecent = this;
      }
    }, undefined, this.disposables);
    this.panel.onDidDispose(() => {
      this.disposables.forEach((d) => d.dispose());
      this.disposables.length = 0;
      this.disposed = true;
      if (ConfigPanel.panels.get(this.project.id) === this) {
        ConfigPanel.panels.delete(this.project.id);
      }
      if (ConfigPanel.mostRecent === this) {
        ConfigPanel.mostRecent = undefined;
      }
    }, undefined, this.disposables);
  }

  /** The most recently posted view state (undefined before the first render completes). */
  get lastState(): ViewState | undefined {
    return this.latestState;
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
    return ConfigPanel.mostRecent?.latestState;
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

  /** Applies a selection change (project, profile, environment) and re-renders; state is committed only on success. */
  private async handleSelect(message: Extract<WebviewMessage, { type: 'select' }>): Promise<void> {
    try {
      const provider = this.createProvider();
      let target = this.project;
      let selection = this.selection;
      let description: ProjectDescription | undefined;
      if (message.projectId !== undefined && message.projectId !== this.project.id) {
        const requested = this.projects.find((p) => p.id === message.projectId);
        if (requested) {
          const other = ConfigPanel.panels.get(requested.id);
          if (other && other !== this) {
            other.panel.reveal(undefined, false);
            await this.render();
            return;
          }
          description = await provider.describe(requested);
          target = requested;
          selection = { ...description.defaultSelection };
        }
      }
      if (message.profile !== undefined) {
        if (message.profile === null) {
          selection = { environment: selection.environment };
        } else {
          description ??= await provider.describe(target);
          selection = { profile: message.profile, environment: description.profileEnvironments[message.profile] ?? 'Development' };
        }
      }
      if (message.environment !== undefined) {
        selection = { ...selection, environment: message.environment };
      }
      if (target !== this.project) {
        if (ConfigPanel.panels.get(this.project.id) === this) {
          ConfigPanel.panels.delete(this.project.id);
        }
        this.project = target;
        ConfigPanel.panels.set(target.id, this);
        this.panel.title = ConfigPanel.titleFor(target);
        this.reveals = new RevealState();
      }
      this.selection = selection;
      this.selectionReady = true;
    } catch {
      // Nothing committed; render reports the failure as an error diagnostic.
    }
    await this.render();
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
      const root = toViewModel(buildTree(entries), this.reveals.current(entries), locations, `r${token}`);
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
    this.latestState = state;
    const message: HostMessage = { type: 'state', state };
    await this.panel.webview.postMessage(message);
  }
}
