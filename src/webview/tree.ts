import type { ViewNode, WebviewMessage } from '../panel/messages';
import { button, el } from './dom';
import type { UiState } from './render';

/** Text shown in place of a masked value. */
const MASK = '••••••';

/** Callback used to post messages to the host. */
type Post = (m: WebviewMessage) => void;

/** Context shared while rendering the body. */
export interface BodyContext {
  /** Persistent UI state. */
  ui: UiState;
  /** Posts a message to the host. */
  post: Post;
  /** Re-renders the body after a UI state change. */
  rerender: () => void;
  /** Notifies that the UI state changed (for persistence). */
  changed: () => void;
}

/**
 * Tells whether a section is shown expanded. `ui.expanded` holds explicit choices: `path` for
 * expanded and `!path` for collapsed; absent entries fall back to "top-level expanded".
 * @param ui UI state.
 * @param path Section path.
 * @param depth Depth of the section (top-level sections are 1).
 * @param searching True while a search query is active (everything expanded).
 * @returns True when expanded.
 */
export function isExpanded(ui: UiState, path: string, depth: number, searching: boolean): boolean {
  if (searching) {
    return true;
  }
  if (ui.expanded.has(path)) {
    return true;
  }
  if (ui.expanded.has('!' + path)) {
    return false;
  }
  return depth <= 1;
}

/**
 * Flips a section's expansion and records it in the UI state, keeping only choices that differ from the default.
 * @param ui UI state.
 * @param path Section path.
 * @param depth Section depth.
 */
function toggle(ui: UiState, path: string, depth: number): void {
  const next = !isExpanded(ui, path, depth, false);
  ui.expanded.delete(path);
  ui.expanded.delete('!' + path);
  if (next !== depth <= 1) {
    ui.expanded.add(next ? path : '!' + path);
  }
}

/**
 * Describes a value as text for the override chain.
 * @param value Value, null when masked or an empty section.
 * @param masked Whether the value is masked.
 * @returns Display text.
 */
function chainText(value: string | null | undefined, masked: boolean): string {
  if (masked) {
    return '(masked)';
  }
  return value === null || value === undefined ? '(empty section)' : value;
}

/**
 * Builds a source label: a button opening the source when it has a location, else plain text.
 * @param label Layer label.
 * @param locationId Optional location id.
 * @param post Message poster.
 * @param className Optional class.
 * @returns The element.
 */
function sourceLabel(label: string, locationId: string | undefined, post: Post, className?: string): HTMLElement {
  if (!locationId) {
    return el('span', className, label);
  }
  const b = button(label, 'openSource', () => post({ type: 'openSource', locationId }));
  if (className) {
    b.className = className;
  }
  return b;
}

/**
 * Builds the value cell of a row, with reveal/hide controls for sensitive values.
 * @param node The node.
 * @param post Message poster.
 * @returns The cell element.
 */
function valueCell(node: ViewNode, post: Post): HTMLElement {
  const cell = el('span', 'value');
  if (node.masked) {
    cell.append(el('span', 'masked', MASK));
    cell.append(
      button('👁', 'reveal', () => post({ type: 'reveal', path: node.path, revealed: true }), 'Reveal value'),
    );
    return cell;
  }
  cell.append(el('span', 'text', node.value ?? ''));
  if (node.sensitive && node.revealed) {
    cell.append(button('🙈', 'hide', () => post({ type: 'reveal', path: node.path, revealed: false }), 'Hide value'));
  }
  return cell;
}

/**
 * Builds the expandable override chain: winner first, then overridden contributions newest first.
 * @param node The node.
 * @param post Message poster.
 * @returns The details element.
 */
function chain(node: ViewNode, ctx: BodyContext): HTMLElement {
  const post = ctx.post;
  const details = el('details', 'chain');
  const open = (ctx.ui.openChains ??= new Set<string>());
  details.open = open.has(node.path);
  details.addEventListener('toggle', () => {
    if (details.open === open.has(node.path)) {
      return;
    }
    if (details.open) {
      open.add(node.path);
    } else {
      open.delete(node.path);
    }
    ctx.changed();
  });
  details.append(el('summary', undefined, `${node.overridden.length} overridden`));
  const list = el('ul');
  const add = (label: string, locationId: string | undefined, text: string): void => {
    const li = el('li');
    li.append(sourceLabel(label, locationId, post), document.createTextNode(' '), el('span', 'chain-value', text));
    list.append(li);
  };
  if (node.winner) {
    add(node.winner.layerLabel, node.winner.locationId, chainText(node.value, node.masked));
  }
  for (const o of [...node.overridden].reverse()) {
    add(o.layerLabel, o.locationId, chainText(o.value, o.masked));
  }
  details.append(list);
  return details;
}

