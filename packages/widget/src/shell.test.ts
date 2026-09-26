// @vitest-environment happy-dom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetContext } from './api.ts';
import { App } from './app.tsx';
import { STORAGE_KEY } from './storage.ts';

const me: WidgetContext = {
  user: {
    uid: 1,
    username: 'anna',
    displayName: 'Anna Bianchi',
    email: 'a@x.test',
    mustChangePassword: false,
  },
  env: 'staging',
  csrfToken: 'csrf-1',
  node: { path: '/site/pages/index', kind: 'page', exists: true, version: 1 },
  page: { latestVersion: 1, publishedVersion: 1, hasDraft: false },
};

let container: HTMLElement;

async function renderApp(status = 200) {
  const fetchFn = vi.fn(
    async () => new Response(JSON.stringify(status === 200 ? me : {}), { status }),
  ) as unknown as typeof fetch;
  await act(async () => {
    render(h(App, { fetchFn }), container);
  });
  // Let the fetch promise chain settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T & HTMLElement>(selector);

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

describe('Shell', () => {
  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  it('renders nothing for visitors without a session', async () => {
    document.cookie = 'cms_ui=1; path=/';
    await renderApp(401);
    expect(container.innerHTML).toBe('');
    expect(document.cookie).not.toContain('cms_ui=1');
  });

  it('shows the launcher, then opens the panel with user, environment and all tabs', async () => {
    await renderApp();
    const launcher = $('.launcher')!;
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect($('[role="dialog"]')!.hidden).toBe(true);

    await act(() => launcher.click());
    const dialog = $('[role="dialog"]')!;
    expect(dialog.hidden).toBe(false);
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    expect($('.user')!.textContent).toContain('Anna Bianchi');
    expect($('.env-badge')!.textContent).toBe('Staging');
    expect(dialog.textContent).toContain('Passa a Produzione');
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Chat', 'Pagina', 'Sito', 'Sviluppo', 'Utenti', 'AI', 'Audit']);
    expect(document.activeElement).toBe($('[role="tab"][aria-selected="true"]'));
  });

  it('moves between tabs with the arrow keys', async () => {
    await renderApp();
    await act(() => $('.launcher')!.click());
    await act(() => press($('[role="tab"][aria-selected="true"]')!, 'ArrowLeft'));
    const selected = $('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toBe('Audit');
    expect(selected.tabIndex).toBe(0);
    expect(document.activeElement).toBe(selected);
    const panel = $(`#${selected.getAttribute('aria-controls')}`)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('Disponibile a breve');
  });

  it('closes with Escape and returns focus to the launcher', async () => {
    await renderApp();
    await act(() => $('.launcher')!.click());
    await act(() => press($('[role="tab"][aria-selected="true"]')!, 'Escape'));
    expect($('[role="dialog"]')!.hidden).toBe(true);
    expect(document.activeElement).toBe($('.launcher'));
  });

  it('toggles with Ctrl + . and remembers the state', async () => {
    await renderApp();
    await act(() => press(window, '.', { code: 'Period', ctrlKey: true }));
    expect($('[role="dialog"]')!.hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ open: true });
    await act(() => press(window, '.', { code: 'Period', metaKey: true }));
    expect($('[role="dialog"]')!.hidden).toBe(true);
  });

  it('moves the panel with the arrow keys when the title bar has focus', async () => {
    await renderApp();
    await act(() => $('.launcher')!.click());
    const dialog = $('[role="dialog"]')!;
    const before = parseInt(dialog.style.left, 10);
    const titlebar = $('.titlebar')!;
    titlebar.focus();
    await act(() => press(titlebar, 'ArrowLeft'));
    expect(parseInt(dialog.style.left, 10)).toBe(before - 16);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as { rect: { x: number } };
    expect(stored.rect.x).toBe(before - 16);
  });
});
