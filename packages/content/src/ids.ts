import { randomUUID } from 'node:crypto';

/** Pattern accepted for block ids: short, URL- and attribute-safe. */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Generates a new stable block id (12 hex chars, ~48 bits of randomness). */
export function newBlockId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}
