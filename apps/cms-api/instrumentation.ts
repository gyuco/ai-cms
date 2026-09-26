import path from 'node:path';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.CMS_MIGRATE_ON_START === '0') return;

  const { coreDatabaseUrl, runMigrations } = await import('@ai-cms/db');
  const folder =
    process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), '../../packages/db/migrations');
  await runMigrations(coreDatabaseUrl('owner'), folder);
  console.log('cms-api: migrations applied');
}
