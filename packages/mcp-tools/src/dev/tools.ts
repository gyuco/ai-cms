/**
 * The development tools of the developer agent (E10.6, TECHNICAL §7.6): running the checks,
 * reading their results, querying the database of the changeset and opening its preview.
 * Thin adapters over `DevServices`, which cms-api implements with the pipeline.
 */
import { z } from 'zod';
import { defineCmsTool } from '../registry.ts';
import { requireDevSession, type DevTool } from './context.ts';

/** The check output can be long: the agent needs the end and the failing names first. */
const MAX_OUTPUT = 4_000;

function clip(output: string | null): string | null {
  if (output === null || output.length <= MAX_OUTPUT) return output;
  return `[… ${output.length - MAX_OUTPUT} caratteri omessi …]\n${output.slice(-MAX_OUTPUT)}`;
}

const noInput = z.object({});

export const runChecksTool: DevTool<typeof noInput> = defineCmsTool({
  name: 'run_checks',
  action: 'write',
  description:
    'Avvia i controlli automatici del changeset (permessi, migrazioni, tipi, lint, test, regole HTML, sicurezza, e2e) nel builder, sull’ultimo lavoro salvato (il CMS lo salva alla fine di ogni turno). Tipi, lint, test e build non si possono eseguire altrove: nel tuo ambiente il codice del sito non gira. Girano in background: dopo la chiamata usa `get_check_results` finché nessun controllo è in corso. Chiamalo quando hai finito una modifica e non prima.',
  input: noInput,
  run: async (_input, ctx) => {
    const id = requireDevSession(ctx, 'write', 'code');
    const { queued } = await ctx.dev.runChecks(id);
    return queued
      ? 'Controlli avviati. Usa get_check_results per seguirli.'
      : 'I controlli sono già in corso. Usa get_check_results per seguirli.';
  },
});

export const getCheckResultsTool: DevTool<typeof noInput> = defineCmsTool({
  name: 'get_check_results',
  action: 'read',
  description:
    'Restituisce lo stato dei controlli dell’ultimo commit del changeset: per ognuno stato e output. Se `pending` non è vuoto i controlli sono ancora in corso e va richiamato più tardi. Se `failed` non è vuoto leggi l’output, correggi il codice e rilancia `run_checks` (al massimo 3 tentativi, poi spiega il problema all’utente).',
  input: noInput,
  run: async (_input, ctx) => {
    const id = requireDevSession(ctx, 'read', 'code');
    const state = await ctx.dev.getCheckResults(id);
    return { ...state, checks: state.checks.map((c) => ({ ...c, output: clip(c.output) })) };
  },
});

const queryInput = z.object({
  sql: z
    .string()
    .trim()
    .min(1, 'Scrivi la query da eseguire')
    .max(10_000)
    .describe('Una sola istruzione SELECT (o WITH … SELECT) sul database del changeset.'),
});

const READ_ONLY = /^(select|with|explain|show)\b/i;
// A second statement or a write hidden inside `WITH` would still be stopped by the read-only
// transaction the service opens; this check only gives the agent a clear message first.
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i;

/** Returns why the statement is not a single read-only query, or null when it looks fine. */
export function readOnlyProblem(statement: string): string | null {
  const text = statement.trim().replace(/;\s*$/, '');
  if (text.includes(';')) return 'È ammessa una sola istruzione.';
  if (!READ_ONLY.test(text)) return 'Sono ammesse solo query di lettura (SELECT).';
  if (FORBIDDEN.test(text)) return 'La query contiene parole riservate alle modifiche.';
  return null;
}

export const queryStagingDbTool: DevTool<typeof queryInput> = defineCmsTool({
  name: 'query_staging_db',
  action: 'read',
  description:
    'Esegue una query di sola lettura sul database del changeset (una copia dello staging) per controllare tabelle, migrazioni e dati di esempio. Non può modificare nulla: per cambiare lo schema scrivi una migrazione nel codice. Restituisce al massimo 200 righe.',
  input: queryInput,
  run: async ({ sql }, ctx) => {
    const id = requireDevSession(ctx, 'read', 'data');
    const problem = readOnlyProblem(sql);
    if (problem) throw new Error(problem);
    return ctx.dev.queryStagingDb(id, sql.trim().replace(/;\s*$/, ''));
  },
});

export const openPreviewTool: DevTool<typeof noInput> = defineCmsTool({
  name: 'open_preview',
  action: 'read',
  description:
    'Restituisce l’indirizzo dell’anteprima del changeset, con il sito costruito dall’ultimo commit e collegato al suo database. L’anteprima esiste solo dopo che i controlli (`run_checks`) hanno completato la build: se `ready` è falso, esegui prima i controlli. Dai l’indirizzo all’utente perché la apra.',
  input: noInput,
  run: async (_input, ctx) => {
    const id = requireDevSession(ctx, 'read', 'code');
    return ctx.dev.previewUrl(id);
  },
});

/** Everything the developer agent can do beyond files and the shell. */
export const devTools = [
  runChecksTool,
  getCheckResultsTool,
  queryStagingDbTool,
  openPreviewTool,
] as const;
