import type { ConfigNode, MergedEntry, NodeFlag } from './types';
import { compareKeys, isNumericSegment, splitKey } from './keys';

/** Mutable build-time node, converted to {@link ConfigNode} once all entries are inserted. */
interface BuildNode {
  segment: string;
  /** Lowest layer index of anything at or below this node; decides the display casing of `segment`. */
  rank: number;
  entry?: MergedEntry;
  children: Map<string, BuildNode>;
}

/** Creates an empty build node. */
function newNode(segment: string, rank: number): BuildNode {
  return { segment, rank, children: new Map() };
}

/** The lowest layer index among all contributions of an entry. */
function lowestLayerIndex(entry: MergedEntry): number {
  return Math.min(entry.winner.layerIndex, ...entry.overridden.map((c) => c.layerIndex));
}

/** Collects the distinct winner layer ids of every entry at or below a build node. */
function collectLayerIds(node: BuildNode, into: Set<string>): void {
  if (node.entry) {
    into.add(node.entry.winner.layerId);
  }
  for (const child of node.children.values()) {
    collectLayerIds(child, into);
  }
}

/** Converts a build node (recursively) into a sorted, flagged {@link ConfigNode}. */
function finalize(node: BuildNode, path: string): ConfigNode {
  const children = [...node.children.values()]
    .sort((a, b) => compareKeys(a.segment, b.segment))
    .map((c) => finalize(c, path === '' ? c.segment : `${path}:${c.segment}`));
  const isArray = children.length > 0 && children.every(c => isNumericSegment(c.segment));
  const flags: NodeFlag[] = [];
  if (isArray) {
    const layers = new Set<string>();
    for (const child of node.children.values()) {
      collectLayerIds(child, layers);
    }
    if (layers.size > 1) {
      flags.push('mixedArray');
    }
  }
  if (children.length > 0 && node.entry !== undefined && node.entry.value !== null) {
    flags.push('valueAndChildren');
  }
  const result: ConfigNode = { segment: node.segment, path, children, isArray, flags };
  if (node.entry) {
    result.entry = node.entry;
  }
  return result;
}

/**
 * Builds the hierarchical configuration tree from merged flat entries.
 * Segments are matched case-insensitively; the display casing of a segment comes from the lowest
 * layer that defines anything at or below it (ties keep the first-seen casing); children are sorted with
 * {@link compareKeys}; intermediate sections that never appear as their own key have no `entry`.
 * @param entries Merged entries (`Section:Key` → value + provenance).
 * @returns The root node (`segment` and `path` are empty, no entry).
 */
export function buildTree(entries: MergedEntry[]): ConfigNode {
  const root = newNode('', 0);
  for (const entry of entries) {
    let current = root;
    const rank = lowestLayerIndex(entry);
    for (const segment of splitKey(entry.key)) {
      const id = segment.toLowerCase();
      let child = current.children.get(id);
      if (!child) {
        child = newNode(segment, rank);
        current.children.set(id, child);
      } else if (rank < child.rank) {
        child.segment = segment;
        child.rank = rank;
      }
      current = child;
    }
    current.entry = entry;
  }
  return finalize(root, '');
}

/**
 * Flattens a tree into the nodes that carry an entry, in depth-first order
 * (a node precedes its children; siblings follow {@link compareKeys} order).
 * @param root Root of the tree from {@link buildTree}.
 * @returns Nodes with an `entry`, in display order.
 */
export function flattenTree(root: ConfigNode): ConfigNode[] {
  const out: ConfigNode[] = [];
  const visit = (node: ConfigNode): void => {
    if (node.entry) {
      out.push(node);
    }
    node.children.forEach(visit);
  };
  visit(root);
  return out;
}
