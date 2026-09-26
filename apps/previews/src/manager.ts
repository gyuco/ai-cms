import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type { PreviewConfig } from '@ai-cms/pipeline/builder';
import { readPreviewConfig } from './config.ts';

export interface SiteProcess {
  port: number;
  /** Resolves when the process exits, for whatever reason. */
  exited: Promise<void>;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  /** Absolute artifact directory, on the read-only artifacts volume. */
  artifactDir: string;
  /** `server.js`, relative to the artifact directory. */
  server: string;
  env: Record<string, string>;
}

export type LaunchSite = (options: LaunchOptions) => Promise<SiteProcess>;

export type PreviewState =
  | { state: 'missing' }
  | { state: 'starting'; commit: string }
  | { state: 'ready'; commit: string; port: number }
  | { state: 'failed'; commit: string; error: string };

interface Entry {
  commit: string;
  state: 'starting' | 'ready' | 'failed';
  port?: number;
  error?: string;
  process?: SiteProcess;
  startedAt: number;
  lastUsed: number;
}

export interface PreviewManagerOptions {
  artifactsRoot: string;
  launch: LaunchSite;
  /** Environment given to every preview besides preview.json (no platform secrets). */
  baseEnv?: Record<string, string>;
  /** A preview nobody requested for this long is stopped. Default 15 minutes. */
  idleMs?: number;
  /** After a failed start, the next request retries once this much time has passed. */
  retryMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * One `next start` process per changeset, started on the first request, replaced when a newer
 * artifact appears in preview.json, stopped after 15 minutes without requests or when the
 * changeset artifacts are removed (closed changeset).
 */
export class PreviewManager {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: PreviewManagerOptions) {
    this.idleMs = options.idleMs ?? 15 * 60_000;
    this.retryMs = options.retryMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** State of the preview of a changeset, starting it when needed. */
  async resolve(changesetId: string): Promise<PreviewState> {
    const config = await readPreviewConfig(this.options.artifactsRoot, changesetId);
    const entry = this.entries.get(changesetId);
    if (!config) {
      if (entry) await this.stop(changesetId);
      return { state: 'missing' };
    }
    if (entry && entry.commit === config.commit) {
      entry.lastUsed = this.now();
      const retry = entry.state === 'failed' && this.now() - entry.startedAt >= this.retryMs;
      if (!retry) {
        if (entry.state === 'ready')
          return { state: 'ready', commit: entry.commit, port: entry.port! };
        if (entry.state === 'failed') {
          return { state: 'failed', commit: entry.commit, error: entry.error ?? '' };
        }
        return { state: 'starting', commit: entry.commit };
      }
    }
    if (entry) await this.stop(changesetId);
    this.start(changesetId, config);
    return { state: 'starting', commit: config.commit };
  }

  private start(changesetId: string, config: PreviewConfig) {
    const entry: Entry = {
      commit: config.commit,
      state: 'starting',
      startedAt: this.now(),
      lastUsed: this.now(),
    };
    this.entries.set(changesetId, entry);
    this.log(`starting ${changesetId} at ${config.commit}`);
    const launched = this.options.launch({
      artifactDir: join(this.options.artifactsRoot, changesetId, config.artifact),
      server: config.server,
      env: { ...this.options.baseEnv, ...config.env, CMS_ENV: 'staging' },
    });
    void launched.then(
      (process) => {
        if (this.entries.get(changesetId) !== entry) {
          void process.stop(); // replaced or stopped while starting
          return;
        }
        entry.state = 'ready';
        entry.port = process.port;
        entry.process = process;
        this.log(`ready ${changesetId} on port ${String(process.port)}`);
        void process.exited.then(() => {
          if (this.entries.get(changesetId) === entry) {
            this.entries.delete(changesetId);
            this.log(`exited ${changesetId}`);
          }
        });
      },
      (error: unknown) => {
        entry.state = 'failed';
        entry.error = (error as Error).message;
        this.log(`failed ${changesetId}: ${entry.error}`);
      },
    );
  }

  async stop(changesetId: string): Promise<void> {
    const entry = this.entries.get(changesetId);
    this.entries.delete(changesetId);
    if (entry?.process) {
      this.log(`stopping ${changesetId}`);
      await entry.process.stop();
    }
  }

  /** Stops idle previews and those whose artifacts are gone. Run periodically. */
  async reap(): Promise<void> {
    for (const [changesetId, entry] of [...this.entries]) {
      const idle = this.now() - entry.lastUsed >= this.idleMs;
      const config = idle ? null : await readPreviewConfig(this.options.artifactsRoot, changesetId);
      if (idle || !config) await this.stop(changesetId);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  /** Changesets with a preview process, for diagnostics and tests. */
  active(): string[] {
    return [...this.entries.keys()];
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Nessuna porta libera'));
      });
    });
  });
}

/**
 * Starts the standalone server of an artifact. The artifact volume is read-only and Next.js
 * writes its caches next to the server, so each preview runs from a private copy.
 */
export function createLauncher(options: { runRoot: string; startTimeoutMs?: number }): LaunchSite {
  return async ({ artifactDir, server, env }) => {
    await mkdir(options.runRoot, { recursive: true });
    const copy = join(options.runRoot, randomBytes(8).toString('hex'));
    await cp(artifactDir, copy, { recursive: true, verbatimSymlinks: true });
    const port = await freePort();
    const serverPath = join(copy, server);
    const child = spawn(process.execPath, [serverPath], {
      cwd: dirname(serverPath),
      env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    const collect = (chunk: Buffer) => {
      logs = (logs + chunk.toString('utf8')).slice(-8_192);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let exitedFlag = false;
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => {
        exitedFlag = true;
        void rm(copy, { recursive: true, force: true }).finally(resolve);
      }),
    );
    const stop = async () => {
      if (exitedFlag) return;
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        return;
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }, 5_000);
      await exited;
      clearTimeout(timer);
    };

    const deadline = Date.now() + (options.startTimeoutMs ?? 60_000);
    while (!exitedFlag && Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${String(port)}/`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000),
        });
        return { port, exited, stop };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await stop();
    await rm(copy, { recursive: true, force: true });
    throw new Error(
      exitedFlag
        ? `Il sito si è fermato durante l'avvio.\n${logs}`
        : `Il sito non risponde entro il tempo massimo.\n${logs}`,
    );
  };
}
