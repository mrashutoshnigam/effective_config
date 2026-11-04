/** Identity of a focusable control, stable across re-renders. */
interface FocusKey {
  role?: string;
  action?: string;
  path?: string;
  start: number | null;
  end: number | null;
}

/**
 * Captures the identity of the focused control inside `root` (its `data-role`, `data-action`,
 * owning row `data-path`, and caret for text inputs) so focus can be restored after a re-render.
 * @param root Container whose content is about to be rebuilt.
 * @returns A function that re-focuses the matching control in the rebuilt content; a no-op when
 *   focus was elsewhere.
 */
export function captureFocus(root: HTMLElement): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active) || active === root) {
    return () => undefined;
  }
  const key: FocusKey = {
    role: active.dataset.role,
    action: active.dataset.action,
    path: active.closest<HTMLElement>('[data-path]')?.dataset.path,
    start: null,
    end: null,
  };
  if (active instanceof HTMLInputElement) {
    try {
      key.start = active.selectionStart;
      key.end = active.selectionEnd;
    } catch {
      // Some input types do not expose a selection.
    }
  }
  if (key.role === undefined && key.action === undefined) {
    return () => undefined;
  }
  return () => {
    const candidates = root.querySelectorAll<HTMLElement>('[data-role],[data-action]');
    for (const c of candidates) {
      if (
        c.dataset.role === key.role &&
        c.dataset.action === key.action &&
        c.closest<HTMLElement>('[data-path]')?.dataset.path === key.path
      ) {
        c.focus();
        if (c instanceof HTMLInputElement && key.start !== null && key.end !== null) {
          try {
            c.setSelectionRange(key.start, key.end);
          } catch {
            // Ignore inputs without selection support.
          }
        }
        return;
      }
    }
  };
}
