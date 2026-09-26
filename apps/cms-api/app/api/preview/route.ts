import { authorize } from '@ai-cms/authz';
import { pageNodeFromPath } from '@ai-cms/site-kit/paths';
import { authenticate } from '@/lib/context.ts';
import { error, json, type Env } from '@/lib/http.ts';
import { latestPageVersion } from '@/lib/preview.ts';

/**
 * `GET /_cms/api/preview?path=/chi-siamo&env=prod`: the latest version of a page, published
 * or not, for a signed-in user with read permission (FR-150). Called by the site with the
 * visitor's session cookie; the response is never cached.
 */
export async function GET(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;

  const params = new URL(request.url).searchParams;
  const envParam = params.get('env');
  if (envParam !== null && envParam !== 'prod' && envParam !== 'staging') {
    return error(400, 'invalid_env', 'Ambiente non valido: usa "prod" o "staging".');
  }
  const env: Env = envParam ?? context.env;
  const nodePath = pageNodeFromPath(params.get('path') ?? '');
  if (!nodePath) return error(404, 'not_found', 'Pagina non trovata.');

  const latest = await latestPageVersion(env, nodePath);
  if (!latest) return error(404, 'not_found', 'Pagina non trovata.');

  const { uid, username } = context.session.user;
  const decision = authorize({ uid, username, status: 'active' }, 'read', latest.target, env);
  if (!decision.allowed) return error(403, 'forbidden', decision.message);

  return json({ body: latest.body, version: latest.version, published: latest.published });
}
