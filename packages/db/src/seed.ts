import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { contentVersions, publications } from './schema/content.ts';
import { users } from './schema/identity.ts';
import { nodes, type NodeEnv, type NodeKind, type NodeStorage } from './schema/tree.ts';

export const ROOT_UID = 0;
export const SYSTEM_UID = 1;
export const DEFAULT_SITE_NAME = 'Nuovo sito';

interface SeedNode {
  path: string;
  kind: NodeKind;
  storage?: NodeStorage;
  env?: NodeEnv;
}

/** Base tree from PRD §5.7.2. Parents come before children. */
const baseTree: SeedNode[] = [
  { path: '', kind: 'dir' },
  { path: 'site', kind: 'dir' },
  { path: 'site.pages', kind: 'dir' },
  { path: 'site.pages.index', kind: 'page' },
  { path: 'site.layouts', kind: 'dir' },
  { path: 'site.components', kind: 'dir', storage: 'git' },
  { path: 'site.menus', kind: 'dir' },
  { path: 'site.assets', kind: 'dir', storage: 's3' },
  { path: 'site.settings', kind: 'setting' },
  { path: 'data', kind: 'dir' },
  { path: 'data.collections', kind: 'dir' },
  { path: 'code', kind: 'dir', storage: 'git' },
  { path: 'code.api', kind: 'dir', storage: 'git' },
  { path: 'code.lib', kind: 'dir', storage: 'git' },
  { path: 'code.migrations', kind: 'dir', storage: 'git' },
  { path: 'releases', kind: 'dir', storage: 'virtual' },
  { path: 'system', kind: 'dir' },
  { path: 'system.users', kind: 'dir', storage: 'virtual' },
  { path: 'system.agents', kind: 'dir' },
  { path: 'system.agents.content-agent', kind: 'agent' },
  { path: 'system.ai', kind: 'dir' },
  { path: 'system.secrets', kind: 'dir' },
  { path: 'system.audit', kind: 'dir', storage: 'virtual' },
];

/**
 * Content agent profile (E9.6, TECHNICAL §7.7): the mask of `packages/authz`'
 * `contentAgentProfile`, published in the tree so it can be read (and, in phase 2, edited
 * with `CAP_AGENT_CONFIG`) like any other system setting. It only ever narrows what the
 * invariants I4 (no secrets) and I6 (no code or schemas) already forbid the agent outright,
 * whatever this profile allows (`packages/authz/src/constraints.ts`).
 */
const CONTENT_AGENT_PROFILE = {
  name: 'content-agent',
  envs: ['prod', 'staging'],
  allow: [
    {
      path: 'site',
      actions: ['read', 'list', 'traverse', 'write', 'create', 'delete', 'publish'],
      storages: ['db', 's3'],
    },
  ],
  deny: [{ path: 'system', actions: ['manage'] }],
};

/** Initial published content: a blank home page, the site settings and the agent profiles. */
const initialContent: Record<string, unknown> = {
  'site.pages.index': { meta: {}, blocks: [] },
  'site.settings': {
    name: DEFAULT_SITE_NAME,
    lang: 'it',
    titleTemplate: '%s · ' + DEFAULT_SITE_NAME,
  },
  'system.agents.content-agent': CONTENT_AGENT_PROFILE,
};

export interface SeedOptions {
  hashPassword: (password: string) => Promise<string>;
  /** Called once, only when the root user is created, with its generated password. */
  onRootPassword?: (password: string) => void;
}

export interface SeedResult {
  rootCreated: boolean;
  nodesCreated: number;
}

/** Creates system users, the base tree and the blank home page. Safe to run repeatedly. */
export async function seed(db: Database, options: SeedOptions): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    // One seeder at a time, e.g. when several cms-api instances start together.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7411002)`);

    let rootPassword: string | null = null;
    const [root] = await tx.select().from(users).where(eq(users.uid, ROOT_UID));
    if (!root) {
      rootPassword = randomBytes(18).toString('base64url');
      await tx
        .insert(users)
        .overridingSystemValue()
        .values([
          {
            uid: ROOT_UID,
            username: 'root',
            email: 'root@localhost',
            displayName: 'Root',
            passwordHash: await options.hashPassword(rootPassword),
            status: 'active',
            mustChangePassword: true,
          },
          {
            uid: SYSTEM_UID,
            username: 'system',
            email: 'system@localhost',
            displayName: 'Sistema',
            kind: 'service',
            status: 'active',
          },
        ]);
    }

    let nodesCreated = 0;
    const ids = new Map<string, string>();
    for (const item of baseTree) {
      const [existing] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(sql`${nodes.path} = ${item.path}::ltree`, isNull(nodes.deletedAt)));
      if (existing) {
        ids.set(item.path, existing.id);
        continue;
      }
      const segments = item.path === '' ? [] : item.path.split('.');
      const parentPath = segments.slice(0, -1).join('.');
      const [created] = await tx
        .insert(nodes)
        .values({
          parentId: item.path === '' ? null : ids.get(parentPath),
          name: segments.at(-1) ?? '',
          path: item.path,
          kind: item.kind,
          storage: item.storage ?? 'db',
          env: item.env ?? 'both',
          createdBy: SYSTEM_UID,
        })
        .returning({ id: nodes.id });
      ids.set(item.path, created!.id);
      nodesCreated++;

      const body = initialContent[item.path];
      if (body === undefined) continue;
      for (const env of ['prod', 'staging'] as const) {
        const [version] = await tx
          .insert(contentVersions)
          .values({ nodeId: created!.id, env, version: 1, body, authorUid: SYSTEM_UID })
          .returning({ id: contentVersions.id });
        await tx.insert(publications).values({
          nodeId: created!.id,
          env,
          versionId: version!.id,
          status: 'published',
          publishedBy: SYSTEM_UID,
        });
      }
    }

    if (rootPassword) options.onRootPassword?.(rootPassword);
    return { rootCreated: rootPassword !== null, nodesCreated };
  });
}
