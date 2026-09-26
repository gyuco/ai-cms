import {
  Rule,
  type DOMReadyEvent,
  type DOMTree,
  type HtmlElement,
  type Location,
  type Plugin,
} from 'html-validate';

export const TITLE_MAX_LENGTH = 60;
export const DESCRIPTION_MIN_LENGTH = 50;
export const DESCRIPTION_MAX_LENGTH = 160;

/** Sectioning elements that turn a nested header/footer/nav into a non-page landmark. */
const SECTIONING = 'article, aside, main, nav, section';

const documentStart: Location = { filename: 'inline', offset: 0, line: 1, column: 1, size: 1 };

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Returns the node to anchor document-level reports on: <html> if present. */
function anchor(document: DOMTree): HtmlElement | null {
  return document.querySelector('html');
}

function isHidden(element: HtmlElement): boolean {
  return element.hasAttribute('hidden') || element.getAttributeValue('aria-hidden') === 'true';
}

abstract class DocumentRule<Options = void> extends Rule<void, Options> {
  override setup(): void {
    this.on('dom:ready', (event: DOMReadyEvent) => this.check(event.document));
  }

  protected abstract check(document: DOMTree): void;

  protected reportDocument(document: DOMTree, message: string): void {
    const root = anchor(document);
    this.report(root, message, root ? root.location : documentStart);
  }
}

export class HtmlLang extends DocumentRule {
  protected check(document: DOMTree): void {
    const html = document.querySelector('html');
    if (!html) {
      this.reportDocument(document, 'Manca l’elemento <html>.');
      return;
    }
    if (!normalize(html.getAttributeValue('lang') ?? '')) {
      this.report(
        html,
        'L’elemento <html> deve avere l’attributo lang con la lingua della pagina (es. lang="it").',
      );
    }
  }
}

export class MetaCharset extends DocumentRule {
  protected check(document: DOMTree): void {
    const metas = document.querySelectorAll('meta[charset]');
    const [first] = metas;
    if (!first) {
      this.reportDocument(document, 'Manca <meta charset="utf-8"> nell’head della pagina.');
      return;
    }
    if (normalize(first.getAttributeValue('charset') ?? '').toLowerCase() !== 'utf-8') {
      this.report(first, 'La codifica della pagina deve essere UTF-8 (<meta charset="utf-8">).');
    }
    for (const extra of metas.slice(1)) {
      this.report(extra, 'La codifica della pagina è dichiarata più di una volta.');
    }
  }
}

export class MetaViewport extends DocumentRule {
  protected check(document: DOMTree): void {
    const viewport = document
      .querySelectorAll('meta[name]')
      .find((meta) => meta.getAttributeValue('name')?.toLowerCase() === 'viewport');
    if (!viewport) {
      this.reportDocument(
        document,
        'Manca <meta name="viewport" content="width=device-width, initial-scale=1">: la pagina non si adatterà agli schermi dei telefoni.',
      );
      return;
    }
    if (!normalize(viewport.getAttributeValue('content') ?? '')) {
      this.report(viewport, 'Il <meta name="viewport"> non ha un valore nell’attributo content.');
    }
  }
}

export interface PageTitleOptions {
  otherTitles: string[];
}

export class PageTitle extends DocumentRule<PageTitleOptions> {
  constructor(options: Partial<PageTitleOptions>) {
    super({ otherTitles: [], ...options });
  }

  protected check(document: DOMTree): void {
    const titles = document.querySelectorAll('title').filter((title) => !title.closest('svg'));
    const [first] = titles;
    if (!first) {
      this.reportDocument(document, 'Manca il <title> della pagina.');
      return;
    }
    for (const extra of titles.slice(1)) {
      this.report(extra, 'La pagina ha più di un <title>: deve essercene esattamente uno.');
    }
    const text = normalize(first.textContent);
    if (!text) {
      this.report(first, 'Il <title> della pagina è vuoto.');
      return;
    }
    const key = text.toLowerCase();
    if (this.options.otherTitles.some((other) => normalize(other).toLowerCase() === key)) {
      this.report(
        first,
        `Il titolo "${text}" è già usato da un’altra pagina del sito: ogni pagina deve avere un titolo unico.`,
      );
    }
  }
}

export class TitleLength extends DocumentRule {
  protected check(document: DOMTree): void {
    const title = document.querySelector('title');
    if (!title) return;
    const length = normalize(title.textContent).length;
    if (length > TITLE_MAX_LENGTH) {
      this.report(
        title,
        `Il titolo è lungo ${String(length)} caratteri: sopra i ${String(TITLE_MAX_LENGTH)} i motori di ricerca lo tagliano.`,
      );
    }
  }
}

