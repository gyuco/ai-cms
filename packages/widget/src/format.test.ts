import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  pageStateLabel,
  pageUrlOf,
  plural,
  shortText,
  slugify,
  splitNodePath,
} from './format.ts';

describe('format', () => {
  it('shortText collapses whitespace and truncates', () => {
    expect(shortText('  Ciao\n\n  mondo  ')).toBe('Ciao mondo');
    expect(shortText('abcdefghij', 6)).toBe('abcde…');
  });

  it('formatDateTime formats valid dates and leaves anything else as is', () => {
    const utc = new Intl.DateTimeFormat('it-IT', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });
    expect(formatDateTime('2026-09-26T09:05:00Z', utc)).toBe('26 set 2026, 09:05');
    expect(formatDateTime('non una data')).toBe('non una data');
  });

  it('pageStateLabel describes every publication state', () => {
    expect(
      pageStateLabel({ latestVersion: null, publishedVersion: null, hasDraft: false }),
    ).toEqual({
      label: 'Senza contenuto',
      tone: 'off',
    });
    expect(pageStateLabel({ latestVersion: 1, publishedVersion: null, hasDraft: true }).label).toBe(
      'Bozza, mai pubblicata',
    );
    expect(pageStateLabel({ latestVersion: 3, publishedVersion: 2, hasDraft: true })).toEqual({
      label: 'Pubblicata, con modifiche in bozza',
      tone: 'draft',
    });
    expect(pageStateLabel({ latestVersion: 2, publishedVersion: 2, hasDraft: false }).tone).toBe(
      'ok',
    );
  });

  it('splits node paths and maps them to page URLs', () => {
    expect(splitNodePath('/site/pages/a/b')).toEqual({ parent: '/site/pages/a', name: 'b' });
    expect(splitNodePath('/site')).toBeNull();
    expect(pageUrlOf('/site/pages/index')).toBe('/');
    expect(pageUrlOf('/site/pages/chi-siamo/team')).toBe('/chi-siamo/team');
    expect(pageUrlOf('/site/layouts/header')).toBeNull();
  });

  it('plural and slugify', () => {
    expect(plural(1, 'versione', 'versioni')).toBe('1 versione');
    expect(plural(0, 'versione', 'versioni')).toBe('0 versioni');
    expect(slugify('  Chi siamo? Perché noi!  ')).toBe('chi-siamo-perche-noi');
    expect(slugify('Ω')).toBe('');
  });
});
