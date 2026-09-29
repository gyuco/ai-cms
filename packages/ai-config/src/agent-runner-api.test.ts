import { devAgentProfile, contentAgentProfile, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideAgentToolUse,
  handleAgentAuthorize,
  handleAgentWhoami,
  type AgentAuthorizeBody,
} from './agent-runner-api.ts';
import { issueAgentSession } from './agent-sessions.ts';

const principal: Principal = {
  uid: 7,
  username: 'mario',
  status: 'active',
  agent: devAgentProfile,
};
const dev = { principal, agent: 'dev-agent' as const, env: 'staging' as const };

describe('decideAgentToolUse', () => {
  it('allows file tools inside the tree the dev-agent profile covers', () => {
    expect(
      decideAgentToolUse(dev, { tool: 'Read', path: 'app/(dynamic)/blog/page.tsx' }),
    ).toMatchObject({
      allowed: true,
      treePath: 'site.pages.blog',
      action: 'read',
    });
    expect(
      decideAgentToolUse(dev, { tool: 'Write', path: 'lib/x.ts', exists: false }),
    ).toMatchObject({
      allowed: true,
      treePath: 'code.lib',
      action: 'create',
    });
    expect(decideAgentToolUse(dev, { tool: 'Edit', path: 'components/Nav.tsx' })).toMatchObject({
      allowed: true,
      action: 'write',
    });
  });

  it('denies paths outside the clone and protected directories', () => {
    expect(decideAgentToolUse(dev, { tool: 'Read', path: '../../etc/passwd' })).toMatchObject({
      allowed: false,
      code: 'outside-workspace',
    });
    expect(decideAgentToolUse(dev, { tool: 'Edit', path: '.claude/settings.json' })).toMatchObject({
      allowed: false,
      code: 'protected-path',
    });
  });

  it('applies authz: the dev-agent works only in staging', () => {
    expect(
      decideAgentToolUse({ ...dev, env: 'prod' }, { tool: 'Edit', path: 'lib/x.ts' }),
    ).toMatchObject({ allowed: false, code: 'invariant-I1' });
  });

  it('checks commands against the allowlist', () => {
    expect(decideAgentToolUse(dev, { tool: 'Bash', command: 'git status' })).toMatchObject({
      allowed: true,
    });
    expect(decideAgentToolUse(dev, { tool: 'Bash', command: 'pnpm test' })).toMatchObject({
      allowed: false,
      code: 'not-allowed',
    });
    expect(decideAgentToolUse(dev, { tool: 'Bash', command: 'curl http://x' })).toMatchObject({
      allowed: false,
      code: 'not-allowed',
    });
    const add = decideAgentToolUse(dev, { tool: 'run', command: 'pnpm add left-pad' });
    expect(add).toMatchObject({ allowed: false, code: 'dependency-add' });
    expect(add.message).toMatch(/nuove dipendenze richiedono conferma/i);
  });

  it('allows pnpm add only for the packages the user approved', () => {
    const approved = { ...dev, approvedDependencies: ['left-pad'] };
    const command = 'pnpm add left-pad --ignore-scripts --ignore-pnpmfile';
    expect(decideAgentToolUse(approved, { tool: 'Bash', command })).toMatchObject({
      allowed: true,
    });
    expect(decideAgentToolUse(dev, { tool: 'Bash', command })).toMatchObject({
      allowed: false,
      code: 'dependency-add',
    });
    expect(
      decideAgentToolUse(approved, {
        tool: 'Bash',
        command: 'pnpm add evil --ignore-scripts --ignore-pnpmfile',
      }),
    ).toMatchObject({ allowed: false, code: 'dependency-add' });
  });

  it('denies unknown tools and every code tool to the content agent', () => {
    expect(decideAgentToolUse(dev, { tool: 'WebFetch', path: 'x' })).toMatchObject({
      allowed: false,
      code: 'unknown-tool',
    });
    expect(
      decideAgentToolUse(
        {
          principal: { ...principal, agent: contentAgentProfile },
          agent: 'content-agent',
          env: 'prod',
        },
        { tool: 'Read', path: 'app/page.tsx' },
      ),
    ).toMatchObject({ allowed: false, code: 'agent-no-code-tools' });
  });
});

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://cms-api:3100/_cms/internal/agent/${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!testDatabaseUrl)('agent-runner endpoints', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let uid: number;
  let token: string;
  const changesetId = '0b6f3a52-7d8e-4c1a-9f2b-3c4d5e6f7a8b';

  beforeAll(async () => {
    database = await createTestDatabase();
    const [user] = await database.db
      .insert(schema.users)
      .values({ username: 'lucia', email: 'lucia@example.com', status: 'active' })
      .returning();
    uid = user!.uid;
    await database.db.insert(schema.changesets).values({
      id: changesetId,
      title: 'Prova',
      branch: `cs/${changesetId}`,
      baseCommit: '0'.repeat(40),
      authorUid: uid,
    });
    ({ token } = await issueAgentSession(database.db, {
      uid,
      agent: 'dev-agent',
      env: 'staging',
      changesetId,
    }));
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('whoami returns the session, with the token as Bearer or in the body', async () => {
    const expected = {
      uid,
      username: 'lucia',
      email: 'lucia@example.com',
      agent: 'dev-agent',
      env: 'staging',
      changesetId,
      conversationId: null,
    };
    const byHeader = await handleAgentWhoami(
      post('whoami', {}, { authorization: `Bearer ${token}` }),
      { db: database.db },
    );
    expect(byHeader.status).toBe(200);
    expect(await byHeader.json()).toMatchObject(expected);
    const byBody = await handleAgentWhoami(post('whoami', { token }), { db: database.db });
    expect(await byBody.json()).toMatchObject(expected);
  });

  it('whoami rejects unknown tokens', async () => {
    const res = await handleAgentWhoami(post('whoami', { token: 'nope' }), { db: database.db });
    expect(res.status).toBe(401);
  });

  it('authorize answers with a decision and audits denials', async () => {
    const call = async (body: Omit<AgentAuthorizeBody, 'token'>) => {
      const res = await handleAgentAuthorize(post('authorize', { token, ...body }), {
        db: database.db,
      });
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await call({ tool: 'Edit', path: 'lib/db.ts' })).toMatchObject({ allowed: true });
    expect(await call({ tool: 'Bash', command: 'wget http://x' })).toMatchObject({
      allowed: false,
      code: 'not-allowed',
    });
    const [entry] = await database.db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    expect(entry).toMatchObject({
      actorUid: uid,
      agent: 'dev-agent',
      action: 'agent.tool',
      outcome: 'denied',
    });
    expect(entry!.details).toMatchObject({ tool: 'Bash', command: 'wget http://x', changesetId });
  });

  it('authorize rejects bad requests and unknown tokens', async () => {
    const bad = await handleAgentAuthorize(post('authorize', { tool: 'Read' }), {
      db: database.db,
    });
    expect(bad.status).toBe(400);
    const unknown = await handleAgentAuthorize(
      post('authorize', { token: 'nope', tool: 'Read', path: 'x' }),
      { db: database.db },
    );
    expect(unknown.status).toBe(401);
  });
});
