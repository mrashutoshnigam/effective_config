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
  winner?: { layerLabel: string; locationId?: string; references?: string[] };
  /** Overridden contributions, lowest priority first. */
  overridden: { layerLabel: string; value: string | null; masked: boolean; locationId?: string; references?: string[] }[];
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
  projects: { id: string; name: string; kind: string; tag: string }[];
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

/** Checks one message body (already known to be an object) for its type. */
type Validator = (m: Record<string, unknown>) => boolean;

/** True when the value is undefined or a string. */
const optString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * One validator per {@link WebviewMessage} type. The mapped type makes the table exhaustive: adding a
 * message type without a validator fails type-checking, so the protocol and its guard cannot drift.
 */
const VALIDATORS: { [K in WebviewMessage['type']]: Validator } = {
  ready: () => true,
  refresh: () => true,
  exportMenu: () => true,
  select: (m) => optString(m.projectId) && (m.profile === null || optString(m.profile)) && optString(m.environment),
  reveal: (m) => typeof m.path === 'string' && typeof m.revealed === 'boolean',
  openSource: (m) => typeof m.locationId === 'string',
  copy: (m) => typeof m.path === 'string' && (m.what === 'value' || m.what === 'keyPath' || m.what === 'envVarName'),
  export: (m) => (m.format === 'json' || m.format === 'env') && typeof m.revealAll === 'boolean',
};

/** The message types of the webview-to-host protocol. */
export const WEBVIEW_MESSAGE_TYPES = Object.keys(VALIDATORS) as WebviewMessage['type'][];

/**
 * Type guard validating the shape of a message received from the webview.
 * @param value Anything received over the webview channel.
 * @returns True when `value` is a well-formed {@link WebviewMessage}.
 */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const m = value as Record<string, unknown>;
  return typeof m.type === 'string' && Object.hasOwn(VALIDATORS, m.type) && VALIDATORS[m.type as WebviewMessage['type']](m);
}
