const ABSOLUTE = /^https?:\/\/[^\s/?#]+\S*$/i;
const SCHEME_ONLY = /^(mailto|tel):\S+$/i;
// A single leading slash: `//host` would be a protocol-relative URL to another origin.
const ROOT_RELATIVE = /^\/(?![/\\])[^\s\\]*$/;
// Browsers strip some control characters while parsing URLs (e.g. `java\tscript:`).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** An absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  return !CONTROL.test(value) && ABSOLUTE.test(value);
}

/** A root-relative path such as `/chi-siamo`. */
export function isRootRelative(value: string): boolean {
  return !CONTROL.test(value) && ROOT_RELATIVE.test(value);
}

/** Link targets allowed in content: http(s), mailto, tel or root-relative paths. */
export function isSafeHref(value: string): boolean {
  return (
    isHttpUrl(value) || isRootRelative(value) || (!CONTROL.test(value) && SCHEME_ONLY.test(value))
  );
}

/** Image sources: an asset id, an absolute http(s) URL or a root-relative path. */
export function isSafeImageSrc(value: string): boolean {
  return ASSET_ID.test(value) || isHttpUrl(value) || isRootRelative(value);
}
