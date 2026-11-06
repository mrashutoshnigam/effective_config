import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { createProvider, projectTag } from '../ecosystem';
import { ECOSYSTEMS } from '../hostEcosystems';
import { normalizeKey } from '../engine/keys';
import { copyText, exportText } from './actions';
import { mergeLayers } from '../engine/merge';
import { buildTree } from '../engine/tree';
import type { Diagnostic, MergedEntry, SourceLocation } from '../engine/types';
import type { ConfigProvider, ProjectDescription, ProjectInfo, Selection } from '../provider';
import type { HostMessage, ViewNode, ViewState, WebviewMessage } from './messages';
import { nextSelection } from './selection';
import { RevealState, toViewModel } from './viewModel';
import { watchTargetKey, watchTargetsFor, type WatchTarget } from './watchTargets';

/** Default mask patterns (glob, case-insensitive). */
const DEFAULT_MASK_PATTERNS = ['*Password*', '*Secret*', '*Key*', '*TOKEN*', 'ConnectionStrings:*'];

/** Delay in milliseconds before a file change triggers a re-render. */
const REFRESH_DEBOUNCE_MS = 200;

/** The view type of the configuration webview panel. */
const VIEW_TYPE = 'effectiveConfig';

/** The export choices offered by the Export quick pick. */
const EXPORT_CHOICES: { label: string; format: 'json' | 'env'; revealAll: boolean }[] = [
  { label: 'JSON', format: 'json', revealAll: false },
  { label: 'KEY=value', format: 'env', revealAll: false },
  { label: 'JSON (reveal all)', format: 'json', revealAll: true },
  { label: 'KEY=value (reveal all)', format: 'env', revealAll: true },
];

