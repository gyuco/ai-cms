import {
  checkCommand,
  COMMAND_TOOLS,
  fileAccessFor,
  normalizeRepoPath,
  type FileAccess,
} from '@ai-cms/agents';
import { writeAudit } from '@ai-cms/audit';
import { authorize, fromLtree, type Action } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { treePathForFile } from '@ai-cms/pipeline';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveAgentSession, type ResolvedAgentSession } from './agent-sessions.ts';

/**
 * Internal endpoints for the agent-runner (TECHNICAL §7.6), which has no database: it asks
 * cms-api who an agent session belongs to and whether each file or command of the developer
 * agent is allowed.
 */

export interface AgentWhoami {
  uid: number;
  username: string;
  email: string;
  agent: ResolvedAgentSession['agent'];
  env: ResolvedAgentSession['env'];
  changesetId: string | null;
  conversationId: string | null;
  expiresAt: string;
}

export const agentAuthorizeBody = z.object({
  token: z.string().min(1).max(512),
  /** Tool name: Claude Code built-ins (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`) or native ones. */
  tool: z.string().min(1).max(64),
  /** File or directory, relative to the changeset clone (`''` is its root). */
  path: z.string().max(4096).optional(),
  command: z.string().max(10_000).optional(),
  /** Whether the file exists: writing a new file needs `create` instead of `write`. */
  exists: z.boolean().optional(),
});

export type AgentAuthorizeBody = z.input<typeof agentAuthorizeBody>;

export interface AgentToolDecision {
  allowed: boolean;
  code: string;
  /** Italian explanation, passed back to the model when denied. */
  message: string;
  /** Tree node the file belongs to (TECHNICAL §6.6), for file tools. */
  treePath?: string;
  action?: Action;
}

const ACCESS_ACTION: Record<FileAccess, Action> = {
  read: 'read',
  list: 'list',
  write: 'write',
  create: 'create',
};

function deny(code: string, message: string): AgentToolDecision {
  return { allowed: false, code, message };
}

/**
 * Decides one tool use of the developer agent: commands go through the allowlist, files are
 * mapped to their tree node and checked with authz for the session's principal and env.
 */
export function decideAgentToolUse(
  session: Pick<ResolvedAgentSession, 'principal' | 'agent' | 'env'>,
  input: Omit<z.output<typeof agentAuthorizeBody>, 'token'>,
): AgentToolDecision {
  if (session.agent !== 'dev-agent') {
    return deny(
      'agent-no-code-tools',
      `L'agente "${session.agent}" non può usare strumenti su file e comandi.`,
    );
  }

  if (COMMAND_TOOLS.has(input.tool)) {
    if (input.command === undefined) return deny('bad-request', 'Comando mancante.');
    const check = checkCommand(input.command);
    return check.allowed
      ? { allowed: true, code: 'command-allowed', message: 'Comando consentito.' }
      : deny(check.code, check.message);
  }

  const access = fileAccessFor(input.tool, input.exists ?? true);
  if (!access) return deny('unknown-tool', `Strumento non consentito: ${input.tool}.`);
  if (input.path === undefined) return deny('bad-request', 'Percorso mancante.');
  const normalized = normalizeRepoPath(input.path);
  if (!normalized.ok) return deny(normalized.code, normalized.message);

  const treePath = treePathForFile(normalized.path);
  const action = ACCESS_ACTION[access];
  const decision = authorize(
    session.principal,
    action,
    { path: treePath, kind: 'file', storage: 'git' },
    session.env,
  );
  const target = normalized.path || '.';
  return {
    allowed: decision.allowed,
    code: decision.code,
    message: decision.allowed
      ? decision.message
      : `${target} (${fromLtree(treePath)}): ${decision.message}`,
    treePath,
    action,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

const unauthenticated = () =>
  jsonError(401, 'unauthenticated', 'Token di sessione agente mancante o scaduto.');

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

/** `POST /_cms/internal/agent/whoami`: the session behind a token (Bearer or `{ token }`). */
export async function handleAgentWhoami(
  request: Request,
  deps: { db: Database },
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const token =
    bearer(request) ??
    (body && typeof body === 'object' && 'token' in body && typeof body.token === 'string'
      ? body.token
      : null);
  const session = token ? await resolveAgentSession(deps.db, token) : null;
  if (!session) return unauthenticated();
  const [user] = await deps.db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.uid, session.principal.uid));
  return json(200, {
    uid: session.principal.uid,
    username: session.principal.username,
    email: user?.email ?? '',
    agent: session.agent,
    env: session.env,
    changesetId: session.changesetId,
    conversationId: session.conversationId,
    expiresAt: session.expiresAt.toISOString(),
  } satisfies AgentWhoami);
}

/**
 * `POST /_cms/internal/agent/authorize`: the decision for one file or command of the
 * developer agent. Always 200 with `{ allowed, code, message }` for a valid session; denials
 * are written to the audit log.
 */
export async function handleAgentAuthorize(
  request: Request,
  deps: { db: Database },
): Promise<Response> {
  const parsed = agentAuthorizeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      400,
      'bad_request',
      `Richiesta non valida: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  const { token, ...input } = parsed.data;
  const session = await resolveAgentSession(deps.db, token);
  if (!session) return unauthenticated();

  const decision = decideAgentToolUse(session, input);
  if (!decision.allowed) {
    await writeAudit(deps.db, {
      actorUid: session.principal.uid,
      agent: session.agent,
      action: 'agent.tool',
      nodePath: decision.treePath ?? null,
      env: session.env,
      outcome: 'denied',
      details: {
        tool: input.tool,
        code: decision.code,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.command !== undefined ? { command: input.command.slice(0, 500) } : {}),
        changesetId: session.changesetId,
        conversationId: session.conversationId,
      },
    });
  }
  return json(200, {
    allowed: decision.allowed,
    code: decision.code,
    message: decision.message,
  });
}
