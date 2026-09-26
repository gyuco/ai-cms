export const SESSION_COOKIE = 'cms_session';
/** Tells the page loader to fetch the widget. Not a credential (TECHNICAL §10.1). */
export const UI_COOKIE = 'cms_ui';

export interface CookieOptions {
  secure: boolean;
}

function serialize(name: string, value: string, attrs: string[]): string {
  return [`${name}=${value}`, 'Path=/', 'SameSite=Lax', ...attrs].join('; ');
}

export function sessionCookies(token: string, expiresAt: Date, options: CookieOptions): string[] {
  const common = [`Expires=${expiresAt.toUTCString()}`, ...(options.secure ? ['Secure'] : [])];
  return [
    serialize(SESSION_COOKIE, token, ['HttpOnly', ...common]),
    serialize(UI_COOKIE, '1', common),
  ];
}

export function clearedSessionCookies(options: CookieOptions): string[] {
  const common = [
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
    ...(options.secure ? ['Secure'] : []),
  ];
  return [serialize(SESSION_COOKIE, '', ['HttpOnly', ...common]), serialize(UI_COOKIE, '', common)];
}
