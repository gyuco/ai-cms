import { authorize } from '@ai-cms/authz';
import { pageNodeFromPath, SHARED_NODES } from '@ai-cms/site-kit/paths';
import { authenticate } from '@/lib/context.ts';
import { error, json, type Env } from '@/lib/http.ts';
import { latestNodeVersion, latestPageVersion } from '@/lib/preview.ts';

/**
 * `GET /_cms/api/preview?path=/chi-siamo&env=prod`: the latest version of a page, published
 * or not, for a signed-in user with read permission (FR-150). `node=site.layouts.header` asks
 * the same for a shared element (settings, header, footer, main menu); any other node is
 * refused. Called by the site with the visitor's session cookie; the response is never cached.
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
  const sharedNode = params.get('node');
  let latest;
  if (sharedNode !== null) {
    const kind = Object.hasOwn(SHARED_NODES, sharedNode) ? SHARED_NODES[sharedNode] : undefined;
    if (!kind) return error(404, 'not_found', 'Elemento non trovato.');
    latest = await latestNodeVersion(env, sharedNode, kind);
  } else {
    const nodePath = pageNodeFromPath(params.get('path') ?? '');
    if (!nodePath) return error(404, 'not_found', 'Pagina non trovata.');
    latest = await latestPageVersion(env, nodePath);
  }
  if (!latest) return error(404, 'not_found', 'Pagina non trovata.');

  const { uid, username } = context.session.user;
  const decision = authorize({ uid, username, status: 'active' }, 'read', latest.target, env);
  if (!decision.allowed) return error(403, 'forbidden', decision.message);

  return json({ body: latest.body, version: latest.version, published: latest.published });
}
