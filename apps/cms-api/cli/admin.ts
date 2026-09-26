import { issueTemporaryPassword } from '@ai-cms/auth';
import { coreDatabaseUrl, createDatabase, ROOT_UID } from '@ai-cms/db';

// Administrative commands run inside the cms-api container, e.g.
//   node apps/cms-api/admin.mjs reset-root-password
const commands: Record<string, () => Promise<void>> = {
  async 'reset-root-password'() {
    const database = createDatabase(coreDatabaseUrl('api'), { max: 1 });
    try {
      const password = await issueTemporaryPassword(database.db, ROOT_UID);
      console.log(`Nuova password temporanea di root: ${password}`);
      console.log('Va cambiata al primo accesso.');
    } finally {
      await database.close();
    }
  },
};

const name = process.argv[2] ?? '';
const command = commands[name];
if (!command) {
  console.error(`Comandi disponibili: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
await command();
