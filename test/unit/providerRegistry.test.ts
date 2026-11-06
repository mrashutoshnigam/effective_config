import { describe, it, expect } from 'vitest';
import { createProvider, discoverProjects, projectTag, type Ecosystem } from '../../src/ecosystem';
import type { ViewNode } from '../../src/panel/messages';
import { PanelSession } from '../../src/panel/session';
import type { ProjectDescription, ProjectInfo } from '../../src/provider';
import { DotenvProviderBase, type DotenvProviderOptions } from '../../src/sources/dotenvProvider';

/** A language provider nothing in the host knows about: it exists only in this test. */
class StubLanguageProvider extends DotenvProviderBase {
  /** @inheritdoc */
  async describe(): Promise<ProjectDescription> {
    return {
      profiles: [],
      environments: ['dev'],
      profileEnvironments: {},
      defaultSelection: { environment: 'dev' },
      mergeLabel: 'Simulated — stub language order',
      envVarSeparator: '__',
      watchGlobs: ['.env'],
    };
  }
}

/** The stub language project discovered by {@link STUB_ECOSYSTEM}. */
const STUB_PROJECT: ProjectInfo = { id: '/app/stub.toml', name: 'app', dir: '/app', projectFile: '/app/stub.toml', kind: 'stub-language' };

/** Options reading one in-memory `.env` file. */
const OPTIONS: DotenvProviderOptions = {
  fs: { readFile: async () => 'HOST=h\nAPI_PASSWORD=hunter2\n', listDir: async () => ['.env'] },
  osEnv: {},
  envFiles: ['.env'],
  fileOverridesOs: false,
  envPrefixes: [],
  nestedDelimiter: '__',
};

/** The one registry entry a new language needs. */
const STUB_ECOSYSTEM: Ecosystem = {
  kind: 'stub-language',
  tag: '[Stub]',
  discover: async () => [STUB_PROJECT],
  createProvider: () => new StubLanguageProvider(OPTIONS),
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
    expect(state.projects).toEqual([{ id: '/app/stub.toml', name: 'app', kind: 'stub-language', tag: '[Stub]' }]);
    expect(state.label).toBe('Simulated — stub language order');
    expect(state.environment).toBe('dev');
    expect(child(state.root, 'HOST')?.value).toBe('h');
    expect(child(state.root, 'API_PASSWORD')?.masked).toBe(true);
    expect(JSON.stringify(state)).not.toContain('hunter2');
  });
});
