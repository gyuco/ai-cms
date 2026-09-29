import type { Tone } from './format.ts';

const CHANGESET_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'In lavorazione', tone: 'draft' },
  checking: { label: 'Controlli in corso', tone: 'draft' },
  checks_failed: { label: 'Controlli falliti', tone: 'error' },
  ready: { label: 'Pronto per la pubblicazione', tone: 'ok' },
  releasing: { label: 'Pubblicazione in corso', tone: 'draft' },
  released: { label: 'Pubblicato', tone: 'ok' },
  release_failed: { label: 'Pubblicazione fallita', tone: 'error' },
  rejected: { label: 'Rifiutato', tone: 'off' },
  rolled_back: { label: 'Annullato', tone: 'off' },
  closed: { label: 'Chiuso', tone: 'off' },
};

export function changesetStatusLabel(status: string): { label: string; tone: Tone } {
  return CHANGESET_STATUS[status] ?? { label: status, tone: 'off' };
}

const CHECK_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'In coda', tone: 'off' },
  running: { label: 'In corso', tone: 'draft' },
  passed: { label: 'Superato', tone: 'ok' },
  failed: { label: 'Fallito', tone: 'error' },
  skipped: { label: 'Saltato', tone: 'off' },
};

export function checkStatusLabel(status: string): { label: string; tone: Tone } {
  return CHECK_STATUS[status] ?? { label: status, tone: 'off' };
}

const CHECK_NAME: Record<string, string> = {
  permissions: 'Permessi',
  typecheck: 'Tipi (typecheck)',
  lint: 'Lint',
  deps: 'Dipendenze',
  unit: 'Test unitari',
  migration: 'Migrazioni',
  build: 'Build',
  e2e: 'Test end-to-end',
  html: 'Regole HTML',
  a11y: 'Accessibilità',
};

export function checkNameLabel(name: string): string {
  return CHECK_NAME[name] ?? name;
}

const RELEASE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'In attesa', tone: 'draft' },
  running: { label: 'In corso', tone: 'draft' },
  released: { label: 'Pubblicata', tone: 'ok' },
  failed: { label: 'Fallita', tone: 'error' },
  rolled_back: { label: 'Annullata', tone: 'off' },
};

export function releaseStatusLabel(status: string): { label: string; tone: Tone } {
  return RELEASE_STATUS[status] ?? { label: status, tone: 'off' };
}

export type AutofixState = 'idle' | 'running' | 'exhausted';

/** The line about the automatic correction rounds (FR-42); null when there is nothing to say. */
export function autofixLabel(autofix: {
  state: AutofixState;
  attempts: number;
  maxAttempts: number;
}): string | null {
  const of = `${String(autofix.attempts)} di ${String(autofix.maxAttempts)}`;
  if (autofix.state === 'running') {
    return `Correzione automatica in corso (tentativo ${of}).`;
  }
  if (autofix.state === 'exhausted') {
    return `Correzione automatica esaurita dopo ${of} tentativi: serve un intervento.`;
  }
  return autofix.attempts > 0 ? `Correzione automatica: ${of} tentativi usati.` : null;
}

/** Statuses in which the checks or the release are still moving: the tab polls faster. */
export function isBusyStatus(status: string): boolean {
  return status === 'checking' || status === 'releasing' || status === 'draft';
}

/** The developer of a changeset or the approver of a release, as a name. */
export function personName(
  person: { username: string; displayName: string | null } | null | undefined,
): string {
  if (!person) return 'utente sconosciuto';
  return person.displayName || person.username;
}
