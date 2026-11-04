import type { Diagnostic, SourceLocation } from '../engine/types';
import { stripBom } from './jsonLayer';

/** One `KEY=value` assignment read from a `.env` file. */
export interface DotenvEntry {
  /** Variable name. */
  name: string;
  /** Value after quote removal and escape processing (not yet expanded). */
  value: string;
  /** True when `${VAR}` expansion applies (false for single-quoted values). */
  expand: boolean;
  /** 0-based position of the value's first character (after the opening quote for quoted values). */
  location: SourceLocation;
}

/** Result of parsing a `.env` file. */
export interface DotenvParseResult {
  /** Assignments in source order; duplicates are kept (later wins when merged). */
  entries: DotenvEntry[];
  /** Problems found; messages never contain values. */
  diagnostics: Diagnostic[];
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

const isBlank = (c: string): boolean => c === ' ' || c === '\t';

/**
 * Parses `.env` text following python-dotenv rules: optional `export ` prefix, whitespace
 * around `=`, `#` comments (inline only after whitespace), single-quoted literals,
 * double-quoted values with escapes, and quoted values spanning several lines. CRLF and CR
 * are normalized to LF first and a leading BOM is ignored; reported positions refer to the
 * normalized text.
 * @param text File contents.
 * @param filePath Path recorded in locations.
 * @returns Entries and diagnostics. A bare `KEY` yields an `info`; an unparseable line
 * yields a `warning` and parsing continues; an unterminated quote yields a `warning` and
 * parsing stops.
 */
export function parseDotenv(text: string, filePath: string): DotenvParseResult {
  const src = stripBom(text).replace(/\r\n?/g, '\n');
  const entries: DotenvEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const lineStarts: number[] = [0];
  for (let n = src.indexOf('\n'); n !== -1; n = src.indexOf('\n', n + 1)) {
    lineStarts.push(n + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const loc = (offset: number): SourceLocation => {
    const line = lineOf(offset);
    return { filePath, line, column: offset - lineStarts[line] };
  };
  const lineEnd = (from: number): number => {
    const i = src.indexOf('\n', from);
    return i === -1 ? src.length : i;
  };

  let pos = 0;
  while (pos < src.length) {
    const eol = lineEnd(pos);
    const lineStart = pos;
    let i = pos;
    while (i < eol && isBlank(src[i])) i++;
    if (i >= eol || src[i] === '#') {
      pos = eol + 1;
      continue;
    }

    const lineNo = lineOf(lineStart) + 1;
    const warn = (message: string, at: number): void => {
      diagnostics.push({ severity: 'warning', message, location: loc(at) });
    };

    // Optional `export` prefix (only when followed by whitespace).
    if (src.startsWith('export', i) && i + 6 < eol && isBlank(src[i + 6])) {
      i += 6;
      while (i < eol && isBlank(src[i])) i++;
    }

    const keyStart = i;
    while (i < eol && src[i] !== '=' && src[i] !== '#' && !isBlank(src[i])) i++;
    const name = src.slice(keyStart, i);
    while (i < eol && isBlank(src[i])) i++;

    if (name === '' || (i < eol && src[i] !== '=' && src[i] !== '#')) {
      warn(`Cannot parse line ${lineNo}`, keyStart);
      pos = eol + 1;
      continue;
    }
    if (i >= eol || src[i] === '#') {
      diagnostics.push({
        severity: 'info',
        message: `'${name}' has no value; python-dotenv does not set it`,
        location: loc(keyStart),
      });
      pos = eol + 1;
      continue;
    }

    i++; // '='
    while (i < eol && isBlank(src[i])) i++;
    const quote = i < eol ? src[i] : '';

    if (quote === "'" || quote === '"') {
      const valueStart = i + 1;
      let j = valueStart;
      let value = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === quote) {
          closed = true;
          break;
        }
        if (quote === '"' && c === '\\' && j + 1 < src.length) {
          const next = src[j + 1];
          value += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
          j += 2;
          continue;
        }
        value += c;
        j++;
      }
      if (!closed) {
        warn(`Cannot parse line ${lineNo}: unterminated quote`, keyStart);
        break;
      }
      const after = lineEnd(j + 1);
      let k = j + 1;
      while (k < after && isBlank(src[k])) k++;
      if (k < after && src[k] !== '#') {
        warn(`Cannot parse line ${lineNo}`, keyStart);
      } else {
        entries.push({ name, value, expand: quote === '"', location: loc(valueStart) });
      }
      pos = after + 1;
      continue;
    }

    // Unquoted value.
    const valueStart = i;
    let end = eol;
    for (let k = valueStart; k < eol; k++) {
      if (src[k] === '#' && k > keyStart && isBlank(src[k - 1])) {
        end = k;
        break;
      }
    }
    const value = src.slice(valueStart, end).trim();
    entries.push({ name, value, expand: true, location: loc(valueStart) });
    pos = eol + 1;
  }

  return { entries, diagnostics };
}

/**
 * Expands `${NAME}` and `${NAME:-default}` references in a value (python-dotenv style).
 * `$NAME` without braces stays literal. The default is used when the lookup returns
 * `undefined` or an empty string; an unresolved reference without default becomes `''`.
 * Default text is not expanded further.
 * @param value Raw value.
 * @param lookup Resolves a variable name, or `undefined` when unknown.
 * @returns The expanded value and the distinct referenced names in first-seen order
 * (unresolved ones included).
 */
export function expandDotenvValue(
  value: string,
  lookup: (name: string) => string | undefined,
): { value: string; references: string[] } {
  const references: string[] = [];
  const expanded = value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_m, name: string, dflt: string | undefined) => {
    if (!references.includes(name)) {
      references.push(name);
    }
    const found = lookup(name);
    if (found === undefined || found === '') {
      return dflt ?? '';
    }
    return found;
  });
  return { value: expanded, references };
}
