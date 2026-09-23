/**
 * Отчёт probe уходит человеку и, возможно, дальше по почте. Значения
 * заголовков, несущих сессию, в него попадать не должны — только факт
 * наличия и длина.
 */
const SECRET = /^(cookie|set-cookie|authorization|proxy-authorization|tor|x-csrf-token|x-xsrf-token)$/i;
const SECRETISH = /(token|secret|signature|session|auth)/i;

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SECRET.test(k) || SECRETISH.test(k) ? `«скрыто, ${v.length} символов»` : v;
  }
  return out;
}

/** Маскирует то, что похоже на длинные токены, внутри произвольного текста. */
export function redactText(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '«скрыто»')
    .replace(/(eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]+/g, '«jwt скрыт»');
}