/**
 * Builds the warning icon for a flag.
 * @param text Tooltip text.
 * @returns The icon element.
 */
function warning(text: string): HTMLElement {
  const w = el('span', 'warn', '⚠');
  w.title = text;
  w.setAttribute('role', 'img');
  w.tabIndex = 0;
  w.setAttribute('aria-label', text);
  return w;
}

/**
 * Builds one row for a node.
 * @param node The node.
 * @param keyText Text of the key cell.
 * @param depth Indentation depth (0 for flat mode).
 * @param expandable Expansion state when the node is a section in tree mode, else undefined.
 * @param ctx Render context.
 * @returns The row element.
 */
function row(node: ViewNode, keyText: string, depth: number, expandable: boolean | undefined, ctx: BodyContext, searching = false): HTMLElement {
  const r = el('div', `row d${Math.min(depth, 12)}`);
  r.dataset.path = node.path;
  if (expandable !== undefined) {
    const t = button(expandable ? '▾' : '▸', 'toggle', () => {
      toggle(ctx.ui, node.path, depth);
      ctx.changed();
      ctx.rerender();
    }, `${expandable ? 'Collapse' : 'Expand'} ${node.segment}`);
    t.className = 'toggle';
    t.disabled = searching;
    t.setAttribute('aria-expanded', String(expandable));
    r.append(t);
  } else {
    r.append(el('span', 'toggle-spacer'));
  }
  r.append(el('span', 'key', keyText));
  if (node.flags.includes('valueAndChildren')) {
    r.append(warning('section also has a direct value'));
  }
  if (node.flags.includes('mixedArray')) {
    r.append(warning('array items come from multiple sources'));
  }
  if (node.value !== undefined) {
    r.append(valueCell(node, ctx.post));
    if (node.winner) {
      r.append(sourceLabel(node.winner.layerLabel, node.winner.locationId, ctx.post, 'badge'));
    }
    const actions = el('span', 'actions');
    if (!node.masked) {
      actions.append(button('⧉', 'copy-value', () => ctx.post({ type: 'copy', path: node.path, what: 'value' }), 'Copy value'));
    }
    actions.append(button('⌘', 'copy-key', () => ctx.post({ type: 'copy', path: node.path, what: 'keyPath' }), 'Copy key path'));
    actions.append(button('$', 'copy-env', () => ctx.post({ type: 'copy', path: node.path, what: 'envVarName' }), 'Copy env var name'));
    r.append(actions);
    if (node.overridden.length > 0) {
      r.append(chain(node, ctx));
    }
  }
  return r;
}

/**
 * Renders the nodes below `parent` as an indented, expandable tree.
 * @param body Container to append to.
 * @param parent Node whose children are rendered.
 * @param depth Depth of the children.
 * @param searching Whether a search filter is active.
 * @param ctx Render context.
 */
function renderTree(body: HTMLElement, parent: ViewNode, depth: number, searching: boolean, ctx: BodyContext): void {
  for (const node of parent.children) {
    const isSection = node.children.length > 0;
    const open = isSection && isExpanded(ctx.ui, node.path, depth, searching);
    body.append(row(node, node.segment, depth, isSection ? open : undefined, ctx, searching));
    if (open) {
      renderTree(body, node, depth + 1, searching, ctx);
    }
  }
}

/**
 * Appends one row per node that has a value, using the full key path as key.
 * @param body Container to append to.
 * @param node Node to walk.
 * @param ctx Render context.
 */
function renderFlat(body: HTMLElement, node: ViewNode, ctx: BodyContext): void {
  for (const child of node.children) {
    if (child.value !== undefined) {
      body.append(row(child, child.path, 0, undefined, ctx));
    }
    renderFlat(body, child, ctx);
  }
}

/**
 * Fills the body container from the (already filtered) root.
 * @param body Container to fill; existing content is replaced.
 * @param root Filtered root, or undefined when nothing matches.
 * @param ctx Render context.
 */
export function renderBody(body: HTMLElement, root: ViewNode | undefined, ctx: BodyContext): void {
  body.replaceChildren();
  if (!root || root.children.length === 0) {
    body.append(el('div', 'empty', ctx.ui.query.trim() ? 'No matches.' : 'No configuration values.'));
    return;
  }
  if (ctx.ui.mode === 'flat') {
    renderFlat(body, root, ctx);
  } else {
    renderTree(body, root, 1, ctx.ui.query.trim() !== '', ctx);
  }
}
