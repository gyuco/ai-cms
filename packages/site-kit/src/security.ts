/** Request header carrying the per-request CSP nonce from the proxy to the layout. */
export const NONCE_HEADER = 'x-nonce';

/** A fresh, unpredictable nonce (128 bits, base64). */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Content Security Policy of the site (TECHNICAL §9). Scripts need the request nonce;
 * `'strict-dynamic'` extends trust to the scripts they load: Next.js chunks and the CMS
 * widget, which the inline loader adds to the page.
 *
 * `style-src 'unsafe-inline'` is accepted for now: the widget injects a <style> element into
 * its shadow root and React/Preact set `style` attributes. Styles cannot run code, and the
 * content HTML is sanitized on save (FR-112), so the residual risk is CSS-based UI redress.
 * Images may come from any https origin, as content can link external images.
 */
export function contentSecurityPolicy(nonce: string, options: { dev?: boolean } = {}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      // React uses eval() only in development, to rebuild server error stacks.
      ...(options.dev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** Headers for every response of the site, static files included. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': [
    'accelerometer=()',
    'autoplay=()',
    'camera=()',
    'display-capture=()',
    'encrypted-media=()',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'serial=()',
    'usb=()',
    'xr-spatial-tracking=()',
  ].join(', '),
};
