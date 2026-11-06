import { describe, it, expect } from 'vitest';
import { createProvider, discoverProjects, projectTag, type Ecosystem } from '../../src/ecosystem';
import type { ViewNode } from '../../src/panel/messages';
import { PanelSession } from '../../src/panel/session';
import { STUB_KIND, STUB_LABEL, STUB_PROJECT, StubProvider, memFs, stubOptions } from './support/stubProvider';

/** The one registry entry a new language needs; it reads one in-memory `.env` file. */
const STUB_ECOSYSTEM: Ecosystem = {
  kind: STUB_KIND,
  tag: '[Stub]',
  /** @inheritdoc */
  discover: async () => [STUB_PROJECT],
  /** @inheritdoc */
  createProvider: () => new StubProvider(stubOptions(memFs({ '.env': 'APP_ENV=dev\nHOST=h\nAPI_PASSWORD=hunter2\n' }))),
};

/** Finds a direct child of a view node by its key segment. */
function child(root: ViewNode, segment: string): ViewNode | undefined {
  return root.children.find((c) => c.segment === segment);
}

describe('provider registry', () => {
  /**
   * Validates acceptance criterion "a test registers a stub provider and sees it discovered and rendered":
   * a kind unknown to the host goes through discovery and the panel pipeline, and the view state shows
   * its tag, merge label and values, with a secret-looking value still masked.
   */
  it('discovers and renders a registered stub provider', async () => {
    const registry = [STUB_ECOSYSTEM];
    const projects = await discoverProjects(registry);
    expect(projects).toEqual([STUB_PROJECT]);

    const session = new PanelSession(projects[0], projects, {
      createProvider: (project) => createProvider(registry, project),
      maskPatterns: () => ['*Password*'],
      tag: (project) => projectTag(registry, project),
    });
    const { state } = await session.render();

    expect(state.diagnostics).toEqual([]);
    expect(state.projects).toEqual([{ id: STUB_PROJECT.id, name: STUB_PROJECT.name, kind: STUB_KIND, tag: '[Stub]' }]);
    expect(state.label).toBe(STUB_LABEL);
    expect(state.environment).toBe('dev');
    expect(child(state.root, 'HOST')?.value).toBe('h');
    expect(child(state.root, 'API_PASSWORD')?.masked).toBe(true);
    expect(JSON.stringify(state)).not.toContain('hunter2');
  });
});
