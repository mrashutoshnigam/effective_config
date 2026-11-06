import { describe, it, expect } from 'vitest';
import type { FileSystem } from '../../src/sources/fileSystem';
import type { ProjectInfo } from '../../src/provider';
import { dropFallbackInClaimedRoots, findPythonProjects, IGNORED_FOLDERS, PYTHON_MARKERS } from '../../src/python/projectDiscovery';

/** Builds a fake file system from a directory -> entries map. */
function fakeFs(dirs: Record<string, string[]>): FileSystem {
  return {
    readFile: async () => undefined,
    listDir: async (d) => dirs[d] ?? [],
  };
}

describe('findPythonProjects', () => {
  it('exposes markers and ignored folders', () => {
    expect(PYTHON_MARKERS).toEqual(['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']);
    expect(IGNORED_FOLDERS).toEqual(['node_modules', '.venv', 'venv', 'env', '__pycache__', 'site-packages', '.git', 'bin', 'obj']);
  });
  it('marker dir without .env files is not a project', async () => {
    const fs = fakeFs({ '/ws/app': ['pyproject.toml', 'main.py'] });
    expect(await findPythonProjects(['/ws/app/pyproject.toml'], ['/ws'], fs)).toEqual([]);
  });
  it('marker dir with .env or .env.* is a project with kind python', async () => {
    const fs = fakeFs({ '/ws/a': ['setup.py', '.env'], '/ws/b': ['Pipfile', '.ENV.dev'] });
    const r = await findPythonProjects(['/ws/b/Pipfile', '/ws/a/setup.py'], ['/ws'], fs);
    expect(r).toEqual([
      { id: '/ws/a/setup.py', name: 'a', dir: '/ws/a', projectFile: '/ws/a/setup.py', kind: 'python' },
      { id: '/ws/b/Pipfile', name: 'b', dir: '/ws/b', projectFile: '/ws/b/Pipfile', kind: 'python' },
    ]);
  });
  it('both pyproject.toml and requirements.txt give one project with id = pyproject.toml', async () => {
    const fs = fakeFs({ '/ws/a': ['pyproject.toml', 'requirements.txt', '.env'] });
    const r = await findPythonProjects(['/ws/a/requirements.txt', '/ws/a/pyproject.toml'], ['/ws'], fs);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('/ws/a/pyproject.toml');
    expect(r[0].projectFile).toBe('/ws/a/pyproject.toml');
  });
  it('markers under ignored folders are dropped case-insensitively', async () => {
    const fs = fakeFs({ '/ws/.venv/lib': ['setup.py', '.env'], '/ws/Node_Modules/x': ['setup.py', '.env'], '/ws/ok': ['setup.py', '.env'] });
    const r = await findPythonProjects(['/ws/.venv/lib/setup.py', '/ws/Node_Modules/x/setup.py', '/ws/ok/setup.py'], ['/ws'], fs);
    expect(r.map((p) => p.name)).toEqual(['ok']);
  });
  it('fallback root project when no markers — uses actual .env casing', async () => {
    const fs = fakeFs({ '/ws': ['.ENV', 'main.py'] });
    expect(await findPythonProjects([], ['/ws'], fs)).toEqual([
      { id: '/ws/.ENV', name: 'ws', dir: '/ws', projectFile: '/ws/.ENV', kind: 'python' },
    ]);
  });
  it('no fallback for a root that has a project under it', async () => {
    const fs = fakeFs({ '/ws': ['.env'], '/ws/sub': ['setup.py', '.env'] });
    const r = await findPythonProjects(['/ws/sub/setup.py'], ['/ws'], fs);
    expect(r.map((p) => p.dir)).toEqual(['/ws/sub']);
  });
  it('fallback applies per root and requires exactly .env — .env.dev alone does not qualify', async () => {
    const fs = fakeFs({ '/r1': ['.env.dev'], '/r2': ['.env'], '/r3/x': ['setup.py', '.env'], '/r3': ['.env'] });
    const r = await findPythonProjects(['/r3/x/setup.py'], ['/r1', '/r2', '/r3'], fs);
    expect(r.map((p) => p.dir)).toEqual(['/r2', '/r3/x']);
  });
  it('at-or-under comparison ignores case and separators', async () => {
    const fs = fakeFs({ 'C:\\WS': ['.env'], 'c:/ws/App': ['setup.py', '.env'] });
    const r = await findPythonProjects(['c:/ws/App/setup.py'], ['C:\\WS'], fs);
    expect(r.map((p) => p.name)).toEqual(['App']);
  });
  it('sorts by name then dir', async () => {
    const fs = fakeFs({ '/ws/b/x': ['setup.py', '.env'], '/ws/a/x': ['setup.py', '.env'], '/ws/a': ['.env'] });
    const r = await findPythonProjects(['/ws/b/x/setup.py', '/ws/a/x/setup.py'], ['/ws'], fs);
    expect(r.map((p) => p.dir)).toEqual(['/ws/a/x', '/ws/b/x']);
  });
  it('handles Windows paths', async () => {
    const fs = fakeFs({ 'C:\\ws\\app': ['Pipfile', '.env'] });
    const r = await findPythonProjects(['C:\\ws\\app\\Pipfile'], ['C:\\ws'], fs);
    expect(r).toEqual([{ id: 'C:\\ws\\app\\Pipfile', name: 'app', dir: 'C:\\ws\\app', projectFile: 'C:\\ws\\app\\Pipfile', kind: 'python' }]);
  });
  it('workspace root living under an ignored-named folder is still discovered; ignored folders below it are dropped', async () => {
    const fs = fakeFs({ '/work/env/app': ['setup.py', '.env'], '/work/env/app/.venv/x': ['setup.py', '.env'] });
    const r = await findPythonProjects(['/work/env/app/setup.py', '/work/env/app/.venv/x/setup.py'], ['/work/env/app'], fs);
    expect(r.map((p) => p.dir)).toEqual(['/work/env/app']);
  });
  it('Windows root under bin is discovered; longest containing root decides what is below it', async () => {
    const fs = fakeFs({ 'C:\\src\\bin\\proj': ['setup.py', '.env'] });
    const r = await findPythonProjects(['C:\\src\\bin\\proj\\setup.py'], ['C:\\SRC', 'c:/src/bin/proj'], fs);
    expect(r.map((p) => p.name)).toEqual(['proj']);
  });
  it('fallback ignores fallback projects of earlier roots, so nested roots are independent of order', async () => {
    const fs = fakeFs({ '/ws': ['.env'], '/ws/inner': ['.env'] });
    expect((await findPythonProjects([], ['/ws', '/ws/inner'], fs)).map((p) => p.dir)).toEqual(['/ws/inner', '/ws']);
    expect((await findPythonProjects([], ['/ws/inner', '/ws'], fs)).map((p) => p.dir)).toEqual(['/ws/inner', '/ws']);
  });
});

