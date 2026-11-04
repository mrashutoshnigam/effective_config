import { compareKeys, normalizeKey, splitKey } from './keys';
import { isSensitiveKey } from './mask';
import type { Contribution, Layer, MergedEntry } from './types';

/** Internal accumulator for one normalized key. */
interface Acc {
  key: string;
  contributions: Contribution[];
}

/** Compares two keys segment by segment; a key that is a prefix of another sorts first. */
function compareFullKeys(a: string, b: string): number {
  const sa = splitKey(a);
  const sb = splitKey(b);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(sa[i], sb[i]);
    if (c !== 0) {
      return c;
    }
  }
  return sa.length - sb.length;
}

/**
 * Marks contributions sensitive when any key they were expanded from is sensitive
 * (matches a mask pattern, or its merged entry has a sensitive contribution).
 * References must already be in `:` key form (matched case-insensitively; unknown keys are ignored).
 * Iterates to a fixpoint; sensitivity only ever turns on, so reference cycles terminate.
 */
function propagateSensitivity(map: Map<string, Acc>, maskPatterns: string[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const acc of map.values()) {
      for (const c of acc.contributions) {
        if (c.sensitive || !c.references) {
          continue;
        }
        const tainted = c.references.some(
          (ref) =>
            isSensitiveKey(ref, maskPatterns) ||
            (map.get(normalizeKey(ref))?.contributions.some((x) => x.sensitive) ?? false),
        );
        if (tainted) {
          c.sensitive = true;
          changed = true;
        }
      }
    }
  }
}

/**
 * Merges configuration layers (lowest priority first) into effective entries with provenance.
 * Keys are matched case-insensitively; the first layer defining a key fixes its display casing.
 * Within one layer a later entry overrides an earlier one with the same key.
 * @param layers Layers ordered lowest priority first.
 * @param maskPatterns Glob patterns whose matching keys are flagged sensitive.
 * @returns Merged entries sorted by key (per-segment .NET ordering).
 */
export function mergeLayers(layers: Layer[], maskPatterns: string[]): MergedEntry[] {
  const map = new Map<string, Acc>();
  layers.forEach((layer, layerIndex) => {
    for (const entry of layer.entries) {
      const norm = normalizeKey(entry.key);
      let acc = map.get(norm);
      if (!acc) {
        acc = { key: entry.key, contributions: [] };
        map.set(norm, acc);
      }
      acc.contributions.push({
        layerId: layer.id,
        layerLabel: layer.label,
        layerIndex,
        value: entry.value,
        location: entry.location,
        sensitive: layer.sensitive || isSensitiveKey(entry.key, maskPatterns),
        ...(entry.references ? { references: [...entry.references] } : {}),
      });
    }
  });
  propagateSensitivity(map, maskPatterns);
  const result: MergedEntry[] = [];
  for (const acc of map.values()) {
    const winner = acc.contributions[acc.contributions.length - 1];
    result.push({
      key: acc.key,
      value: winner.value,
      winner,
      overridden: acc.contributions.slice(0, -1),
      sensitive: acc.contributions.some((c) => c.sensitive),
    });
  }
  return result.sort((x, y) => compareFullKeys(x.key, y.key));
}
