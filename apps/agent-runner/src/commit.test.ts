import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareClaudeWorkspace } from './claude-settings.ts';
import { commitMessage, commitTurn, git } from './commit.ts';

const exec = promisify(execFile);
let root: string;

const info = {
  prompt: 'Aggiungi il modulo contatti\nCon nome, email e messaggio.',
  agent: 'dev-agent',
  ai: 'claude-code/claude-opus-5-5',
  conversationId: '6d1b1c52-9a0e-4a55-8f7e-1f2e3d4c5b6a',
};

async function gitOut(args: string[]): Promise<string> {
  return (await git(args, { cwd: root })).stdout;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'commit-'));
  await exec('git', ['init', '--quiet', '-b', 'cs/test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), 'sito\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'init'], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('commitMessage', () => {
  it('uses the first line of the prompt and adds the trailers', () => {
    expect(commitMessage(info)).toBe(
      'Aggiungi il modulo contatti\n\n' +
        'Agent: dev-agent\n' +
        'AI: claude-code/claude-opus-5-5\n' +
        'Conversation: 6d1b1c52-9a0e-4a55-8f7e-1f2e3d4c5b6a\n',
    );
  });

  it('truncates long subjects and omits a missing conversation', () => {
    const message = commitMessage({
      ...info,
      prompt: `\n  ${'a'.repeat(100)}`,
      conversationId: null,
    });
    const [subject] = message.split('\n');
    expect(subject).toHaveLength(72);
    expect(subject!.endsWith('…')).toBe(true);
    expect(message).not.toContain('Conversation:');
    expect(commitMessage({ ...info, prompt: '   ' }).split('\n')[0]).toBe(
      "Modifiche dell'agente sviluppatore",
    );
  });
});

describe('commitTurn', () => {
  it('commits every change with the user as author, leaving .claude out', async () => {
    await prepareClaudeWorkspace(root, { hookCommand: 'hook' });
    await mkdir(path.join(root, 'app'));
    await writeFile(path.join(root, 'app', 'page.tsx'), 'export {}\n');
    await writeFile(path.join(root, 'README.md'), 'sito aggiornato\n');

    const result = await commitTurn(root, { name: 'mario', email: 'mario@example.com' }, info);
    expect(result?.files.sort()).toEqual(['README.md', 'app/page.tsx']);
    expect(result?.commit).toMatch(/^[0-9a-f]{40}$/);

    const log = await gitOut(['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B']);
    expect(log).toBe(
      'mario <mario@example.com>\nAI-CMS <system@localhost>\n' + commitMessage(info) + '\n',
    );
    const trailers = await gitOut(['log', '-1', '--format=%(trailers:only,unfold)']);
    expect(trailers).toContain('Agent: dev-agent');
    expect(await gitOut(['ls-files'])).not.toContain('.claude');
    expect(await gitOut(['status', '--porcelain'])).toBe('');
  });

  it('does nothing when there are no changes', async () => {
    const head = await gitOut(['rev-parse', 'HEAD']);
    expect(await commitTurn(root, { name: 'mario', email: 'm@x' }, info)).toBeNull();
    expect(await gitOut(['rev-parse', 'HEAD'])).toBe(head);
  });

  it('never runs hooks from the clone', async () => {
    const marker = path.join(root, '..', `${path.basename(root)}-pwned`);
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
      const file = path.join(root, '.git', 'hooks', hook);
      await writeFile(file, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(file, 0o755);
    }
    await exec('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: root });
    await writeFile(path.join(root, 'x.txt'), 'x');
    expect(await commitTurn(root, { name: 'mario', email: 'm@x' }, info)).not.toBeNull();
    await expect(stat(marker)).rejects.toThrow();
  });
});
