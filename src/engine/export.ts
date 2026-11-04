import type { ConfigNode, MergedEntry } from './types';
import { keyToEnvVarName } from './keys';
import { buildTree } from './tree';

/** True when the node's children are numeric segments forming exactly 0..n-1 (in sorted order). */
function isDenseArray(node: ConfigNode): boolean {
  return node.isArray && node.children.every((c, i) => Number(c.segment) === i);
}

/** Converts a node to a JSON-serializable value. */
function nodeToJson(node: ConfigNode, valueOf: (e: MergedEntry) => string | null): unknown {
  if (node.children.length === 0) {
    if (!node.entry || node.entry.value === null) {
      return {};
    }
    return valueOf(node.entry);
  }
  const hasDirectValue = node.entry !== undefined && node.entry.value !== null;
  if (!hasDirectValue && isDenseArray(node)) {
    return node.children.map(c => nodeToJson(c, valueOf));
  }
  const obj: Record<string, unknown> = {};
  for (const child of node.children) {
    obj[child.segment] = nodeToJson(child, valueOf);
  }
  return obj;
}

/**
 * Exports merged entries as nested JSON (2-space indent).
 * Children that are numeric segments exactly 0..n-1 become a JSON array, otherwise an object.
 * A key with both a direct value and children becomes an object and the scalar is dropped (lossy by design).
 * A leaf with a `null` value (empty section) becomes `{}`; a leaf whose `valueOf` result is `null` (masked) becomes `null`.
 * @param entries Merged entries.
 * @param valueOf Supplies the value to emit for an entry (e.g. applies masking).
 * @returns The JSON text.
 */
export function toNestedJson(entries: MergedEntry[], valueOf: (e: MergedEntry) => string | null): string {
  const root = buildTree(entries);
  return JSON.stringify(nodeToJson(root, valueOf), null, 2);
}

/**
 * Exports merged entries as `NAME=value` environment-variable lines (`:` becomes the separator).
 * Entries with a `null` value (empty sections) are skipped; a `null` result from `valueOf` yields an empty value.
 * @param entries Merged entries.
 * @param valueOf Supplies the value to emit for an entry (e.g. applies masking).
 * @param separator Separator replacing `:` in names; defaults to `__`.
 * @returns Lines joined with `\n`, without a trailing newline.
 */
export function toEnvLines(
  entries: MergedEntry[],
  valueOf: (e: MergedEntry) => string | null,
  separator = '__',
): string {
  return entries
    .filter(e => e.value !== null)
    .map(e => `${keyToEnvVarName(e.key, separator)}=${valueOf(e) ?? ''}`)
    .join('\n');
}
