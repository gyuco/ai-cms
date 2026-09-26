import { schema, type Database } from '@ai-cms/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { generateToken, hashToken } from './tokens.ts';

export type AuthTokenPurpose = 'invite' | 'reset' | 'sso';

export const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  sso: 60 * 1000,
};

/** Issues a single-use token; only its hash is stored. */
export async function issueAuthToken(
  db: Database,
  uid: number,
  purpose: AuthTokenPurpose,
): Promise<string> {
  const token = generateToken();
  await db.insert(schema.authTokens).values({
    id: hashToken(token),
    uid,
    purpose,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
  });
  return token;
}

/** Returns the token's uid if it is valid, without consuming it (to show a form). */
export async function peekAuthToken(
  db: Database,
  token: string,
  purpose: AuthTokenPurpose,
): Promise<number | null> {
  const [row] = await db
    .select({ uid: schema.authTokens.uid })
    .from(schema.authTokens)
    .where(
      and(
        eq(schema.authTokens.id, hashToken(token)),
        eq(schema.authTokens.purpose, purpose),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, new Date()),
      ),
    );
  return row?.uid ?? null;
}

/** Atomically marks the token as used; returns its uid, or null if invalid or already used. */
export async function consumeAuthToken(
  db: Database,
  token: string,
  purpose: AuthTokenPurpose,
): Promise<number | null> {
  const [row] = await db
    .update(schema.authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.authTokens.id, hashToken(token)),
        eq(schema.authTokens.purpose, purpose),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ uid: schema.authTokens.uid });
  return row?.uid ?? null;
}
