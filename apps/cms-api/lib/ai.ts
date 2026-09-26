import { ConfigError, createGateway, GatewayError, type Gateway } from '@ai-cms/ai-config';
import { AuthzError, type Principal } from '@ai-cms/authz';
import { readSecret } from '@ai-cms/db';
import type { RequestContext } from './context.ts';
import { db } from './db.ts';
import { error } from './http.ts';

let master: string | undefined;
let gatewayInstance: Gateway | undefined;

/** Key that encrypts the API keys in `secrets` (TECHNICAL §13). Only cms-api has it. */
export function masterKey(): string {
  master ??= readSecret('ai_keys_master');
  return master;
}

export function secretOptions() {
  return { masterKey: masterKey() };
}

export function gateway(): Gateway {
  gatewayInstance ??= createGateway(db(), { masterKey: masterKey() });
  return gatewayInstance;
}

/** The logged-in user as an authz principal (sessions exist only for active users). */
export function principalOf(context: RequestContext): Principal {
  const { uid, username } = context.session.user;
  return { uid, username, status: 'active' };
}

/** Maps the errors of the AI configuration services to JSON responses. */
export function aiErrorResponse(err: unknown): Response {
  if (err instanceof AuthzError) return error(403, err.code, err.message);
  if (err instanceof ConfigError || err instanceof GatewayError) {
    return error(err.status, err.code, err.message);
  }
  throw err;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}
