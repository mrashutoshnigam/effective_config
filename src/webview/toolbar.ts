import type { ViewState, WebviewMessage } from '../panel/messages';
import { button, el } from './dom';
import type { UiState } from './render';

/** Sentinel option value for the "Custom…" environment entry. */
const CUSTOM = '__custom__';

/** Hooks the toolbar needs from the renderer. */
export interface ToolbarHooks {
  /** Posts a message to the host. */
  post: (m: WebviewMessage) => void;
  /** Called when the tree/flat mode changed. */
  onModeChange: () => void;
  /** Called when the search text changed. */
  onQueryChange: () => void;
}

/**
 * Builds a select element.
 * @param role Value for `data-role`.
 * @param label Accessible label.
 * @param options Option value/text pairs.
 * @param selected Value to select.
 * @returns The select.
 */
function makeSelect(role: string, label: string, options: [string, string][], selected: string): HTMLSelectElement {
  const s = el('select');
  s.dataset.role = role;
  s.title = label;
  s.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const o = el('option', undefined, text);
    o.value = value;
    s.append(o);
  }
  s.value = selected;
  return s;
}

/**
 * Builds the toolbar: project, profile, environment, mode toggle, search, refresh and export.
 * @param state View state.
 * @param ui UI state (mode and query are read and written).
 * @param hooks Callbacks.
 * @returns The toolbar element.
 */
export function renderToolbar(state: ViewState, ui: UiState, hooks: ToolbarHooks): HTMLElement {
  const bar = el('div', 'toolbar');
  const { post } = hooks;

  if (state.projects.length > 1) {
    const p = makeSelect('project', 'Project', state.projects.map((x): [string, string] => [x.id, `${x.kind === 'python' ? '[Python]' : '[.NET]'} ${x.name}`]), state.projectId);
    p.addEventListener('change', () => post({ type: 'select', projectId: p.value }));
    bar.append(p);
  }

  const profile = makeSelect(
    'profile',
    'Launch profile',
    [['', '(none)'], ...state.profiles.map((x): [string, string] => [x, x])],
    state.profile ?? '',
  );
  profile.addEventListener('change', () => post({ type: 'select', profile: profile.value === '' ? null : profile.value }));
  bar.append(profile);

  const envs = state.environments.includes(state.environment) ? state.environments : [...state.environments, state.environment];
  const env = makeSelect(
    'environment',
    'Environment',
    [...envs.map((x): [string, string] => [x, x]), [CUSTOM, 'Custom…']],
    ui.customEnvOpen ? CUSTOM : state.environment,
  );
  const custom = el('input', ui.customEnvOpen ? '' : 'hidden');
  custom.type = 'text';
  custom.dataset.role = 'custom-env';
  custom.value = ui.customEnvText ?? '';
  custom.placeholder = 'Environment name, Enter to apply';
  custom.setAttribute('aria-label', 'Custom environment name');
  env.addEventListener('change', () => {
    if (env.value === CUSTOM) {
      ui.customEnvOpen = true;
      custom.classList.remove('hidden');
      custom.focus();
    } else {
      ui.customEnvOpen = false;
      ui.customEnvText = '';
      custom.classList.add('hidden');
      post({ type: 'select', environment: env.value });
    }
  });
  custom.addEventListener('keydown', (e) => {
    const text = custom.value.trim();
    if (e.key === 'Enter' && text !== '') {
      ui.customEnvOpen = false;
      ui.customEnvText = '';
      post({ type: 'select', environment: text });
    } else if (e.key === 'Escape') {
      ui.customEnvOpen = false;
      ui.customEnvText = '';
      custom.value = '';
      custom.classList.add('hidden');
      env.value = state.environment;
      env.focus();
    }
  });
  custom.addEventListener('input', () => {
    ui.customEnvText = custom.value;
  });
  bar.append(env, custom);

  const mode = button(ui.mode === 'tree' ? 'Tree' : 'Flat', 'mode', () => {
    ui.mode = ui.mode === 'tree' ? 'flat' : 'tree';
    hooks.onModeChange();
  }, 'Toggle tree / flat view');
  bar.append(mode);

  const search = el('input');
  search.type = 'search';
  search.dataset.role = 'search';
  search.placeholder = 'Search key or value';
  search.setAttribute('aria-label', 'Search');
  search.value = ui.query;
  search.addEventListener('input', () => {
    ui.query = search.value;
    hooks.onQueryChange();
  });
  bar.append(search);

  bar.append(button('Refresh', 'refresh', () => post({ type: 'refresh' }), 'Refresh'));

  bar.append(button('Export…', 'export', () => post({ type: 'exportMenu' }), 'Export'));
  return bar;
}
