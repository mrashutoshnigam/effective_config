import { describe, it, expect } from 'vitest';
import type { Layer } from '../../src/engine/types';
import type { ConfigProvider, LayerBuild, ProjectDescription, ProjectInfo, Selection } from '../../src/provider';
import { PanelSession } from '../../src/panel/session';
import type { ViewNode } from '../../src/panel/messages';

/** Builds a project. */
function project(id: string, kind = 'dotnet'): ProjectInfo {
  return { id, name: id, dir: `/${id}`, projectFile: `/${id}/x`, kind };
}

/** Builds a one-entry JSON layer. */
function layer(id: string, entries: [string, string][], sensitive = false): Layer {
  return {
    id, label: id, kind: 'json', sensitive, filePath: `/${id}`,
    entries: entries.map(([key, value], i) => ({ key, value, location: { filePath: `/${id}`, line: i, column: 0 } })),
  };
}

/** Description with two profiles: `web` (Production) and `cli` (no environment). */
const DESCRIPTION: ProjectDescription = {
  profiles: ['web', 'cli'],
  environments: ['Development', 'Production'],
  profileEnvironments: { web: 'Production', cli: undefined },
  defaultSelection: { profile: 'web', environment: 'Production' },
  mergeLabel: 'label',
  envVarSeparator: '__',
  watchGlobs: [],
};

/** A scriptable provider recording the selections it was asked to build. */
class FakeProvider implements ConfigProvider {
  readonly built: Selection[] = [];
  constructor(private readonly layers: Layer[], private readonly description: ProjectDescription = DESCRIPTION) {}
  async describe(): Promise<ProjectDescription> {
    return this.description;
  }
  async buildLayers(_p: ProjectInfo, selection: Selection): Promise<LayerBuild> {
    this.built.push(selection);
    return { layers: this.layers, diagnostics: [{ severity: 'info', message: 'note' }], watchPaths: ['/w'] };
  }
}

/** Creates a session whose provider is the given one. */
function session(provider: ConfigProvider, projects: ProjectInfo[] = [project('a')], maskPatterns = ['*Password*']): PanelSession {
  return new PanelSession(projects[0], projects, { createProvider: () => provider, maskPatterns: () => maskPatterns });
}

