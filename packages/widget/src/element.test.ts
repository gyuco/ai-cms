// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, TAG_NAME } from './element.tsx';

describe('mount', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('registers <cms-widget> and appends a single instance with an open shadow root', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const first = mount();
    const second = mount();
    expect(second).toBe(first);
    expect(customElements.get(TAG_NAME)).toBeDefined();
    expect(document.querySelectorAll(TAG_NAME)).toHaveLength(1);
    expect(first.shadowRoot).not.toBeNull();
    expect(first.shadowRoot?.querySelector('style')).not.toBeNull();
    // Nothing is added to the document head: all styles stay in the shadow root.
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
  });
});
