/**
 * Parses a comma-separated allowlist. An entry starting with "." matches the domain and
 * all its subdomains; any other entry matches the exact host only.
 */
export function parseAllowlist(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function isAllowed(host: string, allowlist: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) =>
    entry.startsWith('.') ? name === entry.slice(1) || name.endsWith(entry) : name === entry,
  );
}

/** Splits a CONNECT target ("host:port") and accepts only port 443. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (port !== 443) return null;
  return { host: match[1]!, port };
}
