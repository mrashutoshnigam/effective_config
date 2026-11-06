import { normalizeKey } from '../engine/keys';
import { mergeLayers } from '../engine/merge';
import { buildTree } from '../engine/tree';
import type { Diagnostic, MergedEntry, SourceLocation } from '../engine/types';
import type { ConfigProvider, ProjectDescription, ProjectInfo, Selection } from '../provider';
import { copyText, exportText } from './actions';
import type { ViewNode, ViewState } from './messages';
import { nextSelection, type SelectMessage } from './selection';
import { RevealState, toViewModel } from './viewModel';

/** What a {@link PanelSession} needs from its host; both are read on every use so setting changes apply immediately. */
export interface SessionDeps {
  /** Builds the provider for a project. */
  createProvider(project: ProjectInfo): ConfigProvider;
  /** Current mask patterns. */
  maskPatterns(): string[];
  /** Picker tag of a project, e.g. `[.NET]`; defaults to `[kind]`. */
  tag?(project: ProjectInfo): string;
}

/** Result of {@link PanelSession.render}. */
export interface RenderResult {
  /** The view state to post (an error state when reading failed). */
  state: ViewState;
  /** Paths whose changes should trigger a re-render; undefined when reading failed. */
  watchPaths?: string[];
  /** True when a newer render started meanwhile; the caller must discard this result. */
  stale: boolean;
}

/** Result of {@link PanelSession.copy}. */
export type CopyOutcome = { kind: 'unknown' } | { kind: 'masked' } | { kind: 'text'; text: string };

/** Result of {@link PanelSession.select}. */
export type SelectOutcome =
  | { kind: 'applied'; projectChanged: boolean }
  | { kind: 'failed' }
  | { kind: 'redirect'; project: ProjectInfo };

/** Builds an empty root node used when configuration could not be read. */
function emptyRoot(): ViewNode {
  return { segment: '', path: '', masked: false, revealed: false, sensitive: false, overridden: [], isArray: false, flags: [], children: [] };
}

/**
 * The state and behaviour behind one configuration panel: the shown project, the user's selection,
 * reveals, and the pipeline that turns provider layers into a masked view state. It has no
 * dependency on VS Code, so every behaviour can be tested through this interface.
 */
export class PanelSession {
  private reveals = new RevealState();
  private selectionReady = false;
  private selection: Selection = { environment: 'Development' };
  private description?: ProjectDescription;
  private entries: MergedEntry[] = [];
  private locations = new Map<string, SourceLocation>();
  private renderCounter = 0;

  /**
   * @param current The project shown first.
   * @param all All discovered projects, for the project switcher.
   * @param deps Host services.
   */
  constructor(
    private current: ProjectInfo,
    private all: ProjectInfo[],
    private readonly deps: SessionDeps,
  ) {}

  /** The project currently shown. */
  get project(): ProjectInfo {
    return this.current;
  }

  /** Replaces the project list offered by the switcher. */
  setProjects(projects: ProjectInfo[]): void {
    this.all = projects;
  }

  /** Glob patterns, relative to the project directory, of extra files to watch (from the latest render). */
  get watchGlobs(): string[] {
    return this.description?.watchGlobs ?? [];
  }