describe('dropFallbackInClaimedRoots', () => {
  const py = (dir: string, file: string): ProjectInfo => ({ id: file, name: 'x', dir, projectFile: file, kind: 'python' });
  const net = (dir: string): ProjectInfo => ({ id: `${dir}/a.csproj`, name: 'a', dir, projectFile: `${dir}/a.csproj`, kind: 'dotnet' });

  it('drops the root fallback project when a .NET project lives under that root — result is empty', () => {
    expect(dropFallbackInClaimedRoots([py('/ws', '/ws/.env')], [net('/ws/src/Api')], ['/ws'])).toEqual([]);
  });

  it('drops the fallback when the .NET project sits at the root itself, with Windows paths and case differences', () => {
    expect(dropFallbackInClaimedRoots([py('C:\\WS', 'C:\\WS\\.env')], [net('c:/ws')], ['c:/ws'])).toEqual([]);
  });

  it('keeps the fallback project when no .NET project is under its root — one project remains', () => {
    const p = py('/ws', '/ws/.env');
    expect(dropFallbackInClaimedRoots([p], [net('/other/Api')], ['/ws'])).toEqual([p]);
  });

  it('keeps marker-based Python projects even when a .NET project shares the root — project preserved', () => {
    const p = py('/ws/app', '/ws/app/pyproject.toml');
    expect(dropFallbackInClaimedRoots([p], [net('/ws/app')], ['/ws'])).toEqual([p]);
  });

  it('keeps a root fallback in a different workspace root than the .NET project — only the matching root is dropped', () => {
    const keep = py('/b', '/b/.env');
    expect(dropFallbackInClaimedRoots([py('/a', '/a/.env'), keep], [net('/a/Api')], ['/a', '/b'])).toEqual([keep]);
  });

  it('does not treat a sibling folder sharing a name prefix as under the root — fallback kept', () => {
    const p = py('/ws', '/ws/.env');
    expect(dropFallbackInClaimedRoots([p], [net('/ws2/Api')], ['/ws'])).toEqual([p]);
  });

  /** Validates that the rule is not .NET specific: a project of any other kind under the root drops the fallback, so a new language needs no edit here. */
  it('drops the fallback for a project of any other kind under the root — result is empty', () => {
    const other: ProjectInfo = { id: '/ws/app/x', name: 'x', dir: '/ws/app', projectFile: '/ws/app/x', kind: 'stub-language' };
    expect(dropFallbackInClaimedRoots([py('/ws', '/ws/.env')], [other], ['/ws'])).toEqual([]);
  });
});
