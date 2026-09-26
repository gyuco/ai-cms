/** Collapses whitespace and cuts the text to `max` characters, ending with "…". */
export function shortText(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
