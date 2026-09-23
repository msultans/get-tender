import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { enqueue, claim, complete, fail, requeueStale, queueStats } from '../src/pipeline/queue.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'gt-q-')), 'q.sqlite'));

test('та же задача, поставленная дважды, не удваивается', () => {
  const db = fresh();
  assert.equal(enqueue(db, 'purchase.detail', 'detail:1247669:new', { n: 1 }), true);
  assert.equal(enqueue(db, 'purchase.detail', 'detail:1247669:new', { n: 1 }), false);
  const n = db.prepare('select count(*) n from job').get() as { n: number };
  assert.equal(n.n, 1);
});

test('задача берётся один раз — второй воркер её уже не увидит', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', {});
  const a = claim(db, 'q');
  const b = claim(db, 'q');
  assert.ok(a);
  assert.equal(b, undefined);
  assert.equal(a.attempts, 1);
});

test('задачи чужой очереди не берутся', () => {
  const db = fresh();
  enqueue(db, 'other', 'k1', {});
  assert.equal(claim(db, 'q'), undefined);
});

test('после провала задача возвращается с отложенным запуском', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', {}, { maxAttempts: 3 });
  const job = claim(db, 'q')!;
  fail(db, job, new Error('портал не ответил'));

  const row = db.prepare('select status, next_attempt_at, last_error from job').get() as
    { status: string; next_attempt_at: string; last_error: string };
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /портал не ответил/);
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), 'запуск отложен в будущее');
  assert.equal(claim(db, 'q'), undefined, 'до срока задача не берётся');
});

test('исчерпав попытки, задача падает в failed и остаётся видимой', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', {}, { maxAttempts: 2 });
  fail(db, claim(db, 'q')!, new Error('раз'));
  db.prepare(`update job set next_attempt_at = '2000-01-01T00:00:00Z'`).run();
  fail(db, claim(db, 'q')!, new Error('два'));

  const row = db.prepare('select status, attempts from job').get() as { status: string; attempts: number };
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.equal(claim(db, 'q'), undefined);
});

test('выполненная задача закрывается и не берётся снова', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', {});
  const job = claim(db, 'q')!;
  complete(db, job.id);
  const row = db.prepare('select status, finished_at from job').get() as
    { status: string; finished_at: string };
  assert.equal(row.status, 'done');
  assert.ok(row.finished_at);
  assert.equal(claim(db, 'q'), undefined);
});

test('зависшие в running после падения процесса возвращаются в очередь', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', {});
  claim(db, 'q');
  assert.equal(requeueStale(db, 0), 1);
  assert.ok(claim(db, 'q'), 'задача снова доступна');
});

test('отложенная задача не берётся раньше срока', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', {}, { delayMs: 60_000 });
  assert.equal(claim(db, 'q'), undefined);
});

test('статистика считает по очередям и статусам', () => {
  const db = fresh();
  enqueue(db, 'a', 'k1', {});
  enqueue(db, 'a', 'k2', {});
  enqueue(db, 'b', 'k3', {});
  complete(db, claim(db, 'a')!.id);
  const stats = queueStats(db);
  assert.deepEqual(
    stats.map((s) => `${s.queue}/${s.status}=${s.n}`).sort(),
    ['a/done=1', 'a/pending=1', 'b/pending=1'],
  );
});

test('полезная нагрузка доходит до воркера без потерь', () => {
  const db = fresh();
  enqueue(db, 'q', 'k1', { purchaseNo: '1247669', сумма: 49875000 });
  const job = claim(db, 'q')!;
  assert.deepEqual(JSON.parse(job.payload), { purchaseNo: '1247669', сумма: 49875000 });
});
