import { toLtree } from '@ai-cms/authz';
import { publicPathFromNode } from '@ai-cms/site-kit/paths';
import type { Env } from './http.ts';
import { revalidateSite } from './revalidate.ts';

/**
 * Site paths to regenerate for content nodes (in `/site/pages/x` form): pages map to their
 * public URL; layouts, menus, settings and assets affect every page, so they map to '*'.
 */
export function sitePathsFor(nodePaths: string[]): string[] {
  const paths = new Set<string>();
  for (const nodePath of nodePaths) {
    const page = publicPathFromNode(toLtree(nodePath));
    paths.add(page ?? '*');
  }
  return paths.has('*') ? ['*'] : [...paths];
}

/** `onPublished` hook for the content services: refreshes the site after a publication. */
export async function revalidateAfterPublish(nodePaths: string[], env: Env): Promise<void> {
  await revalidateSite(env, sitePathsFor(nodePaths));
}