export class MetaDescription extends DocumentRule {
  protected check(document: DOMTree): void {
    const description = document
      .querySelectorAll('meta[name]')
      .find((meta) => meta.getAttributeValue('name')?.toLowerCase() === 'description');
    if (!description) {
      this.reportDocument(
        document,
        `Manca la meta description: aggiungi una descrizione della pagina di ${String(DESCRIPTION_MIN_LENGTH)}–${String(DESCRIPTION_MAX_LENGTH)} caratteri.`,
      );
      return;
    }
    const length = normalize(description.getAttributeValue('content') ?? '').length;
    if (length < DESCRIPTION_MIN_LENGTH || length > DESCRIPTION_MAX_LENGTH) {
      this.report(
        description,
        `La meta description è lunga ${String(length)} caratteri: dovrebbe essere tra ${String(DESCRIPTION_MIN_LENGTH)} e ${String(DESCRIPTION_MAX_LENGTH)}.`,
      );
    }
  }
}

export class SingleMain extends DocumentRule {
  protected check(document: DOMTree): void {
    const mains = document.querySelectorAll('main').filter((main) => !isHidden(main));
    if (mains.length === 0) {
      this.reportDocument(
        document,
        'Manca l’elemento <main>: il contenuto principale della pagina deve stare in un <main>.',
      );
      return;
    }
    for (const extra of mains.slice(1)) {
      this.report(extra, 'La pagina ha più di un <main>: deve essercene esattamente uno.');
    }
  }
}

function hasContent(element: HtmlElement): boolean {
  return element.childElements.length > 0 || normalize(element.textContent) !== '';
}

export class SingleH1 extends DocumentRule {
  protected check(document: DOMTree): void {
    const headings = document.querySelectorAll('h1');
    for (const extra of headings.slice(1)) {
      this.report(
        extra,
        'La pagina ha più di un <h1>: deve essercene esattamente uno. Usa <h2> per le sezioni.',
      );
    }
    if (headings.length > 0) return;
    const main = document.querySelector('main');
    if (main && hasContent(main)) {
      this.report(
        main,
        'La pagina ha contenuto ma nessun <h1>: aggiungi un titolo principale che descriva la pagina.',
      );
    }
  }
}

function isPageLevel(element: HtmlElement): boolean {
  return element.parent?.closest(SECTIONING) == null;
}

function accessibleName(element: HtmlElement): string {
  return normalize(
    element.getAttributeValue('aria-label') ?? element.getAttributeValue('aria-labelledby') ?? '',
  );
}

export class PageLandmarks extends DocumentRule {
  protected check(document: DOMTree): void {
    for (const tag of ['header', 'footer'] as const) {
      const landmarks = document.querySelectorAll(tag).filter(isPageLevel);
      for (const extra of landmarks.slice(1)) {
        this.report(
          extra,
          `La pagina ha più di un <${tag}> a livello di pagina: usane uno solo (dentro <article> o <section> sono ammessi).`,
        );
      }
    }
    // Several navigation menus are legitimate as long as each one is told apart by its label.
    const seen = new Set<string>();
    for (const nav of document.querySelectorAll('nav').filter(isPageLevel)) {
      const name = accessibleName(nav).toLowerCase();
      if (seen.has(name)) {
        this.report(
          nav,
          name
            ? `Ci sono più <nav> con la stessa etichetta "${name}": dai a ciascun menu un aria-label diverso.`
            : 'La pagina ha più di un <nav>: dai a ciascun menu un aria-label diverso (es. "Menu principale", "Menu del piè di pagina").',
        );
      }
      seen.add(name);
    }
  }
}

export const PLUGIN_NAME = 'ai-cms';

export const plugin: Plugin = {
  name: PLUGIN_NAME,
  rules: {
    [`${PLUGIN_NAME}/html-lang`]: HtmlLang,
    [`${PLUGIN_NAME}/meta-charset`]: MetaCharset,
    [`${PLUGIN_NAME}/meta-viewport`]: MetaViewport,
    [`${PLUGIN_NAME}/page-title`]: PageTitle,
    [`${PLUGIN_NAME}/title-length`]: TitleLength,
    [`${PLUGIN_NAME}/meta-description`]: MetaDescription,
    [`${PLUGIN_NAME}/single-main`]: SingleMain,
    [`${PLUGIN_NAME}/single-h1`]: SingleH1,
    [`${PLUGIN_NAME}/page-landmarks`]: PageLandmarks,
  },
};
