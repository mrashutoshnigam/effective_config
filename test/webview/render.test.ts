// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ViewNode, ViewState, WebviewMessage } from '../../src/panel/messages';
import { filterViewTree, render, type UiState } from '../../src/webview/render';

/** Builds a leaf node with sensible defaults. */
function leaf(path: string, value: string | null | undefined, extra: Partial<ViewNode> = {}): ViewNode {
  const segment = path.split(':').pop()!;
  return {
    segment,
    path,
    value,
    masked: false,
    revealed: false,
    sensitive: false,
    winner: { layerLabel: 'appsettings.json', locationId: `loc:${path}` },
    overridden: [],
    isArray: false,
    flags: [],
    children: [],
    ...extra,
  };
}

/** Builds a section node. */
function section(path: string, children: ViewNode[], extra: Partial<ViewNode> = {}): ViewNode {
  return {
    segment: path.split(':').pop()!,
    path,
    masked: false,
    revealed: false,
    sensitive: false,
    overridden: [],
    isArray: false,
    flags: [],
    children,
    ...extra,
  };
}

/** Builds a complete view state around the given top-level nodes. */
function makeState(children: ViewNode[], extra: Partial<ViewState> = {}): ViewState {
  return {
    projects: [{ id: 'p1', name: 'Api' }],
    projectId: 'p1',
    profiles: ['https', 'iis'],
    profile: 'https',
    environments: ['Development', 'Production'],
    environment: 'Development',
    root: section('', children, { segment: '' }),
    diagnostics: [],
    label: 'Simulated — default WebApplication.CreateBuilder order',
    ...extra,
  };
}

/** Fresh UI state. */
function makeUi(extra: Partial<UiState> = {}): UiState {
  return { mode: 'tree', query: '', expanded: new Set<string>(), ...extra };
}

/** Sample tree used by several tests. */
function sampleChildren(): ViewNode[] {
  return [
    section('Logging', [
      section('Logging:LogLevel', [leaf('Logging:LogLevel:Default', 'Information'), leaf('Logging:LogLevel:Trace', 'x')]),
    ]),
    section('Db', [leaf('Db:Host', 'localhost'), leaf('Db:Password', null, { masked: true, sensitive: true })]),
  ];
}

/** Renders into a fresh container. */
function setup(state: ViewState, ui = makeUi()) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const post = vi.fn<(m: WebviewMessage) => void>();
  render(el, state, ui, post);
  return { el, post, ui };
}

/** Fires a change event after setting a select's value. */
function choose(sel: HTMLSelectElement, value: string): void {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}

describe('filterViewTree', () => {
  it('returns undefined when nothing matches', () => {
    expect(filterViewTree(makeState(sampleChildren()).root, 'zzz')).toBeUndefined();
  });

  it('keeps only ancestors of a matching leaf — search "trace" leaves Logging chain', () => {
    const r = filterViewTree(makeState(sampleChildren()).root, 'TRACE')!;
    expect(r.children.map((c) => c.path)).toEqual(['Logging']);
    expect(r.children[0].children[0].children.map((c) => c.path)).toEqual(['Logging:LogLevel:Trace']);
  });

  it('keeps all descendants of a matched section', () => {
    const r = filterViewTree(makeState(sampleChildren()).root, 'loglevel')!;
    expect(r.children[0].children[0].children).toHaveLength(2);
  });

  it('matches on unmasked value case-insensitively', () => {
    const r = filterViewTree(makeState(sampleChildren()).root, 'LOCALHOST')!;
    expect(r.children[0].children.map((c) => c.path)).toEqual(['Db:Host']);
  });

  it('never matches a masked value', () => {
    const root = makeState([leaf('A:B', 'p@ss', { masked: true, sensitive: true })]).root;
    expect(filterViewTree(root, 'p@ss')).toBeUndefined();
  });

  it('returns the root unchanged for an empty query', () => {
    const root = makeState(sampleChildren()).root;
    expect(filterViewTree(root, '')).toBe(root);
  });
});

