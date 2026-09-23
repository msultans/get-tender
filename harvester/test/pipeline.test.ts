import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { rowsFromListResponse } from '../src/portal/extract.js';
import { upsertPurchase, upsertLot, saveRawCapture } from '../src/db/repo.js';
import { enqueue, claim } from '../src/pipeline/queue.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'gt-p-')), 'p.sqlite'));

/** Ответ портала, каким его ожидает увидеть дозор. */
const page = (rows: { no: string; lot: string; sum: number; close?: string }[]) =>
  JSON.stringify({
    content: rows.map((r) => ({
      purchaseNumber: r.no,
      lotNumber: r.lot,
      nameRu: `Лот ${r.lot}`,
      customerNameRu: 'АО «Кселл»',
      statusNameRu: 'Опубликовано',
      sumNoNds: r.sum,
      publishDate: '24.08.2026 10:00',
      endDate: r.close ?? '15.09.2026 11:00',
    })),
  });

/** Ровно то, что делает дозор: разобрать, записать, поставить задачу. */
function ingest(db: ReturnType<typeof fresh>, body: string): { fresh: number; changed: number; queued: number } {
  let f = 0;
  let c = 0;
  let q = 0;
  const tx = db.transaction(() => {
    saveRawCapture(db, 'list', 'test', body, 200);
    for (const row of rowsFromListResponse(body)) {
      const p = upsertPurchase(db, {
        externalNo: row.purchaseNo,
        title: row.title,
        status: row.status,
        totalAmountNoVat: row.amountNoVat,
        bidsCloseAt: row.bidsCloseAt,
        raw: row.raw,
      });
      if (row.lotNo) upsertLot(db, p.id, { externalNo: row.lotNo, amountNoVat: row.amountNoVat });
      if (p.isNew) f += 1;
      else if (p.changed) c += 1;
      if (p.isNew || p.changed) {
        if (enqueue(db, 'purchase.detail', `detail:${row.purchaseNo}:${p.isNew ? 'new' : 'changed'}`, { purchaseNo: row.purchaseNo })) q += 1;
      }
    }
  });
  tx();
  return { fresh: f, changed: c, queued: q };
}

test('первый проход дозора заводит лоты и ставит задачи', () => {
  const db = fresh();
  const r = ingest(db, page([{ no: '1247669', lot: '4514471', sum: 49_875_000 }, { no: '1245224', lot: '4507400', sum: 17_000_000 }]));
  assert.deepEqual(r, { fresh: 2, changed: 0, queued: 2 });
});

test('второй проход по той же странице не делает ничего — это главное свойство дозора', () => {
  const db = fresh();
  const body = page([{ no: '1247669', lot: '4514471', sum: 49_875_000 }]);
  ingest(db, body);
  const again = ingest(db, body);
  assert.deepEqual(again, { fresh: 0, changed: 0, queued: 0 }, 'иначе один тендер разберётся десять раз и десять раз будет оплачен');
  const jobs = db.prepare('select count(*) n from job').get() as { n: number };
  assert.equal(jobs.n, 1);
});

test('продление срока замечается и ставит отдельную задачу', () => {
  const db = fresh();
  ingest(db, page([{ no: '1247669', lot: '4514471', sum: 49_875_000, close: '15.09.2026 11:00' }]));
  const r = ingest(db, page([{ no: '1247669', lot: '4514471', sum: 49_875_000, close: '25.09.2026 11:00' }]));
  assert.equal(r.changed, 1);
  assert.equal(r.queued, 1);
  const row = db.prepare('select bids_close_at from purchase').get() as { bids_close_at: string };
  assert.match(row.bids_close_at, /2026-09-25/);
});

test('новый лот среди уже знакомых ловится, знакомые не трогаются', () => {
  const db = fresh();
  ingest(db, page([{ no: '1247669', lot: '4514471', sum: 49_875_000 }]));
  const r = ingest(db, page([
    { no: '1300000', lot: '4600000', sum: 5_000_000 },
    { no: '1247669', lot: '4514471', sum: 49_875_000 },
  ]));
  assert.deepEqual(r, { fresh: 1, changed: 0, queued: 1 });
});

test('задача доходит до сборщика с номером закупки', () => {
  const db = fresh();
  ingest(db, page([{ no: '1247669', lot: '4514471', sum: 49_875_000 }]));
  const job = claim(db, 'purchase.detail');
  assert.ok(job);
  assert.equal((JSON.parse(job.payload) as { purchaseNo: string }).purchaseNo, '1247669');
});

test('сырой ответ сохраняется до разбора — по нему можно перегнать парсер', () => {
  const db = fresh();
  const body = page([{ no: '1247669', lot: '4514471', sum: 49_875_000 }]);
  ingest(db, body);
  const raw = db.prepare('select payload, http_status from raw_capture').get() as { payload: string; http_status: number };
  assert.equal(raw.payload, body);
  assert.equal(raw.http_status, 200);
});

test('пустой ответ портала ничего не ломает и ничего не пишет', () => {
  const db = fresh();
  const r = ingest(db, JSON.stringify({ content: [] }));
  assert.deepEqual(r, { fresh: 0, changed: 0, queued: 0 });
});
