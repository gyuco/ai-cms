import type { ChatEvent, ChatRequest, ToolSpec } from '@ai-cms/ai';
import type { Principal } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { eq } from 'drizzle-orm';
import { saveTestResult } from './connections.ts';
import { GatewayError, type Gateway } from './gateway.ts';
import { ConfigError, guard } from './guard.ts';

export interface ConnectionTestResult {
  ok: boolean;
  /** `unverified`: the check happens elsewhere (Claude Code, in the agent-runner). */
  status: 'ok' | 'error' | 'unverified';
  model: string | null;
  tools: boolean;
  latencyMs: number;
  /** Italian, for the UI. */
  message: string;
}

const PROBE_TOOL: ToolSpec = {
  name: 'connection_check',
  description: 'Confirms that the connection works. Call it exactly once.',
  inputSchema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['ok'] } },
    required: ['status'],
    additionalProperties: false,
  },
};

const PROBE: Omit<ChatRequest, 'model'> = {
  system: 'You are a connection test. Do exactly what the user asks, nothing else.',
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Call the connection_check tool with status "ok".' }],
    },
  ],
  tools: [PROBE_TOOL],
  maxOutputTokens: 256,
};

interface ProbeOutcome {
  toolCalled: boolean;
  error: Extract<ChatEvent, { type: 'error' }> | null;
}

async function probe(events: AsyncIterable<ChatEvent>): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = { toolCalled: false, error: null };
  for await (const event of events) {
    if (event.type === 'tool_call' && event.name === PROBE_TOOL.name) outcome.toolCalled = true;
    if (event.type === 'error') outcome.error ??= event;
  }
  return outcome;
}

function describeError(error: { message: string; status?: number }): string {
  switch (error.status) {
    case 401:
    case 403:
      return 'Credenziali rifiutate dal provider: controlla la chiave API.';
    case 404:
      return 'Modello o indirizzo non trovato: controlla il nome del modello e l’indirizzo base.';
    case 429:
      return 'Il provider ha rifiutato la richiesta per limiti di frequenza o di credito.';
    default:
      return error.status
        ? `Il provider ha risposto con un errore (${error.status}): ${error.message}`
        : `Provider non raggiungibile: ${error.message}`;
  }
}

/** Providers that reject the `tools` field answer 400 and mention tools in the message. */
function isToolsUnsupported(error: { message: string; status?: number }): boolean {
  return error.status === 400 && /tool|function/i.test(error.message);
}

/**
 * "Prova connessione" (FR-123): one minimal request with a fake tool, to check credentials,
 * model and tool calling. The result is stored on the connection so FR-124 can use it.
 */
export async function testConnection(
  db: Database,
  principal: Principal,
  gateway: Gateway,
  connectionId: string,
  model?: string | null,
): Promise<ConnectionTestResult> {
  await guard(
    db,
    principal,
    'manage',
    { path: `system.ai.connections.${connectionId}`, kind: 'setting', storage: 'db' },
    'ai.connection.test',
    { id: connectionId },
  );
  const [connection] = await db
    .select()
    .from(schema.aiConnections)
    .where(eq(schema.aiConnections.id, connectionId));
  if (!connection || (connection.ownerUid !== null && connection.ownerUid !== principal.uid)) {
    throw new ConfigError('not_found', 'Connessione AI non trovata.', 404);
  }

  if (connection.provider === 'claude-code') {
    return {
      ok: false,
      status: 'unverified',
      model: model ?? connection.defaultModel,
      tools: true,
      latencyMs: 0,
      message:
        'Da verificare: l’abbonamento Claude Code si verifica nel container agent-runner, con il login dell’utente.',
    };
  }

  const started = performance.now();
  const call = {
    uid: principal.uid,
    connectionId,
    role: 'connection-test',
    ...(model ? { model } : {}),
  };
  let resolvedModel: string | null = model ?? connection.defaultModel;
  const finish = async (
    result: Omit<ConnectionTestResult, 'latencyMs' | 'model'>,
  ): Promise<ConnectionTestResult> => {
    const full = {
      ...result,
      model: resolvedModel,
      latencyMs: Math.round(performance.now() - started),
    };
    if (resolvedModel) {
      await saveTestResult(db, connectionId, {
        model: resolvedModel,
        ok: full.ok,
        tools: full.tools,
        at: new Date().toISOString(),
      });
    }
    return full;
  };

  let opened;
  try {
    opened = await gateway.open(call);
  } catch (err) {
    if (err instanceof GatewayError)
      return finish({ ok: false, status: 'error', tools: false, message: err.message });
    throw err;
  }
  resolvedModel = opened.model;

  const first = await probe(opened.engine.stream({ ...PROBE, model: opened.model }));
  if (first.toolCalled) {
    return finish({
      ok: true,
      status: 'ok',
      tools: true,
      message: `Connessione riuscita: il modello "${opened.model}" risponde e sa usare gli strumenti.`,
    });
  }
  if (!first.error) {
    return finish({
      ok: true,
      status: 'ok',
      tools: false,
      message: `Connessione riuscita, ma il modello "${opened.model}" non ha usato lo strumento di prova: non può fare da agente.`,
    });
  }
  if (isToolsUnsupported(first.error)) {
    const retry = await probe(opened.engine.stream({ ...PROBE, tools: [], model: opened.model }));
    if (!retry.error) {
      return finish({
        ok: true,
        status: 'ok',
        tools: false,
        message: `Connessione riuscita, ma il modello "${opened.model}" non supporta l’uso di strumenti: non può fare da agente.`,
      });
    }
    return finish({
      ok: false,
      status: 'error',
      tools: false,
      message: describeError(retry.error),
    });
  }
  return finish({ ok: false, status: 'error', tools: false, message: describeError(first.error) });
}
