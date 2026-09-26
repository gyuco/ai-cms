import { createGateway, type Gateway } from '@ai-cms/ai-config';
import { readSecret } from '@ai-cms/db';
import { db } from './db.ts';

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
