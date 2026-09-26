import { randomBytes } from 'node:crypto';
import { lookupCapabilities } from '@ai-cms/ai';
import { writeAudit, type Executor } from '@ai-cms/audit';
import type { NodeTarget, Principal } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ConfigError, CONFIG_ENV, guard } from './guard.ts';
import {
  AI_ROLES,
  connectionConfig,
  type AiConnection,
  type AiRole,
  type ConnectionConfig,
  type ConnectionTestRecord,
} from './roles.ts';
import { deleteSecret, setSecret, type SecretOptions } from './secrets.ts';

const CONNECTIONS = 'system.ai.connections';
const ROLES = 'system.ai.roles';

function connectionTarget(id?: string): NodeTarget {
  return { path: id ? `${CONNECTIONS}.${id}` : CONNECTIONS, kind: 'setting', storage: 'db' };
}

const rolesTarget: NodeTarget = { path: ROLES, kind: 'setting', storage: 'db' };

/**
 * Login of a subscription CLI, read from the agent-runner (E8.9). The login lives in the profile
 * of the user, not on the connection, so the same status applies to every subscription.
 */
export interface ConnectionSubscription {
  /** `null` when the agent-runner did not answer: the state is unknown, not missing. */
  linked: boolean | null;
}

/** A connection as the UI sees it: never the key, only whether there is one and its hint. */
export interface ConnectionView {
  id: string;
  label: string;
  type: AiConnection['type'];
  provider: AiConnection['provider'];
  baseUrl: string | null;
  defaultModel: string | null;
  scope: 'shared' | 'personal';
  ownerUid: number | null;
  hasKey: boolean;
  keyHint: string | null;
  lastTest: ConnectionTestRecord | null;
  /** Only for `subscription` connections, and only once the runner has answered. */
  subscription?: ConnectionSubscription;
  createdAt: Date;
  updatedAt: Date;
}

const idSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,47}$/,
    'Identificativo non valido: lettere minuscole, numeri, trattini.',
  );

const urlSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Indirizzo base non valido: serve un URL http o https.');

const createSchema = z.object({
  id: idSchema.optional(),
  label: z.string().trim().min(1, 'Indica un nome per la connessione.').max(100),
  type: z.enum(['api', 'subscription', 'local']),
  provider: z.enum(['anthropic', 'openai-compatible', 'claude-code']),
  baseUrl: urlSchema.nullish(),
  defaultModel: z.string().trim().min(1).max(200).nullish(),
  apiKey: z.string().trim().min(1).max(4096).nullish(),
  scope: z.enum(['shared', 'personal']).default('shared'),
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  baseUrl: urlSchema.nullish(),
  defaultModel: z.string().trim().min(1).max(200).nullish(),
  /** A string replaces the key, null removes it, undefined leaves it. */
  apiKey: z.string().trim().min(1).max(4096).nullish(),
});

export type CreateConnectionInput = z.input<typeof createSchema>;
export type UpdateConnectionInput = z.input<typeof updateSchema>;

function parse<T>(schemaDef: z.ZodType<T>, input: unknown): T {
  const result = schemaDef.safeParse(input);
  if (!result.success) {
    throw new ConfigError('invalid_input', result.error.issues[0]?.message ?? 'Dati non validi.');
  }
  return result.data;
}

function checkShape(c: {
  type: AiConnection['type'];
  provider: AiConnection['provider'];
  baseUrl: string | null;
  hasKey: boolean;
}): void {
  if ((c.provider === 'claude-code') !== (c.type === 'subscription')) {
    throw new ConfigError(
      'invalid_input',
      'Gli abbonamenti sono disponibili solo con Claude Code, e Claude Code solo come abbonamento.',
    );
  }
  if (c.provider === 'openai-compatible' && !c.baseUrl) {
    throw new ConfigError(
      'invalid_input',
      "Per un provider compatibile OpenAI serve l'indirizzo base.",
    );
  }
  if (c.type === 'local' && c.provider !== 'openai-compatible') {
    throw new ConfigError('invalid_input', 'I modelli locali usano il tipo compatibile OpenAI.');
  }
  if (c.type === 'api' && !c.hasKey) {
    throw new ConfigError('invalid_input', 'Per una connessione con chiave API serve la chiave.');
  }
  if (c.type === 'subscription' && c.hasKey) {
    throw new ConfigError('invalid_input', 'Un abbonamento non usa chiavi API.');
  }
}

