import type { ProjectInfo } from '../provider';
import type { FileSystem } from '../sources/fileSystem';

/** Kind of a Node project. */
export const NODE_KIND = 'node';

/** File marking a directory as a Node project. */
export const NODE_MARKER = 'package.json';

/** Folder names under which `package.json` files are dependencies, not projects (compared case-insensitively). */
export const IGNORED_FOLDERS: string[] = ['node_modules'];

/** Normalizes a path for comparison: forward slashes, lower case, no trailing slash. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').toLowerCase();
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Tells whether a directory lies inside an ignored folder, looking only at the segments below the
 * deepest workspace root containing it (all segments when no root does).
 * @param dir Directory to check.
 * @param roots Normalized workspace roots.
 * @returns True when a segment below the root is an ignored folder.
 */
function isIgnored(dir: string, roots: string[]): boolean {
  const nd = norm(dir);
  const root = roots.filter((r) => nd === r || nd.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
  const below = root === undefined ? nd : nd.slice(root.length);
  return below.split('/').some((segment) => IGNORED_FOLDERS.includes(segment));
}

/** Splits a path at its last separator (either kind). */
function splitPath(p: string): { dir: string; base: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i), base: p.slice(i + 1) };
}

/** Tells whether a directory listing contains `.env` or `.env.*` (case-insensitive). */
function hasEnvFile(names: string[]): boolean {
  return names.some((n) => {
    const l = n.toLowerCase();
    return l === '.env' || l.startsWith('.env.');
  });
}

/**
 * Finds Node projects: directories holding a `package.json` and a `.env`/`.env.*` file, outside
 * {@link IGNORED_FOLDERS}.
 * @param markerPaths Absolute paths of `package.json` files found in the workspace.
 * @param workspaceRoots Absolute workspace folder paths.
 * @param fs File system used to list directories.
 * @returns Projects of {@link NODE_KIND}, identified by their `package.json`, sorted by name.
 */
export async function findNodeProjects(markerPaths: string[], workspaceRoots: string[], fs: FileSystem): Promise<ProjectInfo[]> {
  const roots = workspaceRoots.map(norm);
  const projects: ProjectInfo[] = [];
  for (const markerPath of markerPaths) {
    const { dir, base } = splitPath(markerPath);
    if (base.toLowerCase() !== NODE_MARKER || isIgnored(dir, roots) || !hasEnvFile(await fs.listDir(dir))) {
      continue;
    }
    projects.push({ id: markerPath, name: splitPath(dir).base, dir, projectFile: markerPath, kind: NODE_KIND });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
