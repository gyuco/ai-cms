import { listUsers } from '@ai-cms/auth';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

// Phase 1: every authenticated user is an administrator (MVP1.md, E4).
export const GET = route(async () => json({ users: await listUsers(db()) }));
