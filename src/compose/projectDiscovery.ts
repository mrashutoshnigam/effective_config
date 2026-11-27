import * as path from 'node:path';
import type { ProjectInfo } from '../provider';
import { OVERRIDE_COMPOSE_FILES, PRIMARY_COMPOSE_FILES } from './composeFiles';

/** Kind of a Compose project. */
export const COMPOSE_KIND = 'compose';

/** Folder names under which compose files are not projects (compared case-insensitively). */
export const IGNORED_FOLDERS: string[] = ['node_modules', '.git'];

/**
 * Ranks a file name among the primary compose files.
 * @param fileName File name without directory.
 * @returns Its index in {@link PRIMARY_COMPOSE_FILES}, or -1 when it is not a primary file.
 */
function primaryRank(fileName: string): number {
  return PRIMARY_COMPOSE_FILES.indexOf(fileName.toLowerCase());
}

/**
 * Tells whether a path lies inside an ignored folder.
 * @param dir Directory to check.
 * @returns True when one of its segments is in {@link IGNORED_FOLDERS}.
 */
function isIgnored(dir: string): boolean {
  return dir.split(/[\\/]/).some((segment) => IGNORED_FOLDERS.includes(segment.toLowerCase()));
}

/**
 * Finds Compose projects: one per directory holding a primary compose file, outside {@link IGNORED_FOLDERS}.
 * @param markerPaths Absolute paths of the primary compose files found in the workspace.
 * @returns Projects of {@link COMPOSE_KIND}, identified by the directory's first primary file in
 * Compose's lookup order and named after the directory, sorted by name.
 */
export function findComposeProjects(markerPaths: string[]): ProjectInfo[] {
  const byDir = new Map<string, string>();
  for (const marker of markerPaths) {
    const dir = path.dirname(marker);
    const rank = primaryRank(path.basename(marker));
    if (rank < 0 || isIgnored(dir)) {
      continue;
    }
    const current = byDir.get(dir);
    if (current === undefined || rank < primaryRank(path.basename(current))) {
      byDir.set(dir, marker);
    }
  }
  return [...byDir.entries()]
    .map(([dir, projectFile]): ProjectInfo => ({ id: projectFile, name: path.basename(dir), dir, projectFile, kind: COMPOSE_KIND }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tells whether a file belongs to a Compose project.
 * @param fileName File name without directory.
 * @returns True for primary and override compose file names, in any case.
 */
export function ownsComposeFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return PRIMARY_COMPOSE_FILES.includes(lower) || OVERRIDE_COMPOSE_FILES.includes(lower);
}