/** Returns true when `dir` is an existing directory. */
function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
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
    case 'exportMenu':
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
  /** Description of the shown project from the latest render; supplies label, separator and watch globs. */
  private description?: ProjectDescription;
  private renderCounter = 0;
  private disposed = false;
  private watchers: vscode.Disposable[] = [];
  private watchedKeys = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

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
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'panel-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'panel-dark.svg'),
    };
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('effectiveConfig')) {
        void this.render();
      }
    }, undefined, this.disposables);
    this.panel.onDidDispose(() => {
      this.clearWatchers();
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

  /**
   * Test hook: runs a webview message through the most recent panel's handler.
   * @param message The message, as the webview would post it.
   * @returns Resolves after the resulting render and post completed.
   * @throws When no panel is open or the message is malformed.
   */
  static async sendMessage(message: WebviewMessage): Promise<void> {
    const target = ConfigPanel.mostRecent;
    if (!target) {
      throw new Error('No Effective Config panel is open');
    }
    if (!isWebviewMessage(message)) {
      throw new Error('Malformed webview message');
    }
    await target.handleMessage(message);
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

  /** Builds the provider for a project from its registered ecosystem and the current settings. */
  private createProvider(project: ProjectInfo = this.project): ConfigProvider {
    return createProvider(ECOSYSTEMS, project);
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
        await this.copy(message.path, message.what);
        break;
      case 'exportMenu':
        await this.exportMenu();
        break;
      case 'export':
        await this.export(message.format, message.revealAll);
        break;
      case 'refresh':
        // Force the watchers to be rebuilt, e.g. when a watched folder did not exist before.
        this.watchedKeys = new Set();
        await this.render();
        break;
    }
  }

  /** Copies a value, key path or env var name to the clipboard; masked values are not copied. */
  private async copy(keyPath: string, what: 'value' | 'keyPath' | 'envVarName'): Promise<void> {
    const norm = normalizeKey(keyPath);
    const known = this.entries.some((e) => {
      const key = normalizeKey(e.key);
      return key === norm || key.startsWith(`${norm}:`);
    });
    if (!known) {
      return;
    }
    const text = copyText(this.entries, keyPath, what, this.reveals.current(this.entries), this.description?.envVarSeparator);
    if (text === undefined) {
      void vscode.window.showInformationMessage('Reveal the value before copying');
      return;
    }
    await vscode.env.clipboard.writeText(text);
  }

  /** Lets the user pick an export format via a quick pick, then runs the export. */
  private async exportMenu(): Promise<void> {
    const picked = await vscode.window.showQuickPick(EXPORT_CHOICES, { placeHolder: 'Export merged configuration as...' });
    if (picked) {
      await this.export(picked.format, picked.revealAll);
    }
  }

  /** Exports the merged configuration into an untitled document; revealing secrets needs confirmation. */
  private async export(format: 'json' | 'env', revealAll: boolean): Promise<void> {
    if (revealAll) {
      const choice = await vscode.window.showWarningMessage('Export will include secret values in plain text.', { modal: true }, 'Export');
      if (choice !== 'Export') {
        return;
      }
    }
    const content = exportText(this.entries, format, revealAll, this.description?.envVarSeparator);
    const doc = await vscode.workspace.openTextDocument({ content, language: format === 'json' ? 'json' : 'properties' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Disposes all file watchers and the pending debounce timer. */
  private clearWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this.watchedKeys = new Set();
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /** Schedules a debounced re-render after a watched file changed. */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.disposed) {
        void this.render();
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Rebuilds the file watchers when the set of watch targets changed. Each file is watched from its nearest
   * existing ancestor folder, so files in not-yet-created folders (such as user secrets) are picked up later.
   */
  private syncWatchers(paths: string[]): void {
    const targets: WatchTarget[] = watchTargetsFor(paths, isDirectory);
    for (const pattern of this.description?.watchGlobs ?? []) {
      targets.push({ base: this.project.dir, pattern });
    }
    const next = new Set(targets.map(watchTargetKey));
    if (next.size === this.watchedKeys.size && [...next].every((k) => this.watchedKeys.has(k))) {
      return;
    }
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    for (const target of targets) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(target.base), target.pattern));
      watcher.onDidCreate(() => this.scheduleRefresh());
      watcher.onDidChange(() => this.scheduleRefresh());
      watcher.onDidDelete(() => this.scheduleRefresh());
      this.watchers.push(watcher);
    }
    this.watchedKeys = next;
  }

  /** Applies a selection change (project, profile, environment) and re-renders; state is committed only on success. */
  private async handleSelect(message: Extract<WebviewMessage, { type: 'select' }>): Promise<void> {
    try {
      let target = this.project;
      if (message.projectId !== undefined && message.projectId !== this.project.id) {
        const requested = this.projects.find((p) => p.id === message.projectId);
        if (requested) {
          const other = ConfigPanel.panels.get(requested.id);
          if (other && other !== this) {
            other.panel.reveal(undefined, false);
            await this.render();
            return;
          }
          target = requested;
        }
      }
      const provider = this.createProvider(target);
      const projectChanged = target !== this.project;
      const needsDescription = projectChanged || (message.profile !== undefined && message.profile !== null);
      const description = needsDescription ? await provider.describe(target) : undefined;
      const selection = nextSelection(this.selection, message, description, projectChanged);
      if (target !== this.project) {
        if (ConfigPanel.panels.get(this.project.id) === this) {
          ConfigPanel.panels.delete(this.project.id);
        }
        this.project = target;
        ConfigPanel.panels.set(target.id, this);
        this.panel.title = ConfigPanel.titleFor(target);
        this.reveals = new RevealState();
      }
      if (description) {
        this.description = description;
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
    const projectsInfo = this.projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind, tag: projectTag(ECOSYSTEMS, p) }));
    let state: ViewState;
    let locations = new Map<string, SourceLocation>();
    let entries: MergedEntry[] = [];
    let watchPaths: string[] | undefined;
    try {
      const provider = this.createProvider();
      const description = await provider.describe(this.project);
      this.description = description;
      if (!this.selectionReady) {
        this.selection = { ...description.defaultSelection };
        this.selectionReady = true;
      }
      const build = await provider.buildLayers(this.project, this.selection);
      watchPaths = build.watchPaths;
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
        label: description.mergeLabel,
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
        label: this.description?.mergeLabel ?? '',
      };
    }
    if (this.disposed || token !== this.renderCounter) {
      return;
    }
    this.locations = locations;
    this.entries = entries;
    if (watchPaths) {
      this.syncWatchers(watchPaths);
    }
    this.latestState = state;
    const message: HostMessage = { type: 'state', state };
    await this.panel.webview.postMessage(message);
  }
}
