/**
 * Чистые функции разбора записанного трафика. Без ввода-вывода —
 * чтобы проверялись тестами без портала.
 */

export interface CaptureLike {
  url: string;
  method: string;
  status: number;
  isJson: boolean;
  bodyPreview: string;
  bodyBytes: number;
}

export interface Candidate {
  url: string;
  method: string;
  score: number;
  reasons: string[];
  rowsGuess: number;
}

const URL_HINTS: [RegExp, number, string][] = [
  [/\blots?\b/i, 30, 'в адресе есть lot'],
  [/advert/i, 25, 'в адресе есть advert'],
  [/purchase|zakup/i, 20, 'в адресе есть purchase/zakup'],
  [/search|list|grid|page/i, 15, 'в адресе есть search/list'],
  [/open-api|api/i, 10, 'в адресе есть api'],
];

/**
 * Ищет среди записанных XHR тот, что похож на список лотов.
 *
 * Признаки: успешный JSON, в адресе слова про лоты, в теле массив
 * однотипных объектов, внутри — номера закупок и суммы.
 */
export function rankListCandidates(captures: CaptureLike[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of captures) {
    if (c.status >= 400 || !c.isJson || !c.bodyPreview) continue;

    let score = 0;
    const reasons: string[] = [];
    for (const [re, points, why] of URL_HINTS) {
      if (re.test(c.url)) {
        score += points;
        reasons.push(why);
      }
    }

    const shape = inspectJsonShape(c.bodyPreview);
    if (shape.arrayLength > 1) {
      score += Math.min(40, shape.arrayLength * 2);
      reasons.push(`массив из ${shape.arrayLength}+ элементов`);
    }
    if (shape.looksLikePurchaseNumbers) {
      score += 25;
      reasons.push('внутри номера вида 1247669');
    }
    if (shape.looksLikeAmounts) {
      score += 20;
      reasons.push('внутри суммы');
    }
    if (shape.looksLikeDates) {
      score += 10;
      reasons.push('внутри даты');
    }
    if (score > 0) out.push({ url: c.url, method: c.method, score, reasons, rowsGuess: shape.arrayLength });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface JsonShape {
  arrayLength: number;
  looksLikePurchaseNumbers: boolean;
  looksLikeAmounts: boolean;
  looksLikeDates: boolean;
  topLevelKeys: string[];
  /** Путь до самого длинного массива, например `content` или `data.items`. */
  arrayPath: string | null;
}

export function inspectJsonShape(text: string): JsonShape {
  const empty: JsonShape = {
    arrayLength: 0,
    looksLikePurchaseNumbers: false,
    looksLikeAmounts: false,
    looksLikeDates: false,
    topLevelKeys: [],
    arrayPath: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }

  const found = longestArray(parsed, '');
  return {
    arrayLength: found.length,
    arrayPath: found.path,
    topLevelKeys:
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed as Record<string, unknown>).slice(0, 40)
        : [],
    // Номер закупки на портале — семизначный.
    looksLikePurchaseNumbers: /\b\d{6,8}\b/.test(text),
    looksLikeAmounts: /\d{6,}(\.\d{1,2})?/.test(text),
    looksLikeDates: /\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/.test(text),
  };
}

function longestArray(node: unknown, path: string, depth = 0): { length: number; path: string | null } {
  if (depth > 6 || node === null || typeof node !== 'object') return { length: 0, path: null };
  let best = { length: 0, path: null as string | null };
  if (Array.isArray(node)) {
    const objects = node.filter((x) => x && typeof x === 'object').length;
    if (objects > best.length) best = { length: objects, path: path || '.' };
    for (const [i, item] of node.slice(0, 5).entries()) {
      const inner = longestArray(item, `${path}[${i}]`, depth + 1);
      if (inner.length > best.length) best = inner;
    }
    return best;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const inner = longestArray(v, path ? `${path}.${k}` : k, depth + 1);
    if (inner.length > best.length) best = inner;
  }
  return best;
}

/**
 * Какие заголовки браузер добавляет сверх обычных. Среди них и та
 * подпись, из-за которой прямой запрос отдаёт 418.
 */
const ORDINARY = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection',
  'content-length', 'content-type', 'host', 'origin', 'pragma', 'referer',
  'user-agent', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-ch-ua',
  'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'cookie', 'priority', 'te', 'dnt',
]);

export function unusualHeaders(headers: Record<string, string>): { name: string; length: number }[] {
  return Object.entries(headers)
    .filter(([k]) => !ORDINARY.has(k.toLowerCase()) && !k.startsWith(':'))
    .map(([k, v]) => ({ name: k, length: v.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type PortalMode = 'http' | 'hybrid' | 'browser' | 'unknown';

export interface Verdict {
  mode: PortalMode;
  variant: 'A/B' | 'C' | 'D' | '—';
  summary: string;
  filesOverHttp: boolean;
  portalReachable: boolean;
}

/**
 * Вердикт по результатам опытов.
 *
 * Скачивание файлов и доступ к API данных — разные вопросы, и отвечают на
 * них разные опыты. Файлы могут качаться обычным HTTP даже тогда, когда
 * API требует браузера.
 */
export function decideMode(r: {
  portalReachable: boolean;
  fileOverPlainHttp: boolean;
  apiWithoutHeaders: boolean;
  apiWithBrowserHeaders: boolean;
}): Verdict {
  // До портала не достучались вообще. Никакого вывода о способе доступа
  // из этого не следует — сказать «нужен браузер» было бы выдумкой.
  if (!r.portalReachable) {
    return {
      mode: 'unknown',
      variant: '—',
      summary: 'портал недоступен с этой машины — проверка не состоялась',
      filesOverHttp: false,
      portalReachable: false,
    };
  }
  if (r.apiWithoutHeaders) {
    return {
      mode: 'http',
      variant: 'A/B',
      summary: 'API отвечает без подписи — браузер не нужен вообще',
      filesOverHttp: r.fileOverPlainHttp,
      portalReachable: true,
    };
  }
  if (r.apiWithBrowserHeaders) {
    return {
      mode: 'hybrid',
      variant: 'C',
      summary: 'подпись из браузера переиспользуется обычным клиентом — гибрид',
      filesOverHttp: r.fileOverPlainHttp,
      portalReachable: true,
    };
  }
  return {
    mode: 'browser',
    variant: 'D',
    summary: r.fileOverPlainHttp
      ? 'API только через браузер, файлы качаются обычным HTTP'
      : 'всё через браузер',
    filesOverHttp: r.fileOverPlainHttp,
    portalReachable: true,
  };
}
