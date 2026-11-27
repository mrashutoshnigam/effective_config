/**
 * Docker Compose variable interpolation, as documented at
 * https://docs.docker.com/reference/compose-file/interpolation/ : `$VAR`, `${VAR}`, `${VAR:-d}`,
 * `${VAR-d}`, `${VAR:?e}`, `${VAR?e}`, `${VAR:+r}`, `${VAR+r}`, nested expressions in `d`, `e` and `r`,
 * and `$$` for a literal `$`. An unset variable without a default "displays a warning and substitutes
 * the variable with an empty string". Other shell forms such as `${VAR/foo/bar}` are not supported.
 */

/** Result of interpolating one string. */
export interface InterpolationResult {
  /** Expanded text; a failing expression contributes `''`. */
  value: string;
  /** Distinct variable names read, in first-seen order. */
  references: string[];
  /** Names read with no default that were unset (Compose warns and uses `''`). */
  unset: string[];
  /** Required-variable failures and format errors. Messages never quote a variable's value. */
  errors: string[];
}

/** Deepest nesting of expressions inside defaults, replacements and messages; compose files are untrusted. */
export const MAX_INTERPOLATION_DEPTH = 32;

/** Longest expanded text; bounds memory when a crafted file repeats a long value. */
export const MAX_INTERPOLATED_LENGTH = 1_000_000;

/** Longest variable name quoted in a format error. */
const MAX_QUOTED_NAME = 40;

/** Looks up a variable; undefined when it is unset. */
type Lookup = (name: string) => string | undefined;

/** State shared by every level of one interpolation. */
interface ScanState {
  /** The lookup. */
  lookup: Lookup;
  /** Distinct names read. */
  references: string[];
  /** Distinct names read unset without default. */
  unset: string[];
  /** Errors in the order they were found. */
  errors: string[];
  /** True once a limit was hit; every level stops then, so the limit is reported once. */
  stopped: boolean;
}

/** The operator of a braced expression. */
type Operator = ':-' | '-' | ':?' | '?' | ':+' | '+';

/** Operators, two-character ones first so `:-` is not read as `:`. */
const OPERATORS: readonly Operator[] = [':-', ':?', ':+', '-', '?', '+'];

/**
 * Tells whether a character can start a variable name.
 * @param c One character, or undefined past the end.
 * @returns True for a letter or underscore.
 */
function isNameStart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z_]/.test(c);
}

/**
 * Finds the end of a run of name characters.
 * @param text Text to scan.
 * @param from Offset of the first character.
 * @returns Offset just past the last letter, digit or underscore.
 */
function nameEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {
    i++;
  }
  return i;
}

/**
 * Finds the `}` closing a `${`, as compose-go's `template.getFirstBraceClosingIndex` does: every `{`
 * and `}` counts, `$` and `$$` are not special, so `${A:-$${X}}` closes at its last brace. When the
 * braces do not balance, compose-go keeps its pattern's greedy match, which ends at the last `}` before
 * the next line break; that is the fallback here. compose-go also skips the byte after each `{`, which
 * only matters for a `{` directly followed by a brace and gives the same text once the rest of the
 * match is appended, so it is not copied.
 * @param text Text to scan.
 * @param from Offset just past the opening `${`.
 * @returns Offset of the closing brace, or -1 when there is no `}` left on the line.
 */
function closingBrace(text: string, from: number): number {
  let depth = 1;
  let lineEnd = text.length;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    } else if (c === '\n') {
      lineEnd = i;
      break;
    }
  }
  const last = text.lastIndexOf('}', lineEnd - 1);
  return last >= from ? last : -1;
}

/**
 * Adds a name to a list unless it is already there.
 * @param list Names in first-seen order.
 * @param name Name to add.
 */
function addOnce(list: string[], name: string): void {
  if (!list.includes(name)) {
    list.push(name);
  }
}

/**
 * Builds the format error for an expression.
 * @param text Text holding the expression.
 * @param nameStart Offset just past its `${`.
 * @returns The message, naming only the variable name, so a default holding a secret is not quoted.
 */
function formatError(text: string, nameStart: number): string {
  const name = text.slice(nameStart, Math.min(nameEnd(text, nameStart), nameStart + MAX_QUOTED_NAME));
  return name ? `invalid interpolation format for ${name}` : 'invalid interpolation format';
}

