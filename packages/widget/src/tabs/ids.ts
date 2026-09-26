export const TAB_IDS = ['chat', 'page', 'site', 'dev', 'users', 'ai', 'audit'] as const;

export type TabId = (typeof TAB_IDS)[number];

export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}
