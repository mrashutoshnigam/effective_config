import type { ProjectInfo } from '../provider';

/** Normalizes a path for comparison: forward slashes, lower case, no trailing slash. */
function norm(p: string): string {
  return p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Finds the project owning a file: the one with the deepest directory containing it.
 * Paths are compared case-insensitively with `\` and `/` treated alike.
 * @param filePath Absolute path of the file.
 * @param projects Candidate projects.
 * @returns The owning project, or undefined when none contains the file.
 */
export function findOwningProject(filePath: string, projects: ProjectInfo[]): ProjectInfo | undefined {
  const file = norm(filePath);
  let best: ProjectInfo | undefined;
  let bestLen = -1;
  for (const project of projects) {
    const dir = norm(project.dir);
    if (file.startsWith(`${dir}/`) && dir.length > bestLen) {
      best = project;
      bestLen = dir.length;
    }
  }
  return best;
}
