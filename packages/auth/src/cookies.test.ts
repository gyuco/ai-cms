import { describe, expect, it } from 'vitest';
import { clearedSessionCookies, sessionCookies } from './cookies.ts';

describe('session cookies', () => {
  const expires = new Date('2030-01-01T00:00:00Z');

  it('marks the session cookie HttpOnly and the UI flag readable by scripts', () => {
    const [session, ui] = sessionCookies('tok', expires, { secure: true });
    expect(session).toContain('cms_session=tok');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    expect(ui).toContain('cms_ui=1');
    expect(ui).not.toContain('HttpOnly');
  });

  it('clears both cookies', () => {
    const cookies = clearedSessionCookies({ secure: false });
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((c) => c.includes('Secure'))).toBe(false);
  });
});
