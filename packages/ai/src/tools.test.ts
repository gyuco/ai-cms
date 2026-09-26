import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lookupCapabilities } from './capabilities.ts';
import { defineTool, toToolSpec } from './tools.ts';

const readPage = defineTool({
  name: 'read_page',
  description: 'Reads a page by path',
  action: 'read',
  input: z.object({
    path: z.string().describe('Node path, e.g. /site/blog'),
    lang: z.enum(['it', 'en']).default('it'),
  }),
  run: ({ path, lang }) => `${path}:${lang}`,
});

describe('tools', () => {
  it('converts a Zod tool to a ToolSpec with JSON Schema', () => {
    const spec = toToolSpec(readPage);
    expect(spec.name).toBe('read_page');
    expect(spec.description).toBe('Reads a page by path');
    expect(spec.inputSchema).not.toHaveProperty('$schema');
    expect(spec.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Node path, e.g. /site/blog' },
        lang: { type: 'string', enum: ['it', 'en'], default: 'it' },
      },
      required: ['path'],
    });
  });

  it('rejects tool names the providers would refuse', () => {
    expect(() =>
      defineTool({ name: 'bad name', description: '', input: z.object({}), run: () => '' }),
    ).toThrow(/Invalid tool name/);
  });

  it('runs with typed input', async () => {
    const input = readPage.input.parse({ path: '/site' });
    expect(await readPage.run(input, { toolCallId: 't1' })).toBe('/site:it');
  });
});

describe('capabilities table', () => {
  it('matches patterns, first row wins', () => {
    expect(lookupCapabilities('claude-opus-5-5')).toEqual({
      tools: true,
      vision: true,
      streaming: true,
      contextWindow: 1_000_000,
    });
    expect(lookupCapabilities('claude-haiku-4-5').contextWindow).toBe(200_000);
    expect(lookupCapabilities('anthropic/claude-sonnet-5').tools).toBe(true);
  });

  it('lets custom rows override the defaults', () => {
    const custom = [{ model: 'llama3.1:8b', caps: { tools: false } }];
    expect(lookupCapabilities('llama3.1:8b', custom).tools).toBe(false);
    expect(lookupCapabilities('llama3.1:70b', custom).tools).toBe(true);
  });

  it('assumes unknown models cannot use tools', () => {
    expect(lookupCapabilities('mystery-model')).toEqual({
      tools: false,
      vision: false,
      streaming: true,
    });
  });
});
