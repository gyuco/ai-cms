export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.CMS_MIGRATE_ON_START === '0') return;
  const { prepareDatabase } = await import('./lib/startup.ts');
  await prepareDatabase();
}
