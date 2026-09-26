import { ConfigError, GatewayError } from '@ai-cms/ai-config';
import { AuthzError } from '@ai-cms/authz';
import { ConflictError, NotFoundError, ValidationError } from '@ai-cms/tree';
import { json } from './http.ts';

/** A request the route itself rejects, e.g. a missing parameter. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Maps the typed errors of the services to JSON responses with Italian messages. Anything
 * else is a bug and is rethrown, so Next.js logs it and answers 500.
 */
export function serviceErrorResponse(err: unknown): Response {
  if (err instanceof BadRequestError) {
    return json({ error: { code: 'bad_request', message: err.message } }, { status: 400 });
  }
  if (err instanceof AuthzError) {
    return json(
      { error: { code: err.code, message: err.message, steps: err.decision.steps } },
      { status: 403 },
    );
  }
  if (err instanceof NotFoundError) {
    return json({ error: { code: 'not_found', message: err.message } }, { status: 404 });
  }
  if (err instanceof ConflictError) {
    return json(
      {
        error: {
          code: 'conflict',
          message: err.message,
          expectedVersion: err.expectedVersion,
          currentVersion: err.currentVersion,
        },
      },
      { status: 409 },
    );
  }
  if (err instanceof ValidationError) {
    return json(
      { error: { code: 'invalid', message: err.message, issues: err.issues } },
      { status: 400 },
    );
  }
  if (err instanceof ConfigError || err instanceof GatewayError) {
    return json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  throw err;
}
