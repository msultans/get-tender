import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import {
  upsertPurchase, upsertLot, upsertDocument, linkDocument,
  purchaseFingerprint, knownPurchaseNos, getKv, setKv,
} from '../src/db/repo.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'gt-')), 'test.sqlite'));

test('повторная запись той же закупки не создаёт вторую и не считается новой', () => {
  const db = fresh();
  const input = { externalNo: '1247669', title: 'Авиа', totalAmountNoVat: 49_875_000 };

  const first = upsertPurchase(db, input);
  assert.equal(first.isNew, true);

  const second = upsertPurchase(db, input);
  assert.equal(second.isNew, false);
  assert.equal(second.changed, false, 'ничего не поменялось — значит задача ставиться не должна');
  assert.equal(second.id, first.id);

  const n = db.prepare('select count(*) n from purchase').get() as { n: number };
  assert.equal(n.n, 1);
});

test('изменение суммы или срока поднимает флаг changed', () => {
  const db = fresh();
  upsertPurchase(db, { externalNo: '1247669', totalAmountNoVat: 49_875_000 });
  const again = upsertPurchase(db, { externalNo: '1247669', totalAmountNoVat: 52_000_000 });
  assert.equal(again.changed, true);

  const later = upsertPurchase(db, { externalNo: '1247669', totalAmountNoVat: 52_000_000, bidsCloseAt: '2026-09-20T11:00:00' });
  assert.equal(later.changed, true, 'продление срока — событие');
});

test('отпечаток не зависит от порядка полей и от сырого ответа', () => {
  const a = purchaseFingerprint({ externalNo: '1', title: 'X', status: 'published', raw: { nonce: 1 } });
  const b = purchaseFingerprint({ status: 'published', externalNo: '1', title: 'X', raw: { nonce: 999 } });
  assert.equal(a, b, 'служебные метки в сыром ответе не должны делать лот изменившимся');
});

test('частичное обновление не затирает уже известные поля', () => {
  const db = fresh();
  upsertPurchase(db, { externalNo: '1247669', title: 'Авиа', customerName: 'АО «Кселл»' });
  upsertPurchase(db, { externalNo: '1247669', status: 'published' });
  const row = db.prepare('select title, customer_name, status from purchase').get() as
    { title: string; customer_name: string; status: string };
  assert.equal(row.title, 'Авиа');
  assert.equal(row.customer_name, 'АО «Кселл»');
  assert.equal(row.status, 'published');
});

test('лоты уникальны внутри закупки', () => {
  const db = fresh();
  const p = upsertPurchase(db, { externalNo: '1247669' });
  assert.equal(upsertLot(db, p.id, { externalNo: '4514471', amountNoVat: 49_875_000 }).isNew, true);
  assert.equal(upsertLot(db, p.id, { externalNo: '4514471', amountNoVat: 49_875_000 }).isNew, false);
  const n = db.prepare('select count(*) n from lot').get() as { n: number };
  assert.equal(n.n, 1);
});

test('один файл на хеш, привязок сколько угодно — это и есть дедупликация', () => {
  const db = fresh();
  const p1 = upsertPurchase(db, { externalNo: '1247669' });
  const p2 = upsertPurchase(db, { externalNo: '1245224' });
  const doc = { sha256: 'a'.repeat(64), sizeBytes: 100, storagePath: 'aa/aa/x.pdf', filename: 'ТД.pdf' };

  const first = upsertDocument(db, doc);
  assert.equal(first.isNew, true);
  const second = upsertDocument(db, doc);
  assert.equal(second.isNew, false, 'тот же файл не качается и не разбирается второй раз');
  assert.equal(second.id, first.id);

  linkDocument(db, { documentId: first.id, purchaseId: p1.id });
  linkDocument(db, { documentId: first.id, purchaseId: p2.id });
  linkDocument(db, { documentId: first.id, purchaseId: p2.id });

  const docs = db.prepare('select count(*) n from document').get() as { n: number };
  const links = db.prepare('select count(*) n from document_link').get() as { n: number };
  assert.equal(docs.n, 1);
  assert.equal(links.n, 2, 'повторная привязка к той же закупке не дублируется');
});

test('привязка к закупке и к лоту различаются, хотя lot_id бывает null', () => {
  const db = fresh();
  const p = upsertPurchase(db, { externalNo: '1247669' });
  const l = upsertLot(db, p.id, { externalNo: '4514471' });
  const doc = upsertDocument(db, { sha256: 'b'.repeat(64), sizeBytes: 10, storagePath: 'bb/bb/y.pdf' });
  linkDocument(db, { documentId: doc.id, purchaseId: p.id, lotId: null });
  linkDocument(db, { documentId: doc.id, purchaseId: p.id, lotId: l.id });
  linkDocument(db, { documentId: doc.id, purchaseId: p.id, lotId: null });
  const links = db.prepare('select count(*) n from document_link').get() as { n: number };
  assert.equal(links.n, 2);
});

test('знакомые номера определяются одним запросом', () => {
  const db = fresh();
  upsertPurchase(db, { externalNo: '1247669' });
  upsertPurchase(db, { externalNo: '1245224' });
  const known = knownPurchaseNos(db, ['1247669', '9999999', '1245224']);
  assert.deepEqual([...known].sort(), ['1245224', '1247669']);
  assert.equal(knownPurchaseNos(db, []).size, 0);
});

test('kv переживает перезапись', () => {
  const db = fresh();
  assert.equal(getKv(db, 'portal.mode'), undefined);
  setKv(db, 'portal.mode', 'hybrid');
  setKv(db, 'portal.mode', 'browser');
  assert.equal(getKv(db, 'portal.mode'), 'browser');
});
