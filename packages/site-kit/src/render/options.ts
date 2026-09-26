import { isHttpUrl, isRootRelative } from '@ai-cms/content';

export interface RenderOptions {
  /** Public origin of the site (e.g. `http://www.localhost`): links elsewhere are external. */
  siteOrigin?: string;
  /** URL of an asset given its id. Defaults to `/_cms/assets/<id>`. */
  assetUrl?: (id: string) => string;
}

export function defaultAssetUrl(id: string): string {
  return `/_cms/assets/${encodeURIComponent(id)}`;
}

/** Image `src` in content is an asset id, an absolute http(s) URL or a root-relative path. */
export function resolveImageSrc(src: string, options: RenderOptions = {}): string {
  if (isHttpUrl(src) || isRootRelative(src)) return src;
  return (options.assetUrl ?? defaultAssetUrl)(src);
}

/** An absolute http(s) link to another origin. */
export function isExternalLink(href: string, options: RenderOptions = {}): boolean {
  if (!isHttpUrl(href)) return false;
  if (!options.siteOrigin) return true;
  try {
    return new URL(href).origin !== new URL(options.siteOrigin).origin;
  } catch {
    return true;
  }
}

/** `rel` for a content link: external links never get `window.opener` nor the referrer. */
export function linkRel(href: string, options: RenderOptions = {}): string | undefined {
  return isExternalLink(href, options) ? 'noopener noreferrer' : undefined;
}
