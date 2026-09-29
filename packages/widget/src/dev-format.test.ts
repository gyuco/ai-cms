import { describe, expect, it } from 'vitest';
import {
  autofixLabel,
  changesetStatusLabel,
  checkNameLabel,
  checkStatusLabel,
  isBusyStatus,
  personName,
  releaseStatusLabel,
} from './dev-format.ts';

describe('the words of the Development tab', () => {
  it('names the statuses in Italian and falls back to the raw value', () => {
    expect(changesetStatusLabel('ready')).toEqual({
      label: 'Pronto per la pubblicazione',
      tone: 'ok',
    });
    expect(changesetStatusLabel('checks_failed').tone).toBe('error');
    expect(changesetStatusLabel('nuovo')).toEqual({ label: 'nuovo', tone: 'off' });
    expect(checkStatusLabel('passed').label).toBe('Superato');
    expect(releaseStatusLabel('rolled_back').label).toBe('Annullata');
    expect(checkNameLabel('html')).toBe('Regole HTML');
    expect(checkNameLabel('altro')).toBe('altro');
  });

  it('describes the automatic correction rounds', () => {
    expect(autofixLabel({ state: 'idle', attempts: 0, maxAttempts: 3 })).toBeNull();
    expect(autofixLabel({ state: 'running', attempts: 2, maxAttempts: 3 })).toBe(
      'Correzione automatica in corso (tentativo 2 di 3).',
    );
    expect(autofixLabel({ state: 'exhausted', attempts: 3, maxAttempts: 3 })).toContain(
      'serve un intervento',
    );
    expect(autofixLabel({ state: 'idle', attempts: 1, maxAttempts: 3 })).toBe(
      'Correzione automatica: 1 di 3 tentativi usati.',
    );
  });

  it('polls while the checks or the release are moving', () => {
    expect(isBusyStatus('checking')).toBe(true);
    expect(isBusyStatus('releasing')).toBe(true);
    expect(isBusyStatus('ready')).toBe(false);
  });

  it('shows a person by display name, then user name', () => {
    expect(personName({ username: 'anna', displayName: 'Anna Rossi' })).toBe('Anna Rossi');
    expect(personName({ username: 'anna', displayName: null })).toBe('anna');
    expect(personName(null)).toBe('utente sconosciuto');
  });
});