function toView(row: AiConnection, hint: string | null): ConnectionView {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    provider: row.provider,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    scope: row.ownerUid === null ? 'shared' : 'personal',
    ownerUid: row.ownerUid,
    hasKey: row.secretName !== null,
    keyHint: row.secretName !== null ? (hint ?? '…') : null,
    lastTest: connectionConfig(row).lastTest ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Adds what the agent-runner knows about the subscription login to the subscription connections
 * (E8.9). The answer is about the user, so it is the same for all of them, and it is `null`
 * when the runner could not be asked. Other types are returned unchanged.
 */
export function withSubscriptionStatus(
  connections: readonly ConnectionView[],
  linked: boolean | null,
): ConnectionView[] {
  return connections.map((connection) =>
    connection.type === 'subscription' ? { ...connection, subscription: { linked } } : connection,
  );
}

async function loadConnection(db: Executor, id: string): Promise<AiConnection> {
  const [row] = await db.select().from(schema.aiConnections).where(eq(schema.aiConnections.id, id));
  if (!row) throw new ConfigError('not_found', 'Connessione AI non trovata.', 404);
  return row;
}

async function loadView(db: Executor, id: string): Promise<ConnectionView> {
  const [row] = await db
    .select({ connection: schema.aiConnections, hint: schema.secrets.hint })
    .from(schema.aiConnections)
    .leftJoin(schema.secrets, eq(schema.secrets.name, schema.aiConnections.secretName))
    .where(eq(schema.aiConnections.id, id));
  if (!row) throw new ConfigError('not_found', 'Connessione AI non trovata.', 404);
  return toView(row.connection, row.hint);
}

function audit(
  db: Executor,
  principal: Principal,
  action: string,
  path: string,
  details: Record<string, unknown>,
) {
  return writeAudit(db, {
    actorUid: principal.uid,
    agent: principal.agent?.name ?? null,
    action,
    nodePath: path,
    env: CONFIG_ENV,
    outcome: 'ok',
    details,
  });
}

/** Shared connections and the caller's personal ones. */
export async function listConnections(
  db: Database,
  principal: Principal,
): Promise<ConnectionView[]> {
  await guard(db, principal, 'list', connectionTarget(), 'ai.connection.list');
  const rows = await db
    .select({ connection: schema.aiConnections, hint: schema.secrets.hint })
    .from(schema.aiConnections)
    .leftJoin(schema.secrets, eq(schema.secrets.name, schema.aiConnections.secretName))
    .orderBy(schema.aiConnections.createdAt);
  return rows
    .filter((r) => r.connection.ownerUid === null || r.connection.ownerUid === principal.uid)
    .map((r) => toView(r.connection, r.hint));
}

export function connectionSecretName(id: string): string {
  return `ai/${id}`;
}

export async function createConnection(
  db: Database,
  principal: Principal,
  input: CreateConnectionInput,
  options: SecretOptions,
): Promise<ConnectionView> {
  const data = parse(createSchema, input);
  const id = data.id ?? `${data.provider}-${randomBytes(3).toString('hex')}`;
  await guard(db, principal, 'manage', connectionTarget(id), 'ai.connection.create', { id });
  const baseUrl = data.baseUrl ?? null;
  checkShape({ type: data.type, provider: data.provider, baseUrl, hasKey: Boolean(data.apiKey) });

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.aiConnections.id })
      .from(schema.aiConnections)
      .where(eq(schema.aiConnections.id, id));
    if (existing)
      throw new ConfigError('exists', 'Esiste già una connessione con questo identificativo.', 409);

    const secretName = data.apiKey ? connectionSecretName(id) : null;
    if (data.apiKey && secretName) await setSecret(tx, principal, secretName, data.apiKey, options);
    await tx.insert(schema.aiConnections).values({
      id,
      label: data.label,
      type: data.type,
      provider: data.provider,
      baseUrl,
      defaultModel: data.defaultModel ?? null,
      secretName,
      ownerUid: data.scope === 'personal' ? principal.uid : null,
    });
    await audit(tx, principal, 'ai.connection.create', connectionTarget(id).path, {
      id,
      type: data.type,
      provider: data.provider,
      baseUrl,
      defaultModel: data.defaultModel ?? null,
      scope: data.scope,
      hasKey: secretName !== null,
    });
  });
  return loadView(db, id);
}

export async function updateConnection(
  db: Database,
  principal: Principal,
  id: string,
  input: UpdateConnectionInput,
  options: SecretOptions,
): Promise<ConnectionView> {
  const data = parse(updateSchema, input);
  await guard(db, principal, 'manage', connectionTarget(id), 'ai.connection.update', { id });

  await db.transaction(async (tx) => {
    const row = await loadConnection(tx, id);
    if (row.ownerUid !== null && row.ownerUid !== principal.uid) {
      throw new ConfigError('not_found', 'Connessione AI non trovata.', 404);
    }
    const baseUrl = data.baseUrl === undefined ? row.baseUrl : data.baseUrl;
    const hasKey = data.apiKey === undefined ? row.secretName !== null : data.apiKey !== null;
    checkShape({ type: row.type, provider: row.provider, baseUrl, hasKey });

    let secretName = row.secretName;
    if (data.apiKey) {
      secretName = connectionSecretName(id);
      await setSecret(tx, principal, secretName, data.apiKey, options);
    } else if (data.apiKey === null && row.secretName) {
      await deleteSecret(tx, principal, row.secretName);
      secretName = null;
    }

    // A different server or key invalidates the last test.
    const config: ConnectionConfig = { ...connectionConfig(row) };
    if (data.apiKey !== undefined || data.baseUrl !== undefined) delete config.lastTest;

    await tx
      .update(schema.aiConnections)
      .set({
        label: data.label ?? row.label,
        baseUrl,
        defaultModel: data.defaultModel === undefined ? row.defaultModel : data.defaultModel,
        secretName,
        config,
        updatedAt: new Date(),
      })
      .where(eq(schema.aiConnections.id, id));
    await audit(tx, principal, 'ai.connection.update', connectionTarget(id).path, {
      id,
      fields: Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined),
    });
  });
  return loadView(db, id);
}

