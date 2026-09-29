/**
 * The wire protocol of the chat tab (E7.4, TECHNICAL §10.4) and the plans waiting for the
 * user's answer. `POST /_cms/api/chat` streams `ChatStreamEvent`s as server-sent events; the
 * widget (a browser bundle that cannot import server packages) mirrors this shape.
 */
import type { PlanOperation, PlanResult } from '@ai-cms/content/service';
import type { Env } from '@ai-cms/authz';
import { createPlanSession, requiresConfirmation, type PlanSession } from './plan.ts';

/** A change the plan would make to one page, in the terms the widget shows. */
export interface PlanPageView {
  path: string;
  created: boolean;
  added: number;
  removed: number;
  changed: number;
}

/** What the user sees before answering "Conferma" / "Annulla". */
export interface PlanView {
  operations: readonly PlanOperation[];
  /** One readable line per operation, in Italian. */
  steps: string[];
  pages: PlanPageView[];
  /** Destructive: the user must confirm explicitly (FR-06). */
  destructive: boolean;
}

export type ChatStreamEvent =
  | { type: 'conversation'; id: string; title: string | null }
  | { type: 'status'; state: 'thinking' | 'working' }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      ok: boolean;
      /** The tool refused because of a permission or a system constraint. */
      blocked: boolean;
      /** Why it failed, in Italian, already readable by the user. */
      detail?: string;
    }
  | { type: 'plan'; plan: PlanView }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: string };

/** One server-sent event frame. */
export function encodeSse(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const TOOL_LABELS: Record<string, string> = {
  list_nodes: "Guardo l'albero del sito",
  read_node: 'Leggo un contenuto',
  create_page: 'Creo una pagina',
  update_blocks: 'Modifico il contenuto',
  update_meta: 'Aggiorno titolo e descrizione',
  update_layout: 'Modifico header e footer',
  update_menu: 'Modifico il menu',
  upload_asset: "Carico un'immagine",
  publish: 'Pubblico',
  move_node: 'Sposto un contenuto',
  delete_node: 'Elimino un contenuto',
  propose_plan: 'Preparo un piano di modifiche',
};

/** Short Italian description of what a tool call is doing, for the "in corso" list. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Eseguo ${name}`;
}

/** Tool failures that come from authz or a system constraint, not from a bad input. */
export function isBlockedResult(content: string): boolean {
  return content.startsWith('Permesso negato:');
}

const OP_STEPS: Record<string, (op: Record<string, unknown>) => string> = {
  createNode: (op) => `Creare ${String(op.name)} in ${String(op.parentPath)}`,
  updateMeta: (op) => `Aggiornare titolo e descrizione di ${String(op.path)}`,
  createPage: (op) => `Creare la pagina «${String(op.name)}» in ${String(op.parentPath)}`,
  delete: (op) => `Eliminare ${String(op.path)}`,
  publish: (op) => `Pubblicare ${String(op.path)}`,
  unpublish: (op) => `Ritirare ${String(op.path)}`,
  move: (op) => `Spostare ${String(op.path)}`,
  rename: (op) => `Rinominare ${String(op.path)}`,
  updateBody: (op) => `Riscrivere il contenuto di ${String(op.path)}`,
  patchBlocks: (op) => `Modificare dei blocchi di ${String(op.path)}`,
};

/** A readable line for an operation of a plan. */
export function describeOperation(operation: PlanOperation): string {
  const op = operation as unknown as Record<string, unknown>;
  const describe = OP_STEPS[String(op.op)];
  return describe ? describe(op) : `Operazione ${String(op.op)}`;
}

/** The plan as the widget shows it, from the operations and the dry-run that validated them. */
export function toPlanView(operations: readonly PlanOperation[], preview: PlanResult): PlanView {
  return {
    operations,
    steps: operations.map(describeOperation),
    pages: (preview.preview ?? []).map((page) => ({
      path: page.path,
      created: page.created,
      added: page.diff.blocks.added.length,
      removed: page.diff.blocks.removed.length,
      changed: page.diff.blocks.modified.length,
    })),
    destructive: requiresConfirmation(operations, preview),
  };
}

interface Pending {
  session: PlanSession;
  uid: number;
  env: Env;
  expiresAt: number;
}

/** How long a plan waits for the answer before it is forgotten. */
export const PLAN_TTL_MS = 30 * 60 * 1000;

/**
 * The plans waiting for "Conferma" / "Annulla", one per conversation. They live in the memory
 * of cms-api: an unanswered plan is lost on restart and the agent proposes it again (MVP 1
 * runs a single cms-api instance).
 */
export class PlanStore {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PLAN_TTL_MS,
  ) {}

  /** The plan of a conversation, created empty on first use. Only its owner can reach it. */
  session(conversationId: string, owner: { uid: number; env: Env }): PlanSession {
    this.sweep();
    const existing = this.pending.get(conversationId);
    if (existing && existing.uid === owner.uid && existing.env === owner.env) {
      existing.expiresAt = this.now() + this.ttlMs;
      return existing.session;
    }
    const session = createPlanSession();
    this.pending.set(conversationId, {
      session,
      uid: owner.uid,
      env: owner.env,
      expiresAt: this.now() + this.ttlMs,
    });
    return session;
  }

  /** The waiting plan, or null when there is none (never proposed, answered or expired). */
  find(conversationId: string, owner: { uid: number; env: Env }): PlanSession | null {
    this.sweep();
    const entry = this.pending.get(conversationId);
    if (!entry || entry.uid !== owner.uid || entry.env !== owner.env) return null;
    return entry.session.isEmpty() ? null : entry.session;
  }

  discard(conversationId: string): void {
    this.pending.delete(conversationId);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id);
  }
}
