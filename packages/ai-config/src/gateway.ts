import {
  AnthropicEngine,
  OpenAICompatibleEngine,
  type ChatEngine,
  type ChatEvent,
  type ChatRequest,
  type Usage,
} from '@ai-cms/ai';
import { schema, type Database } from '@ai-cms/db';
import { eq } from 'drizzle-orm';
import { getRoleAssignment } from './roles.ts';
import { estimateCost, type PriceEntry } from './pricing.ts';
import { connectionConfig, type AiConnection, type AiRole } from './roles.ts';
import { readSecretValue } from './secrets.ts';

export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

/** Builds the engine for a connection. Injectable so tests never touch the network. */
export type EngineFactory = (connection: AiConnection, apiKey: string | undefined) => ChatEngine;

export const defaultEngineFactory: EngineFactory = (connection, apiKey) => {
  const baseURL = connection.baseUrl ?? undefined;
  switch (connection.provider) {
    case 'anthropic':
      return new AnthropicEngine({
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
      });
    case 'openai-compatible': {
      const capabilities = connectionConfig(connection).capabilities;
      return new OpenAICompatibleEngine({
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(capabilities ? { capabilityTable: capabilities } : {}),
      });
    }
    case 'claude-code':
      throw cliEngineError(connection);
  }
};

function cliEngineError(connection: AiConnection): GatewayError {
  return new GatewayError(
    'cli_engine',
    `La connessione "${connection.label}" usa un abbonamento Claude Code: è gestita dal motore CLI nel container agent-runner, non dal gateway.`,
  );
}

export interface GatewayOptions {
  /** Content of the `ai_keys_master` Docker secret. */
  masterKey: string;
  /** Price rows ahead of the defaults (cost estimates only). */
  prices?: PriceEntry[];
  createEngine?: EngineFactory;
  /** Called when a usage row cannot be written; the model call itself is not affected. */
  onUsageError?: (error: unknown) => void;
}

/** Who is calling and what for. Either a role, or an explicit connection (e.g. a test). */
export type GatewayCall = {
  uid: number;
  conversationId?: string | null;
} & (
  | { role: AiRole; connectionId?: undefined; model?: undefined }
  | { connectionId: string; model?: string; role?: string }
);

export interface GatewayEngine {
  /** Records one `ai_usage` row at the end of every `stream()`. */
  engine: ChatEngine;
  connection: AiConnection;
  /** The model to put in `ChatRequest.model`. */
  model: string;
  role: string;
}

export interface Gateway {
  /** Resolves connection and model without decrypting anything. */
  resolve(call: GatewayCall): Promise<{ connection: AiConnection; model: string; role: string }>;
  /** Decrypts the key and builds the engine for one call (or a few, within a request). */
  open(call: GatewayCall): Promise<GatewayEngine>;
  /** `open` + `stream` with the resolved model. */
  stream(call: GatewayCall, req: Omit<ChatRequest, 'model'>): AsyncIterable<ChatEvent>;
}

type Outcome = 'ok' | 'max_tokens' | 'refusal' | 'error' | 'aborted';

/**
 * The AI gateway (TECHNICAL §7.2): every call with an API key goes through here. Keys are
 * decrypted only at call time and live only inside the engine; every stream ends with a row
 * in `ai_usage`.
 */
export function createGateway(db: Database, options: GatewayOptions): Gateway {
  const createEngine = options.createEngine ?? defaultEngineFactory;
  const onUsageError =
    options.onUsageError ?? ((err: unknown) => console.error('ai_usage insert failed', err));

  async function resolve(call: GatewayCall) {
    let connection: AiConnection | undefined;
    let model: string | null | undefined;
    let role: string;
    if (call.connectionId !== undefined) {
      [connection] = await db
        .select()
        .from(schema.aiConnections)
        .where(eq(schema.aiConnections.id, call.connectionId));
      if (!connection) {
        throw new GatewayError('connection_not_found', 'Connessione AI non trovata.', 404);
      }
      model = call.model ?? connection.defaultModel;
      role = call.role ?? 'direct';
    } else {
      const assignment = await getRoleAssignment(db, call.role);
      if (!assignment) {
        throw new GatewayError(
          'no_connection',
          `Nessuna connessione AI configurata per il ruolo "${call.role}": scegline una nelle impostazioni AI.`,
        );
      }
      connection = assignment.connection;
      model = assignment.model ?? connection.defaultModel;
      role = call.role;
    }

    if (connection.ownerUid !== null && connection.ownerUid !== call.uid) {
      throw new GatewayError(
        'personal_connection',
        `La connessione "${connection.label}" è personale di un altro utente.`,
        403,
      );
    }
    if (connection.provider === 'claude-code') throw cliEngineError(connection);
    if (!model) {
      throw new GatewayError(
        'no_model',
        `Nessun modello indicato per la connessione "${connection.label}".`,
      );
    }
    return { connection, model, role };
  }

  async function open(call: GatewayCall): Promise<GatewayEngine> {
    const { connection, model, role } = await resolve(call);
    let apiKey: string | undefined;
    if (connection.secretName) {
      apiKey = (await readSecretValue(db, connection.secretName, options)) ?? undefined;
    }
    if (connection.type === 'api' && apiKey === undefined) {
      throw new GatewayError(
        'missing_key',
        `Manca la chiave API della connessione "${connection.label}".`,
      );
    }
    const inner = createEngine(connection, apiKey);
    const prices = [...(connectionConfig(connection).prices ?? []), ...(options.prices ?? [])];

    const record = async (model: string, usage: Required<Usage>, outcome: Outcome) => {
      const cost = connection.type === 'local' ? 0 : estimateCost(model, usage, prices);
      try {
        await db.insert(schema.aiUsage).values({
          uid: call.uid,
          role,
          connection: connection.id,
          model,
          kind: connection.type,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costEstimate: cost === null ? null : cost.toFixed(6),
          outcome,
          conversationId: call.conversationId ?? null,
        });
      } catch (err) {
        onUsageError(err);
      }
    };

    const engine: ChatEngine = {
      provider: inner.provider,
      capabilities: (m) => inner.capabilities(m),
      async *stream(req) {
        const usage: Required<Usage> = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        let outcome: Outcome = 'aborted';
        let aborted = false;
        try {
          for await (const event of inner.stream(req)) {
            if (event.type === 'usage') {
              usage.inputTokens += event.inputTokens;
              usage.outputTokens += event.outputTokens;
              usage.cacheReadTokens += event.cacheReadTokens ?? 0;
              usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
            } else if (event.type === 'error' && event.aborted) {
              aborted = true;
            } else if (event.type === 'done') {
              outcome = doneOutcome(event.stopReason, aborted);
            }
            yield event;
          }
        } catch (err) {
          outcome = 'error';
          throw err;
        } finally {
          // Also runs when the consumer stops early (outcome stays "aborted").
          await record(req.model, usage, outcome);
        }
      },
    };
    return { engine, connection, model, role };
  }

  return {
    resolve,
    open,
    async *stream(call, req) {
      const { engine, model } = await open(call);
      yield* engine.stream({ ...req, model });
    },
  };
}

function doneOutcome(stopReason: string, aborted: boolean): Outcome {
  switch (stopReason) {
    case 'end_turn':
    case 'tool_use':
      return 'ok';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return aborted ? 'aborted' : 'error';
  }
}
