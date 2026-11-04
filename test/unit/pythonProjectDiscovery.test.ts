import { describe, it, expect } from 'vitest';
import type { FileSystem } from '../../src/dotnet/fileSystem';
import { findPythonProjects, IGNORED_FOLDERS, PYTHON_MARKERS } from '../../src/python/projectDiscovery';

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
});
