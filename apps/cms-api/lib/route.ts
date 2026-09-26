import type { Principal } from '@ai-cms/authz';
import { authenticate, type RequestContext } from './context.ts';
import { BadRequestError, serviceErrorResponse } from './errors.ts';

/** The logged-in user as an authz principal (sessions exist only for active users). */
export function principalOf(context: RequestContext): Principal {
  const { uid, username } = context.session.user;
  return { uid, username, status: 'active' };
}

type Handler<P> = (request: Request, context: RequestContext, params: P) => Promise<Response>;

/**
 * Wraps a route handler: authenticates the request (CSRF included for mutating methods) and
 * turns the services' typed errors into JSON responses.
 */
export function route<P = Record<string, string>>(
  handler: Handler<P>,
  options: { allowPasswordChangePending?: boolean } = {},
) {
  return async (request: Request, segment: { params: Promise<P> }): Promise<Response> => {
    const context = await authenticate(request, options);
    if (context instanceof Response) return context;
    try {
      return await handler(request, context, await segment.params);
    } catch (err) {
      return serviceErrorResponse(err);
    }
  };
}

export type Body = Record<string, unknown>;

/** The JSON object in the request body; throws `BadRequestError` for anything else. */
export async function readBody(request: Request): Promise<Body> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Richiesta non valida.');
  }
  return body as Body;
}

export function requireString(body: Body, key: string, message: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new BadRequestError(message);
  return value.trim();
}

export function optionalNumber(body: Body, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestError(`Il campo "${key}" deve essere un numero intero.`);
  }
  return value;
}

export function requireQuery(request: Request, key: string, message: string): string {
  const value = new URL(request.url).searchParams.get(key);
  if (!value) throw new BadRequestError(message);
  return value;
}
