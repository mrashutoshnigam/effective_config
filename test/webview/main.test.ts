// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Loads a fresh copy of main.ts with a stubbed VS Code API. */
async function load(saved: unknown) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const api = { postMessage: vi.fn(), getState: vi.fn(() => saved), setState: vi.fn() };
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => api;
  const mod = await import('../../src/webview/main.js');
  return { api, mod };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
});

describe('main', () => {
  it('posts ready exactly once on load', async () => {
    const { api } = await load(undefined);
    expect(api.postMessage.mock.calls.filter(([m]) => m.type === 'ready')).toHaveLength(1);
    expect(api.postMessage).toHaveBeenCalledTimes(1);
  });

  it('restore falls back to defaults for malformed saved state', async () => {
    const { mod } = await load(undefined);
    const ui = mod.restore({ mode: 5, query: 7, expanded: 'x', openChains: [1, 'a'] });
    expect(ui.mode).toBe('tree');
    expect(ui.query).toBe('');
    expect([...ui.expanded]).toEqual([]);
    expect([...ui.openChains!]).toEqual(['a']);
    expect(mod.restore(null).mode).toBe('tree');
  });

  it('restore keeps valid saved state', async () => {
    const { mod } = await load(undefined);
    const ui = mod.restore({ mode: 'flat', query: 'q', expanded: ['A', '!B'] });
    expect(ui.mode).toBe('flat');
    expect(ui.query).toBe('q');
    expect([...ui.expanded]).toEqual(['A', '!B']);
  });
});
