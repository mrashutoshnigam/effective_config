import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { COMPOSE_KIND, findComposeProjects, ownsComposeFileName } from '../../src/compose/projectDiscovery';

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
