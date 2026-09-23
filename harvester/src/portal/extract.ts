/**
 * Разбор ответов портала в наши поля.
 *
 * ВАЖНО. Точные имена ключей в API портала неизвестны до первого запуска
 * `probe`. Поэтому поля ищутся не по жёсткому пути, а по смыслу имени:
 * набором шаблонов, на любой глубине объекта. Такой разбор переживает
 * и переименование соседних полей, и двуязычие (ru/kz суффиксы).
 *
 * Если после probe окажется, что имена другие — правится один список
 * шаблонов ниже, остальной код не трогается.
 */

export type Json = Record<string, unknown>;

export interface ListRow {
  purchaseNo: string;
  lotNo?: string | null;
  lineNo?: string | null;
  title?: string | null;
  customerName?: string | null;
  method?: string | null;
  status?: string | null;
  publishedAt?: string | null;
  bidsCloseAt?: string | null;
  amountNoVat?: number | null;
  place?: string | null;
  raw: Json;
}

/** Шаблоны имён ключей, от самого точного к самому общему. */
const F = {
  purchaseNo: [/^(purchase|advert|announce|zakup)?_?(number|no|num|id)$/i, /purchase.*num/i, /advert.*num/i],
  lotNo: [/^lot_?(number|no|num|id)$/i, /lot.*num/i, /^lotid$/i],
  lineNo: [/(line|row|plan).*(number|no|num)/i, /^строка$/i],
  title: [/^(name|title|subject|lot_?name)(_ru|_rus|ru)?$/i, /name.*ru$/i, /^description$/i],
  customer: [/customer.*(name)?(_ru|ru)?$/i, /client.*name/i, /organizer.*name/i, /^заказчик$/i],
  method: [/method|type.*(purchase|trade)|way/i],
  status: [/status|state/i],
  publishedAt: [/publish.*(date|at)/i, /date.*publish/i, /^created(_?at|_?date)?$/i],
  bidsCloseAt: [/(end|close|finish|deadline).*(date|at|time)/i, /date.*(end|close)/i],
  bidsOpenAt: [/(start|begin|open).*(date|at|time)/i, /date.*(start|begin)/i],
  amountNoVat: [/(sum|amount|price|cost).*(no_?nds|no_?vat|without)/i, /^(sum|amount|total_?sum|plan_?sum)$/i, /nds.*sum/i],
  place: [/(place|location|delivery.*place|region).*(name|_ru|ru)?$/i, /^адрес$/i],
  deliveryTerm: [/(delivery|supply|execution).*(term|period|date|srok)/i],
  paymentTerms: [/payment.*(term|condition)/i, /prepay/i],
  fileUuid: [/^(file_?)?(uuid|guid|id)$/i],
  fileName: [/(file_?)?name(_ru|ru)?$/i, /original.*name/i],
} as const;

/** Ищет значение по шаблонам имени ключа на любой глубине. */
export function pickField(node: unknown, patterns: readonly RegExp[], depth = 0): unknown {
  if (depth > 5 || node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const entries = Object.entries(node as Json);
  for (const pattern of patterns) {
    for (const [k, v] of entries) {
      if (pattern.test(k) && v !== null && v !== undefined && v !== '') {
        if (typeof v !== 'object') return v;
      }
    }
  }
  for (const [, v] of entries) {
    const found = pickField(v, patterns, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function pickString(node: unknown, patterns: readonly RegExp[]): string | null {
  const v = pickField(node, patterns);
  if (v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Суммы на портале даются без НДС и приходят то числом, то строкой
 * с пробелами и запятой.
 */
export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value)
    .replace(/[\s  ]/g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
  if (cleaned === '') return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Даты приходят и как ISO, и как 24.08.2026 10:00. Приводим к ISO. */
export function parseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (dmy) {
    const [, d, m, y, hh = '00', mm = '00'] = dmy;
    return `${y}-${m}-${d}T${hh}:${mm}:00`;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Статус портала → наш словарь. */
export function normalizeStatus(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/предварительн|алдын ала|prelim|discuss/.test(s)) return 'preliminary_discussion';
  if (/опубликован|жарияланды|publish/.test(s)) return 'published';
  return 'other';
}

export function rowFromJson(node: Json): ListRow | null {
  const purchaseNo = pickString(node, F.purchaseNo);
  if (!purchaseNo || !/^\d{4,10}$/.test(purchaseNo)) return null;
  return {
    purchaseNo,
    lotNo: pickString(node, F.lotNo),
    lineNo: pickString(node, F.lineNo),
    title: pickString(node, F.title),
    customerName: pickString(node, F.customer),
    method: pickString(node, F.method),
    status: normalizeStatus(pickString(node, F.status)),
    publishedAt: parseDate(pickField(node, F.publishedAt)),
    bidsCloseAt: parseDate(pickField(node, F.bidsCloseAt)),
    amountNoVat: parseAmount(pickField(node, F.amountNoVat)),
    place: pickString(node, F.place),
    raw: node,
  };
}

/** Достаёт самый длинный массив однотипных объектов и разбирает его как список. */
export function rowsFromListResponse(body: string): ListRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const arr = deepestObjectArray(parsed);
  const rows: ListRow[] = [];
  for (const item of arr) {
    const row = rowFromJson(item);
    if (row) rows.push(row);
  }
  return rows;
}

function deepestObjectArray(node: unknown, depth = 0): Json[] {
  if (depth > 6 || node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    const objs = node.filter((x): x is Json => !!x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length > 0) return objs;
    return [];
  }
  let best: Json[] = [];
  for (const v of Object.values(node as Json)) {
    const inner = deepestObjectArray(v, depth + 1);
    if (inner.length > best.length) best = inner;
  }
  return best;
}

export interface FileRef {
  uuid: string;
  url: string;
  filename?: string | null;
  lotNo?: string | null;
}

/**
 * Ссылки на файлы. Настоящий URL вида
 * eprocfilestorage/open-api/files/download/<uuid> добывает браузер, но
 * читается он обычным HTTP-запросом без подписи.
 */
export function fileRefsFromText(text: string, baseUrl: string): FileRef[] {
  const out = new Map<string, FileRef>();
  const re = /(?:https?:\/\/[^\s"'<>]+)?\/?(eprocfilestorage\/open-api\/files\/download\/([A-Za-z0-9_-]{8,}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1]!;
    const uuid = m[2]!;
    out.set(uuid, { uuid, url: `${baseUrl.replace(/\/$/, '')}/${path}` });
  }
  return [...out.values()];
}

/** Тип документа по его имени — грубо, но достаточно для полки в интерфейсе. */
export function classifyDocKind(filename: string | null | undefined): string {
  const s = (filename ?? '').toLowerCase();
  if (/объявл|хабарланд|announce|advert/.test(s)) return 'advert';
  if (/тендерн.*документац|ТД|тендерлік/i.test(s)) return 'td';
  if (/договор|шарт|contract/.test(s)) return 'contract_draft';
  if (/специф|ерекшел|техн|lot_/.test(s)) return 'tech_spec';
  if (/прилож|қосымша|annex|прил/.test(s)) return 'annex';
  if (/разъясн|түсінд/.test(s)) return 'clarification';
  return 'other';
}
