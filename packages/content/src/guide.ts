/**
 * The exact shape of the bodies an agent writes, as text for a model: system prompt, tool
 * descriptions and the hint attached to a validation error. The examples are checked against
 * the real parsers in `guide.test.ts`, so they cannot drift from the schemas.
 */

/** A page body: `blocks` is an ARRAY, every block has an `id` and a `type`. */
export const PAGE_BODY_EXAMPLE = {
  meta: { title: 'Chi siamo', description: 'La nostra storia, il team e i valori.' },
  blocks: [
    { id: 'titolo', type: 'heading', level: 1, text: 'Chi siamo' },
    {
      id: 'intro',
      type: 'paragraph',
      content: [{ text: 'Siamo un team di ' }, { text: 'artigiani digitali', bold: true }],
    },
    {
      id: 'valori',
      type: 'list',
      ordered: false,
      items: [[{ text: 'Cura' }], [{ text: 'Semplicità' }]],
    },
    { id: 'contatti', type: 'button', label: 'Scrivici', href: '/contatti' },
  ],
};

/** A layout (header or footer): only `blocks`. */
export const LAYOUT_BODY_EXAMPLE = {
  blocks: [{ id: 'logo', type: 'paragraph', content: [{ text: 'Cloax', bold: true, href: '/' }] }],
};

/** A menu: `items`, not blocks. */
export const MENU_BODY_EXAMPLE = {
  items: [
    { label: 'Home', href: '/' },
    {
      label: 'Servizi',
      href: '/servizi',
      children: [{ label: 'Consulenza', href: '/servizi/consulenza' }],
    },
  ],
};

/** Rules the model gets wrong most often, one line each. */
const BLOCK_RULES = [
  '`blocks` è sempre un ARRAY di blocchi, mai un oggetto.',
  'Ogni blocco ha `id` (lettere, cifre, "-" e "_") e `type`, unico nella pagina.',
  '`heading`: `level` da 1 a 6 (obbligatorio) e `text` (una stringa).',
  '`paragraph` e `quote`: `content` è un ARRAY di frammenti `{ "text": "...", "bold"?, "italic"?, "code"?, "href"? }`, mai un oggetto o una stringa.',
  '`list`: `ordered` (true/false) e `items`, un array di elementi, ognuno un array di frammenti.',
  '`button`: `label` e `href`. `image`: `src`, `alt` (oppure `decorative: true`). `section`: `tag` e `children` (array di blocchi). `html`: `html`.',
];

const json = (value: unknown) => JSON.stringify(value);

/** What to write in the body of a node of the given kind (`page`, `layout`, `menu`, `setting`). */
export function bodyShapeGuide(kind: string): string {
  switch (kind) {
    case 'menu':
      return [
        'Il corpo di un menu è `{ "items": [...] }` (non ha blocchi): ogni voce ha `label` e `href`, e può avere `children` (al massimo 3 livelli).',
        `Esempio: ${json(MENU_BODY_EXAMPLE)}`,
      ].join('\n');
    case 'layout':
      return [
        'Il corpo di un layout (header, footer) è `{ "blocks": [...] }`.',
        ...BLOCK_RULES.map((rule) => `- ${rule}`),
        `Esempio: ${json(LAYOUT_BODY_EXAMPLE)}`,
      ].join('\n');
    case 'setting':
      return 'Le impostazioni del sito sono `{ "name": "...", "lang": "it", "titleTemplate": "%s · Nome" }`.';
    default:
      return [
        'Il corpo di una pagina è `{ "meta": { "title", "description" }, "blocks": [...] }`.',
        ...BLOCK_RULES.map((rule) => `- ${rule}`),
        `Esempio: ${json(PAGE_BODY_EXAMPLE)}`,
      ].join('\n');
  }
}

/** The guide for a page, layout and menu body together, for a system prompt. */
export function contentShapesGuide(): string {
  return [
    ['Pagina', 'page'],
    ['Layout (header e footer)', 'layout'],
    ['Menu', 'menu'],
  ]
    .map(([label, kind]) => `${label}:\n${bodyShapeGuide(kind!)}`)
    .join('\n\n');
}
