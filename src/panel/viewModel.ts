import { normalizeKey } from '../engine/keys';
import type { ConfigNode, Contribution, MergedEntry, SourceLocation } from '../engine/types';
import type { ViewNode } from './messages';

/**
 * Converts a configuration tree to the view tree sent to the webview, applying masking.
 * A node is masked when its entry is sensitive and its path is not in `revealed` (case-insensitive);
 * masked values, including those of overridden contributions, are sent as `null`.
 * @param root Root of the merged tree.
 * @param revealed Paths whose sensitive values are currently revealed.
 * @param locations Output map; filled with opaque ids (`l0`, `l1`, ...) for every contribution location.
 * @param idPrefix Prefix of the location ids (lets the host invalidate ids of earlier renders).
 * @returns The root view node.
 */
export function toViewModel(
  root: ConfigNode,
  revealed: Set<string>,
  locations: Map<string, SourceLocation>,
  idPrefix = '',
): ViewNode {
  const revealedNorm = new Set([...revealed].map(normalizeKey));
  let next = 0;
  const register = (location: SourceLocation | undefined): string | undefined => {
    if (!location) {
      return undefined;
    }
    const id = `${idPrefix}l${next++}`;
    locations.set(id, location);
    return id;
  };
  const convert = (node: ConfigNode): ViewNode => {
    const entry = node.entry;
    const sensitive = entry?.sensitive ?? false;
    const isRevealed = sensitive && revealedNorm.has(normalizeKey(node.path));
    const masked = sensitive && !isRevealed;
    const view: ViewNode = {
      segment: node.segment,
      path: node.path,
      masked,
      revealed: isRevealed,
      sensitive,
      overridden: [],
      isArray: node.isArray,
      flags: [...node.flags],
      children: [],
    };
    if (entry) {
      view.value = masked ? null : entry.value;
      view.winner = {
        layerLabel: entry.winner.layerLabel,
        locationId: register(entry.winner.location),
        ...(entry.winner.references ? { references: [...entry.winner.references] } : {}),
      };
      view.overridden = entry.overridden.map((c: Contribution) => ({
        layerLabel: c.layerLabel,
        value: masked ? null : c.value,
        masked,
        locationId: register(c.location),
        ...(c.references ? { references: [...c.references] } : {}),
      }));
    }
    view.children = node.children.map(convert);
    return view;
  };
  return convert(root);
}

/** Remembers which sensitive values the user revealed, and drops a reveal once a different layer wins. */
export class RevealState {
  private readonly revealed = new Map<string, string>();

  /**
   * Records a reveal.
   * @param path Key path of the value.
   * @param layerId Id of the layer currently winning that key.
   */
  reveal(path: string, layerId: string): void {
    this.revealed.set(normalizeKey(path), layerId);
  }

  /**
   * Forgets a reveal.
   * @param path Key path of the value.
   */
  hide(path: string): void {
    this.revealed.delete(normalizeKey(path));
  }

  /**
   * Computes the still-valid reveals; reveals whose winner layer changed (or whose key vanished) are forgotten.
   * @param entries Current merged entries.
   * @returns Keys (as displayed in `entries`) that remain revealed.
   */
  current(entries: MergedEntry[]): Set<string> {
    const result = new Set<string>();
    const stillValid = new Map<string, string>();
    for (const entry of entries) {
      const norm = normalizeKey(entry.key);
      const recorded = this.revealed.get(norm);
      if (recorded !== undefined && recorded === entry.winner.layerId) {
        result.add(entry.key);
        stillValid.set(norm, recorded);
      }
    }
    this.revealed.clear();
    for (const [k, v] of stillValid) {
      this.revealed.set(k, v);
    }
    return result;
  }
}
