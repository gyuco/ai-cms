import type { CapabilityEntry } from '@ai-cms/ai';
import type { Executor } from '@ai-cms/audit';
import { schema } from '@ai-cms/db';
import { eq } from 'drizzle-orm';
import type { PriceEntry } from './pricing.ts';

/** AI roles (TECHNICAL §7.7). */
export const AI_ROLES = [
  'content-agent',
  'dev-agent',
  'ai-review',
  'translate',
  'alt-text',
] as const;
export type AiRole = (typeof AI_ROLES)[number];

/** Roles that run an agent loop and therefore need tool calling (FR-124). */
export const TOOL_ROLES: readonly AiRole[] = ['content-agent', 'dev-agent'];

export function isAiRole(value: unknown): value is AiRole {
  return typeof value === 'string' && (AI_ROLES as readonly string[]).includes(value);
}

export type AiConnection = typeof schema.aiConnections.$inferSelect;
export type ConnectionType = AiConnection['type'];
export type ConnectionProvider = AiConnection['provider'];

export interface ConnectionTestRecord {
  model: string;
  ok: boolean;
  tools: boolean;
  at: string;
}

/** Shape of `ai_connections.config`. Unknown keys are kept as they are. */
export interface ConnectionConfig {
  /** Extra capability rows for this connection's models, ahead of the defaults. */
  capabilities?: CapabilityEntry[];
  /** Extra price rows, ahead of the gateway's table. */
  prices?: PriceEntry[];
  /** Result of the last "Prova connessione", per model. */
  lastTest?: ConnectionTestRecord;
  [key: string]: unknown;
}

export function connectionConfig(connection: Pick<AiConnection, 'config'>): ConnectionConfig {
  const config = connection.config;
  return config && typeof config === 'object' && !Array.isArray(config)
    ? (config as ConnectionConfig)
    : {};
}

export interface RoleAssignment {
  role: AiRole;
  connection: AiConnection;
  model: string | null;
  fallback: unknown;
}

/** Connection and model assigned to a role. No authorization: used by the gateway. */
export async function getRoleAssignment(
  db: Executor,
  role: AiRole,
): Promise<RoleAssignment | null> {
  const [row] = await db
    .select({ role: schema.aiRoles, connection: schema.aiConnections })
    .from(schema.aiRoles)
    .innerJoin(schema.aiConnections, eq(schema.aiConnections.id, schema.aiRoles.connectionId))
    .where(eq(schema.aiRoles.role, role));
  if (!row) return null;
  return { role, connection: row.connection, model: row.role.model, fallback: row.role.fallback };
}