/**
 * Evaluates one braced expression.
 * @param name Variable name.
 * @param operator Operator, or undefined for `${NAME}`.
 * @param argument Text after the operator, still to be interpolated when it is used.
 * @param state Shared state.
 * @param depth Nesting of the expression.
 * @returns The expression's value.
 */
function evaluate(name: string, operator: Operator | undefined, argument: string, state: ScanState, depth: number): string {
  addOnce(state.references, name);
  const value = state.lookup(name);
  const set = value !== undefined;
  const nonEmpty = set && value !== '';
  /** Interpolates the argument one level deeper. */
  const nested = (): string => expand(argument, state, depth + 1);
  switch (operator) {
    case undefined:
      if (!set) {
        addOnce(state.unset, name);
      }
      return value ?? '';
    case ':-':
      return nonEmpty ? value : nested();
    case '-':
      return set ? value : nested();
    case ':+':
      return nonEmpty ? nested() : '';
    case '+':
      return set ? nested() : '';
    case ':?':
    case '?': {
      if (operator === ':?' ? nonEmpty : set) {
        return value as string;
      }
      const message = nested();
      if (!state.stopped) {
        state.errors.push(`required variable ${name} is missing a value${message ? `: ${message}` : ''}`);
      }
      return '';
    }
  }
}

/**
 * Expands one level of text.
 * @param text Text to expand.
 * @param state Shared state.
 * @param depth Nesting of this text; 0 at the top.
 * @returns The expanded text, cut short when a limit is hit.
 */
function expand(text: string, state: ScanState, depth: number): string {
  if (depth > MAX_INTERPOLATION_DEPTH) {
    state.errors.push(`interpolation nests deeper than ${MAX_INTERPOLATION_DEPTH} levels`);
    state.stopped = true;
    return '';
  }
  let out = '';
  /**
   * Appends text unless the result would exceed {@link MAX_INTERPOLATED_LENGTH}.
   * @param piece Text to append.
   */
  const append = (piece: string): void => {
    if (state.stopped) {
      return;
    }
    if (out.length + piece.length > MAX_INTERPOLATED_LENGTH) {
      state.errors.push(`interpolated value exceeds ${MAX_INTERPOLATED_LENGTH} characters`);
      state.stopped = true;
      return;
    }
    out += piece;
  };

  let i = 0;
  while (i < text.length && !state.stopped) {
    const dollar = text.indexOf('$', i);
    if (dollar < 0) {
      append(text.slice(i));
      break;
    }
    append(text.slice(i, dollar));
    const next = text[dollar + 1];
    if (next === '$') {
      append('$');
      i = dollar + 2;
    } else if (isNameStart(next)) {
      const end = nameEnd(text, dollar + 1);
      append(evaluate(text.slice(dollar + 1, end), undefined, '', state, depth));
      i = end;
    } else if (next === '{') {
      const nameStart = dollar + 2;
      const close = closingBrace(text, nameStart);
      if (close < 0) {
        state.errors.push(formatError(text, nameStart));
        break;
      }
      i = close + 1;
      const end = nameEnd(text, nameStart);
      const operator = text[end] === '}' ? undefined : OPERATORS.find((op) => text.startsWith(op, end));
      if (!isNameStart(text[nameStart]) || (operator === undefined && end !== close)) {
        state.errors.push(formatError(text, nameStart));
        continue;
      }
      const argument = operator === undefined ? '' : text.slice(end + operator.length, close);
      append(evaluate(text.slice(nameStart, end), operator, argument, state, depth));
    } else {
      append('$');
      i = dollar + 1;
    }
  }
  return out;
}

/**
 * Interpolates Compose variables in a string. Work is bounded by {@link MAX_INTERPOLATION_DEPTH} and
 * {@link MAX_INTERPOLATED_LENGTH}, so a crafted file cannot hang the extension host; looked-up values
 * are inserted as they are and never interpolated again.
 * @param text Text as written in the compose or env file.
 * @param lookup Resolves a variable name, or undefined when it is unset.
 * @returns The expanded text, the names read, the unset ones and the errors.
 */
export function interpolate(text: string, lookup: Lookup): InterpolationResult {
  const state: ScanState = { lookup, references: [], unset: [], errors: [], stopped: false };
  const value = expand(text, state, 0);
  return { value, references: state.references, unset: state.unset, errors: state.errors };
}
