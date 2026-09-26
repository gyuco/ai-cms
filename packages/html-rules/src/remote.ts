import { validateDocument, type ValidationContext, type ValidationReport } from './validate.ts';

export type RenderedPageCheck =
  | { status: 'checked'; url: string; report: ValidationReport }
  /** The page could not be fetched: the site is down, slow, or answered with an error. */
  | { status: 'unavailable'; url: string; message: string };

export interface RenderedPageOptions extends ValidationContext {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Downloads a page as the site renders it and validates it (TECHNICAL §11). A site that
 * cannot be reached is not an error of the page: the result says so with a warning.
 */
export async function checkRenderedPage(
  url: string,
  options: RenderedPageOptions = {},
): Promise<RenderedPageCheck> {
  const { fetch: fetchFn = fetch, timeoutMs = 10_000, ...context } = options;
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      status: 'unavailable',
      url,
      message: 'Il sito non è raggiungibile in questo momento: riprova la verifica tra poco.',
    };
  }
  if (response.status === 404) {
    return {
      status: 'unavailable',
      url,
      message:
        'Il sito non mostra ancora questa pagina (404): la verifica usa la versione pubblicata.',
    };
  }
  if (!response.ok) {
    return {
      status: 'unavailable',
      url,
      message: `Il sito ha risposto con un errore (${String(response.status)}): riprova tra poco.`,
    };
  }
  const html = await response.text();
  return { status: 'checked', url, report: await validateDocument(html, context) };
}
