import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { PortalBrowser } from '../portal/browser.js';
import { httpGet, guessExtension, filenameFromDisposition } from '../portal/http.js';
import { fileRefsFromText, classifyDocKind, rowFromJson, rowsFromListResponse, type FileRef } from '../portal/extract.js';
import { upsertPurchase, upsertLot, upsertDocument, linkDocument, saveRawCapture } from '../db/repo.js';
import { sha256, storagePathFor } from '../util/hash.js';
import { claim, complete, fail, requeueStale, enqueue } from './queue.js';

/**
 * Сборщик: по номеру закупки открывает её карточку, забирает поля и
 * ссылки на файлы, качает файлы.
 *
 * Разделение труда: ссылку добывает браузер (в интерфейсе она висит на
 * javascript:;), а качает обычный HTTP-клиент — файловое хранилище
 * подписи не требует и позволяет качать параллельно.
 */
export async function fetchPurchase(db: Db, browser: PortalBrowser, purchaseNo: string): Promise<void> {
  browser.clearCaptures();
  await browser.gotoHash(`/ext(popup:item/${purchaseNo}/advert)`, { waitMs: 5_000 });

  const page = browser.page_();
  const html = await page.content();
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

  // Поля карточки — из перехваченного JSON, если он есть.
  let purchaseId: number | undefined;
  for (const c of browser.captures) {
    if (!c.isJson || !c.bodyPreview || c.status >= 400) continue;
    saveRawCapture(db, 'purchase', purchaseNo, c.bodyPreview, c.status);
    const parsed = safeJson(c.bodyPreview);
    const row = parsed && !Array.isArray(parsed) ? rowFromJson(parsed as Record<string, unknown>) : null;
    if (row && row.purchaseNo === purchaseNo) {
      const p = upsertPurchase(db, {
        externalNo: row.purchaseNo,
        title: row.title,
        customerName: row.customerName,
        method: row.method,
        status: row.status,
        publishedAt: row.publishedAt,
        bidsCloseAt: row.bidsCloseAt,
        totalAmountNoVat: row.amountNoVat,
        raw: row.raw,
      });
      purchaseId = p.id;
    }
    // Лоты часто приходят массивом внутри той же карточки.
    for (const lotRow of rowsFromListResponse(c.bodyPreview)) {
      if (!lotRow.lotNo) continue;
      const pid = purchaseId ?? ensurePurchase(db, purchaseNo);
      purchaseId = pid;
      upsertLot(db, pid, {
        externalNo: lotRow.lotNo,
        lineNo: lotRow.lineNo,
        title: lotRow.title,
        amountNoVat: lotRow.amountNoVat,
        place: lotRow.place,
        raw: lotRow.raw,
      });
    }
  }
  purchaseId ??= ensurePurchase(db, purchaseNo);

  // Ссылки на файлы: сначала из перехваченного трафика, затем из разметки.
  const refs = new Map<string, FileRef>();
  for (const c of browser.captures) {
    for (const r of fileRefsFromText(c.url + '\n' + c.bodyPreview, config.baseUrl)) refs.set(r.uuid, r);
  }
  for (const r of fileRefsFromText(html, config.baseUrl)) refs.set(r.uuid, r);
  for (const r of fileRefsFromText(bodyText, config.baseUrl)) refs.set(r.uuid, r);

  if (refs.size === 0) {
    log.warn('файлы не найдены в карточке', { закупка: purchaseNo });
  }

  db.prepare('update purchase set detail_fetched_at = ? where id = ?').run(new Date().toISOString(), purchaseId);

  await downloadAll(db, purchaseId, [...refs.values()]);
  log.info('карточка собрана', { закупка: purchaseNo, файлов: refs.size });
}

function ensurePurchase(db: Db, purchaseNo: string): number {
  return upsertPurchase(db, { externalNo: purchaseNo }).id;
}

/** Файлы качаются параллельно обычным HTTP — мимо браузера и его паузы. */
async function downloadAll(db: Db, purchaseId: number, refs: FileRef[]): Promise<void> {
  const queue = [...refs];
  const workers = Array.from({ length: Math.min(config.downloadConcurrency, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const ref = queue.shift();
      if (!ref) return;
      try {
        await downloadOne(db, purchaseId, ref);
      } catch (err) {
        log.warn('файл не скачался', { uuid: ref.uuid, error: String(err) });
      }
    }
  });
  await Promise.all(workers);
}

async function downloadOne(db: Db, purchaseId: number, ref: FileRef): Promise<void> {
  const res = await httpGet(ref.url, { timeoutMs: 120_000 });
  if (res.status !== 200 || res.body.byteLength === 0) {
    throw new Error(`статус ${res.status}, байт ${res.body.byteLength}`);
  }
  const digest = sha256(res.body);

  // Совпал хеш — тот же файл уже лежит и уже разобран. Типовая
  // документация повторяется из закупки в закупку, это прямая экономия.
  const filename = filenameFromDisposition(res.headers['content-disposition']) ?? ref.filename ?? null;
  const mime = res.headers['content-type']?.split(';')[0]?.trim() ?? null;
  const rel = storagePathFor(digest, guessExtension(filename, mime));
  const abs = resolve(config.storageDir, rel);

  const doc = upsertDocument(db, {
    sha256: digest,
    filename,
    mime,
    sizeBytes: res.body.byteLength,
    storagePath: rel,
  });
  if (doc.isNew) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.body);
  }
  linkDocument(db, {
    documentId: doc.id,
    purchaseId,
    docKind: classifyDocKind(filename),
    externalUuid: ref.uuid,
    sourceUrl: ref.url,
  });
  log.debug(doc.isNew ? 'файл сохранён' : 'файл уже был', { uuid: ref.uuid, bytes: res.body.byteLength });
}

/** Воркер очереди `purchase.detail`. */
export async function fetchLoop(db: Db, opts: { once?: boolean } = {}): Promise<void> {
  const requeued = requeueStale(db);
  if (requeued > 0) log.info('вернул зависшие задачи в очередь', { n: requeued });

  const browser = new PortalBrowser();
  const stop = { now: false };
  process.on('SIGINT', () => {
    stop.now = true;
  });
  try {
    while (!stop.now) {
      const job = claim(db, 'purchase.detail');
      if (!job) {
        if (opts.once) return;
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      const payload = JSON.parse(job.payload) as { purchaseNo: string };
      try {
        await fetchPurchase(db, browser, payload.purchaseNo);
        complete(db, job.id);
        // Место стыковки с обработчиком: дальше этап 2, текст и фрагменты.
        enqueue(db, 'analyze.pending', `analyze:${payload.purchaseNo}`, payload);
      } catch (err) {
        fail(db, job, err);
      }
      if (opts.once) return;
    }
  } finally {
    await browser.close();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
