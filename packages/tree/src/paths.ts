import { fromLtree, toLtree } from '@ai-cms/authz';
import { ValidationError } from './errors.ts';

/** Same rule as the `nodes_name_check` constraint. */
export const NODE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isValidNodeName(name: string): boolean {
  return NODE_NAME_PATTERN.test(name);
}

export function assertNodeName(name: string): void {
  if (!isValidNodeName(name)) {
    throw new ValidationError(
      `Nome non valido: "${name}". Usa da 1 a 63 caratteri tra lettere minuscole, cifre, "-" e "_", iniziando con una lettera o una cifra.`,
    );
  }
}

/**
 * Parses a public path (`/site/pages/blog`, `/` for the root) into ltree form
 * (`site.pages.blog`, `''`). The ltree form itself is accepted too.
 */
export function parsePath(input: string): string {
  const ltree = toLtree(input.trim());
  if (ltree === '') return '';
  for (const segment of ltree.split('.')) {
    if (!isValidNodeName(segment)) {
      throw new ValidationError(
        `Percorso non valido: "${input}". Ogni parte deve contenere solo lettere minuscole, cifre, "-" e "_".`,
      );
    }
  }
  return ltree;
}

/** Public form of an ltree path. */
export const toPublicPath = fromLtree;

export function joinLtree(parent: string, name: string): string {
  return parent === '' ? name : `${parent}.${name}`;
}

export function parentLtree(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(0, index);
}

export function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}
