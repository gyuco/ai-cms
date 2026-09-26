import { spawn } from 'node:child_process';
import { MAX_CHECK_OUTPUT, truncateOutput } from '@ai-cms/pipeline/builder';

export interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Bytes of output kept (beginning and end); the rest is dropped while the command runs. */
  maxOutput?: number;
}

export interface CommandResult {
  /** Exit code; null when killed by a signal (timeout included). */
  code: number | null;
  /** stdout and stderr interleaved, truncated to `maxOutput`. */
  output: string;
  timedOut: boolean;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/** Collects output keeping only its head and a rolling tail, so memory stays bounded. */
class BoundedOutput {
  private head = '';
  private tail = '';
  private dropped = false;

  constructor(private readonly max: number) {}

  push(chunk: string) {
    const headMax = Math.floor(this.max / 8);
    if (this.head.length < headMax) {
      const take = chunk.slice(0, headMax - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    this.tail += chunk;
    if (this.tail.length > this.max * 2) {
      this.tail = this.tail.slice(-this.max);
      this.dropped = true;
    }
  }

  toString() {
    const text = this.dropped ? `${this.head}\n…\n${this.tail}` : this.head + this.tail;
    return truncateOutput(text, this.max);
  }
}

/**
 * Runs a command without a shell, in its own process group so that a timeout kills everything
 * it started (next build spawns workers).
 */
export const runCommand: RunCommand = (command, args, options) =>
  new Promise((resolve) => {
    const output = new BoundedOutput(options.maxOutput ?? MAX_CHECK_OUTPUT);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (c: string) => output.push(c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => output.push(c));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${command}: ${error.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      kill(); // stray grandchildren of a finished command
      let text = output.toString();
      if (timedOut) {
        text += `\n\nComando interrotto: tempo massimo di ${String(Math.round(options.timeoutMs / 1000))} s superato.`;
      }
      resolve({ code: timedOut ? null : code, output: text, timedOut });
    });
  });

/** Variables passed through to site commands: proxy and CA settings, nothing else. */
const PASSTHROUGH = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'LANG',
  'TZ',
];

/**
 * Environment of the untrusted site commands: a clean one built from scratch, so nothing of
 * the builder's own configuration leaks into it.
 */
export function siteEnv(
  home: string,
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  };
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (value) env[key] = value;
  }
  if (source.PNPM_STORE_DIR) env.npm_config_store_dir = source.PNPM_STORE_DIR;
  return { ...env, ...extra };
}
