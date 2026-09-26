import { access, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuilderCheckName, BuilderRunRequest, CheckStatus } from '@ai-cms/pipeline/builder';
import { saveArtifact } from './artifact.ts';
import { runCommand, siteEnv, type RunCommand } from './exec.ts';
import { lintSite } from './lint.ts';
import { smokeTest, startSite, validatePages } from './site-server.ts';
import { prepareWorkspace, SITE_DIR } from './workspace.ts';

export interface BuilderConfig {
  /** The platform monorepo, with its node_modules (read-only). */
  platformRoot: string;
  /** Scratch space for the runs. */
  workRoot: string;
  /** Changeset clones (`/data/workspaces`, read-only). */
  workspacesRoot: string;
  /** Build artifacts and preview.json files, shared with the previews service. */
  artifactsRoot: string;
  /** Read-only URL of the published content, given to the built site (CORE_DATABASE_URL). */
  contentDatabaseUrl?: string;
  timeouts?: Partial<Record<'install' | 'typecheck' | 'unit' | 'build' | 'start', number>>;
}

/** Every side effect of a run, replaceable in tests. */
export interface RunTools {
  exec: RunCommand;
  prepare: typeof prepareWorkspace;
  lint: typeof lintSite;
  saveArtifact: typeof saveArtifact;
  startSite: typeof startSite;
  smokeTest: typeof smokeTest;
  validatePages: typeof validatePages;
}

export const defaultTools: RunTools = {
  exec: runCommand,
  prepare: prepareWorkspace,
  lint: lintSite,
  saveArtifact,
  startSite,
  smokeTest,
  validatePages,
};

export type Report = (name: BuilderCheckName, status: CheckStatus, output?: string | null) => void;

const MINUTE = 60_000;
const DEFAULT_TIMEOUTS = {
  install: 5 * MINUTE,
  typecheck: 5 * MINUTE,
  unit: 10 * MINUTE,
  build: 15 * MINUTE,
  start: MINUTE,
};

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Dependencies added, changed or removed by the site compared with the platform template. */
export function dependencyChanges(before: unknown, after: unknown): string[] {
  const deps = (manifest: unknown) => {
    const all = new Map<string, string>();
    for (const field of DEPENDENCY_FIELDS) {
      const group = (manifest as Record<string, unknown> | null)?.[field];
      if (group && typeof group === 'object') {
        for (const [name, spec] of Object.entries(group)) all.set(name, String(spec));
      }
    }
    return all;
  };
  const old = deps(before);
  const now = deps(after);
  const changes: string[] = [];
  for (const [name, spec] of now) {
    if (!old.has(name)) changes.push(`+ ${name}@${spec} (nuova)`);
    else if (old.get(name) !== spec) changes.push(`~ ${name}: ${old.get(name)!} → ${spec}`);
  }
  for (const name of old.keys()) if (!now.has(name)) changes.push(`- ${name} (rimossa)`);
  return changes.sort();
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the site has at least one unit test file. */
export async function hasTests(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    if (entry.isDirectory()) {
      if (await hasTests(join(dir, entry.name))) return true;
    } else if (TEST_FILE.test(entry.name)) return true;
  }
  return false;
}

const tail = (text: string, max = 4_000) => (text.length > max ? `…${text.slice(-max)}` : text);

/**
 * Runs the builder checks of one changeset commit (TECHNICAL §8.2) and reports each result as
 * soon as it is known. Execution order: deps (the install everything else needs), typecheck,
 * lint, unit, build, e2e, html, a11y.
 */
