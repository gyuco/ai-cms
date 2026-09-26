import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './cms.css';

export const metadata: Metadata = {
  title: 'Accesso · AI-CMS',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
