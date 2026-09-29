import { createHash, randomBytes } from 'node:crypto';
import {
  contentAgentProfile,
  devAgentProfile,
  type AgentProfile,
  type Env,
  type Principal,
} from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { and, eq, gt, lt } from 'drizzle-orm';

export const AGENT_PROFILES = {
  'content-agent': contentAgentProfile,
  'dev-agent': devAgentProfile,
} as const satisfies Record<string, AgentProfile>;

export type AgentName = keyof typeof AGENT_PROFILES;

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && Object.hasOwn(AGENT_PROFILES, value);
}

export const DEFAULT_AGENT_SESSION_TTL_MS = 60 * 60 * 1000;

export interface IssueAgentSessionInput {
  uid: number;
  agent: AgentName;
  env: Env;
  /** ltree path prefixes the conversation is restricted to (FR-86). */
  scope?: string[];
  conversationId?: string | null;
  changesetId?: string | null;
  /** Package names the user approved in the chat for this run (`pnpm add`, FR-37). */
  approvedDependencies?: string[];
  ttlMs?: number;
}

export interface ResolvedAgentSession {
  /** The user, masked by the agent profile and the scope (TECHNICAL §6.4). */
  principal: Principal;
  agent: AgentName;
  env: Env;
  conversationId: string | null;
  changesetId: string | null;
  approvedDependencies: string[];
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a short-lived token for one agent run (MCP server, AI gateway). Only its SHA-256 is
 * stored; the token is handed to the agent-runner and never persisted by the CMS.
 */
export async function issueAgentSession(
  db: Database,
  input: IssueAgentSessionInput,
): Promise<{ token: string; expiresAt: Date }> {
  if (!isAgentName(input.agent)) throw new Error(`Unknown agent profile: ${String(input.agent)}`);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_AGENT_SESSION_TTL_MS));
  await db.insert(schema.agentSessions).values({
    id: hashToken(token),
    uid: input.uid,
    agent: input.agent,
    env: input.env,
    scope: input.scope ?? null,
    conversationId: input.conversationId ?? null,
    changesetId: input.changesetId ?? null,
    approvedDependencies: input.approvedDependencies ?? [],
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Resolves a token to the principal the agent acts for. Returns null when the token is
 * unknown or expired, the user is not active, or the agent profile no longer exists.
 */
export async function resolveAgentSession(
  db: Database,
  token: string,
): Promise<ResolvedAgentSession | null> {
  if (!token) return null;
  const [row] = await db
    .select({ session: schema.agentSessions, user: schema.users })
    .from(schema.agentSessions)
    .innerJoin(schema.users, eq(schema.users.uid, schema.agentSessions.uid))
    .where(
      and(
        eq(schema.agentSessions.id, hashToken(token)),
        gt(schema.agentSessions.expiresAt, new Date()),
      ),
    );
  if (!row || row.user.status !== 'active') return null;
  const agent = row.session.agent;
  if (!isAgentName(agent)) return null;

  const principal: Principal = {
    uid: row.user.uid,
    username: row.user.username,
    status: row.user.status,
    agent: AGENT_PROFILES[agent],
    ...(row.session.scope ? { scope: row.session.scope } : {}),
  };
  return {
    principal,
    agent,
    env: row.session.env as Env,
    conversationId: row.session.conversationId,
    changesetId: row.session.changesetId,
    approvedDependencies: row.session.approvedDependencies,
    expiresAt: row.session.expiresAt,
  };
}

export async function revokeAgentSession(db: Database, token: string): Promise<void> {
  await db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, hashToken(token)));
}

export async function deleteExpiredAgentSessions(db: Database): Promise<void> {
  await db.delete(schema.agentSessions).where(lt(schema.agentSessions.expiresAt, new Date()));
}
