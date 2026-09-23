import { config } from '../config.js';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}

/**
 * Обычный HTTP-клиент, мимо браузера.
 *
 * Файлы портала (eprocfilestorage/open-api/files/download/<uuid>) читаются
 * простым запросом без подписи — этим и занят этот клиент. Заголовки,
 * снятые с живого браузера, передаются сюда же, если понадобятся для
 * запросов к API данных.
 */
export async function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': config.userAgent, ...(opts.headers ?? {}) },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const max = opts.maxBytes ?? 200 * 1024 * 1024;
    if (buf.byteLength > max) throw new Error(`ответ больше ${max} байт: ${buf.byteLength}`);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body: buf, url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/zip': '.zip',
  'text/html': '.html',
};

/** Расширение по имени файла, иначе по типу содержимого, иначе .bin */
export function guessExtension(filename: string | null | undefined, mime: string | null | undefined): string {
  const fromName = filename?.match(/(\.[A-Za-z0-9]{1,5})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_MIME[base] ?? '.bin';
}

/** Имя файла из Content-Disposition, включая RFC 5987 (filename*=UTF-8''…). */
export function filenameFromDisposition(value: string | undefined): string | null {
  if (!value) return null;
  const star = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* битая кодировка — пробуем обычный filename */
    }
  }
  const plain = value.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  return plain ? plain.trim() : null;
}
