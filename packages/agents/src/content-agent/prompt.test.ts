import { describe, expect, it } from 'vitest';
import type { PageContext } from './context.ts';
import { buildContentAgentPrompt, CONTENT_AGENT_SYSTEM_PROMPT } from './prompt.ts';

const context: PageContext = {
  env: 'staging',
  path: '/site/pages/index',
  title: 'Home',
  outline: [{ id: 'b1', level: 1, text: 'Home' }],
  selected: null,
};

describe('CONTENT_AGENT_SYSTEM_PROMPT', () => {
  it('states the role in Italian and mentions the HTML rules', () => {
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain('agente contenuti');
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain('violations');
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain('warnings');
  });

  it('tells the agent how to react to a blocked action instead of working around it', () => {
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain('vincoli di sistema');
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain("non cercare un'altra via");
  });

  it('requires explicit confirmation before destructive operations', () => {
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain('conferma esplicita');
  });
});

describe('buildContentAgentPrompt', () => {
  it('appends the rendered page context after the static prompt', () => {
    const prompt = buildContentAgentPrompt(context);
    expect(prompt.startsWith(CONTENT_AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('Ambiente: staging.');
    expect(prompt).toContain('Pagina corrente: /site/pages/index ("Home").');
  });

  it('changes with the context on every call, unlike the static prompt', () => {
    const first = buildContentAgentPrompt(context);
    const second = buildContentAgentPrompt({ ...context, path: '/site/pages/altra' });
    expect(first).not.toBe(second);
  });
});