/** Finds a node by path in a view tree. */
function find(node: ViewNode, path: string): ViewNode | undefined {
  if (node.path === path) {
    return node;
  }
  for (const child of node.children) {
    const hit = find(child, path);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

describe('PanelSession.render', () => {
  it('builds the view state from the provider — default selection, project list, label and diagnostics', async () => {
    const s = session(new FakeProvider([layer('l', [['A', '1']])]), [project('a'), project('b', 'python')]);
    const r = await s.render();
    expect(r.stale).toBe(false);
    expect(r.watchPaths).toEqual(['/w']);
    expect(r.state).toMatchObject({
      projectId: 'a', profile: 'web', environment: 'Production', profiles: ['web', 'cli'], environments: ['Development', 'Production'],
      label: 'label', diagnostics: [{ severity: 'info', message: 'note' }],
    });
    expect(r.state.projects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(find(r.state.root, 'A')?.value).toBe('1');
  });

  it('masks values whose key matches a mask pattern', async () => {
    const r = await session(new FakeProvider([layer('l', [['DbPassword', 'hunter2']])])).render();
    const node = find(r.state.root, 'DbPassword');
    expect(node?.masked).toBe(true);
    expect(JSON.stringify(r.state)).not.toContain('hunter2');
  });

  it('turns a provider failure into an error diagnostic with an empty tree — it never throws', async () => {
    const failing: ConfigProvider = { async describe() { throw new Error('boom'); }, buildLayers: async () => { throw new Error('unused'); } };
    const r = await session(failing).render();
    expect(r.stale).toBe(false);
    expect(r.state.diagnostics).toEqual([{ severity: 'error', message: 'Failed to read configuration: boom' }]);
    expect(r.state.root.children).toEqual([]);
    expect(r.watchPaths).toBeUndefined();
  });

  it('marks an overtaken render stale — only the newest render wins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: ConfigProvider = {
      async describe() {
        if (++calls === 1) {
          await gate;
        }
        return DESCRIPTION;
      },
      buildLayers: async () => ({ layers: [layer('l', [['A', '1']])], diagnostics: [], watchPaths: [] }),
    };
    const s = session(provider);
    const first = s.render();
    const second = await s.render();
    release();
    expect(second.stale).toBe(false);
    expect((await first).stale).toBe(true);
  });

  it('commits entries on render — copy resolves against the latest committed render', async () => {
    const s = session(new FakeProvider([layer('l', [['A', 'new']])]));
    await s.render();
    expect(s.copy('A', 'value')).toEqual({ kind: 'text', text: 'new' });
  });
});

describe('PanelSession.select', () => {
  it('selecting a profile takes its environment — and an unknown or env-less profile falls back to Development', async () => {
    const s = session(new FakeProvider([]));
    await s.render();
    expect(await s.select({ type: 'select', profile: 'cli' }, () => false)).toEqual({ kind: 'applied', projectChanged: false });
    expect((await s.render()).state).toMatchObject({ profile: 'cli', environment: 'Development' });
  });

  it('an explicit environment overrides the profile environment', async () => {
    const s = session(new FakeProvider([]));
    await s.select({ type: 'select', profile: 'web', environment: 'Development' }, () => false);
    expect((await s.render()).state).toMatchObject({ profile: 'web', environment: 'Development' });
  });

  it('commits nothing when the provider fails to describe — the previous selection survives', async () => {
    const good = new FakeProvider([]);
    let failing = false;
    const provider: ConfigProvider = {
      describe: async (p) => { if (failing) { throw new Error('x'); } return good.describe(); },
      buildLayers: (p, sel) => good.buildLayers(p, sel),
    };
    const s = session(provider);
    await s.render();
    failing = true;
    expect(await s.select({ type: 'select', profile: 'cli' }, () => false)).toEqual({ kind: 'failed' });
    failing = false;
    expect((await s.render()).state.profile).toBe('web');
  });

  it('switching project adopts it, resets to its default selection and forgets reveals', async () => {
    const a = project('a');
    const b = project('b');
    const s = session(new FakeProvider([layer('l', [['DbPassword', 'pw']])]), [a, b]);
    await s.render();
    s.setReveal('DbPassword', true);
    expect(find((await s.render()).state.root, 'DbPassword')?.revealed).toBe(true);
    expect(await s.select({ type: 'select', projectId: 'b' }, () => false)).toEqual({ kind: 'applied', projectChanged: true });
    expect(s.project).toBe(b);
    const state = (await s.render()).state;
    expect(state.projectId).toBe('b');
    expect(find(state.root, 'DbPassword')?.revealed).toBe(false);
  });

  it('asks the caller to switch panels when the requested project is open elsewhere — nothing changes here', async () => {
    const a = project('a');
    const b = project('b');
    const s = session(new FakeProvider([]), [a, b]);
    expect(await s.select({ type: 'select', projectId: 'b' }, (p) => p.id === 'b')).toEqual({ kind: 'redirect', project: b });
    expect(s.project).toBe(a);
  });

  it('ignores a request for an unknown project id', async () => {
    const s = session(new FakeProvider([]));
    expect(await s.select({ type: 'select', projectId: 'zzz' }, () => false)).toEqual({ kind: 'applied', projectChanged: false });
    expect(s.project.id).toBe('a');
  });
});

describe('PanelSession reveal, copy, export, locations', () => {
  const secret = (): PanelSession => session(new FakeProvider([layer('l', [['DbPassword', 'pw'], ['Plain', 'v']])]));

  it('reveal shows a masked value and hide masks it again', async () => {
    const s = secret();
    await s.render();
    s.setReveal('DbPassword', true);
    expect(find((await s.render()).state.root, 'DbPassword')).toMatchObject({ revealed: true, value: 'pw' });
    s.setReveal('DbPassword', false);
    expect(find((await s.render()).state.root, 'DbPassword')?.masked).toBe(true);
  });

  it('revealing an unknown key does nothing', async () => {
    const s = secret();
    await s.render();
    s.setReveal('Nope', true);
    expect(find((await s.render()).state.root, 'Nope')).toBeUndefined();
  });

  it('copy refuses a masked value, returns a revealed or plain one, and ignores unknown keys', async () => {
    const s = secret();
    await s.render();
    expect(s.copy('DbPassword', 'value')).toEqual({ kind: 'masked' });
    expect(s.copy('Plain', 'value')).toEqual({ kind: 'text', text: 'v' });
    expect(s.copy('Nope', 'value')).toEqual({ kind: 'unknown' });
    s.setReveal('DbPassword', true);
    await s.render();
    expect(s.copy('DbPassword', 'value')).toEqual({ kind: 'text', text: 'pw' });
  });

  it('copy of a key path and env var name needs no reveal — the env var name uses the provider separator', async () => {
    const s = session(new FakeProvider([layer('l', [['Db:Password', 'pw']])]));
    await s.render();
    expect(s.copy('Db:Password', 'keyPath')).toEqual({ kind: 'text', text: 'Db:Password' });
    expect(s.copy('Db:Password', 'envVarName')).toEqual({ kind: 'text', text: 'Db__Password' });
  });

  it('export masks secrets unless revealAll is set', async () => {
    const s = secret();
    await s.render();
    expect(s.exportContent('env', false)).not.toContain('pw');
    expect(s.exportContent('env', true)).toContain('DbPassword=pw');
  });

  it('resolves a location id from the latest render and returns undefined for unknown ids', async () => {
    const s = secret();
    const node = find((await s.render()).state.root, 'Plain');
    const id = node?.winner?.locationId;
    expect(id).toBeDefined();
    expect(s.location(id as string)).toEqual({ filePath: '/l', line: 1, column: 0 });
    expect(s.location('nope')).toBeUndefined();
  });
});
