import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { PortalBrowser } from '../portal/browser.js';
import { rankListCandidates } from '../portal/discover.js';
import { rowsFromListResponse, type ListRow } from '../portal/extract.js';
import { upsertPurchase, upsertLot, saveRawCapture, getKv, setKv } from '../db/repo.js';
import { enqueue } from './queue.js';

/** Считается при каждом обходе, а не при загрузке модуля: иначе демо и
 *  тесты не могут подменить адрес портала. */
const listUrl = (): string => process.env.PORTAL_LIST_URL ?? `${config.baseUrl}/#/ext/lots`;

/**
 * Дозор: раз в минуту открывает первую страницу списка, отсортированного
 * по дате публикации, и сверяет верхние строки с базой.
 *
 * Всё знакомо — выхода из цикла не происходит, просто ничего не делается.
 * Появилась незнакомая строка — ставится задача собрать закупку.
 */
export async function watchOnce(db: Db, browser: PortalBrowser): Promise<{ seen: number; fresh: number; changed: number }> {
  browser.clearCaptures();
  await browser.goto(listUrl(), { waitMs: 5_000 });

  const rows = await readRows(browser, db);
  if (rows.length === 0) {
    throw new Error(
      'дозор не увидел ни одной строки списка. Запусти `npm run probe` — он покажет, ' +
        'какие запросы уходят и что в них приходит, и по этому правится src/portal/extract.ts',
    );
  }

  let fresh = 0;
  let changed = 0;
  const apply = db.transaction((list: ListRow[]) => {
    for (const row of list) {
      const p = upsertPurchase(db, {
        externalNo: row.purchaseNo,
        title: row.title,
        customerName: row.customerName,
        method: row.method,
        status: row.status,
        publishedAt: row.publishedAt,
        bidsCloseAt: row.bidsCloseAt,
        totalAmountNoVat: row.amountNoVat,
        url: `${config.baseUrl}/#/ext(popup:item/${row.purchaseNo}/advert)`,
        raw: row.raw,
      });
      if (row.lotNo) {
        upsertLot(db, p.id, {
          externalNo: row.lotNo,
          lineNo: row.lineNo,
          title: row.title,
          amountNoVat: row.amountNoVat,
          place: row.place,
          raw: row.raw,
        });
      }
      if (p.isNew) fresh += 1;
      else if (p.changed) changed += 1;

      // Задача и запись — одной транзакцией: процесс, умерший между ними,
      // оставил бы либо закупку без задачи, либо задачу без закупки.
      if (p.isNew || p.changed) {
        enqueue(db, 'purchase.detail', `detail:${row.purchaseNo}:${p.isNew ? 'new' : 'changed'}`, {
          purchaseId: p.id,
          purchaseNo: row.purchaseNo,
        });
      }
    }
  });
  apply(rows);

  setKv(db, 'watch.last_ok_at', new Date().toISOString());
  log.info('дозор', { строк: rows.length, новых: fresh, изменилось: changed });
  return { seen: rows.length, fresh, changed };
}

/**
 * Строки берутся из перехваченного JSON, а не из вёрстки: портал — SPA и
 * сам ходит в своё API, а разбор разметки ломался бы от любой её правки.
 */
async function readRows(browser: PortalBrowser, db: Db): Promise<ListRow[]> {
  const remembered = getKv(db, 'portal.list_url_pattern');
  const captures = browser.captures;

  const ordered = remembered
    ? [...captures].sort((a, b) => Number(b.url.includes(remembered)) - Number(a.url.includes(remembered)))
    : captures;

  const candidates = rankListCandidates(ordered);
  for (const cand of candidates) {
    const capture = captures.find((c) => c.url === cand.url);
    if (!capture?.bodyPreview) continue;
    const rows = rowsFromListResponse(capture.bodyPreview);
    if (rows.length > 0) {
      saveRawCapture(db, 'list', cand.url, capture.bodyPreview, capture.status);
      const pattern = (cand.url.split('?')[0] ?? cand.url).split('/').slice(-2).join('/');
      setKv(db, 'portal.list_url_pattern', pattern);
      return rows.slice(0, config.watchRows);
    }
  }
  return [];
}

export async function watchLoop(db: Db): Promise<void> {
  const browser = new PortalBrowser();
  let consecutiveErrors = 0;
  const stop = { now: false };
  process.on('SIGINT', () => {
    log.info('останавливаюсь');
    stop.now = true;
  });

  try {
    while (!stop.now) {
      const started = Date.now();
      try {
        await watchOnce(db, browser);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        log.error('обход не удался', { подряд: consecutiveErrors, error: String(err) });
        if (consecutiveErrors >= config.breakerThreshold) {
          log.error('слишком много ошибок подряд — пауза 10 минут');
          await sleep(10 * 60_000);
          consecutiveErrors = 0;
        }
      }
      const rest = config.watchIntervalMs - (Date.now() - started);
      if (rest > 0) await sleep(rest);
    }
  } finally {
    await browser.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
