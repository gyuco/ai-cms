import { z } from 'zod';
import { defineCmsTool } from './registry.ts';

/** Harmless tool that tells the agent on whose behalf it acts; useful to test a connection. */
export const whoamiTool = defineCmsTool({
  name: 'whoami',
  description: 'Returns the CMS user and agent profile this session acts for, and the environment.',
  input: z.object({}),
  run: (_input, { principal, env }) => ({
    username: principal.username,
    agent: principal.agent?.name ?? null,
    env,
    scope: principal.scope ?? null,
  }),
});

/** The tools cms-api exposes until the content tools (E9.1) land. */
export const exampleTools = [whoamiTool] as const;
