import { enqueue } from '@ai-cms/pipeline';
import { writeAudit } from '@ai-cms/audit';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';

/** Starts a copy of the published production content and assets to staging (E10.10). */
export async function POST(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const jobId = await enqueue(db(), 'staging.sync', {}, { dedupeKey: 'staging.sync' });
  await writeAudit(db(), {
    actorUid: context.session.user.uid,
    action: 'staging.sync_request',
    outcome: 'ok',
    details: { jobId },
  });
  return json({ jobId, alreadyRunning: jobId === null }, { status: 202 });
}
