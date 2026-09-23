import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { httpGet } from './http.js';
import { PortalBrowser } from './browser.js';
import { rankListCandidates, unusualHeaders, decideMode, inspectJsonShape, type Verdict } from './discover.js';
import { redactHeaders, redactText } from '../util/redact.js';
import { sha256 } from '../util/hash.js';

/**
 * Файл, проиндексированный поисковиками. Если он качается голым curl —
 * значит файловое хранилище открыто и подписи не требует.
 */
const KNOWN_PUBLIC_FILE =
  process.env.PROBE_FILE_URL ??
  `${config.baseUrl}/eprocfilestorage/open-api/files/download/fdd4e90d-1847-4df1-91a0-ee77371c7ccc-2021-mdb`;

export interface ProbeReport {
  startedAt: string;
  baseUrl: string;
  experiments: Record<string, unknown>;
  verdict: Verdict;
  nextSteps: string[];
}

export async function runProbe(outDir = 'probe-dump'): Promise<ProbeReport> {
  mkdirSync(outDir, { recursive: true });
  const experiments: Record<string, unknown> = {};

  // ── Опыт 1. Качается ли файл без браузера ──────────────────────────────
  log.info('опыт 1: скачивание файла обычным HTTP, без браузера');
  let fileOverPlainHttp = false;
  try {
    const res = await httpGet(KNOWN_PUBLIC_FILE, { timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024 });
    const head = res.body.subarray(0, 5).toString('latin1');
    fileOverPlainHttp = res.status === 200 && res.body.byteLength > 1000 && !head.startsWith('<');
    experiments.file_over_plain_http = {
      url: KNOWN_PUBLIC_FILE,
      status: res.status,
      bytes: res.body.byteLength,
      contentType: res.headers['content-type'] ?? null,
      looksLikeRealFile: fileOverPlainHttp,
      magic: head,
    };
    log.info(fileOverPlainHttp ? '  файл скачался' : '  файл не скачался', {
      status: res.status,
      bytes: res.body.byteLength,
    });
  } catch (err) {
    experiments.file_over_plain_http = { url: KNOWN_PUBLIC_FILE, error: String(err) };
    log.warn('  опыт 1 не удался', { error: String(err) });
  }

  // ── Опыт 0 и 2. Открываем портал и записываем весь трафик ──────────────
  const browser = new PortalBrowser();
  let apiWithoutHeaders = false;
  let apiWithBrowserHeaders = false;

  try {
    log.info('опыт 0: главная страница, ищу раздел для разработчиков');
    const page = await browser.goto(config.baseUrl, { waitMs: 3_000 });
    const devLinks = await page
      .$$eval('a', (as) =>
        as
          .map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 80), href: a.getAttribute('href') ?? '' }))
          .filter((l) =>
            /api|разработчик|developer|открыт[ыа]|open.?data|интеграц|документац/i.test(`${l.text} ${l.href}`),
          )
          .slice(0, 40),
      )
      .catch(() => []);
    experiments.developer_links = devLinks;
    log.info(`  найдено ссылок-кандидатов: ${devLinks.length}`);

    log.info('опыт 2: открываю список лотов и записываю XHR');
    browser.clearCaptures();
    const listUrl = process.env.PROBE_LIST_URL ?? `${config.baseUrl}/#/ext/lots`;
    await browser.goto(listUrl, { waitMs: 6_000 });

    const captures = browser.captures;
    log.info(`  записано XHR-ответов: ${captures.length}`);

    // Сырьё — на диск: по нему потом достраивается разбор полей.
    for (const [i, c] of captures.entries()) {
      if (!c.bodyPreview) continue;
      writeFileSync(
        resolve(outDir, `xhr-${String(i).padStart(3, '0')}-${sha256(c.url).slice(0, 8)}.json`),
        JSON.stringify(
          { url: c.url, method: c.method, status: c.status, headers: redactHeaders(c.responseHeaders), body: c.bodyPreview },
          null,
          2,
        ),
      );
    }

    const candidates = rankListCandidates(captures);
    experiments.xhr_seen = captures.map((c) => ({
      url: c.url,
      method: c.method,
      status: c.status,
      isJson: c.isJson,
      bytes: c.bodyBytes,
    }));
    experiments.list_candidates = candidates.slice(0, 5);

    const best = candidates[0];
    if (!best) {
      log.warn('  запрос, похожий на список, не найден — возможно, страница рисуется на сервере');
      experiments.list_request = null;
    } else {
      log.info('  похоже на список', { url: best.url, score: best.score, rows: best.rowsGuess });
      const headers = browser.lastApiRequestHeaders(new RegExp(escapeRe(best.url.split('?')[0] ?? best.url)));
      const extra = headers ? unusualHeaders(headers) : [];
      experiments.list_request = {
        url: best.url,
        score: best.score,
        reasons: best.reasons,
        unusualRequestHeaders: extra,
        shape: inspectJsonShape(captures.find((c) => c.url === best.url)?.bodyPreview ?? ''),
      };
      log.info(`  нестандартных заголовков в запросе: ${extra.length}`, {
        names: extra.map((e) => e.name).join(',') || '—',
      });

      // 2b. Тот же запрос голым клиентом, без заголовков.
      try {
        const bare = await httpGet(best.url, { timeoutMs: 20_000 });
        apiWithoutHeaders = bare.status === 200 && bare.body.byteLength > 50;
        experiments.api_without_headers = { status: bare.status, bytes: bare.body.byteLength };
        log.info(`  без заголовков: ${bare.status}`);
      } catch (err) {
        experiments.api_without_headers = { error: String(err) };
      }

      // 2a. Тот же запрос с заголовками, снятыми с живого браузера.
      if (headers) {
        try {
          const cookie = await browser.cookieHeader();
          const replay: Record<string, string> = { ...headers };
          if (cookie) replay.cookie = cookie;
          delete replay['content-length'];
          const withHeaders = await httpGet(best.url, { headers: replay, timeoutMs: 20_000 });
          apiWithBrowserHeaders = withHeaders.status === 200 && withHeaders.body.byteLength > 50;
          experiments.api_with_browser_headers = {
            status: withHeaders.status,
            bytes: withHeaders.body.byteLength,
            headersSent: redactHeaders(replay),
          };
          log.info(`  с заголовками браузера: ${withHeaders.status}`);
        } catch (err) {
          experiments.api_with_browser_headers = { error: String(err) };
        }
      }
    }

    // ── Опыт 3. Откуда берётся подпись ───────────────────────────────────
    log.info('опыт 3: ищу в бандле, где формируется нестандартный заголовок');
    const scriptHits = await findSignatureInBundles(browser, experiments);
    experiments.signature_in_bundle = scriptHits;
    log.info(`  совпадений в скриптах: ${scriptHits.length}`);
  } catch (err) {
    experiments.browser_error = String(err);
    log.error('браузерная часть проверки не прошла', { error: String(err) });
  } finally {
    await browser.close();
  }

  const verdict = decideMode({ fileOverPlainHttp, apiWithoutHeaders, apiWithBrowserHeaders });

  const report: ProbeReport = {
    startedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    experiments,
    verdict,
    nextSteps: nextSteps(verdict, experiments),
  };
  writeFileSync('probe-report.json', redactText(JSON.stringify(report, null, 2)));
  return report;
}

