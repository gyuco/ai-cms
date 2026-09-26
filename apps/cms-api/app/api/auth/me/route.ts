import { authenticate } from '@/lib/context.ts';
import { json } from '@/lib/http.ts';

export async function GET(request: Request) {
  const context = await authenticate(request, { allowPasswordChangePending: true });
  if (context instanceof Response) return context;
  return json({
    user: context.session.user,
    env: context.env,
    csrfToken: context.session.csrfToken,
  });
}
