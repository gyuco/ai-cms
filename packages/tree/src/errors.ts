/** The requested node (or version) does not exist, or is not visible in this environment. */
export class NotFoundError extends Error {
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

/**
 * Optimistic concurrency failure (FR-64): someone else changed the node in the meantime.
 * `currentVersion` is the version the caller should reload and merge with.
 */
export class ConflictError extends Error {
  readonly path: string | undefined;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  constructor(options: { path?: string; expectedVersion: number; currentVersion: number }) {
    super(
      `Conflitto: ${options.path ?? 'il nodo'} è stato modificato da qualcun altro ` +
        `(versione attesa ${options.expectedVersion}, versione attuale ${options.currentVersion}). ` +
        'Ricarica la versione attuale e applica di nuovo le modifiche.',
    );
    this.name = 'ConflictError';
    this.path = options.path;
    this.expectedVersion = options.expectedVersion;
    this.currentVersion = options.currentVersion;
  }
}

/** Invalid input: names, paths, kinds, bodies, or an operation that the tree cannot accept. */
export class ValidationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** True for a Postgres unique violation, whether raw or wrapped by Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === '23505') return true;
    if (typeof current !== 'object') break;
  }
  return false;
}
