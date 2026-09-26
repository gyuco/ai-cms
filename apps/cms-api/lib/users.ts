import type { UserStatusChangeResult } from '@ai-cms/auth';
import { BadRequestError } from './errors.ts';
import { error, json } from './http.ts';

type Reason = Extract<UserStatusChangeResult, { ok: false }>['reason'];

const failures: Record<Reason, [status: number, message: string]> = {
  not_found: [404, 'Utente non trovato.'],
  self: [403, 'Non puoi sospendere te stesso.'],
  root: [403, "L'utente root non si può sospendere."],
  not_suspendable: [409, "L'utente è già sospeso."],
  not_suspended: [409, "L'utente non è sospeso."],
};

export function parseUid(value: string): number {
  const uid = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(uid)) {
    throw new BadRequestError('Utente non valido.');
  }
  return uid;
}

/** Response for a suspension or reactivation. */
export function statusChangeResponse(result: UserStatusChangeResult): Response {
  if (result.ok) return json({ status: result.status });
  const [status, message] = failures[result.reason];
  return error(status, result.reason, message);
}
