import type { FileSystem } from '../dotnet/fileSystem';
import type { ProjectInfo } from '../provider';

/** Files whose presence marks a directory as a Python project, in id-preference order. */
export const PYTHON_MARKERS: string[] = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'];

/** Directory names under which marker files are ignored (compared case-insensitively). */
export const IGNORED_FOLDERS: string[] = ['node_modules', '.venv', 'venv', 'env', '__pycache__', 'site-packages', '.git', 'bin', 'obj'];

/** Normalizes a path for comparison: forward slashes, lower case, no trailing slash. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').toLowerCase();
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Splits a path at its last separator (either kind). */
function splitPath(p: string): { dir: string; base: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i), base: p.slice(i + 1) };
}

/** Last path segment, ignoring trailing separators. */
function basename(p: string): string {
  return splitPath(p.replace(/[\\/]+$/, '')).base;
}

/** Joins a directory and a name using the directory's separator style. */
function join(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

/** Tells whether a directory listing contains `.env` or `.env.*` (case-insensitive). */
function hasEnvFile(names: string[]): boolean {
  return names.some((n) => {
    const l = n.toLowerCase();
    return l === '.env' || l.startsWith('.env.');
  });
}

/**
 * Finds Python projects: directories holding a marker file and a `.env`/`.env.*` file, plus a
 * fallback project for each workspace root that has none at or under it but has a `.env` itself.
 * @param markerPaths Absolute paths of marker files found in the workspace.
 * @param workspaceRoots Absolute workspace folder paths.
 * @param fs File system used to list directories.
 * @returns Projects (`kind: 'python'`) sorted by name, then directory. A project's `id` and
 * `projectFile` are its first marker in {@link PYTHON_MARKERS} order (the `.env` path for fallback projects).
 */
export async function findPythonProjects(
  markerPaths: string[],
  workspaceRoots: string[],
  fs: FileSystem,
): Promise<ProjectInfo[]> {
  const ignored = new Set(IGNORED_FOLDERS.map((f) => f.toLowerCase()));
  const byDir = new Map<string, { dir: string; markers: Map<string, string> }>();
  for (const markerPath of markerPaths) {
    const { dir, base } = splitPath(markerPath);
    if (norm(dir).split('/').some((seg) => ignored.has(seg))) {
      continue;
    }
    const markerIndex = PYTHON_MARKERS.findIndex((m) => m.toLowerCase() === base.toLowerCase());
    if (markerIndex < 0) {
      continue;
    }
    const key = norm(dir);
    const entry = byDir.get(key) ?? { dir, markers: new Map<string, string>() };
    entry.markers.set(PYTHON_MARKERS[markerIndex], markerPath);
    byDir.set(key, entry);
  }

  const projects: ProjectInfo[] = [];
  for (const { dir, markers } of byDir.values()) {
    if (!hasEnvFile(await fs.listDir(dir))) {
      continue;
    }
    const first = PYTHON_MARKERS.find((m) => markers.has(m));
    const file = first === undefined ? undefined : markers.get(first);
    if (file !== undefined) {
      projects.push({ id: file, name: basename(dir), dir, projectFile: file, kind: 'python' });
    }
  }

  for (const root of workspaceRoots) {
    const r = norm(root);
    if (projects.some((p) => norm(p.dir) === r || norm(p.dir).startsWith(r + '/'))) {
      continue;
    }
    const envName = (await fs.listDir(root)).find((n) => n.toLowerCase() === '.env');
    if (envName !== undefined) {
      const file = join(root, envName);
      projects.push({ id: file, name: basename(root), dir: root, projectFile: file, kind: 'python' });
    }
  }

  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return projects.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(norm(a.dir), norm(b.dir)));
}