export async function deleteConnection(
  db: Database,
  principal: Principal,
  id: string,
): Promise<void> {
  await guard(db, principal, 'manage', connectionTarget(id), 'ai.connection.delete', { id });
  await db.transaction(async (tx) => {
    const row = await loadConnection(tx, id);
    if (row.ownerUid !== null && row.ownerUid !== principal.uid) {
      throw new ConfigError('not_found', 'Connessione AI non trovata.', 404);
    }
    const [used] = await tx
      .select({ role: schema.aiRoles.role })
      .from(schema.aiRoles)
      .where(eq(schema.aiRoles.connectionId, id))
      .limit(1);
    if (used) {
      throw new ConfigError(
        'in_use',
        'La connessione è in uso: scegli prima un’altra connessione attiva.',
        409,
      );
    }
    await tx.delete(schema.aiConnections).where(eq(schema.aiConnections.id, id));
    if (row.secretName) await deleteSecret(tx, principal, row.secretName);
    await audit(tx, principal, 'ai.connection.delete', connectionTarget(id).path, { id });
  });
}

/** Records the result of "Prova connessione" on the connection (used by FR-124 checks). */
export async function saveTestResult(
  db: Executor,
  id: string,
  result: ConnectionTestRecord,
): Promise<void> {
  const row = await loadConnection(db, id);
  await db
    .update(schema.aiConnections)
    .set({ config: { ...connectionConfig(row), lastTest: result } })
    .where(eq(schema.aiConnections.id, id));
}

/** Whether a model can call tools: the capability table, or a successful connection test. */
export function modelSupportsTools(connection: AiConnection, model: string): boolean {
  if (connection.provider === 'claude-code') return true;
  const config = connectionConfig(connection);
  if (lookupCapabilities(model, config.capabilities ?? []).tools) return true;
  const test = config.lastTest;
  return Boolean(test && test.ok && test.tools && test.model === model);
}

/**
 * Phase 1 (TECHNICAL §7.8): one connection for every role. Refuses models without tool
 * calling, since the agent roles need it (FR-124).
 */
export async function setActiveConnection(
  db: Database,
  principal: Principal,
  connectionId: string,
  model?: string | null,
): Promise<{ connectionId: string; model: string | null; roles: AiRole[] }> {
  await guard(db, principal, 'manage', rolesTarget, 'ai.active.set', { connectionId });
  const connection = await loadConnection(db, connectionId);
  if (connection.ownerUid !== null) {
    throw new ConfigError(
      'personal_connection',
      'Una connessione personale non può essere usata come connessione attiva per tutti.',
    );
  }
  const chosen = model?.trim() || connection.defaultModel || null;
  if (connection.provider !== 'claude-code') {
    if (!chosen) throw new ConfigError('model_required', 'Indica il modello da usare.');
    if (!modelSupportsTools(connection, chosen)) {
      throw new ConfigError(
        'model_without_tools',
        `Il modello "${chosen}" non risulta in grado di usare strumenti: non può fare da agente. Scegli un altro modello o verifica il supporto con "Prova connessione".`,
      );
    }
  }

  await db.transaction(async (tx) => {
    const now = new Date();
    for (const role of AI_ROLES) {
      await tx
        .insert(schema.aiRoles)
        .values({ role, connectionId, model: chosen, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.aiRoles.role,
          set: { connectionId, model: chosen, updatedAt: now },
        });
    }
    await audit(tx, principal, 'ai.active.set', ROLES, { connectionId, model: chosen });
  });
  return { connectionId, model: chosen, roles: [...AI_ROLES] };
}

/** Current role assignments for the settings page (no keys involved). */
export async function listRoleAssignments(
  db: Database,
  principal: Principal,
): Promise<{ role: AiRole; connectionId: string; model: string | null }[]> {
  await guard(db, principal, 'read', rolesTarget, 'ai.roles.list');
  const rows = await db.select().from(schema.aiRoles);
  return AI_ROLES.flatMap((role) => {
    const row = rows.find((r) => r.role === role);
    return row ? [{ role, connectionId: row.connectionId, model: row.model }] : [];
  });
}