  /** Reads the sources for the current selection and produces the view state. Never throws. */
  async render(): Promise<RenderResult> {
    const token = ++this.renderCounter;
    const projects = this.all.map((p) => ({ id: p.id, name: p.name, kind: p.kind, tag: this.tagOf(p) }));
    let state: ViewState;
    let locations = new Map<string, SourceLocation>();
    let entries: MergedEntry[] = [];
    let watchPaths: string[] | undefined;
    try {
      const provider = this.deps.createProvider(this.current);
      const description = await provider.describe(this.current);
      this.description = description;
      if (!this.selectionReady) {
        this.selection = { ...description.defaultSelection };
        this.selectionReady = true;
      }
      const build = await provider.buildLayers(this.current, this.selection);
      watchPaths = build.watchPaths;
      entries = mergeLayers(build.layers, this.deps.maskPatterns());
      const root = toViewModel(buildTree(entries), this.reveals.current(entries), locations, `r${token}`);
      state = {
        projects,
        projectId: this.current.id,
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
      watchPaths = undefined;
      const diagnostic: Diagnostic = {
        severity: 'error',
        message: `Failed to read configuration: ${err instanceof Error ? err.message : String(err)}`,
      };
      state = {
        projects,
        projectId: this.current.id,
        profiles: [],
        profile: this.selection.profile,
        environments: [this.selection.environment],
        environment: this.selection.environment,
        root: emptyRoot(),
        diagnostics: [diagnostic],
        label: this.description?.mergeLabel ?? '',
      };
    }
    const stale = token !== this.renderCounter;
    if (!stale) {
      this.locations = locations;
      this.entries = entries;
    }
    return { state, watchPaths, stale };
  }

  /**
   * Applies a selection message. State is committed only on success.
   * @param message The select message from the webview.
   * @param isOpenElsewhere Tells whether another panel already shows a project.
   * @returns `redirect` when the requested project is open in another panel (nothing changes),
   * `failed` when the target could not be described (nothing changes), else `applied`.
   */
  async select(message: SelectMessage, isOpenElsewhere: (project: ProjectInfo) => boolean): Promise<SelectOutcome> {
    try {
      let target = this.current;
      if (message.projectId !== undefined && message.projectId !== this.current.id) {
        const requested = this.all.find((p) => p.id === message.projectId);
        if (requested) {
          if (isOpenElsewhere(requested)) {
            return { kind: 'redirect', project: requested };
          }
          target = requested;
        }
      }
      const projectChanged = target !== this.current;
      const needsDescription = projectChanged || (message.profile !== undefined && message.profile !== null);
      const description = needsDescription ? await this.deps.createProvider(target).describe(target) : undefined;
      const selection = nextSelection(this.selection, message, description, projectChanged);
      if (projectChanged) {
        this.current = target;
        this.reveals = new RevealState();
      }
      if (description) {
        this.description = description;
      }
      this.selection = selection;
      this.selectionReady = true;
      return { kind: 'applied', projectChanged };
    } catch {
      return { kind: 'failed' };
    }
  }

  /**
   * Reveals or hides one value. Revealing an unknown key does nothing.
   * @param keyPath Key path of the value.
   * @param revealed True to reveal, false to hide.
   */
  setReveal(keyPath: string, revealed: boolean): void {
    if (!revealed) {
      this.reveals.hide(keyPath);
      return;
    }
    const norm = normalizeKey(keyPath);
    const entry = this.entries.find((e) => normalizeKey(e.key) === norm);
    if (entry) {
      this.reveals.reveal(keyPath, entry.winner.layerId);
    }
  }

  /**
   * Resolves what to copy for a key.
   * @param keyPath Key path (case-insensitive); section rows are allowed.
   * @param what Which representation to copy.
   * @returns `unknown` for a key the tree does not contain, `masked` for a sensitive value that is
   * not revealed, else the text.
   */
  copy(keyPath: string, what: 'value' | 'keyPath' | 'envVarName'): CopyOutcome {
    const norm = normalizeKey(keyPath);
    const known = this.entries.some((e) => {
      const key = normalizeKey(e.key);
      return key === norm || key.startsWith(`${norm}:`);
    });
    if (!known) {
      return { kind: 'unknown' };
    }
    const text = copyText(this.entries, keyPath, what, this.reveals.current(this.entries), this.description?.envVarSeparator);
    return text === undefined ? { kind: 'masked' } : { kind: 'text', text };
  }

  /**
   * Renders the merged configuration for export.
   * @param format `json` or `env`.
   * @param revealAll True to include sensitive values in plain text (the caller must have confirmed).
   */
  exportContent(format: 'json' | 'env', revealAll: boolean): string {
    return exportText(this.entries, format, revealAll, this.description?.envVarSeparator);
  }

  /** Resolves a location id handed out by the latest committed render. */
  location(id: string): SourceLocation | undefined {
    return this.locations.get(id);
  }

  /** Picker tag of a project, from the host when it provides one. */
  private tagOf(project: ProjectInfo): string {
    return this.deps.tag?.(project) ?? `[${project.kind}]`;
  }
}
