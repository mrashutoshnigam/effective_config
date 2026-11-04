import { keyToEnvVarName, normalizeKey } from '../engine/keys';
import { toEnvLines, toNestedJson } from '../engine/export';
import type { MergedEntry } from '../engine/types';

/** Placeholder emitted instead of a masked secret value. */
const MASKED_VALUE = '***';

/**
 * Computes the text to copy for one entry.
 * @param entries Merged entries of the current render.
 * @param path Key path of the entry (case-insensitive).
 * @param what Which representation to copy.
 * @param revealed Key paths whose sensitive values are currently revealed (case-insensitive).
 * @returns The text, or `undefined` when the value is masked (sensitive and not revealed) or unknown.
 * `keyPath` and `envVarName` also work for paths without an entry (section rows) and are built from `path`.
 */
export function copyText(
  entries: MergedEntry[],
  path: string,
  what: 'value' | 'keyPath' | 'envVarName',
  revealed: Set<string>,
): string | undefined {
  const norm = normalizeKey(path);
  const entry = entries.find((e) => normalizeKey(e.key) === norm);
  if (!entry) {
    switch (what) {
      case 'keyPath':
        return path;
      case 'envVarName':
        return keyToEnvVarName(path);
      case 'value':
        return undefined;
    }
  }
  switch (what) {
    case 'keyPath':
      return entry.key;
    case 'envVarName':
      return keyToEnvVarName(entry.key);
    case 'value': {
      if (entry.sensitive && ![...revealed].some((r) => normalizeKey(r) === norm)) {
        return undefined;
      }
      return entry.value ?? '';
    }
  }
}

/**
 * Renders all entries for export.
 * Individual reveals are ignored: sensitive values are written as `***` unless `revealAll` is set.
 * @param entries Merged entries.
 * @param format `json` for nested JSON, `env` for `NAME=value` lines.
 * @param revealAll True to include sensitive values in plain text.
 * @returns The export text.
 */
export function exportText(entries: MergedEntry[], format: 'json' | 'env', revealAll: boolean): string {
  const valueOf = (e: MergedEntry): string | null => (e.sensitive && !revealAll ? MASKED_VALUE : e.value);
  return format === 'json' ? toNestedJson(entries, valueOf) : toEnvLines(entries, valueOf);
}
