import { LineCounter, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import type { Alias, Document, Node, Pair, Scalar, YAMLError, YAMLMap } from 'yaml';
import type { Diagnostic, LayerEntry, SourceLocation } from '../engine/types';
import { stripBom } from './jsonLayer';

/**
 * Most nodes one file may expand to. Bounds the work an untrusted file can cause through aliases, which
 * would otherwise freeze the extension host; far above what the panel can usefully show.
 */
const MAX_EXPANDED_NODES = 1_000_000;

/**
 * Most characters the flattened keys of one file may total. Bounds memory, since each key repeats its
 * parents, so a short file with a long key can expand to gigabytes when the merge engine copies the keys.
 */
const MAX_KEY_CHARS = 32_000_000;

/** Deepest nesting one file may expand to, so that chains of aliases cannot overflow the stack. */
const MAX_NESTING = 512;

/** Result of parsing one YAML configuration file. */
export interface YamlLayerParseResult {
  /**
   * Flattened entries of all documents in file order (empty on error). When the layer is merged, a key
   * repeated in a later document overrides the earlier one. This works key by key, as between layers, so
   * a shorter array in a later document keeps the earlier document's remaining items.
   */
  entries: LayerEntry[];
  /** The same entries per document, by position in the file; an empty document is an empty list. */
  documents: LayerEntry[][];
  /** Problems found while parsing. */
  diagnostics: Diagnostic[];
}

/** A problem that makes the whole file unusable, raised while flattening. */
class YamlLayerError extends Error {
  /**
   * Creates the error.
   * @param message Message shown to the user; must not quote values from the file.
   * @param offset Character offset the problem refers to.
   */
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

/** One key of a mapping after merge keys are applied. */
interface FlatPair {
  /** Key segment contributed to the flattened key. */
  segment: string;
  /** Key node, which locates a key without a value. */
  key: Node;
  /** Value node; null for a key without a value, such as `x` in `{x, y: 1}`. */
  value: Node | null;
  /** Key this pair was merged from, when it came through a merge key. */
  origin?: string;
}

/** What one file may still expand to, shared by all its documents. */
interface ExpansionBudget {
  /** Nodes left; see {@link MAX_EXPANDED_NODES}. */
  nodes: number;
  /** Flattened key characters left; see {@link MAX_KEY_CHARS}. */
  keyChars: number;
}

/** A `<<` key of a mapping, waiting to be expanded. */
interface MergeSlot {
  /** The merge key node. */
  key: Node;
  /** The merge value node; null when the key has no value. */
  merge: Node | null;
}

/**
 * Converts a scalar to its configuration value: strings decoded, null as `""`, anything else as raw
 * source text, because each consumer parses configuration strings its own way.
 * @param node Scalar node.
 * @returns The value.
 */
function scalarValue(node: Scalar): string {
  if (node.value === null) {
    return '';
  }
  return typeof node.value === 'string' ? node.value : String(node.source ?? node.value);
}

/**
 * Gets the offset where a node starts.
 * @param node Parsed node.
 * @returns The 0-based character offset of its first token.
 */
function startOf(node: Node): number {
  return node.range?.[0] ?? 0;
}

/**
 * Joins a key prefix and a segment.
 * @param prefix Key so far; empty at the root.
 * @param segment Segment to add.
 * @returns The `:`-joined key.
 */
function joinKey(prefix: string, segment: string): string {
  return prefix ? `${prefix}:${segment}` : segment;
}

/**
 * Extends a source key by one segment.
 * @param origin Key a collection was reached from, when it was reached through an alias or merge key.
 * @param segment Segment of a child.
 * @returns The child's source key, or undefined when there is no source key.
 */
function originBelow(origin: string | undefined, segment: string): string | undefined {
  return origin === undefined ? undefined : joinKey(origin, segment);
}

/**
 * Tells whether a document holds nothing: comments only, a bare marker or an explicit null.
 * @param doc Parsed document.
 * @returns True when the document is empty.
 */
function isEmptyDocument(doc: Document): boolean {
  return doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null);
}

/**
 * Tells whether a mapping key is the merge key: a plain `<<`, which the parser resolves to a symbol.
 * A quoted `"<<"` stays an ordinary string.
 * @param key Mapping key node.
 * @returns True for the merge key.
 */
function isMergeKey(key: Node): boolean {
  return isScalar(key) && typeof key.value === 'symbol';
}

/**
 * Maps each alias of a document to the node it refers to, the most recent anchor of that name before it.
 * One pass in document order, because the parser's `Alias.resolve` rescans the document on every call,
 * which is quadratic on files with many aliases.
 * @param doc Parsed document.
 * @returns The targets; an alias with no anchor before it has none.
 */
function resolveAliases(doc: Document): Map<Alias, Node> {
  const targets = new Map<Alias, Node>();
  const anchors = new Map<string, Node>();
  visit(doc, {
    /**
     * Records anchors as they appear and resolves aliases against those seen so far.
     * @param _key Position of the node in its parent.
     * @param node Visited node.
     */
    Node(_key, node) {
      if (isAlias(node)) {
        const target = anchors.get(node.source);
        if (target) {
          targets.set(node, target);
        }
      } else if (node.anchor) {
        anchors.set(node.anchor, node);
      }
    },
  });
  return targets;
}

/** Flattens one parsed document into entries, expanding aliases and merge keys. */
class DocumentFlattener {
  /** Target of each alias in the document. */
  private readonly targets: Map<Alias, Node>;
  /** Collections being expanded, used to detect one that contains itself through an alias. */
  private readonly active = new Set<Node>();
  /** Entries produced so far, in source order. */
  private readonly entries: LayerEntry[] = [];
  /** Flattened key of each anchored node, recorded where it is defined. */
  private readonly anchorPaths = new Map<Node, string>();

  /**
   * Creates the flattener.
   * @param doc Document to flatten.
   * @param budget What the file may still expand to.
   * @param loc Converts a character offset to a source location.
   */
  constructor(
    private readonly doc: Document,
    private readonly budget: ExpansionBudget,
    private readonly loc: (offset: number) => SourceLocation,
  ) {
    this.targets = resolveAliases(doc);
  }

  /**
   * Flattens the document.
   * @returns Its entries; none for an empty document.
   * @throws YamlLayerError When the document cannot be flattened.
   */
  run(): LayerEntry[] {
    if (isEmptyDocument(this.doc)) {
      return this.entries;
    }
    const root = this.doc.contents as Node;
    if (!isMap(root)) {
      throw new YamlLayerError('root must be a mapping', startOf(root));
    }
    this.flatten(root, '', 0);
    return this.entries;
  }

  /**
   * Adds one entry, located at the token that holds its value.
   * @param key Flattened key.
   * @param value Entry value.
   * @param node Node holding the value.
   * @param origin Key the value was reached from through an alias or merge key. Recorded as a reference,
   * so the merge engine keeps the value masked when that key is sensitive.
   * @throws YamlLayerError When the file's flattened keys grow too long.
   */
  private add(key: string, value: string | null, node: Node, origin: string | undefined): void {
    this.budget.keyChars -= key.length;
    if (this.budget.keyChars < 0) {
      throw new YamlLayerError(`YAML keys total more than ${MAX_KEY_CHARS} characters when flattened`, startOf(node));
    }
    this.entries.push({
      key,
      value,
      location: this.loc(startOf(node)),
      ...(origin === undefined ? {} : { references: [origin] }),
    });
  }

  /**
   * Counts one more node against the file's limits.
   * @param node Node being expanded.
   * @param depth Current nesting.
   * @throws YamlLayerError When a limit is exceeded.
   */
  private charge(node: Node, depth: number): void {
    if (--this.budget.nodes < 0) {
      throw new YamlLayerError(`YAML expands to more than ${MAX_EXPANDED_NODES} nodes`, startOf(node));
    }
    if (depth > MAX_NESTING) {
      throw new YamlLayerError(`YAML nests deeper than ${MAX_NESTING} levels`, startOf(node));
    }
  }

  /**
   * Follows an alias to the node it refers to.
   * @param node Any node.
   * @returns The alias target, or the node itself when it is not an alias.
   * @throws YamlLayerError When the alias has no anchor or refers to a collection containing it.
   */
  private deref(node: Node): Node {
    if (!isAlias(node)) {
      return node;
    }
    const target = this.targets.get(node);
    // The alias name stays out of these messages: an unquoted password starting with `*` parses as one.
    if (!target) {
      throw new YamlLayerError('Unresolved alias', startOf(node));
    }
    if (this.active.has(target)) {
      throw new YamlLayerError('Alias refers to a collection containing it', startOf(node));
    }
    return target;
  }

  /**
   * Gets the key segment of a mapping key.
   * @param key Mapping key node.
   * @returns The segment.
   * @throws YamlLayerError When the key is not a non-null scalar, which has no flat form.
   */
  private keySegment(key: Node): string {
    const target = this.deref(key);
    if (!isScalar(target)) {
      throw new YamlLayerError('Mapping keys must be scalars', startOf(key));
    }
    if (target.value === null) {
      throw new YamlLayerError('Mapping keys must not be null', startOf(key));
    }
    return scalarValue(target);
  }

  /**
   * Lists the mappings named by a merge value: one mapping or alias, or a sequence of them.
   * @param slot The merge key and its value.
   * @returns The source mappings, highest priority first.
   * @throws YamlLayerError When a source is not a mapping.
   */
  private mergeSources(slot: MergeSlot): YAMLMap[] {
    if (slot.merge === null) {
      throw new YamlLayerError('Merge sources must be mappings', startOf(slot.key));
    }
    const value = this.deref(slot.merge);
    const candidates = isSeq(value) ? (value.items as Node[]) : [slot.merge];
    return candidates.map((candidate) => {
      const source = this.deref(candidate);
      if (!isMap(source)) {
        throw new YamlLayerError('Merge sources must be mappings', startOf(candidate));
      }
      return source;
    });
  }

  /**
   * Lists the keys of a mapping with merge keys applied, at the position of their `<<`. Explicit keys
   * win wherever they are written, and an earlier merge source wins over a later one.
   * @param map Mapping to read; the caller has marked it as active.
   * @param path Flattened key of the mapping.
   * @param depth Current nesting.
   * @returns The effective keys.
   * @throws YamlLayerError When a key repeats or a merge cannot be applied.
   */
  private pairsOf(map: YAMLMap, path: string, depth: number): FlatPair[] {
    const seen = new Set<string>();
    const slots = (map.items as Pair<Node, Node | null>[]).map((pair): FlatPair | MergeSlot => {
      this.charge(pair.key, depth);
      if (isMergeKey(pair.key)) {
        return { key: pair.key, merge: pair.value };
      }
      const segment = this.keySegment(pair.key);
      if (seen.has(segment)) {
        throw new YamlLayerError(`Duplicate key '${joinKey(path, segment)}'`, startOf(pair.key));
      }
      seen.add(segment);
      return { segment, key: pair.key, value: pair.value };
    });

    const result: FlatPair[] = [];
    for (const slot of slots) {
      if (!('merge' in slot)) {
        result.push(slot);
        continue;
      }
      for (const source of this.mergeSources(slot)) {
        const sourcePath = this.anchorPaths.get(source);
        this.active.add(source);
        for (const merged of this.pairsOf(source, path, depth + 1)) {
          if (!seen.has(merged.segment)) {
            seen.add(merged.segment);
            result.push({ ...merged, origin: merged.origin ?? originBelow(sourcePath, merged.segment) });
          }
        }
        this.active.delete(source);
      }
    }
    return result;
  }

  /**
   * Adds the entries of a node and everything below it.
   * @param node Node to expand.
   * @param path Flattened key of the node; empty at the root.
   * @param depth Current nesting.
   * @param inherited Key the enclosing collection was reached from through an alias or merge key.
   * @throws YamlLayerError When the node cannot be flattened.
   */
  private flatten(node: Node, path: string, depth: number, inherited?: string): void {
    this.charge(node, depth);
    const target = this.deref(node);
    const origin = isAlias(node) ? this.anchorPaths.get(target) ?? inherited : inherited;
    if (!isAlias(node) && target.anchor && !this.anchorPaths.has(target)) {
      this.anchorPaths.set(target, path);
    }
    if (isMap(target)) {
      this.active.add(target);
      const pairs = this.pairsOf(target, path, depth);
      if (pairs.length === 0 && path) {
        this.add(path, null, target, origin);
      }
      for (const pair of pairs) {
        const childPath = joinKey(path, pair.segment);
        const childOrigin = pair.origin ?? originBelow(origin, pair.segment);
        if (pair.value === null) {
          this.add(childPath, '', pair.key, childOrigin);
        } else {
          this.flatten(pair.value, childPath, depth + 1, childOrigin);
        }
      }
      this.active.delete(target);
    } else if (isSeq(target)) {
      this.active.add(target);
      if (target.items.length === 0) {
        this.add(path, null, target, origin);
      }
      let index = 0;
      for (const item of target.items as Node[]) {
        const segment = String(index++);
        this.flatten(item, joinKey(path, segment), depth + 1, originBelow(origin, segment));
      }
      this.active.delete(target);
    } else if (isScalar(target)) {
      this.add(path, scalarValue(target), target, origin);
    }
  }
}

/**
 * Parses a YAML file into flat `Section:Key` entries, one list per document. Plain scalars keep their
 * source text, quoted and block scalars are decoded, null and missing values become `""`, and empty
 * collections become a single entry with a `null` value. Aliases and merge keys are expanded, and their
 * entries are located at the anchored value, where it can be edited, and reference the anchored key, so
 * they stay masked when it is sensitive. A leading BOM is ignored (positions refer to the text without it).
 *
 * Keys are compared exactly, unlike JSON layers, whose case-insensitive check is a .NET rule: `A` and `a`
 * are distinct YAML keys, and the merge engine's later-entry-wins rule applies to them.
 *
 * Parser problems are reported by code only, as in JSON layers: the parser's messages quote the source,
 * and an unquoted secret on a broken line must not reach the diagnostics banner.
 * @param text File contents.
 * @param filePath Path recorded in each entry's location.
 * @returns Entries and diagnostics. A problem in any document yields no entries and one error; a file
 * with no content yields no entries and an `info` diagnostic.
 */
export function parseYamlLayer(text: string, filePath: string): YamlLayerParseResult {
  text = stripBom(text);
  const lineCounter = new LineCounter();
  // uniqueKeys is off because the parser's check is quadratic on large mappings; pairsOf checks instead.
  const parsed = parseAllDocuments(text, { lineCounter, prettyErrors: false, merge: true, uniqueKeys: false });
  const docs: Document[] = [...parsed];

  /**
   * Converts a character offset to a source location.
   * @param offset 0-based character offset.
   * @returns The location in this file.
   */
  const loc = (offset: number): SourceLocation => {
    const { line, col } = lineCounter.linePos(offset);
    return { filePath, line: line - 1, column: col - 1 };
  };
  /**
   * Builds the result of a file that cannot be used.
   * @param message Message shown to the user.
   * @param offset Character offset the problem refers to.
   * @returns No entries and one error.
   */
  const fileError = (message: string, offset: number): YamlLayerParseResult => ({
    entries: [],
    documents: [],
    diagnostics: [{ severity: 'error', message, location: loc(offset) }],
  });
  /**
   * Reports parser warnings as one diagnostic, because the banner has one row per diagnostic.
   * @param warnings Parser warnings.
   * @returns One warning at the first problem, or nothing when there are none.
   */
  const summarizeWarnings = (warnings: YAMLError[]): Diagnostic[] => {
    if (warnings.length === 0) {
      return [];
    }
    const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : '';
    return [{ severity: 'warning', message: `YAML warning: ${warnings[0].code}${more}`, location: loc(warnings[0].pos[0]) }];
  };

  const problems = 'empty' in parsed ? parsed : { errors: docs.flatMap((d) => d.errors), warnings: docs.flatMap((d) => d.warnings) };
  if (problems.errors.length > 0) {
    const first = problems.errors[0];
    return fileError(`YAML parse error: ${first.code}`, first.pos[0]);
  }
  if (docs.every(isEmptyDocument)) {
    return { entries: [], documents: docs.map(() => []), diagnostics: [{ severity: 'info', message: 'empty file', location: loc(0) }] };
  }

  try {
    const budget: ExpansionBudget = { nodes: MAX_EXPANDED_NODES, keyChars: MAX_KEY_CHARS };
    const documents = docs.map((doc) => new DocumentFlattener(doc, budget, loc).run());
    return { entries: documents.flat(), documents, diagnostics: summarizeWarnings(problems.warnings) };
  } catch (error) {
    if (error instanceof YamlLayerError) {
      return fileError(error.message, error.offset);
    }
    throw error;
  }
}
