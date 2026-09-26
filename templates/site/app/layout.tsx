import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@ai-cms/site-kit/base.css';

export const metadata: Metadata = {
  title: 'Nuovo sito',
};

/**
 * Loads the CMS widget only for signed-in users (TECHNICAL §10.1). `cms_ui` is a plain hint
 * cookie set at login: visitors download nothing and every page stays identical for them,
 * so the ISR cache is shared.
 */
const WIDGET_LOADER =
  "if(/(?:^|;\\s*)cms_ui=1(?:;|$)/.test(document.cookie)){var s=document.createElement('script');s.type='module';s.src='/_cms/widget.js';document.head.appendChild(s)}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: WIDGET_LOADER }} />
      </body>
    </html>
  );
}