describe('render', () => {
  it('masked value renders dots and reveal posts message without leaking the value', () => {
    const { el, post } = setup(makeState(sampleChildren()));
    expect(el.textContent).toContain('••••••');
    (el.querySelector('[data-action=reveal]') as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'reveal', path: 'Db:Password', revealed: true });
    expect(el.textContent).not.toContain('p@ss');
  });

  it('revealed sensitive value shows hide button that posts revealed false', () => {
    const state = makeState([leaf('Db:Password', 'p@ss', { sensitive: true, revealed: true })]);
    const { el, post } = setup(state);
    expect(el.textContent).toContain('p@ss');
    (el.querySelector('[data-action=hide]') as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'reveal', path: 'Db:Password', revealed: false });
  });

  it('hides the copy-value button when masked but keeps key path and env var copies', () => {
    const { el, post } = setup(makeState(sampleChildren()));
    const row = el.querySelector('[data-path="Db:Password"]')!;
    expect(row.querySelector('[data-action=copy-value]')).toBeNull();
    (row.querySelector('[data-action=copy-key]') as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'copy', path: 'Db:Password', what: 'keyPath' });
    (row.querySelector('[data-action=copy-env]') as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'copy', path: 'Db:Password', what: 'envVarName' });
  });

  it('copy value button posts copy with what=value', () => {
    const { el, post } = setup(makeState(sampleChildren()));
    (el.querySelector('[data-path="Db:Host"] [data-action=copy-value]') as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'copy', path: 'Db:Host', what: 'value' });
  });

  it('flat mode lists one row per valued node with the full key path', () => {
    const { el } = setup(makeState(sampleChildren()), makeUi({ mode: 'flat' }));
    const keys = [...el.querySelectorAll('.row .key')].map((k) => k.textContent);
    expect(keys).toEqual(['Logging:LogLevel:Default', 'Logging:LogLevel:Trace', 'Db:Host', 'Db:Password']);
  });

  it('search "trace" shows only Logging ancestors, fully expanded', () => {
    const { el } = setup(makeState(sampleChildren()), makeUi({ query: 'trace' }));
    const paths = [...el.querySelectorAll('.row')].map((r) => r.getAttribute('data-path'));
    expect(paths).toEqual(['Logging', 'Logging:LogLevel', 'Logging:LogLevel:Trace']);
  });

  it('top-level sections are expanded and deeper ones collapsed by default', () => {
    const { el } = setup(makeState(sampleChildren()));
    const paths = [...el.querySelectorAll('.row')].map((r) => r.getAttribute('data-path'));
    expect(paths).toEqual(['Logging', 'Logging:LogLevel', 'Db', 'Db:Host', 'Db:Password']);
    const toggle = el.querySelector('[data-path="Logging:LogLevel"] [data-action=toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking a section toggle expands it and records it in ui.expanded', () => {
    const { el, ui } = setup(makeState(sampleChildren()));
    (el.querySelector('[data-path="Logging:LogLevel"] [data-action=toggle]') as HTMLElement).click();
    expect(el.querySelector('[data-path="Logging:LogLevel:Trace"]')).not.toBeNull();
    expect(ui.expanded.has('Logging:LogLevel')).toBe(true);
  });

  it('valueAndChildren flag shows tooltip "section also has a direct value"', () => {
    const node = section('A', [leaf('A:B', '1')], { value: 'v', flags: ['valueAndChildren'] });
    const { el } = setup(makeState([node]));
    const w = el.querySelector('.warn')!;
    expect(w.getAttribute('title')).toBe('section also has a direct value');
    expect(w.getAttribute('aria-label')).toBe('section also has a direct value');
    expect(w.textContent).toBe('⚠');
  });

  it('mixedArray flag shows tooltip "array items come from multiple sources"', () => {
    const node = section('A', [leaf('A:0', '1')], { isArray: true, flags: ['mixedArray'] });
    const { el } = setup(makeState([node]));
    expect(el.querySelector('.warn')!.getAttribute('title')).toBe('array items come from multiple sources');
  });

  it('diagnostic error renders banner with file name and line+1', () => {
    const state = makeState([], {
      diagnostics: [
        { severity: 'error', message: 'bad json', location: { filePath: 'C:\\x\\appsettings.json', line: 4, column: 0 } },
        { severity: 'warning', message: 'just a note' },
      ],
    });
    const { el } = setup(state);
    const rows = el.querySelectorAll('.diagnostic');
    expect(rows[0].textContent).toBe('appsettings.json:5: bad json');
    expect(rows[0].classList.contains('error')).toBe(true);
    expect(rows[1].textContent).toBe('just a note');
    expect(rows[1].classList.contains('warning')).toBe(true);
  });

  it('winner badge click posts openSource with locationId', () => {
    const { el, post } = setup(makeState(sampleChildren()));
    (el.querySelector('[data-path="Db:Host"] .badge') as HTMLElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'openSource', locationId: 'loc:Db:Host' });
  });

  it('override chain lists winner first then overridden newest first, with placeholders', () => {
    const node = leaf('A:B', 'win', {
      overridden: [
        { layerLabel: 'base', value: 'old', masked: false },
        { layerLabel: 'mid', value: null, masked: true, locationId: 'm1' },
        { layerLabel: 'empty', value: null, masked: false },
      ],
    });
    const { el, post } = setup(makeState([section('A', [node])]));
    const items = [...el.querySelectorAll('[data-path="A:B"] details li')].map((li) => li.textContent);
    expect(items).toEqual(['appsettings.json win', 'empty (empty section)', 'mid (masked)', 'base old']);
    const midBtn = [...el.querySelectorAll('[data-path="A:B"] details button')].find(
      (b) => b.textContent === 'mid',
    ) as HTMLElement;
    midBtn.click();
    expect(post).toHaveBeenCalledWith({ type: 'openSource', locationId: 'm1' });
  });

  it('shows the label line verbatim', () => {
    const { el } = setup(makeState([]));
    expect(el.querySelector('.label')!.textContent).toBe('Simulated — default WebApplication.CreateBuilder order');
  });

  it('never interprets config values as HTML', () => {
    const { el } = setup(makeState([leaf('A', '<img src=x onerror=alert(1)>')]));
    expect(el.querySelector('img')).toBeNull();
  });

  it('profile select offers (none) first and posts null for it', () => {
    const { el, post } = setup(makeState([]));
    const sel = el.querySelector('select[data-role=profile]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['(none)', 'https', 'iis']);
    choose(sel, '');
    expect(post).toHaveBeenCalledWith({ type: 'select', profile: null });
    choose(sel, 'iis');
    expect(post).toHaveBeenCalledWith({ type: 'select', profile: 'iis' });
  });

  it('project select is hidden for a single project and posts projectId otherwise', () => {
    expect(setup(makeState([])).el.querySelector('select[data-role=project]')).toBeNull();
    const state = makeState([], {
      projects: [
        { id: 'p1', name: 'Api' },
        { id: 'p2', name: 'Web' },
      ],
    });
    const { el, post } = setup(state);
    choose(el.querySelector('select[data-role=project]') as HTMLSelectElement, 'p2');
    expect(post).toHaveBeenCalledWith({ type: 'select', projectId: 'p2' });
  });

  it('environment select posts the environment; Custom… shows input and Enter posts trimmed text', () => {
    const { el, post } = setup(makeState([]));
    const sel = el.querySelector('select[data-role=environment]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Development', 'Production', 'Custom…']);
    choose(sel, 'Production');
    expect(post).toHaveBeenCalledWith({ type: 'select', environment: 'Production' });
    const input = el.querySelector('input[data-role=custom-env]') as HTMLInputElement;
    expect(input.classList.contains('hidden')).toBe(true);
    choose(sel, '__custom__');
    expect(input.classList.contains('hidden')).toBe(false);
    input.value = '  Qa  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(post).toHaveBeenLastCalledWith({ type: 'select', environment: 'Qa' });
    post.mockClear();
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(post).not.toHaveBeenCalled();
  });

  it('Export… button posts exportMenu once per click — no message on mere render', () => {
    const { el, post } = setup(makeState([]));
    expect(post).not.toHaveBeenCalled();
    expect(el.querySelector('select[data-role=export]')).toBeNull();
    (el.querySelector('[data-action=export]') as HTMLElement).click();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ type: 'exportMenu' });
  });

  it('refresh button posts refresh', () => {
    const { el, post } = setup(makeState([]));
    (el.querySelector('[data-action=refresh]') as HTMLElement).click();
    expect(post).toHaveBeenLastCalledWith({ type: 'refresh' });
  });

  it('section rows offer copy key path and env var name but no copy value', () => {
    const { el, post } = setup(makeState(sampleChildren()));
    const row = el.querySelector('[data-path="Db"]')!;
    expect(row.querySelector('[data-action=copy-value]')).toBeNull();
    (row.querySelector('[data-action=copy-key]') as HTMLElement).click();
    expect(post).toHaveBeenLastCalledWith({ type: 'copy', path: 'Db', what: 'keyPath' });
    (row.querySelector('[data-action=copy-env]') as HTMLElement).click();
    expect(post).toHaveBeenLastCalledWith({ type: 'copy', path: 'Db', what: 'envVarName' });
  });

  it('typing in search filters the body and updates ui.query', () => {
    const { el, ui } = setup(makeState(sampleChildren()));
    const input = el.querySelector('input[data-role=search]') as HTMLInputElement;
    input.value = 'host';
    input.dispatchEvent(new Event('input'));
    expect(ui.query).toBe('host');
    expect([...el.querySelectorAll('.row')].map((r) => r.getAttribute('data-path'))).toEqual(['Db', 'Db:Host']);
  });

  it('mode toggle switches between tree and flat', () => {
    const { el, ui } = setup(makeState(sampleChildren()));
    (el.querySelector('[data-action=mode]') as HTMLElement).click();
    expect(ui.mode).toBe('flat');
    expect(el.querySelectorAll('.row .key')[0].textContent).toBe('Logging:LogLevel:Default');
  });
});