async function findSignatureInBundles(
  browser: PortalBrowser,
  experiments: Record<string, unknown>,
): Promise<{ file: string; snippet: string }[]> {
  const listReq = experiments.list_request as { unusualRequestHeaders?: { name: string }[] } | null | undefined;
  const names = (listReq?.unusualRequestHeaders ?? []).map((h) => h.name).filter((n) => n.length >= 2);
  if (names.length === 0) return [];
  try {
    const page = browser.page_();
    return await page.evaluate(async (headerNames: string[]) => {
      const out: { file: string; snippet: string }[] = [];
      const srcs = Array.from(document.querySelectorAll('script[src]'))
        .map((s) => (s as HTMLScriptElement).src)
        .slice(0, 25);
      for (const src of srcs) {
        try {
          const text = await (await fetch(src)).text();
          for (const name of headerNames) {
            const idx = text.indexOf(`"${name}"`) >= 0 ? text.indexOf(`"${name}"`) : text.indexOf(`'${name}'`);
            if (idx >= 0) {
              out.push({ file: src, snippet: text.slice(Math.max(0, idx - 200), idx + 300) });
              break;
            }
          }
        } catch {
          /* скрипт мог не отдаться — пропускаем */
        }
      }
      return out;
    }, names);
  } catch {
    return [];
  }
}

function nextSteps(v: Verdict, experiments: Record<string, unknown>): string[] {
  const steps: string[] = [];
  if (v.mode === 'http') {
    steps.push('API отвечает без подписи. Браузер можно убрать совсем — это самый дешёвый исход.');
  } else if (v.mode === 'hybrid') {
    steps.push('Гибрид подтверждён: браузер держит сессию, обычный клиент делает запросы.');
    steps.push('Замерь, через сколько минут подпись перестаёт работать — это частота её обновления.');
  } else {
    steps.push('Запросы к API идут только через браузер. Это рабочий вариант, просто медленнее.');
  }
  if (v.filesOverHttp) steps.push('Файлы качаются обычным HTTP — скачивание можно параллелить мимо браузера.');
  else steps.push('Файл голым HTTP не скачался: проверь PROBE_FILE_URL, ссылка могла устареть.');

  if (!experiments.list_request) {
    steps.push(
      'Запрос списка не опознан. Загляни в probe-dump/: там лежат все ответы XHR. ' +
        'Пришли этот каталог — по нему достроится разбор полей в src/portal/extract.ts.',
    );
  } else {
    steps.push('Пришли probe-report.json и probe-dump/ — по ним достроится разбор полей.');
  }
  return steps;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
