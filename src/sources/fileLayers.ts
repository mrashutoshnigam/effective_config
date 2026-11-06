import * as path from 'node:path';
import type { Diagnostic, Layer, LayerEntry, LayerKind } from '../engine/types';
import type { FileSystem } from './fileSystem';

/** The outcome of matching one layer pattern against a directory listing. */
export interface LayerFileMatch {
  /** The pattern as configured, e.g. `appsettings.{env}.json`. */
  pattern: string;
  /** The file found for the pattern (undefined when missing). */
  fileName?: string;
  /** True when the found file differs from the expected name only by case (it would not load on case-sensitive file systems). */
  caseMismatch: boolean;
}

/**
 * Matches layer patterns to files in a directory listing, ignoring case.
 * @param fileNames File names in the project directory.
 * @param patterns Layer file patterns, lowest priority first; `{env}` is the environment placeholder.
 * @param env Environment name substituted for `{env}`.
 * @returns One match per pattern, in order.
 */
export function matchLayerFiles(fileNames: string[], patterns: string[], env: string): LayerFileMatch[] {
  return patterns.map((pattern) => {
    const expected = pattern.split('{env}').join(env);
    const lower = expected.toLowerCase();
    const fileName = fileNames.includes(expected) ? expected : fileNames.find((f) => f.toLowerCase() === lower);
    return { pattern, fileName, caseMismatch: fileName !== undefined && fileName !== expected };
  });
}

/** What a file parser returns: the layer entries and the problems found while reading. */
export interface ParsedFileLayer {
  /** Flattened entries in source order. */
  entries: LayerEntry[];
  /** Problems found while parsing. */
  diagnostics: Diagnostic[];
}

/** Default sensitivity rule: a pattern naming "secret" marks its whole layer as sensitive. */
export function isSecretPattern(pattern: string): boolean {
  return pattern.toLowerCase().includes('secret');
}

/** Input of {@link readFileLayers}. */
export interface FileLayerRequest {
  /** File system used for the directory listing and the reads. */
  fs: FileSystem;
  /** Absolute project directory containing the files. */
  dir: string;
  /** Layer file patterns, lowest priority first. */
  patterns: string[];
  /** Environment name substituted for `{env}`. */
  environment: string;
  /** Layer kind stamped on every produced layer. */
  kind: LayerKind;
  /**
   * Parses one file. Called once per existing file in pattern order, so a parser may carry state
   * from earlier files (for example variable expansion).
   */
  parse(text: string, filePath: string): ParsedFileLayer;
  /** Decides whether a layer is sensitive from its pattern; defaults to {@link isSecretPattern}. */
  isSensitive?(pattern: string): boolean;
}

/** Layers, diagnostics and watch paths produced by {@link readFileLayers}. */
export interface FileLayerResult {
  /** One layer per existing file, lowest priority first. */
  layers: Layer[];
  /** Case-mismatch warnings and parser diagnostics, in file order. */
  diagnostics: Diagnostic[];
  /** Expected path of every pattern (existing or not), plus the actual path of case-mismatched files. */
  watchPaths: string[];
}

/**
 * Reads the file-backed layers of a project: matches the patterns case-insensitively, warns about
 * case mismatches, parses each existing file and records watch paths. Shared by every provider whose
 * layers come from pattern-named files in the project directory.
 * @param request What to read and how to parse it.
 * @returns Layers, diagnostics and watch paths.
 */
export async function readFileLayers(request: FileLayerRequest): Promise<FileLayerResult> {
  const { fs, dir, patterns, environment, kind, parse } = request;
  const isSensitive = request.isSensitive ?? isSecretPattern;
  const layers: Layer[] = [];
  const diagnostics: Diagnostic[] = [];
  const watchPaths: string[] = [];

  const names = await fs.listDir(dir);
  for (const match of matchLayerFiles(names, patterns, environment)) {
    const expected = match.pattern.split('{env}').join(environment);
    watchPaths.push(path.join(dir, expected));
    if (match.fileName === undefined) {
      continue;
    }
    const filePath = path.join(dir, match.fileName);
    if (match.caseMismatch) {
      if (!watchPaths.includes(filePath)) {
        watchPaths.push(filePath);
      }
      diagnostics.push({
        severity: 'warning',
        message: `'${match.fileName}' matches '${expected}' only ignoring case; it would not load on case-sensitive file systems`,
      });
    }
    const text = await fs.readFile(filePath);
    if (text === undefined) {
      continue;
    }
    const parsed = parse(text, filePath);
    diagnostics.push(...parsed.diagnostics);
    layers.push({
      id: match.fileName,
      label: match.fileName,
      kind,
      sensitive: isSensitive(match.pattern),
      filePath,
      entries: parsed.entries,
    });
  }
  return { layers, diagnostics, watchPaths };
}
