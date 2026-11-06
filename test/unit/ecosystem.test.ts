import { describe, it, expect } from 'vitest';
import type { ConfigProvider, ProjectInfo } from '../../src/provider';
import { createProvider, discoverProjects, ecosystemFor, preferredKindForFile, projectTag, type Ecosystem } from '../../src/ecosystem';

/** Builds a project of the given kind. */
function project(kind: string, name: string): ProjectInfo {
  return { id: `/${name}`, name, dir: `/${name}`, projectFile: `/${name}/x`, kind };
}

/** A provider stub that is never called. */
const stubProvider = {} as ConfigProvider;

/** Builds an ecosystem stub that discovers the given projects. */
function eco(kind: string, found: ProjectInfo[], over: Partial<Ecosystem> = {}): Ecosystem {
  return { kind, tag: `[${kind}]`, discover: async () => found, createProvider: () => stubProvider, ...over };
}

describe('discoverProjects', () => {
  it('merges the projects of every ecosystem, sorted by name then kind', async () => {
    const all = await discoverProjects([eco('b', [project('b', 'zed'), project('b', 'app')]), eco('a', [project('a', 'app')])]);
    expect(all.map((p) => `${p.name}:${p.kind}`)).toEqual(['app:a', 'app:b', 'zed:b']);
  });

  it('hands each ecosystem the projects found by the ecosystems before it', async () => {
    let seen: ProjectInfo[] = [];
    const first = eco('a', [project('a', 'one')]);
    const second = eco('b', [], {
      discover: async (found) => {
        seen = found;
        return [project('b', 'two')];
      },
    });
    await discoverProjects([first, second]);
    expect(seen.map((p) => p.name)).toEqual(['one']);
  });

  it('keeps the other ecosystems working when one discovery throws — reports the failure', async () => {
    const failures: string[] = [];
    const boom = eco('bad', [], {
      discover: async () => {
        throw new Error('nope');
      },
    });
    const all = await discoverProjects([boom, eco('ok', [project('ok', 'x')])], (e) => failures.push(e.kind));
    expect(all.map((p) => p.name)).toEqual(['x']);
    expect(failures).toEqual(['bad']);
  });

  it('returns nothing for an empty registry', async () => {
    expect(await discoverProjects([])).toEqual([]);
  });
});

describe('ecosystemFor / projectTag / createProvider', () => {
  const registry = [eco('dotnet', []), eco('python', [], { tag: '[Python]' })];

  it('finds the ecosystem by kind', () => {
    expect(ecosystemFor(registry, 'python')?.tag).toBe('[Python]');
    expect(ecosystemFor(registry, 'go')).toBeUndefined();
  });

  it('tags a project with its ecosystem tag — a placeholder for an unknown kind', () => {
    expect(projectTag(registry, project('python', 'a'))).toBe('[Python]');
    expect(projectTag(registry, project('go', 'a'))).toBe('[go]');
  });

  it('creates the provider of the matching ecosystem', () => {
    const made = { tag: 'made' } as unknown as ConfigProvider;
    const r = [eco('x', [], { createProvider: () => made })];
    expect(createProvider(r, project('x', 'a'))).toBe(made);
  });

  it('throws a clear error when no ecosystem handles the kind', () => {
    expect(() => createProvider(registry, project('go', 'a'))).toThrow("No ecosystem registered for project kind 'go'");
  });
});

describe('preferredKindForFile', () => {
  it('returns the kind of the first ecosystem claiming the file name', () => {
    const r = [eco('dotnet', []), eco('python', [], { ownsFileName: (n) => n.startsWith('.env') })];
    expect(preferredKindForFile(r, '.env.local')).toBe('python');
  });

  it('falls back to the first registered kind when no ecosystem claims the file', () => {
    const r = [eco('dotnet', []), eco('python', [], { ownsFileName: () => false })];
    expect(preferredKindForFile(r, 'appsettings.json')).toBe('dotnet');
  });

  it('returns undefined for an empty registry', () => {
    expect(preferredKindForFile([], 'x')).toBeUndefined();
  });
});
