import sanitize from 'sanitize-html';

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    ...HEADINGS,
    'p',
    'br',
    'hr',
    'span',
    'div',
    'section',
    'article',
    'aside',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'small',
    'sub',
    'sup',
    'mark',
    'abbr',
    'cite',
    'q',
    'dfn',
    'time',
    'del',
    'ins',
    'code',
    'pre',
    'kbd',
    'samp',
    'var',
    'blockquote',
    'figure',
    'figcaption',
    'ul',
    'ol',
    'li',
    'dl',
    'dt',
    'dd',
    'a',
    'img',
    'table',
    'caption',
    'colgroup',
    'col',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
  ],
  // `style` and `on*` are never listed, so they are always dropped.
  allowedAttributes: {
    '*': ['class', 'id', 'lang', 'dir', 'title', 'role', 'aria-*'],
    a: ['href', 'target', 'rel', 'hreflang'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
    blockquote: ['cite'],
    q: ['cite'],
    del: ['cite', 'datetime'],
    ins: ['cite', 'datetime'],
    time: ['datetime'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    col: ['span'],
    colgroup: ['span'],
    th: ['colspan', 'rowspan', 'scope', 'headers', 'abbr'],
    td: ['colspan', 'rowspan', 'headers'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // No data: or other schemes for images, only http(s) and relative URLs.
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Tags whose text content is dropped along with the tag.
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'noscript',
    'title',
    'template',
    'xmp',
    'noembed',
    'noframes',
  ],
  transformTags: {
    a: (tagName, attribs) => {
      const { target, ...rest } = attribs;
      if (target?.toLowerCase() !== '_blank') return { tagName, attribs: rest };
      return { tagName, attribs: { ...rest, target: '_blank', rel: 'noopener noreferrer' } };
    },
  },
};

/**
 * Cleans free HTML for storage (TECHNICAL §9, FR-112): content tags only, no scripts,
 * styles, frames or event handlers; links limited to http(s), mailto, tel and relative
 * URLs; `target="_blank"` always gets `rel="noopener noreferrer"`.
 */
export function sanitizeHtml(html: string): string {
  return sanitize(html, OPTIONS);
}

/**
 * What the sanitizer would silently drop from `html` that an author probably meant to keep:
 * styles, scripts, event handlers, and content emptied altogether. Used on save to tell the
 * author (or the agent) instead of storing a block that quietly lost its content.
 */
export function describeRemovals(html: string): string[] {
  const removed: string[] = [];
  if (/<\s*style[\s>]/i.test(html)) removed.push('un tag <style>');
  if (/<[^>]*\sstyle\s*=/i.test(html)) removed.push('un attributo style');
  if (/<\s*script[\s>/]/i.test(html)) removed.push('un tag <script>');
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) removed.push('un gestore di eventi (on*)');
  if (removed.length === 0 && html.trim() !== '' && sanitizeHtml(html).trim() === '') {
    removed.push('tutto il contenuto');
  }
  return removed;
}
