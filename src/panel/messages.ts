import type { Diagnostic, NodeFlag } from '../engine/types';

/** A node of the tree sent to the webview. Raw secret values are never included while masked. */
export interface ViewNode {
  /** Last key segment. */
  segment: string;
  /** Full `:`-separated path. */
  path: string;
  /** Effective value; `null` when masked, absent when the node has no direct value. */
  value?: string | null;
  /** True when the value is hidden because it is sensitive and not revealed. */
  masked: boolean;
  /** True when the node is sensitive and currently revealed. */
  revealed: boolean;
  /** True when the value is considered sensitive. */
  sensitive: boolean;
  /** The winning source. */
  winner?: { layerLabel: string; locationId?: string };
  /** Overridden contributions, lowest priority first. */
  overridden: { layerLabel: string; value: string | null; masked: boolean; locationId?: string }[];
  /** True when the children are array items. */
  isArray: boolean;
  /** Oddity flags. */
  flags: NodeFlag[];
  /** Child nodes. */
  children: ViewNode[];
}

/** The complete view state the host posts to the webview. */
export interface ViewState {
  /** Projects that can be switched to. */
  projects: { id: string; name: string }[];
  /** The shown project's id. */
  projectId: string;
  /** Available launch profile names. */
  profiles: string[];
  /** Selected profile, when any. */
  profile?: string;
  /** Available environment names. */
  environments: string[];
  /** Selected environment. */
  environment: string;
  /** Root of the (masked) configuration tree. */
  root: ViewNode;
  /** Diagnostics to show as banners. */
  diagnostics: Diagnostic[];
  /** Merge-order label shown verbatim in the UI. */
  label: string;
}

/** Messages from the host to the webview. */
export type HostMessage = { type: 'state'; state: ViewState };

/** Messages from the webview to the host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'select'; projectId?: string; profile?: string | null; environment?: string }
  | { type: 'reveal'; path: string; revealed: boolean }
  | { type: 'openSource'; locationId: string }
  | { type: 'copy'; path: string; what: 'value' | 'keyPath' | 'envVarName' }
  | { type: 'exportMenu' }
  | { type: 'export'; format: 'json' | 'env'; revealAll: boolean }
  | { type: 'refresh' };
