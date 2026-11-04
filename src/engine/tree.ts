import type { ConfigNode, MergedEntry, NodeFlag } from './types';
import { compareKeys, isNumericSegment, splitKey } from './keys';

/** Mutable build-time node, converted to {@link ConfigNode} once all entries are inserted. */
interface BuildNode {
  segment: string;
  path: string;
  entry?: MergedEntry;
  children: Map<string, BuildNode>;
}

/** Creates an empty build node. */
function newNode(segment: string, path: string): BuildNode {
  return { segment, path, children: new Map() };
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
function finalize(node: BuildNode): ConfigNode {
  const children = [...node.children.values()]
    .sort((a, b) => compareKeys(a.segment, b.segment))
    .map(finalize);
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
  const result: ConfigNode = { segment: node.segment, path: node.path, children, isArray, flags };
  if (node.entry) {
    result.entry = node.entry;
  }
  return result;
}

/**
 * Builds the hierarchical configuration tree from merged flat entries.
 * Segments are matched case-insensitively (first-seen casing is kept); children are sorted with
 * {@link compareKeys}; intermediate sections that never appear as their own key have no `entry`.
 * @param entries Merged entries (`Section:Key` → value + provenance).
 * @returns The root node (`segment` and `path` are empty, no entry).
 */
export function buildTree(entries: MergedEntry[]): ConfigNode {
  const root = newNode('', '');
  for (const entry of entries) {
    let current = root;
    const segments = splitKey(entry.key);
    segments.forEach((segment, i) => {
      const id = segment.toLowerCase();
      let child = current.children.get(id);
      if (!child) {
        child = newNode(segment, segments.slice(0, i + 1).join(':'));
        current.children.set(id, child);
      }
      current = child;
    });
    current.entry = entry;
  }
  return finalize(root);
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
