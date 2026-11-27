import type { FileSystem } from '../../../src/sources/fileSystem';

/**
 * Normalizes a path for lookup in {@link memoryFs}: forward slashes and no trailing slash, so paths built
 * with `path.join` on Windows match keys written with `/`.
 * @param p Path to normalize.
 * @returns The normalized path.
 */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Builds an in-memory file system over absolute paths.
 * @param files File contents by absolute path, written with `/`, e.g. `/p/compose.yaml`.
 * @returns The file system; a directory lists the names of the files directly inside it.
 */
export function memoryFs(files: Record<string, string>): FileSystem {
  const byPath = new Map(Object.entries(files).map(([p, text]) => [norm(p), text]));
  return {
    readFile: async (p) => byPath.get(norm(p)),
    listDir: async (dir) => {
      const prefix = `${norm(dir)}/`;
      return [...byPath.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length));
    },
  };
}
