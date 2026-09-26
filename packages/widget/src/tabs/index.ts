import type { ComponentType } from 'preact';
import { AiTab } from './ai.tsx';
import { AuditTab } from './audit.tsx';
import { ChatTab } from './chat.tsx';
import { DevTab } from './dev.tsx';
import type { TabId } from './ids.ts';
import { PageTab } from './page.tsx';
import { SiteTab } from './site.tsx';
import { UsersTab } from './users.tsx';

export interface TabDefinition {
  id: TabId;
  label: string;
  Component: ComponentType;
}

/** Phase 1: every user sees every tab (in phase 2 they depend on permissions, TECHNICAL §10.3). */
export const TABS: readonly TabDefinition[] = [
  { id: 'chat', label: 'Chat', Component: ChatTab },
  { id: 'page', label: 'Pagina', Component: PageTab },
  { id: 'site', label: 'Sito', Component: SiteTab },
  { id: 'dev', label: 'Sviluppo', Component: DevTab },
  { id: 'users', label: 'Utenti', Component: UsersTab },
  { id: 'ai', label: 'AI', Component: AiTab },
  { id: 'audit', label: 'Audit', Component: AuditTab },
];

export { isTabId, TAB_IDS, type TabId } from './ids.ts';
