/** The kind of configuration source a {@link Layer} was read from. */
export type LayerKind = 'json' | 'userSecrets' | 'envOs' | 'envProfile' | 'commandLine';

/** A position inside a source file. `line` and `column` are 0-based. */
export interface SourceLocation {
  /** Path of the file containing the value. */
  filePath: string;
  /** 0-based line number. */
  line: number;
  /** 0-based column number. */
  column: number;
}

/** A single flattened `Section:Key` entry produced by one layer. */
export interface LayerEntry {
  /** Flattened key using `:` as separator. */
  key: string;
  /** Value as .NET would store it; `null` marks a section with no direct value (empty object/array). */
  value: string | null;
  /** Where the value token lives in the source file, when known. */
  location?: SourceLocation;
}

/** One configuration source (file, env vars, command line) with its flattened entries. */
export interface Layer {
  /** Stable identifier of the layer. */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Kind of source this layer represents. */
  kind: LayerKind;
  /** True when values from this layer should be masked by default. */
  sensitive: boolean;
  /** Backing file path, if the layer is file based. */
  filePath?: string;
  /** Flattened entries in source order. */
  entries: LayerEntry[];
}

/** A problem or note raised while reading or merging configuration. */
export interface Diagnostic {
  /** Seriousness of the diagnostic. */
  severity: 'error' | 'warning' | 'info';
  /** Message shown to the user. */
  message: string;
  /** Location the diagnostic refers to, when known. */
  location?: SourceLocation;
}

/** A value contributed to a key by one layer. */
export interface Contribution {
  /** Id of the contributing layer. */
  layerId: string;
  /** Label of the contributing layer. */
  layerLabel: string;
  /** The contributed value (`null` for a section without direct value). */
  value: string | null;
  /** Source location of the contribution, when known. */
  location?: SourceLocation;
}

/** The merged result for one key: the winning contribution and those it overrode. */
export interface MergedEntry {
  /** Display-cased flattened key. */
  key: string;
  /** Effective value. */
  value: string | null;
  /** The highest-priority contribution. */
  winner: Contribution;
  /** Lower-priority contributions that were overridden. */
  overridden: Contribution[];
  /** True when the value should be masked by default. */
  sensitive: boolean;
}

/** Flags describing oddities of a {@link ConfigNode}. */
export type NodeFlag = 'mixedArray' | 'valueAndChildren';

/** A node of the merged configuration tree. */
export interface ConfigNode {
  /** Last key segment of this node. */
  segment: string;
  /** Full `:`-separated path of this node. */
  path: string;
  /** Merged entry when the node has a direct value. */
  entry?: MergedEntry;
  /** Child nodes. */
  children: ConfigNode[];
  /** True when the children are array items. */
  isArray: boolean;
  /** Oddity flags for this node. */
  flags: NodeFlag[];
}
