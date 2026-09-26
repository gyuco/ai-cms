import { writeAudit, type Executor } from '@ai-cms/audit';
import type { NodeTarget, Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { eq } from 'drizzle-orm';
import {
  CURRENT_KEY_VERSION,
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  secretHint,
} from './crypto.ts';
import { ConfigError, CONFIG_ENV, guard } from './guard.ts';

export interface SecretOptions {
  /** Content of the `ai_keys_master` Docker secret. */
  masterKey: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63}){0,3}$/i;

function assertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new ConfigError('invalid_secret_name', `Nome del segreto non valido: "${name}".`);
  }
}

/** `ai/anthropic` → the node `/system/secrets/ai/anthropic`, in ltree form. */
export function secretTarget(name: string): NodeTarget {
  return { path: `system.secrets.${name.split('/').join('.')}`, kind: 'secret', storage: 'db' };
}

const keyCache = new Map<string, Buffer>();

function keyFor(masterKey: string, version: number): Buffer {
  const cacheKey = `${version}:${masterKey}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = deriveSecretKey(masterKey, version);
    keyCache.set(cacheKey, key);
  }
  return key;
}

/**
 * Stores (or replaces) a secret, encrypted. Requires `manage` on `/system/secrets/<name>`:
 * agents are always refused by invariant I4. The value never reaches the audit log.
 */
export async function setSecret(
  db: Executor,
  principal: Principal,
  name: string,
  value: string,
  options: SecretOptions,
): Promise<{ hint: string }> {
  assertName(name);
  const target = secretTarget(name);
  await guard(db, principal, 'manage', target, 'secret.set', { name });
  if (value.length === 0) throw new ConfigError('empty_secret', 'Il valore del segreto è vuoto.');

  const ciphertext = encryptSecret(keyFor(options.masterKey, CURRENT_KEY_VERSION), value, name);
  const hint = secretHint(value);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.secrets)
      .values({
        name,
        ciphertext,
        keyVersion: CURRENT_KEY_VERSION,
        hint,
        createdBy: principal.uid,
      })
      .onConflictDoUpdate({
        target: schema.secrets.name,
        set: { ciphertext, keyVersion: CURRENT_KEY_VERSION, hint, updatedAt: now },
      });
    await writeAudit(tx, {
      actorUid: principal.uid,
      agent: principal.agent?.name ?? null,
      action: 'secret.set',
      nodePath: target.path,
      env: CONFIG_ENV,
      outcome: 'ok',
      details: { name },
    });
  });
  return { hint };
}

/** Deletes a secret; returns false when it did not exist. */
export async function deleteSecret(
  db: Executor,
  principal: Principal,
  name: string,
): Promise<boolean> {
  assertName(name);
  const target = secretTarget(name);
  await guard(db, principal, 'manage', target, 'secret.delete', { name });
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.secrets)
      .where(eq(schema.secrets.name, name))
      .returning({ name: schema.secrets.name });
    if (deleted.length === 0) return false;
    await writeAudit(tx, {
      actorUid: principal.uid,
      agent: principal.agent?.name ?? null,
      action: 'secret.delete',
      nodePath: target.path,
      env: CONFIG_ENV,
      outcome: 'ok',
      details: { name },
    });
    return true;
  });
}

/** The displayable hint (`…a1b2`) of a secret, or null when it does not exist. */
export async function getSecretHint(
  db: Executor,
  principal: Principal,
  name: string,
): Promise<string | null> {
  assertName(name);
  await guard(db, principal, 'read', secretTarget(name), 'secret.hint', { name });
  const [row] = await db
    .select({ hint: schema.secrets.hint })
    .from(schema.secrets)
    .where(eq(schema.secrets.name, name));
  return row ? (row.hint ?? '…') : null;
}

/**
 * Decrypts a secret WITHOUT an authorization check. Only the AI gateway may call it, right
 * before a provider call, and the value must never leave the cms-api process (FR-127): not in
 * responses, logs, audit details or tool results. Returns null when the secret does not exist.
 */
export async function readSecretValue(
  db: Executor,
  name: string,
  options: SecretOptions,
): Promise<string | null> {
  const [row] = await db.select().from(schema.secrets).where(eq(schema.secrets.name, name));
  if (!row) return null;
  return decryptSecret(keyFor(options.masterKey, row.keyVersion), row.ciphertext, row.name);
}
