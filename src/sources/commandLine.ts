import type { Diagnostic, LayerEntry } from '../engine/types';
import { envVarNameToKey } from '../engine/keys';

/** Result of parsing a command-line argument string. */
export interface CommandLineParseResult {
  /** Entries in argument order. */
  entries: LayerEntry[];
  /** Warnings for malformed or unsupported arguments. */
  diagnostics: Diagnostic[];
}

/**
 * Splits on whitespace, honoring double quotes (quotes are removed; `""` yields an empty token).
 * @param input Raw argument string.
 * @returns The tokens.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Hides everything after the first `=` of a token so secrets never reach diagnostics. */
function redact(token: string): string {
  const eq = token.indexOf('=');
  return eq >= 0 ? `${token.slice(0, eq)}=***` : token;
}

/**
 * Parses a command-line argument string the way the .NET command-line configuration
 * provider does for the `--key=value` and `--key value` forms (`__` in keys maps to `:`).
 * @param args Raw argument string, e.g. `--A:B=1 --C "two words"`.
 * @returns Entries (no location) and warnings: `missing value for argument: --k` when a
 * key has no value, `unsupported argument form: <arg>` for anything else.
 */
export function parseCommandLineArgs(args: string): CommandLineParseResult {
  const entries: LayerEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const tokens = tokenize(args);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--') || token.length === 2 || token.startsWith('--=')) {
      diagnostics.push({ severity: 'warning', message: `unsupported argument form: ${redact(token)}` });
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      entries.push({ key: envVarNameToKey(body.slice(0, eq)), value: body.slice(eq + 1) });
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      entries.push({ key: envVarNameToKey(body), value: tokens[++i] });
    } else {
      diagnostics.push({ severity: 'warning', message: `missing value for argument: ${redact(token)}` });
    }
  }
  return { entries, diagnostics };
}
