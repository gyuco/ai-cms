import type {
  BuilderReleaseRequest,
  BuilderReleaseResult,
  BuilderRun,
  BuilderRunRequest,
} from './builder-protocol.ts';

/** The longest a release build may take. */
const RELEASE_BUILD_TIMEOUT_MS = 30 * 60_000;

export class BuilderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BuilderError';
  }
}

/** HTTP client of the builder service (`apps/builder`), used by the worker. */
export interface BuilderClient {
  /**
   * Starts a run. When the changeset already has a run in progress on the same commit, that
   * run is returned instead (for example after the worker restarted).
   */
  startRun(request: BuilderRunRequest): Promise<BuilderRun>;
  getRun(runId: string): Promise<BuilderRun>;
  /**
   * Builds the artifact of a release into the releases volume. Waits for the build, which can
   * take several minutes; one release build runs at a time.
   */
  buildRelease(request: BuilderReleaseRequest): Promise<BuilderReleaseResult>;
  /** Removes the changeset artifacts; its preview stops shortly after. */
  deleteArtifacts(changesetId: string): Promise<void>;
}

export interface BuilderClientOptions {
  /** e.g. `http://builder:8090` */
  url: string;
  /** Shared token (`builder_token` secret), read lazily. */
  token: () => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createBuilderClient(options: BuilderClientOptions): BuilderClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');

  async function call(method: string, path: string, body?: unknown, timeoutMs?: number) {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new BuilderError(`Il builder non risponde (${(error as Error).message})`);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: reported below with the status.
    }
    return { status: response.status, json, text };
  }

  const errorOf = (res: { status: number; json: unknown; text: string }) =>
    new BuilderError(
      `Il builder ha risposto ${String(res.status)}: ${
        (res.json as { error?: string } | null)?.error ?? res.text.slice(0, 500)
      }`,
      res.status,
    );

  return {
    async startRun(request) {
      const res = await call('POST', '/runs', request);
      if (res.status === 202 || res.status === 200) return res.json as BuilderRun;
      const active = (res.json as { run?: BuilderRun } | null)?.run;
      if (res.status === 409 && active && active.commit === request.commit) return active;
      throw errorOf(res);
    },
    async getRun(runId) {
      const res = await call('GET', `/runs/${encodeURIComponent(runId)}`);
      if (res.status === 200) return res.json as BuilderRun;
      throw errorOf(res);
    },
    async buildRelease(request) {
      const res = await call('POST', '/releases', request, RELEASE_BUILD_TIMEOUT_MS);
      if (res.status === 200) return res.json as BuilderReleaseResult;
      throw errorOf(res);
    },
    async deleteArtifacts(changesetId) {
      const res = await call('DELETE', `/changesets/${encodeURIComponent(changesetId)}`);
      if (res.status !== 204 && res.status !== 200) throw errorOf(res);
    },
  };
}
