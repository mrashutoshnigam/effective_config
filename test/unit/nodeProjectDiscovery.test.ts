import { describe, it, expect } from 'vitest';
import type { FileSystem } from '../../src/sources/fileSystem';
import { findNodeProjects } from '../../src/node/projectDiscovery';

/** Builds a fake file system from a directory -> entries map. */
function fakeFs(dirs: Record<string, string[]>): FileSystem {
  return {
    readFile: async () => undefined,
    listDir: async (d) => dirs[d] ?? [],
  };
}

describe('findNodeProjects', () => {
  /**
   * A Node project is a directory holding `package.json` and at least one `.env`/`.env.*` file
   * (case-insensitive). Expected: one project per such directory, kind `node`, identified by its
   * package.json and named after its directory, sorted by name; a package.json without env files is
   * not a project.
   */
  it('finds package.json directories that have env files', async () => {
    const fs = fakeFs({
      '/ws/web': ['package.json', '.env.development'],
      '/ws/api': ['package.json', '.ENV'],
      '/ws/lib': ['package.json', 'index.js'],
    });
    const projects = await findNodeProjects(['/ws/web/package.json', '/ws/lib/package.json', '/ws/api/package.json'], ['/ws'], fs);
    expect(projects).toEqual([
      { id: '/ws/api/package.json', name: 'api', dir: '/ws/api', projectFile: '/ws/api/package.json', kind: 'node' },
      { id: '/ws/web/package.json', name: 'web', dir: '/ws/web', projectFile: '/ws/web/package.json', kind: 'node' },
    ]);
  });

  /**
   * Installed packages often ship a package.json next to a `.env` file; they are dependencies, not
   * projects. Only path segments below the workspace root count, so a workspace that itself lives
   * inside a `node_modules` folder still works. Expected: the nested package is skipped, the project
   * under a `node_modules`-named root is kept.
   */
  it('skips package.json files inside node_modules below the workspace root', async () => {
    const fs = fakeFs({
      '/ws/app': ['package.json', '.env'],
      '/ws/app/node_modules/dep': ['package.json', '.env'],
      'C:\\node_modules\\ws': ['package.json', '.env'],
    });
    const projects = await findNodeProjects(
      ['/ws/app/package.json', '/ws/app/node_modules/dep/package.json', 'C:\\node_modules\\ws\\package.json'],
      ['/ws', 'C:\\node_modules\\ws'],
      fs,
    );
    expect(projects.map((p) => p.dir)).toEqual(['/ws/app', 'C:\\node_modules\\ws']);
  });
});
