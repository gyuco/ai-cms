import { describe, expect, it } from 'vitest';
import { fileAccessFor, normalizeRepoPath } from './files.ts';

describe('normalizeRepoPath', () => {
  it('normalizes relative paths', () => {
    expect(normalizeRepoPath('app/./page.tsx')).toEqual({ ok: true, path: 'app/page.tsx' });
    expect(normalizeRepoPath('')).toEqual({ ok: true, path: '' });
    expect(normalizeRepoPath('lib//db/')).toEqual({ ok: true, path: 'lib/db' });
  });

  it.each([
    ['/etc/passwd', 'outside-workspace'],
    ['../other/file', 'outside-workspace'],
    ['app/../../x', 'outside-workspace'],
    ['.git/config', 'protected-path'],
    ['.claude/settings.json', 'protected-path'],
    ['./.git/hooks/pre-commit', 'protected-path'],
    ['a\0b', 'invalid-path'],
  ])('rejects %s', (input, code) => {
    expect(normalizeRepoPath(input)).toMatchObject({ ok: false, code });
  });
});

describe('fileAccessFor', () => {
  it('maps the tools of both engines', () => {
    expect(fileAccessFor('Read')).toBe('read');
    expect(fileAccessFor('Glob')).toBe('list');
    expect(fileAccessFor('Edit')).toBe('write');
    expect(fileAccessFor('Write', false)).toBe('create');
    expect(fileAccessFor('write_file', true)).toBe('write');
    expect(fileAccessFor('list_files')).toBe('list');
    expect(fileAccessFor('Bash')).toBeUndefined();
    expect(fileAccessFor('toString')).toBeUndefined();
  });
});
