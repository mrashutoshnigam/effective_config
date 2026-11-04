import type { HostMessage, ViewState, WebviewMessage } from '../panel/messages';
import { render, type UiState } from './render';

/** The VS Code webview API handle. */
interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Shape of the state persisted through `setState`. */
interface PersistedState {
  mode?: 'tree' | 'flat';
  query?: string;
  expanded?: string[];
}

/**
 * Restores the UI state from the persisted value, tolerating missing or malformed data.
 * @param saved Value returned by `getState`.
 * @returns A valid UI state.
 */
function restore(saved: unknown): UiState {
  const s = (saved ?? {}) as PersistedState;
  return {
    mode: s.mode === 'flat' ? 'flat' : 'tree',
    query: typeof s.query === 'string' ? s.query : '',
    expanded: new Set(Array.isArray(s.expanded) ? s.expanded.filter((x) => typeof x === 'string') : []),
  };
}

/**
 * Webview entry point: restores UI state, renders host state messages and announces readiness.
 */
export function main(): void {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('app');
  if (!container) {
    return;
  }
  const ui = restore(vscode.getState());
  const post = (m: WebviewMessage): void => vscode.postMessage(m);
  const persist = (): void => vscode.setState({ mode: ui.mode, query: ui.query, expanded: [...ui.expanded] });
  let current: ViewState | undefined;

  window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    if (event.data?.type === 'state') {
      current = event.data.state;
      render(container, current, ui, post, persist);
    }
  });
  post({ type: 'ready' });
}

main();
