import type { Db } from '../db/index.js';
import { now } from '../db/index.js';
import { log } from '../util/log.js';

export interface Job {
  id: number;
  queue: string;
  key: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Постановка задачи. `key` несёт идемпотентность: та же задача,
 * поставленная второй раз, не создаёт вторую запись.
 *
 * Возвращает true, если задача действительно добавлена.
 */
export function enqueue(
  db: Db,
  queue: string,
  key: string,
  payload: unknown,
  opts: { maxAttempts?: number; delayMs?: number } = {},
): boolean {
  const at = new Date(Date.now() + (opts.delayMs ?? 0)).toISOString();
  const info = db
    .prepare(
      `insert or ignore into job (queue, key, payload, max_attempts, next_attempt_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(queue, key, JSON.stringify(payload), opts.maxAttempts ?? 5, at, now());
  return info.changes > 0;
}

/** Берёт одну готовую задачу и сразу помечает её выполняющейся. */
export function claim(db: Db, queue: string): Job | undefined {
  const row = db
    .prepare(
      `update job set status = 'running', attempts = attempts + 1
       where id = (
         select id from job
         where queue = ? and status = 'pending' and next_attempt_at <= ?
         order by id limit 1
       )
       returning id, queue, key, payload, attempts, max_attempts`,
    )
    .get(queue, now()) as Job | undefined;
  return row;
}

export function complete(db: Db, id: number): void {
  db.prepare(`update job set status = 'done', finished_at = ?, last_error = null where id = ?`).run(now(), id);
}

/**
 * Ретрай с растущей задержкой. Исчерпали попытки — задача падает в
 * failed и остаётся видимой: молча потерянная задача хуже упавшей.
 */
export function fail(db: Db, job: Job, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts >= job.max_attempts) {
    db.prepare(`update job set status = 'failed', finished_at = ?, last_error = ? where id = ?`).run(
      now(),
      message,
      job.id,
    );
    log.error('задача исчерпала попытки', { queue: job.queue, key: job.key, error: message });
    return;
  }
  const backoffMs = Math.min(30 * 60_000, 2 ** job.attempts * 5_000);
  const jitter = Math.floor(Math.random() * 1_000);
  db.prepare(`update job set status = 'pending', next_attempt_at = ?, last_error = ? where id = ?`).run(
    new Date(Date.now() + backoffMs + jitter).toISOString(),
    message,
    job.id,
  );
  log.warn('задача отложена', {
    queue: job.queue,
    key: job.key,
    attempt: job.attempts,
    retryInSec: Math.round(backoffMs / 1000),
    error: message,
  });
}

/** Задачи, зависшие в running после падения процесса, возвращаются в очередь. */
export function requeueStale(db: Db, olderThanMs = 15 * 60_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db
    .prepare(`update job set status = 'pending' where status = 'running' and created_at <= ?`)
    .run(cutoff);
  return info.changes;
}

export function queueStats(db: Db): { queue: string; status: string; n: number }[] {
  return db
    .prepare(`select queue, status, count(*) as n from job group by queue, status order by queue, status`)
    .all() as { queue: string; status: string; n: number }[];
}
