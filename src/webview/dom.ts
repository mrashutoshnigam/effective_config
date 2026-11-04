/**
 * Creates an element with an optional class and text content. Text is always set through
 * `textContent`, so untrusted configuration data is never parsed as HTML.
 * @param tag Element tag name.
 * @param className Optional space-separated class names.
 * @param text Optional text content.
 * @returns The new element.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

/**
 * Creates a button wired to a click handler.
 * @param label Visible text.
 * @param action Value for the `data-action` attribute.
 * @param onClick Click handler.
 * @param title Optional tooltip and accessible label.
 * @returns The new button.
 */
export function button(label: string, action: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', undefined, label);
  b.type = 'button';
  b.dataset.action = action;
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('click', onClick);
  return b;
}
