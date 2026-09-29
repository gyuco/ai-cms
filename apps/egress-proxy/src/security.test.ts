import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowed, parseAllowlist, parseConnectTarget } from './allowlist.ts';

/**
 * Security tests of the egress proxy (E13.2, PRD FR-111): the agent runner and the builder can
 * only leave through it, so what it lets through is what an agent can reach.
 */

const DEFAULT_ALLOW = '.anthropic.com,.claude.ai,.claude.com,registry.npmjs.org';

describe('allowlist evasion', () => {
  const list = parseAllowlist(DEFAULT_ALLOW);

  it.each([
    // Look-alikes and suffix tricks.
    'anthropic.com.evil.example',
    'evilanthropic.com',
    'api.anthropic.com.evil.example',
    'registry.npmjs.org.evil.example',
    'evil-registry.npmjs.org.example',
    'registry.npmjs.org@evil.example',
    'evil.example#.anthropic.com',
    'evil.example/.anthropic.com',
    // Exact entries do not cover their subdomains or parents.
    'npmjs.org',
    'evil.registry.npmjs.org',
    // Internal names and addresses of the platform.
    'cms-api',
    'postgres-prod',
    'postgres-core',
    's3',
    'localhost',
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '[::1]',
    '::1',
    '0x7f000001',
    '2130706433',
    '',
  ])('does not allow %s', (host) => {
    expect(isAllowed(host, list)).toBe(false);
  });

  it('allows the providers and their subdomains, in any case and with a trailing dot', () => {
    for (const host of [
      'api.anthropic.com',
      'API.Anthropic.COM.',
      'console.anthropic.com',
      'claude.ai',
      'platform.claude.com',
      'registry.npmjs.org',
    ]) {
      expect(isAllowed(host, list), host).toBe(true);
    }
  });

  it('denies everything when the list is empty or holds only blanks', () => {
    expect(isAllowed('api.anthropic.com', parseAllowlist(''))).toBe(false);
    expect(isAllowed('api.anthropic.com', parseAllowlist(' , ,'))).toBe(false);
  });

  it.each([
    'api.anthropic.com:80',
    'api.anthropic.com:22',
    'api.anthropic.com:5432',
    'api.anthropic.com:0443',
    'api.anthropic.com:4430',
    'api.anthropic.com',
    'api.anthropic.com:443/path',
    'user@api.anthropic.com:443',
    'api.anthropic.com:443:22',
    '[::1]:443',
    ':443',
  ])('accepts no tunnel to %s except plain host:443', (target) => {
    const parsed = parseConnectTarget(target);
    // A port that only looks like 443 (0443) never reaches an allowlisted host by accident.
    if (parsed) expect(parsed.port).toBe(443);
    else expect(parsed).toBeNull();
    if (target !== 'api.anthropic.com:0443') expect(parsed).toBeNull();
  });
});

describe('the running proxy', () => {
  let proxy: ChildProcess;
  const PORT = 39_128;

  /** Sends one CONNECT and answers with the status line of the proxy. */
  async function connectVia(target: string): Promise<string> {
    const socket = connect(PORT, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    socket.destroy();
    return chunk.toString('utf8').split('\r\n')[0]!;
  }

  beforeAll(async () => {
    proxy = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        new URL('./main.ts', import.meta.url).pathname,
      ],
      {
        env: { PATH: process.env.PATH ?? '', PORT: String(PORT), EGRESS_ALLOW: DEFAULT_ALLOW },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Wait for "listening".
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('egress-proxy non è partito')), 15_000);
      proxy.stdout!.on('data', (data: Buffer) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      proxy.on('exit', (code) => reject(new Error(`egress-proxy è uscito: ${code}`)));
    });
  });

  afterAll(() => {
    proxy?.kill();
  });

  it.each([
    'cms-api:443',
    'postgres-prod:443',
    'postgres-prod:5432',
    '127.0.0.1:443',
    '169.254.169.254:443',
    'evil.example:443',
    'anthropic.com.evil.example:443',
    'api.anthropic.com:22',
    'api.anthropic.com:8080',
  ])('answers 403 to a tunnel towards %s', async (target) => {
    expect(await connectVia(target)).toBe('HTTP/1.1 403 Forbidden');
  });

  it('answers 405 to a plain HTTP request instead of forwarding it', async () => {
    const socket = connect(PORT, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n',
    );
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    socket.destroy();
    expect(chunk.toString('utf8')).toMatch(/^HTTP\/1\.1 405/);
  });
});
