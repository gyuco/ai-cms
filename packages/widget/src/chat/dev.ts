/** A changeset as `GET /_cms/api/changesets` lists it (only what the chat needs). */
export interface ChangesetItem {
  id: string;
  title: string;
  status: string;
  conversationId: string | null;
  previewUrl: string;
}

/** Statuses in which the developer agent may still add work (see `editableStatuses`). */
const WORKABLE = new Set(['draft', 'checks_failed']);

/** The changesets the person can talk about: opened from a chat and not yet in review. */
export function workableChangesets(all: readonly ChangesetItem[]): ChangesetItem[] {
  return all.filter((item) => item.conversationId !== null && WORKABLE.has(item.status));
}

/** Package names typed by the person, separated by spaces, commas or new lines. */
export function parsePackageNames(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter(Boolean))];
}

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  draft: 'in lavorazione',
  checks_failed: 'controlli falliti',
  checking: 'controlli in corso',
  ready: 'pronta',
  releasing: 'in pubblicazione',
};
