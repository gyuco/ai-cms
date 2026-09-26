import { render } from 'preact';
import { App } from './app.tsx';
import styles from './styles.css?inline';

export const TAG_NAME = 'cms-widget';

/**
 * `<cms-widget>`: everything lives in an open shadow root, so the site's styles cannot reach
 * the widget and the widget's styles cannot leak into the site (TECHNICAL §10.2).
 */
export class CmsWidgetElement extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    root.append(style);
    render(<App />, root);
  }

  disconnectedCallback() {
    if (this.shadowRoot && !this.isConnected) render(null, this.shadowRoot);
  }
}

/** Registers the element once and adds a single instance to the page. */
export function mount(doc: Document = document): HTMLElement {
  const registry = doc.defaultView?.customElements ?? customElements;
  if (!registry.get(TAG_NAME)) registry.define(TAG_NAME, CmsWidgetElement);
  const existing = doc.querySelector<HTMLElement>(TAG_NAME);
  if (existing) return existing;
  const element = doc.createElement(TAG_NAME);
  doc.body.append(element);
  return element;
}
