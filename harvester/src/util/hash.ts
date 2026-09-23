import { createHash } from 'node:crypto';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Канонический JSON: ключи отсортированы на всех уровнях, undefined выброшен.
 * Нужен, чтобы отпечаток не менялся от перестановки полей в ответе портала.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = canonicalize(v);
  }
  return out;
}

/**
 * Отпечаток наблюдаемых полей — не сырых байтов.
 *
 * В сыром ответе портала меняются служебные метки при каждом запросе, и хеш
 * по нему объявлял бы изменившимся вообще всё. Считаем только по тому,
 * изменение чего для нас событие.
 */
export function contentHash(watched: Record<string, unknown>): string {
  return sha256(canonicalJson(watched));
}

/** Путь к файлу в хранилище выводится из хеша: storage/ab/cd/abcd….pdf */
export function storagePathFor(sha: string, ext: string): string {
  const a = sha.slice(0, 2);
  const b = sha.slice(2, 4);
  const clean = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return `${a}/${b}/${sha}${clean}`;
}
