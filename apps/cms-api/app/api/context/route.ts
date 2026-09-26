import { getPageContext } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { principalOf, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * Context of the page the widget is on (TECHNICAL §10.3): user, environment, CSRF token and
 * the page node. `?path=` is the site URL path (`/`, `/chi-siamo`). While a password change
 * is pending only the session part is returned, so the widget can ask for the change.
 */
export const GET = route(
  async (request, context) => {
    const { user, csrfToken } = context.session;
    const base = { user, env: context.env, csrfToken };
    if (user.mustChangePassword) return json({ ...base, node: null, page: null });
    const path = new URL(request.url).searchParams.get('path') ?? '/';
    const page = await getPageContext(db(), principalOf(context), context.env, path);
    return json({ ...base, ...page });
  },
  { allowPasswordChangePending: true },
);