export async function executeRun(
  request: BuilderRunRequest,
  config: BuilderConfig,
  report: Report,
  tools: RunTools = defaultTools,
): Promise<void> {
  const wanted = new Set(request.checks);
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  const set: Report = (name, status, output = null) => {
    if (wanted.has(name)) report(name, status, output);
  };
  const skip = (names: BuilderCheckName[], reason: string) =>
    names.forEach((name) => set(name, 'skipped', reason));

  let workspace;
  try {
    const clone = join(config.workspacesRoot, request.changesetId);
    workspace = await tools.prepare({
      platformRoot: config.platformRoot,
      workRoot: config.workRoot,
      clone,
      commit: request.commit,
      exec: tools.exec,
      env: siteEnv(config.workRoot),
    });
  } catch (error) {
    for (const name of request.checks) {
      set(name, 'failed', `Preparazione del changeset non riuscita: ${(error as Error).message}`);
    }
    return;
  }

  const { repo, site, home } = workspace;
  const env = siteEnv(home);
  const runtimeEnv: Record<string, string> = {
    DATABASE_URL: request.databaseUrl,
    CMS_ENV: 'staging',
    ...(config.contentDatabaseUrl ? { CORE_DATABASE_URL: config.contentDatabaseUrl } : {}),
  };
  const bin = (name: string) => join(repo, 'node_modules', '.bin', name);
  const siteBin = (name: string) => join(site, 'node_modules', '.bin', name);

  try {
    // 4. deps: the site must install from the platform lockfile, offline.
    set('deps', 'running');
    const changes = dependencyChanges(
      await readJson(join(config.platformRoot, SITE_DIR, 'package.json')),
      await readJson(join(site, 'package.json')),
    );
    const install = await tools.exec(
      'pnpm',
      [
        'install',
        '--frozen-lockfile',
        '--offline',
        '--ignore-scripts',
        '--reporter=append-only',
        '--filter',
        // Braces: a directory selector followed by `...` (the site and its dependencies).
        `{./${SITE_DIR}}...`,
        '--filter',
        '.',
      ],
      { cwd: repo, env, timeoutMs: timeouts.install },
    );
    const installed = install.code === 0;
    if (installed) {
      set('deps', 'passed', 'Nessuna dipendenza nuova: il sito usa solo dipendenze già approvate.');
    } else if (
      changes.length > 0 ||
      /ERR_PNPM_(OUTDATED_LOCKFILE|NO_OFFLINE|LOCKFILE_CONFIG_MISMATCH)/.test(install.output)
    ) {
      set(
        'deps',
        'failed',
        [
          'Il sito aggiunge o cambia dipendenze che non sono nel lockfile della piattaforma:',
          ...(changes.length > 0 ? changes : ['(vedi il dettaglio di pnpm)']),
          '',
          "Le nuove dipendenze richiedono l'approvazione di un amministratore della piattaforma. " +
            'Nel frattempo usa solo le dipendenze già presenti in package.json.',
          '',
          tail(install.output),
        ].join('\n'),
      );
    } else {
      set('deps', 'failed', `Installazione delle dipendenze non riuscita:\n${install.output}`);
    }
    const notInstalled = 'Non eseguito: le dipendenze del sito non si installano (vedi deps).';

    // 2. typecheck
    if (!installed) skip(['typecheck'], notInstalled);
    else if (wanted.has('typecheck')) {
      set('typecheck', 'running');
      let prefix = '';
      if (await exists(siteBin('next'))) {
        const typegen = await tools.exec(siteBin('next'), ['typegen'], {
          cwd: site,
          env: { ...env, ...runtimeEnv },
          timeoutMs: timeouts.typecheck,
        });
        if (typegen.code !== 0) prefix = `next typegen non riuscito:\n${typegen.output}\n\n`;
      }
      const tsc = await tools.exec(bin('tsc'), ['--noEmit', '-p', '.'], {
        cwd: site,
        env,
        timeoutMs: timeouts.typecheck,
      });
      if (tsc.code === 0) set('typecheck', 'passed', `${prefix}Nessun errore di tipo.`);
      else set('typecheck', 'failed', `${prefix}tsc --noEmit:\n${tsc.output}`);
    }

    // 3. lint: parses the sources only, so it runs even without dependencies.
    if (wanted.has('lint')) {
      set('lint', 'running');
      try {
        const lint = await tools.lint(site);
        set('lint', lint.status, lint.output);
      } catch (error) {
        set('lint', 'failed', `ESLint non riuscito: ${(error as Error).message}`);
      }
    }

    // 5. unit
    if (!installed) skip(['unit'], notInstalled);
    else if (wanted.has('unit')) {
      if (!(await hasTests(site))) {
        set('unit', 'skipped', 'Nessun test unitario nel sito (file *.test.ts o *.spec.ts).');
      } else {
        set('unit', 'running');
        const vitest = await tools.exec(bin('vitest'), ['run', '--root', '.'], {
          cwd: site,
          env: { ...env, ...runtimeEnv },
          timeoutMs: timeouts.unit,
        });
        set('unit', vitest.code === 0 ? 'passed' : 'failed', vitest.output);
      }
    }

    // 7. build, then 8. e2e and 9. html on the built artifact.
    const needsBuild = ['build', 'e2e', 'html'].some((n) => wanted.has(n as BuilderCheckName));
    let server: string | null = null;
    if (!installed) skip(['build', 'e2e', 'html'], notInstalled);
    else if (needsBuild) {
      set('build', 'running');
      const build = await tools.exec(siteBin('next'), ['build'], {
        cwd: site,
        env: { ...env, ...runtimeEnv, NODE_ENV: 'production' },
        timeoutMs: timeouts.build,
      });
      if (build.code !== 0) {
        set('build', 'failed', `next build:\n${build.output}`);
      } else {
        try {
          const saved = await tools.saveArtifact({
            artifactsRoot: config.artifactsRoot,
            changesetId: request.changesetId,
            commit: request.commit,
            repo,
            site,
            env: runtimeEnv,
          });
          server = saved.server;
          set('build', 'passed', `Artefatto salvato (${request.commit}).\n\n${tail(build.output)}`);
        } catch (error) {
          set('build', 'failed', (error as Error).message);
        }
      }
    }

    if (installed && needsBuild) {
      if (!server) skip(['e2e', 'html'], 'Non eseguito: la build non è riuscita.');
      else if (wanted.has('e2e') || wanted.has('html')) {
        set('e2e', 'running');
        set('html', 'running');
        let running;
        try {
          running = await tools.startSite({
            server,
            env: { ...env, ...runtimeEnv },
            startTimeoutMs: timeouts.start,
          });
        } catch (error) {
          const message = `Il sito non si avvia: ${(error as Error).message}`;
          set('e2e', 'failed', message);
          set('html', 'failed', message);
        }
        if (running) {
          try {
            if (wanted.has('e2e')) {
              const e2e = await tools.smokeTest(running.url, request.publishedPages);
              set('e2e', e2e.status, e2e.output);
            }
            if (wanted.has('html')) {
              const html = await tools.validatePages(running.url, request.pages);
              set('html', html.status, html.output);
            }
          } finally {
            await running.stop();
          }
        }
      }
    }

    // 10. a11y
    set(
      'a11y',
      'skipped',
      "Non eseguito nell'MVP: axe-core richiede un browser headless. Le verifiche WCAG che si " +
        "possono fare sull'HTML (html-validate:a11y) fanno parte del controllo html.",
    );
  } catch (error) {
    // Unexpected failure of the builder itself: whatever is unfinished fails with the reason.
    for (const name of request.checks) {
      set(name, 'failed', `Errore del builder: ${(error as Error).message}`);
    }
  } finally {
    await rm(workspace.dir, { recursive: true, force: true });
  }
}
