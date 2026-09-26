import {
  DEFAULT_SETTINGS,
  NONCE_HEADER,
  PATH_HEADER,
  pageLang,
  WidgetLoader,
} from '@ai-cms/site-kit';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import '@ai-cms/site-kit/base.css';
import { loadPage, loadSettings } from '@ai-cms/site-kit/next';

/**
 * `<html lang>` comes from the page (`meta.lang`) or the site settings. The root layout does
 * not receive the catch-all params, so the proxy passes the requested path in a header.
 */
async function documentLang(path: string | null): Promise<string> {
  // No path: an internal page (e.g. the 503 page) that must render without the database.
  if (path === null) return DEFAULT_SETTINGS.lang;
  try {
    const [page, settings] = await Promise.all([loadPage(path), loadSettings()]);
    return pageLang(page?.body ?? null, settings);
  } catch {
    return DEFAULT_SETTINGS.lang;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const lang = await documentLang(requestHeaders.get(PATH_HEADER));
  return (
    <html lang={lang}>
      <body>
        {children}
        <WidgetLoader nonce={requestHeaders.get(NONCE_HEADER) ?? undefined} />
      </body>
    </html>
  );
}
