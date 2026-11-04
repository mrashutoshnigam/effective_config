import type { ViewNode, ViewState, WebviewMessage } from '../panel/messages';
import { el } from './dom';
import { renderToolbar } from './toolbar';
import { renderBody } from './tree';

/** UI state persisted across reloads with `acquireVsCodeApi().setState`. */
export interface UiState {
  /** Tree or flat presentation. */
  mode: 'tree' | 'flat';
  /** Current search text. */
  query: string;
  /** Explicit expansion choices: `path` = expanded, `!path` = collapsed; absent = default. */
  expanded: Set<string>;
}

/**
 * Tells whether a node itself matches the query. Masked values never match.
 * @param node Node to test.
 * @param q Lower-cased, non-empty query.
 * @returns True on a path or value match.
 */
function matches(node: ViewNode, q: string): boolean {
  if (node.path.toLowerCase().includes(q)) {
    return true;
  }
  return !node.masked && typeof node.value === 'string' && node.value.toLowerCase().includes(q);
}

/**
 * Filters the tree by a case-insensitive query on key path or unmasked value.
 * Ancestors of matches are kept; a matched node keeps all its descendants.
 * @param root Root node.
 * @param query Search text; empty returns `root` unchanged.
 * @returns The filtered root, or `undefined` when nothing matches.
 */
export function filterViewTree(root: ViewNode, query: string): ViewNode | undefined {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return root;
  }
  const walk = (node: ViewNode): ViewNode | undefined => {
    if (node.path !== '' && matches(node, q)) {
      return node;
    }
    const children = node.children.map(walk).filter((c): c is ViewNode => c !== undefined);
    return children.length > 0 ? { ...node, children } : undefined;
  };
  return walk(root);
}

/**
 * Returns the file name of a path using either separator.
 * @param filePath Full path.
 * @returns The last path segment.
 */
function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * Builds the diagnostics banner, one row per diagnostic.
 * @param diagnostics Diagnostics to show.
 * @returns The banner element.
 */
function renderDiagnostics(diagnostics: ViewState['diagnostics']): HTMLElement {
  const banner = el('div', 'diagnostics');
  for (const d of diagnostics) {
    const text = d.location ? `${basename(d.location.filePath)}:${d.location.line + 1}: ${d.message}` : d.message;
    banner.append(el('div', `diagnostic ${d.severity}`, text));
  }
  return banner;
}

/**
 * Renders the whole webview UI into `container`, replacing its content.
 * @param container Root element.
 * @param state View state from the host.
 * @param ui Mutable UI state (mode, query, expansion).
 * @param post Sends a message to the host.
 * @param onUiChange Optional callback fired whenever `ui` changes, e.g. to persist it.
 */
export function render(
  container: HTMLElement,
  state: ViewState,
  ui: UiState,
  post: (m: WebviewMessage) => void,
  onUiChange?: () => void,
): void {
  const changed = (): void => onUiChange?.();
  const body = el('div', 'body');
  const rerenderBody = (): void => renderBody(body, filterViewTree(state.root, ui.query), { ui, post, rerender: rerenderBody, changed });

  const toolbar = renderToolbar(state, ui, {
    post,
    onModeChange: () => {
      changed();
      render(container, state, ui, post, onUiChange);
    },
    onQueryChange: () => {
      changed();
      rerenderBody();
    },
  });
  rerenderBody();
  container.replaceChildren(toolbar, el('div', 'label', state.label), renderDiagnostics(state.diagnostics), body);
}
