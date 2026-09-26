/** POSTs JSON to a CMS endpoint and returns the parsed body or the error message. */
export async function postJson<T>(
  path: string,
  body: unknown,
  csrfToken?: string,
): Promise<{ ok: true; data: T } | { ok: false; message: string; code?: string }> {
  try {
    const response = await fetch(`/_cms${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        code: data?.error?.code,
        message: data?.error?.message ?? 'Si è verificato un errore. Riprova.',
      };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, message: 'Impossibile contattare il server. Riprova.' };
  }
}
