import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { COMPOSE_EXCLUDE_GLOB, COMPOSE_KIND, COMPOSE_MARKER_GLOB, findComposeProjects, ownsComposeFileName } from '../../src/compose/projectDiscovery';
import { discoverProjects, type Ecosystem } from '../../src/ecosystem';
import { findNodeProjects } from '../../src/node/projectDiscovery';
import { dropFallbackInClaimedRoots, findPythonProjects } from '../../src/python/projectDiscovery';
import type { ConfigProvider } from '../../src/provider';
import { memoryFs } from './support/memoryFs';

describe('findComposeProjects', () => {
  /**
   * Validates one project per directory, whichever primary file is found first. Expected: a directory
   * with both `docker-compose.yml` and `compose.yaml` gives one project identified by `compose.yaml`,
   * Compose's first choice, named after the directory.
   */
  it('gives one project per directory, preferring compose.yaml', () => {
    const dir = path.join('/ws', 'app');
    const projects = findComposeProjects([path.join(dir, 'docker-compose.yml'), path.join(dir, 'compose.yaml')]);
    expect(projects).toEqual([{ id: path.join(dir, 'compose.yaml'), name: 'app', dir, projectFile: path.join(dir, 'compose.yaml'), kind: COMPOSE_KIND }]);
  });

  /**
   * Validates several directories. Expected: one project each, sorted by name.
   */
  it('gives one project per directory, sorted by name', () => {
    const projects = findComposeProjects([path.join('/ws', 'web', 'compose.yml'), path.join('/ws', 'api', 'docker-compose.yaml')]);
    expect(projects.map((p) => [p.name, path.basename(p.projectFile)])).toEqual([['api', 'docker-compose.yaml'], ['web', 'compose.yml']]);
  });

  /**
   * Validates that dependencies and Git internals are not projects, and that other file names are not
   * markers. Expected: no project for files under `node_modules` or `.git`, nor for a lone override file.
   */
  it('skips ignored folders and non-primary files', () => {
    expect(findComposeProjects([
      path.join('/ws', 'node_modules', 'pkg', 'compose.yaml'),
      path.join('/ws', '.git', 'compose.yaml'),
      path.join('/ws', 'x', 'compose.override.yaml'),
    ])).toEqual([]);
  });
});

describe('discovery globs', () => {
  /**
   * Validates the workspace search the ecosystem runs. Expected: the four primary file names, and the
   * ignored folders excluded at any depth.
   */
  it('match the primary compose files outside ignored folders', () => {
    expect(COMPOSE_MARKER_GLOB).toBe('**/{compose.yaml,compose.yml,docker-compose.yaml,docker-compose.yml}');
    expect(COMPOSE_EXCLUDE_GLOB).toBe('**/{node_modules,.git}/**');
  });
});

describe('ownsComposeFileName', () => {
  /**
   * Validates which files open a Compose project when the command is run on them. Expected: primary
   * and override names in any case; other YAML files are not claimed.
   */
  it('claims primary and override compose files case-insensitively', () => {
    expect(ownsComposeFileName('Compose.Override.YML')).toBe(true);
    expect(ownsComposeFileName('docker-compose.yaml')).toBe(true);
    expect(ownsComposeFileName('values.yaml')).toBe(false);
  });
});

describe('Compose discovery among the other ecosystems', () => {
  /** Workspace root of these tests. */
  const ROOT = path.join('/ws');

  /**
   * Builds the Node, Compose and Python ecosystems in the order `src/hostEcosystems.ts` registers them,
   * with their real discovery rules over an in-memory workspace.
   * @param files File contents by absolute path; every file is also a discovery marker candidate.
   * @returns The ecosystems.
   */
  const ecosystems = (files: Record<string, string>): Ecosystem[] => {
    const fs = memoryFs(files);
    const markers = Object.keys(files).map((p) => path.join(p));
    /**
     * Builds a test ecosystem around a discovery function.
     * @param kind Project kind.
     * @param discover The discovery.
     * @returns The ecosystem; it never builds providers.
     */
    const eco = (kind: string, discover: Ecosystem['discover']): Ecosystem => ({
      kind,
      tag: `[${kind}]`,
      discover,
      createProvider: (): ConfigProvider => {
        throw new Error('not used');
      },
    });
    return [
      eco('node', () => findNodeProjects(markers, [ROOT], fs)),
      eco(COMPOSE_KIND, async () => findComposeProjects(markers)),
      eco('python', async (found) => dropFallbackInClaimedRoots(await findPythonProjects(markers, [ROOT], fs), found, [ROOT])),
    ];
  };

  /**
   * Validates the design claim that Compose, registered before Python, claims a workspace root holding
   * `compose.yaml` and `.env`. Expected: one Compose project and no Python fallback project.
   */
  it('gives a root with compose.yaml and .env no Python fallback project', async () => {
    const projects = await discoverProjects(ecosystems({ '/ws/compose.yaml': 'services: {}\n', '/ws/.env': 'A=1\n' }));
    expect(projects.map((p) => [p.kind, p.dir])).toEqual([[COMPOSE_KIND, ROOT]]);
  });

  /**
   * Validates the design claim that a folder holding both `package.json` and `compose.yaml` is both a
   * Node and a Compose project. Expected: one project of each kind for that folder.
   */
  it('gives a folder with package.json and compose.yaml both a Node and a Compose project', async () => {
    const dir = path.join(ROOT, 'app');
    const projects = await discoverProjects(ecosystems({ '/ws/app/package.json': '{}', '/ws/app/compose.yaml': 'services: {}\n', '/ws/app/.env': 'A=1\n' }));
    expect(projects.map((p) => [p.kind, p.dir])).toEqual([[COMPOSE_KIND, dir], ['node', dir]]);
  });
});