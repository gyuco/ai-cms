import path from 'node:path';
import { hashPassword } from '@ai-cms/auth';
import { coreDatabaseUrl, createDatabase, runMigrations, seed } from '@ai-cms/db';

/** Applies migrations and the idempotent seed; runs once when cms-api starts. */
export async function prepareDatabase(): Promise<void> {
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
            '  Persa? make reset-root-password',
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
