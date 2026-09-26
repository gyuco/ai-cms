import { coreDatabaseUrl, createDatabase } from '@ai-cms/db';
import { enqueue, runWorker } from '@ai-cms/pipeline';
import { createHandlers, recurringJobs, startupJobs } from './handlers.ts';

const { db, sql, close } = createDatabase(coreDatabaseUrl('worker'));
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`worker: ${signal}, stopping`);
    controller.abort();
  });
}

for (const type of startupJobs) await enqueue(db, type, {}, { dedupeKey: `startup:${type}` });

const timers = recurringJobs.map(({ type, everyMs }) => {
  const schedule = () => void enqueue(db, type, {}, { dedupeKey: `recurring:${type}` });
  schedule();
  return setInterval(schedule, everyMs);
});

console.log('worker: started');
try {
  await runWorker({
    db,
    sql,
    handlers: createHandlers(db),
    signal: controller.signal,
    log: (message) => console.log(`worker: ${message}`),
  });
} finally {
  timers.forEach(clearInterval);
  await close();
  console.log('worker: stopped');
}
