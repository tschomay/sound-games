/** Tiny DOM helpers. See ADR-0002 — no framework, so this is the whole toolkit. */

export type Cleanup = () => void;
export type Screen = (root: HTMLElement) => Cleanup;

type Attributes = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function navigate(route: string): void {
  window.location.hash = route ? `#/${route}` : '#/';
}

/** A back-to-menu header. Every screen except the menu gets one. */
export function topbar(title: string, ...trailing: Child[]): HTMLElement {
  const back = el('button', { class: 'btn-ghost', 'aria-label': 'Back to menu' }, '←');
  back.addEventListener('click', () => navigate(''));
  return el('header', { class: 'topbar' }, back, el('h2', { text: title }), ...trailing);
}

export function readoutCell(label: string): { root: HTMLElement; set(value: string): void } {
  const value = el('strong', { text: '–' });
  const root = el('div', {}, el('span', { text: label }), value);
  return {
    root,
    set(next: string) {
      if (value.textContent !== next) value.textContent = next;
    },
  };
}

/**
 * A full-screen prompt. Browsers only grant microphone access from inside a user
 * gesture, so every audio screen starts behind one of these.
 */
export function overlay(
  message: string,
  actionLabel: string,
  onAction: () => void,
  detail?: string,
): { root: HTMLElement; showError(text: string): void; setBusy(busy: boolean): void } {
  const text = el('p', { text: message });
  const button = el('button', { class: 'btn-primary', text: actionLabel });
  button.addEventListener('click', onAction);
  const root = el(
    'div',
    { class: 'overlay' },
    text,
    button,
    detail ? el('p', { class: 'hint', text: detail }) : null,
  );
  return {
    root,
    showError(errorText: string) {
      text.textContent = errorText;
      text.className = 'error';
      button.disabled = false;
      button.textContent = 'Try again';
    },
    setBusy(busy: boolean) {
      button.disabled = busy;
    },
  };
}
