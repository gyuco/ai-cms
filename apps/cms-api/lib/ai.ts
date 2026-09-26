import { createGateway, type Gateway } from '@ai-cms/ai-config';
import { readSecret } from '@ai-cms/db';
import { db } from './db.ts';
import { serviceErrorResponse } from './errors.ts';

export { principalOf } from './route.ts';

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

/** Maps the errors of the AI configuration services to JSON responses. */
export const aiErrorResponse = serviceErrorResponse;

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}
