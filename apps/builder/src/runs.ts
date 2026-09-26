import { randomUUID } from 'node:crypto';
import type {
  BuilderCheckName,
  BuilderRun,
  BuilderRunRequest,
  CheckStatus,
} from '@ai-cms/pipeline/builder';
import { truncateOutput } from '@ai-cms/pipeline/builder';
import type { Report } from './run.ts';

export type Execute = (request: BuilderRunRequest, report: Report) => Promise<void>;

export interface RunManagerOptions {
  execute: Execute;
  /** Runs executed at the same time; the others wait in order. */
  concurrency?: number;
  /** How long a finished run stays readable. */
  retentionMs?: number;
  now?: () => Date;
}

const FINAL: readonly CheckStatus[] = ['passed', 'failed', 'skipped'];

export class RunConflictError extends Error {
  constructor(readonly run: BuilderRun) {
    super(`Il changeset ${run.changesetId} ha già un controllo in corso (${run.id}).`);
    this.name = 'RunConflictError';
  }
}

/**
 * In-memory registry of the builder runs: at most one active run per changeset and a bounded
 * number running at once. State is lost on restart; the worker then starts a new run.
 */
export class RunManager {
  private readonly runs = new Map<string, BuilderRun>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private readonly concurrency: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: RunManagerOptions) {
    this.concurrency = options.concurrency ?? 1;
    this.retentionMs = options.retentionMs ?? 60 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  get(id: string): BuilderRun | undefined {
    this.expire();
    return this.runs.get(id);
  }

  /** The unfinished run of a changeset, if any. */
  activeFor(changesetId: string): BuilderRun | undefined {
    return [...this.runs.values()].find(
      (run) => run.changesetId === changesetId && run.status !== 'finished',
    );
  }

  /** Registers a run and schedules it; throws `RunConflictError` if the changeset is busy. */
  start(request: BuilderRunRequest): BuilderRun {
    this.expire();
    const busy = this.activeFor(request.changesetId);
    if (busy) throw new RunConflictError(busy);
    const run: BuilderRun = {
      id: randomUUID(),
      changesetId: request.changesetId,
      commit: request.commit,
      status: 'queued',
      checks: request.checks.map((name) => ({ name, status: 'queued', output: null })),
      createdAt: this.now().toISOString(),
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    void this.schedule(run, request);
    return run;
  }

  /** Resolves when every registered run has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while ([...this.runs.values()].some((run) => run.status !== 'finished')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async schedule(run: BuilderRun, request: BuilderRunRequest) {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    run.status = 'running';
    const report: Report = (name, status, output = null) => this.report(run, name, status, output);
    try {
      await this.options.execute(request, report);
    } catch (error) {
      for (const check of run.checks) {
        this.report(
          run,
          check.name as BuilderCheckName,
          'failed',
          `Errore del builder: ${(error as Error).message}`,
        );
      }
    } finally {
      for (const check of run.checks) {
        if (!FINAL.includes(check.status)) {
          this.report(
            run,
            check.name as BuilderCheckName,
            'failed',
            'Controllo non eseguito dal builder.',
          );
        }
      }
      run.status = 'finished';
      run.finishedAt = this.now().toISOString();
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /** Records a check result; a check that already finished keeps its result. */
  private report(
    run: BuilderRun,
    name: BuilderCheckName,
    status: CheckStatus,
    output: string | null,
  ) {
    const check = run.checks.find((c) => c.name === name);
    if (!check || FINAL.includes(check.status)) return;
    const at = this.now().toISOString();
    check.status = status;
    if (output !== null) check.output = truncateOutput(output);
    if (status === 'running') check.startedAt ??= at;
    if (FINAL.includes(status)) {
      check.startedAt ??= at;
      check.finishedAt = at;
    }
  }

  private expire() {
    const limit = this.now().getTime() - this.retentionMs;
    for (const [id, run] of this.runs) {
      if (run.finishedAt && new Date(run.finishedAt).getTime() < limit) this.runs.delete(id);
    }
  }
}
