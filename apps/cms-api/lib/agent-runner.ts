/**
 * The CLI profiles of the subscription live in the `cli-auth` volume, which is mounted only in
 * the agent-runner (TECHNICAL §3.2), so cms-api asks that service and only it. The credentials
 * are never read: the runner answers whether the login file exists (FR-126).
 */
import { issueAgentSession, revokeAgentSession } from '@ai-cms/ai-config';
import type { Principal } from '@ai-cms/authz';
import { db } from './db.ts';
import type { Env } from './http.ts';

/** A status check is a `stat` on the runner: it never waits long. */
const TIMEOUT_MS = 2_000;

/** The token identifies the user for a few seconds and is thrown away right after. */
const SESSION_TTL_MS = 60_000;

export interface AgentRunnerOptions {
  /** `AGENT_RUNNER_URL`, e.g. `http://agent-runner:8070`. */
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function runnerUrl(options: AgentRunnerOptions): string {
  return (options.url ?? process.env.AGENT_RUNNER_URL ?? 'http://agent-runner:8070').replace(
    /\/+$/,
    '',
  );
}

interface StatusAnswer {
  username?: unknown;
  linked?: unknown;
}

/**
 * Whether the user has linked their own subscription CLI, or `null` when the runner does not
 * answer (not up, no route, slow): an unknown state must never break the connections page.
 */
export async function subscriptionLinked(
  principal: Principal,
  env: Env,
  options: AgentRunnerOptions = {},
): Promise<boolean | null> {
  // The runner answers only about the user behind the token, so it is given one to resolve.
  const { token } = await issueAgentSession(db(), {
    uid: principal.uid,
    // The profile is only read to authorize the tools of a run, which this call never does.
    agent: 'content-agent',
    env,
    ttlMs: SESSION_TTL_MS,
  });
  try {
    const response = await (options.fetch ?? fetch)(`${runnerUrl(options)}/cli-auth/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) {
      // Reaching the runner and not getting a status means something is off: worth a log line.
      console.warn(`agent-runner: /cli-auth/status ha risposto ${response.status}`);
      return null;
    }
    const answer = (await response.json()) as StatusAnswer;
    // The answer must be about the caller: a profile of someone else is treated as unknown.
    if (answer.username !== principal.username) return null;
    return typeof answer.linked === 'boolean' ? answer.linked : null;
  } catch {
    return null;
  } finally {
    // Best effort: the token is single-use, and a row left behind expires within a minute.
    await revokeAgentSession(db(), token).catch(() => undefined);
  }
}
