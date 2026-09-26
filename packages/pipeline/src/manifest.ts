/**
 * `cms.manifest.json` (TECHNICAL §6.6): the correspondence between tree paths and files of the
 * site repository, used to keep nodes with `storage='git'` in sync with what is actually
 * committed (E10.2). Purely path arithmetic here; git access and DB writes live in
 * `code-nodes.ts`.
 */
import { parentLtree, parsePath, toPublicPath } from '@ai-cms/tree';

export interface ManifestRule {
  readonly tree: string;
  readonly repo: string;
}

export interface ManifestFileMapping {
  readonly tree: string;
  readonly repo: string;
}

export interface Manifest {
  readonly version: 1;
  readonly rules: readonly ManifestRule[];
  readonly files: readonly ManifestFileMapping[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestError(`${what} deve essere un oggetto.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ManifestError(`${what} deve essere una stringa non vuota.`);
  }
  return value;
}

function parseMapping(value: unknown, what: string): ManifestFileMapping {
  const record = asRecord(value, what);
  return {
    tree: asString(record.tree, `${what}.tree`),
    repo: asString(record.repo, `${what}.repo`),
  };
}

/** Splits a pattern on its single `{placeholder}` into the literal text around it. */
interface Placeholder {
  readonly prefix: string;
  readonly suffix: string;
}

function splitPlaceholder(pattern: string, what: string): Placeholder {
  const open = pattern.indexOf('{');
  const close = pattern.indexOf('}');
  if (open === -1 || close === -1 || close < open) {
    throw new ManifestError(`${what}: deve avere esattamente un segnaposto "{...}".`);
  }
  if (pattern.indexOf('{', open + 1) !== -1 || pattern.indexOf('}', close + 1) !== -1) {
    throw new ManifestError(`${what}: un solo segnaposto "{...}" è supportato.`);
  }
  if (close === open + 1) {
    throw new ManifestError(`${what}: il segnaposto "{}" non può essere vuoto.`);
  }
  return { prefix: pattern.slice(0, open), suffix: pattern.slice(close + 1) };
}

function hasPlaceholder(pattern: string): boolean {
  return pattern.includes('{') || pattern.includes('}');
}

export function parseManifest(raw: unknown): Manifest {
  const record = asRecord(raw, 'cms.manifest.json');
  if (record.version !== 1) {
    throw new ManifestError('cms.manifest.json: versione non supportata (attesa 1).');
  }
  if (!Array.isArray(record.rules)) {
    throw new ManifestError('cms.manifest.json: "rules" deve essere un array.');
  }
  const filesRaw = record.files ?? [];
  if (!Array.isArray(filesRaw)) {
    throw new ManifestError('cms.manifest.json: "files" deve essere un array.');
  }
  const rules = record.rules.map((r, i) => parseMapping(r, `rules[${i}]`));
  const files = filesRaw.map((f, i) => parseMapping(f, `files[${i}]`));
  for (const rule of rules) {
    splitPlaceholder(rule.tree, `rules: tree "${rule.tree}"`);
    splitPlaceholder(rule.repo, `rules: repo "${rule.repo}"`);
  }
  for (const file of files) {
    if (hasPlaceholder(file.tree) || hasPlaceholder(file.repo)) {
      throw new ManifestError(
        `files: "${file.tree}" non può avere un segnaposto "{...}": usa "rules".`,
      );
    }
  }
  return { version: 1, rules, files };
}

function matchAffix(value: string, placeholder: Placeholder): string | null {
  if (placeholder.prefix.length + placeholder.suffix.length >= value.length) return null;
  if (!value.startsWith(placeholder.prefix) || !value.endsWith(placeholder.suffix)) return null;
  return value.slice(placeholder.prefix.length, value.length - placeholder.suffix.length);
}

function build(placeholder: Placeholder, captured: string): string {
  return `${placeholder.prefix}${captured}${placeholder.suffix}`;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The node that must already exist for a file at this rule to attach: the placeholder's own
 * value when something follows it in the tree pattern (e.g. the page a `page.tsx` belongs to,
 * or the collection a `schema` file belongs to — both created elsewhere), otherwise the rule's
 * static container (e.g. `/code/api`, already part of the seeded structure).
 */
function requiredAncestor(tree: Placeholder, captured: string): string {
  const raw = tree.suffix === '' ? tree.prefix : `${tree.prefix}${captured}`;
  return trimTrailingSlash(raw);
}

export interface TreeFileMatch {
  /** Full public tree path for the file, e.g. `/site/pages/catalogo/page.tsx`. */
  readonly path: string;
  readonly requiredAncestor: string;
}

/** Resolves the tree path of a repository file, or `null` when nothing in the manifest matches. */
export function resolveTreePathForFile(manifest: Manifest, repoFile: string): TreeFileMatch | null {
  for (const file of manifest.files) {
    if (file.repo === repoFile) {
      return { path: file.tree, requiredAncestor: parentOfExplicitPath(file.tree) };
    }
  }
  for (const rule of manifest.rules) {
    const tree = splitPlaceholder(rule.tree, 'tree');
    const repo = splitPlaceholder(rule.repo, 'repo');
    const captured = matchAffix(repoFile, repo);
    if (captured === null) continue;
    return { path: build(tree, captured), requiredAncestor: requiredAncestor(tree, captured) };
  }
  return null;
}

/** Resolves the repository file of a tree path, or `null` when nothing in the manifest matches. */
export function resolveRepoFileForTreePath(manifest: Manifest, treePath: string): string | null {
  for (const file of manifest.files) {
    if (file.tree === treePath) return file.repo;
  }
  for (const rule of manifest.rules) {
    const tree = splitPlaceholder(rule.tree, 'tree');
    const repo = splitPlaceholder(rule.repo, 'repo');
    const captured = matchAffix(treePath, tree);
    if (captured === null) continue;
    return build(repo, captured);
  }
  return null;
}

/**
 * Parent of an explicit (placeholder-free) manifest path, as a node path — going through
 * `parsePath` so a literal dot in the last segment (an extension) splits the same way it will
 * when the node is actually looked up or created.
 */
function parentOfExplicitPath(path: string): string {
  return toPublicPath(parentLtree(parsePath(path)));
}
