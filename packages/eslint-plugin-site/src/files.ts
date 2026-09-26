import path from 'node:path';
import type { Rule } from 'eslint';
import { minimatch } from 'minimatch';

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

/**
 * Whether the linted file matches one of the globs. Globs are matched against the path
 * relative to ESLint's working directory and against the absolute path, so both
 * `src/config/**` and `**\/config/**` work.
 */
export function fileMatches(context: Rule.RuleContext, globs: readonly string[]): boolean {
  const absolute = toPosix(context.filename);
  const relative = toPosix(path.relative(context.cwd, context.filename));
  return globs.some(
    (glob) => minimatch(relative, glob, { dot: true }) || minimatch(absolute, glob, { dot: true }),
  );
}

export const globsSchema = {
  type: 'array',
  items: { type: 'string' },
  uniqueItems: true,
} as const;
