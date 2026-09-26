import type { Message } from 'html-validate';

type Translator = (message: string, match: RegExpExecArray | null) => string;

interface Translation {
  pattern?: RegExp;
  text: Translator | string;
}

/**
 * Italian messages for the `html-validate` rules we enable. The original English text is
 * matched with a pattern when it carries details (tag names, ids) worth repeating.
 */
const translations: Record<string, Translation[]> = {
  'missing-doctype': [
    { text: 'Manca il doctype: il documento deve iniziare con <!DOCTYPE html>.' },
  ],
  'doctype-html': [{ text: 'Il doctype deve essere <!DOCTYPE html> (HTML5).' }],
  'heading-level': [
    {
      pattern: /expected <(h\d)> but got <(h\d)>/,
      text: (_, m) =>
        `Salto di livello nei titoli: qui ci si aspetta <${m?.[1] ?? ''}>, invece c’è <${m?.[2] ?? ''}>. I livelli dei titoli devono scendere di uno alla volta.`,
    },
    {
      pattern: /Initial heading level .* <(h\d)> but got <(h\d)>/,
      text: (_, m) =>
        `Il primo titolo della pagina deve essere <${m?.[1] ?? 'h1'}>, invece è <${m?.[2] ?? ''}>.`,
    },
  ],
  'no-dup-id': [
    {
      pattern: /Duplicate ID "([^"]*)"/,
      text: (_, m) =>
        `L’id "${m?.[1] ?? ''}" è usato più di una volta: ogni id deve essere unico nella pagina.`,
    },
  ],
  'element-permitted-content': [
    {
      pattern:
        /<([\w-]+)> element is not permitted as (?:content under|a descendant of) <([\w-]+)>/,
      text: (_, m) =>
        `Nesting non valido: <${m?.[1] ?? ''}> non può stare dentro <${m?.[2] ?? ''}>.`,
    },
  ],
  'element-permitted-parent': [
    {
      pattern: /<([\w-]+)> element requires a <?([\w-]+)>? element as parent/,
      text: (_, m) => `Nesting non valido: <${m?.[1] ?? ''}> deve stare dentro <${m?.[2] ?? ''}>.`,
    },
  ],
  'element-required-ancestor': [
    {
      pattern: /<([\w-]+)> element requires an? (.+) ancestor/,
      text: (_, m) =>
        `Nesting non valido: <${m?.[1] ?? ''}> deve stare dentro ${m?.[2] ?? 'un altro elemento'}.`,
    },
  ],
  'element-permitted-occurrences': [
    {
      pattern: /Element <([\w-]+)> can only appear once under <([\w-]+)>/,
      text: (_, m) => `<${m?.[1] ?? ''}> può comparire una sola volta dentro <${m?.[2] ?? ''}>.`,
    },
  ],
  'element-permitted-order': [
    {
      pattern: /Element <([\w-]+)> must be used before <([\w-]+)>/,
      text: (_, m) =>
        `Ordine non valido: <${m?.[1] ?? ''}> deve venire prima di <${m?.[2] ?? ''}>.`,
    },
  ],
  'element-required-content': [
    {
      pattern: /<([\w-]+)> element must have (.+) as content/,
      text: (_, m) => `<${m?.[1] ?? ''}> deve contenere ${m?.[2] ?? 'altri elementi'}.`,
    },
  ],
  'element-required-attributes': [
    {
      pattern: /<([\w-]+)> is missing required "([^"]+)" attribute/,
      text: (_, m) => `A <${m?.[1] ?? ''}> manca l’attributo obbligatorio "${m?.[2] ?? ''}".`,
    },
  ],
  'close-order': [
    {
      pattern: /Stray end tag '([^']*)'/,
      text: (_, m) =>
        `Tag di chiusura ${m?.[1] ?? ''} senza apertura corrispondente (spesso è un nesting non valido che il browser chiude da solo).`,
    },
    { text: 'Tag aperti e chiusi in ordine sbagliato.' },
  ],
  'close-attr': [{ text: 'I tag di chiusura non possono avere attributi.' }],
  'void-content': [
    { text: 'Gli elementi vuoti (es. <img>, <br>) non possono avere un tag di chiusura.' },
  ],
  deprecated: [
    {
      pattern: /<([\w-]+)> is deprecated/,
      text: (_, m) => `L’elemento <${m?.[1] ?? ''}> è deprecato: usa un elemento moderno e il CSS.`,
    },
  ],
  'no-deprecated-attr': [
    {
      pattern: /Attribute "([^"]+)" is deprecated on <([\w-]+)>/,
      text: (_, m) => `L’attributo "${m?.[1] ?? ''}" di <${m?.[2] ?? ''}> è deprecato: usa il CSS.`,
    },
  ],
  'no-dup-attr': [
    {
      pattern: /Attribute "([^"]+)" duplicated/,
      text: (_, m) => `L’attributo "${m?.[1] ?? ''}" è ripetuto sullo stesso elemento.`,
    },
  ],
  'attribute-allowed-values': [
    {
      pattern: /Attribute "([^"]+)" has invalid value "([^"]*)"/,
      text: (_, m) => `L’attributo "${m?.[1] ?? ''}" ha un valore non valido: "${m?.[2] ?? ''}".`,
    },
  ],
  'element-name': [
    {
      pattern: /<([^>]+)> is not a valid element name/,
      text: (_, m) => `<${m?.[1] ?? ''}> non è un nome di elemento valido.`,
    },
  ],
  'wcag/h37': [
    {
      text: 'Immagine senza attributo alt: descrivi cosa mostra, oppure usa alt="" se è solo decorativa.',
    },
  ],
  'wcag/h30': [
    {
      text: 'Link senza testo: il link deve avere un testo che dica dove porta (oppure un’immagine con alt o un aria-label).',
    },
  ],
  'wcag/h32': [{ text: 'Il form non ha un pulsante di invio.' }],
  'wcag/h36': [
    { text: 'Un <input type="image"> usato come pulsante deve avere un alt non vuoto.' },
  ],
  'wcag/h63': [{ text: 'Le intestazioni di tabella (<th>) devono indicare lo scope (row o col).' }],
  'wcag/h67': [{ text: 'Un’immagine decorativa (alt vuoto) non deve avere l’attributo title.' }],
  'wcag/h71': [{ text: 'Un <fieldset> deve avere come primo figlio una <legend>.' }],
  'text-content': [
    {
      pattern: /<([\w-]+)> must have accessible text/,
      text: (_, m) =>
        `<${m?.[1] ?? ''}> senza testo accessibile: aggiungi un testo visibile o un aria-label che dica cosa fa.`,
    },
  ],
  'input-missing-label': [
    {
      pattern: /<([\w-]+)> element does not have a <label>/,
      text: (_, m) =>
        `Campo <${m?.[1] ?? ''}> senza etichetta: collega un <label for="…"> oppure usa aria-label.`,
    },
  ],
  'no-missing-references': [
    {
      pattern: /references missing id "([^"]*)"/,
      text: (_, m) => `Riferimento all’id "${m?.[1] ?? ''}", che non esiste nella pagina.`,
    },
  ],
  'no-implicit-button-type': [
    { text: 'Indica il tipo del pulsante: type="button" oppure type="submit".' },
  ],
  'aria-label-misuse': [
    {
      pattern: /"(aria-label(?:ledby)?)" cannot be used on this element/,
      text: (_, m) =>
        `${m?.[1] ?? 'aria-label'} non si può usare su questo elemento: mettilo su un elemento interattivo o con un ruolo (landmark, immagine, ecc.).`,
    },
  ],
  'hidden-focusable': [
    {
      text: 'Un elemento nascosto agli screen reader (aria-hidden) non deve poter ricevere il focus.',
    },
  ],
  'aria-hidden-body': [{ text: 'aria-hidden non può essere usato su <body>.' }],
  'meta-refresh': [
    { text: 'Non usare <meta http-equiv="refresh"> per ricaricare o reindirizzare.' },
  ],
  'no-autoplay': [{ text: 'Audio e video non devono partire da soli (autoplay).' }],
  'empty-heading': [{ text: 'Titolo vuoto: ogni titolo (<h1>–<h6>) deve avere un testo.' }],
  'unrecognized-char-ref': [{ text: 'Entità HTML non riconosciuta (es. &nbsp; scritto male).' }],
  'no-raw-characters': [
    { text: 'Carattere speciale non codificato: usa l’entità HTML (es. &amp;).' },
  ],
  'valid-id': [{ text: 'Id non valido: non deve essere vuoto né contenere spazi.' }],
  'form-dup-name': [{ text: 'Due campi dello stesso form hanno lo stesso name.' }],
};

/** Returns the Italian text for a message, falling back to the original English. */
export function translate(message: Message): string {
  if (message.ruleId.startsWith('ai-cms/')) return message.message;
  for (const { pattern, text } of translations[message.ruleId] ?? []) {
    const match = pattern ? pattern.exec(message.message) : null;
    if (pattern && !match) continue;
    return typeof text === 'string' ? text : text(message.message, match);
  }
  return `Problema HTML (${message.ruleId}): ${message.message}`;
}
