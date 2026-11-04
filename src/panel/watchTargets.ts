import * as path from 'node:path';

/** A file-system watch: a base directory that exists plus a glob pattern relative to it. */
export interface WatchTarget {
  /** Existing directory to watch from. */
  base: string;
  /** Glob pattern relative to `base`, using `/` separators. */
  pattern: string;
}

/**
 * Escapes glob metacharacters in one relative path segment.
 * `*`, `?`, `{` and `}` become single-character classes; `[` and `]` become `?` (they cannot be
 * expressed portably inside a class), which may over-match but only triggers an extra refresh.
 * @param segment A path segment.
 * @returns The segment safe for use inside a glob pattern.
 */
export function escapeGlobSegment(segment: string): string {
  return segment.replace(/[*?{}[\]]/g, (c) => (c === '[' || c === ']' ? '?' : `[${c}]`));
}

/**
 * Computes how to watch a file that may not exist yet, including when its folders are missing:
 * watch from the nearest existing ancestor directory with a relative pattern down to the file.
 * @param filePath Absolute path of the file.
 * @param isDirectory Returns true when a path is an existing directory.
 * @returns The watch target.
 */
export function watchTargetFor(filePath: string, isDirectory: (dir: string) => boolean): WatchTarget {
  let base = path.dirname(filePath);
  while (!isDirectory(base)) {
    const parent = path.dirname(base);
    if (parent === base) {
      break;
    }
    base = parent;
  }
  const relative = path.relative(base, filePath);
  const pattern = relative.split(path.sep).map(escapeGlobSegment).join('/');
  return { base, pattern };
}

/**
 * Identity of a watch target; changes whenever the nearest existing ancestor or the pattern changes.
 * @param target The target.
 * @returns A stable string key.
 */
export function watchTargetKey(target: WatchTarget): string {
  return `${target.base}\n${target.pattern}`;
}

/**
 * Computes the de-duplicated watch targets for a set of file paths.
 * @param filePaths Absolute file paths (existing or not).
 * @param isDirectory Returns true when a path is an existing directory.
 * @returns One target per distinct base and pattern.
 */
export function watchTargetsFor(filePaths: string[], isDirectory: (dir: string) => boolean): WatchTarget[] {
  const seen = new Map<string, WatchTarget>();
  for (const p of filePaths) {
    const target = watchTargetFor(p, isDirectory);
    seen.set(watchTargetKey(target), target);
  }
  return [...seen.values()];
}
