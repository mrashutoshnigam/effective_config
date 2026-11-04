// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ViewNode, ViewState, WebviewMessage } from '../../src/panel/messages';
import { render, type UiState } from '../../src/webview/render';

/** Builds a leaf node. */
function leaf(path: string, value: string | null, extra: Partial<ViewNode> = {}): ViewNode {
  return {
    segment: path.split(':').pop()!,
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

/** Builds a state around top-level nodes. */
function makeState(children: ViewNode[]): ViewState {
  return {
    projects: [{ id: 'p1', name: 'Api' }],
    projectId: 'p1',
    profiles: [],
    environments: ['Development'],
    environment: 'Development',
    root: section('', children, { segment: '' }),
    diagnostics: [],
    label: 'l',
  };
}

/** Sample tree. */
function sample(): ViewNode[] {
  return [
    section('Logging', [section('Logging:LogLevel', [leaf('Logging:LogLevel:Trace', 'x')])]),
    section('Db', [leaf('Db:Host', 'h'), leaf('Db:Password', null, { masked: true, sensitive: true })]),
  ];
}

/** Renders into a fresh attached container. */
function setup(state: ViewState, ui: UiState = { mode: 'tree', query: '', expanded: new Set() }) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const post = vi.fn<(m: WebviewMessage) => void>();
  render(el, state, ui, post);
  return { el, post, ui };
}

/** Sets a select value and fires change. */
function choose(sel: HTMLSelectElement, value: string): void {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}

describe('render re-render stability', () => {
  it('clicking a toggle keeps focus on the toggle of the same path', () => {
    const { el } = setup(makeState(sample()));
    const t = el.querySelector('[data-path="Logging:LogLevel"] [data-action=toggle]') as HTMLElement;
    t.focus();
    t.click();
    const now = el.querySelector('[data-path="Logging:LogLevel"] [data-action=toggle]');
    expect(document.activeElement).toBe(now);
    expect(now).not.toBe(t);
  });

  it('mode toggle keeps focus on the mode button', () => {
    const { el } = setup(makeState(sample()));
    (el.querySelector('[data-action=mode]') as HTMLElement).focus();
    (el.querySelector('[data-action=mode]') as HTMLElement).click();
    expect(document.activeElement).toBe(el.querySelector('[data-action=mode]'));
  });

  it('second render keeps focus and caret in the search input', () => {
    const state = makeState(sample());
    const { el, post, ui } = setup(state, { mode: 'tree', query: 'hello', expanded: new Set() });
    const input = el.querySelector('input[data-role=search]') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(2, 3);
    render(el, state, ui, post);
    const again = el.querySelector('input[data-role=search]') as HTMLInputElement;
    expect(document.activeElement).toBe(again);
    expect([again.selectionStart, again.selectionEnd]).toEqual([2, 3]);
  });

  it('second render keeps focus on a reveal button for the same path', () => {
    const state = makeState(sample());
    const { el, post, ui } = setup(state);
    (el.querySelector('[data-path="Db:Password"] [data-action=reveal]') as HTMLElement).focus();
    render(el, state, ui, post);
    expect(document.activeElement).toBe(el.querySelector('[data-path="Db:Password"] [data-action=reveal]'));
  });

  it('second render keeps expansion, open chains and custom-env text', () => {
    const node = leaf('A:B', 'win', { overridden: [{ layerLabel: 'base', value: 'old', masked: false }] });
    const state = makeState([section('A', [node, section('A:C', [leaf('A:C:D', '1')])])]);
    const { el, post, ui } = setup(state);
    (el.querySelector('[data-path="A:C"] [data-action=toggle]') as HTMLElement).click();
    const details = el.querySelector('[data-path="A:B"] details') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    choose(el.querySelector('select[data-role=environment]') as HTMLSelectElement, '__custom__');
    const input = el.querySelector('input[data-role=custom-env]') as HTMLInputElement;
    input.value = 'Qa';
    input.dispatchEvent(new Event('input'));

    render(el, state, ui, post);
    expect(el.querySelector('[data-path="A:C:D"]')).not.toBeNull();
    expect((el.querySelector('[data-path="A:B"] details') as HTMLDetailsElement).open).toBe(true);
    const input2 = el.querySelector('input[data-role=custom-env]') as HTMLInputElement;
    expect(input2.classList.contains('hidden')).toBe(false);
    expect(input2.value).toBe('Qa');
    expect(ui.openChains!.has('A:B')).toBe(true);
  });

  it('second render keeps flat mode', () => {
    const state = makeState(sample());
    const { el, post, ui } = setup(state);
    (el.querySelector('[data-action=mode]') as HTMLElement).click();
    render(el, state, ui, post);
    expect(ui.mode).toBe('flat');
    expect(el.querySelectorAll('.row .key')[0].textContent).toBe('Logging:LogLevel:Trace');
  });

  it('Escape in the custom environment input hides it and restores the select', () => {
    const { el } = setup(makeState([]));
    const sel = el.querySelector('select[data-role=environment]') as HTMLSelectElement;
    choose(sel, '__custom__');
    const input = el.querySelector('input[data-role=custom-env]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(input.classList.contains('hidden')).toBe(true);
    expect(sel.value).toBe('Development');
  });

  it('section toggles are disabled while a search is active', () => {
    const { el } = setup(makeState(sample()), { mode: 'tree', query: 'trace', expanded: new Set() });
    expect((el.querySelector('[data-path="Logging"] [data-action=toggle]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggle accessible name includes the key', () => {
    const { el } = setup(makeState(sample()));
    expect(el.querySelector('[data-path="Logging"] [data-action=toggle]')!.getAttribute('aria-label')).toBe('Collapse Logging');
    expect(el.querySelector('[data-path="Logging:LogLevel"] [data-action=toggle]')!.getAttribute('aria-label')).toBe('Expand LogLevel');
  });

  it('warning icon is a focusable image role', () => {
    const node = section('A', [leaf('A:B', '1')], { flags: ['valueAndChildren'], value: 'v' });
    const w = setup(makeState([node])).el.querySelector('.warn')!;
    expect(w.getAttribute('role')).toBe('img');
    expect(w.getAttribute('tabindex')).toBe('0');
  });

  it('search text with a trailing space is not rewritten on re-render and still filters', () => {
    const state = makeState(sample());
    const { el, post, ui } = setup(state);
    const input = el.querySelector('input[data-role=search]') as HTMLInputElement;
    input.value = 'host ';
    input.dispatchEvent(new Event('input'));
    expect(ui.query).toBe('host ');
    render(el, state, ui, post);
    expect((el.querySelector('input[data-role=search]') as HTMLInputElement).value).toBe('host ');
    expect([...el.querySelectorAll('.row')].map((r) => r.getAttribute('data-path'))).toEqual(['Db', 'Db:Host']);
  });
});
