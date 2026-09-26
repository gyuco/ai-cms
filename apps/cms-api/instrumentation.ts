import path from 'node:path';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.CMS_MIGRATE_ON_START === '0') return;

  const { coreDatabaseUrl, createDatabase, runMigrations, seed } = await import('@ai-cms/db');
  const { hashPassword } = await import('@ai-cms/auth');

  const url = coreDatabaseUrl('owner');
  const folder =
    process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), '../../packages/db/migrations');
  await runMigrations(url, folder);

  const database = createDatabase(url, { max: 1 });
  try {
    const result = await seed(database.db, {
      hashPassword,
      onRootPassword: (password) => {
        console.log(
          [
            '',
            '============================================================',
            `  root password: ${password}`,
            '  Mostrata una sola volta: va cambiata al primo accesso.',
            '============================================================',
            '',
          ].join('\n'),
        );
      },
    });
    console.log(`cms-api: database ready (${result.nodesCreated} nodes created)`);
  } finally {
    await database.close();
  }
}
