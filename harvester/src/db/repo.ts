import type { Db } from './index.js';
import { now } from './index.js';
import { contentHash, sha256 } from '../util/hash.js';

export interface PurchaseInput {
  externalNo: string;
  title?: string | null;
  customerName?: string | null;
  method?: string | null;
  status?: string | null;
  publishedAt?: string | null;
  bidsOpenAt?: string | null;
  bidsCloseAt?: string | null;
  totalAmountNoVat?: number | null;
  url?: string | null;
  raw?: unknown;
}

export interface LotInput {
  externalNo: string;
  lineNo?: string | null;
  title?: string | null;
  amountNoVat?: number | null;
  place?: string | null;
  deliveryTerm?: string | null;
  paymentTerms?: string | null;
  raw?: unknown;
}

export interface UpsertResult {
  id: number;
  isNew: boolean;
  changed: boolean;
}

/**
 * Отпечаток закупки: только поля, изменение которых для нас событие.
 * Сырой ответ сюда не входит — в нём меняются служебные метки.
 */
export function purchaseFingerprint(p: PurchaseInput): string {
  return contentHash({
    title: p.title ?? null,
    status: p.status ?? null,
    method: p.method ?? null,
    bidsOpenAt: p.bidsOpenAt ?? null,
    bidsCloseAt: p.bidsCloseAt ?? null,
    totalAmountNoVat: p.totalAmountNoVat ?? null,
  });
}

export function lotFingerprint(l: LotInput): string {
  return contentHash({
    title: l.title ?? null,
    amountNoVat: l.amountNoVat ?? null,
    place: l.place ?? null,
    deliveryTerm: l.deliveryTerm ?? null,
    paymentTerms: l.paymentTerms ?? null,
  });
}

/**
 * Идемпотентная запись закупки.
 *
 * Тот же тендер мы увидим ещё много раз — дозор смотрит верхние строки
 * списка, и завтра там могут быть те же номера. Повтор обязан быть
 * безвредным: обновляем last_seen_at и отвечаем, изменилось ли что-то
 * по существу.
 */
export function upsertPurchase(db: Db, p: PurchaseInput): UpsertResult {
  const ts = now();
  const fp = purchaseFingerprint(p);
  const existing = db
    .prepare('select id, content_hash from purchase where platform = ? and external_no = ?')
    .get('zakup.sk.kz', p.externalNo) as { id: number; content_hash: string | null } | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `insert into purchase (platform, external_no, title, customer_name, method, status,
            published_at, bids_open_at, bids_close_at, total_amount_no_vat, url, raw,
            content_hash, first_seen_at, last_seen_at)
         values (@platform, @externalNo, @title, @customerName, @method, @status,
            @publishedAt, @bidsOpenAt, @bidsCloseAt, @totalAmountNoVat, @url, @raw,
            @contentHash, @ts, @ts)`,
      )
      .run({
        platform: 'zakup.sk.kz',
        externalNo: p.externalNo,
        title: p.title ?? null,
        customerName: p.customerName ?? null,
        method: p.method ?? null,
        status: p.status ?? null,
        publishedAt: p.publishedAt ?? null,
        bidsOpenAt: p.bidsOpenAt ?? null,
        bidsCloseAt: p.bidsCloseAt ?? null,
        totalAmountNoVat: p.totalAmountNoVat ?? null,
        url: p.url ?? null,
        raw: p.raw === undefined ? null : JSON.stringify(p.raw),
        contentHash: fp,
        ts,
      });
    return { id: Number(info.lastInsertRowid), isNew: true, changed: true };
  }

  const changed = existing.content_hash !== fp;
  db.prepare(
    `update purchase set
       title = coalesce(@title, title),
       customer_name = coalesce(@customerName, customer_name),
       method = coalesce(@method, method),
       status = coalesce(@status, status),
       published_at = coalesce(@publishedAt, published_at),
       bids_open_at = coalesce(@bidsOpenAt, bids_open_at),
       bids_close_at = coalesce(@bidsCloseAt, bids_close_at),
       total_amount_no_vat = coalesce(@totalAmountNoVat, total_amount_no_vat),
       url = coalesce(@url, url),
       raw = coalesce(@raw, raw),
       content_hash = @contentHash,
       last_seen_at = @ts
     where id = @id`,
  ).run({
    id: existing.id,
    title: p.title ?? null,
    customerName: p.customerName ?? null,
    method: p.method ?? null,
    status: p.status ?? null,
    publishedAt: p.publishedAt ?? null,
    bidsOpenAt: p.bidsOpenAt ?? null,
    bidsCloseAt: p.bidsCloseAt ?? null,
    totalAmountNoVat: p.totalAmountNoVat ?? null,
    url: p.url ?? null,
    raw: p.raw === undefined ? null : JSON.stringify(p.raw),
    contentHash: fp,
    ts,
  });
  return { id: existing.id, isNew: false, changed };
}

export function upsertLot(db: Db, purchaseId: number, l: LotInput): UpsertResult {
  const ts = now();
  const fp = lotFingerprint(l);
  const existing = db
    .prepare('select id, content_hash from lot where purchase_id = ? and external_no = ?')
    .get(purchaseId, l.externalNo) as { id: number; content_hash: string | null } | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `insert into lot (purchase_id, external_no, line_no, title, amount_no_vat, place,
             delivery_term, payment_terms, raw, content_hash, first_seen_at, last_seen_at)
         values (@purchaseId, @externalNo, @lineNo, @title, @amountNoVat, @place,
             @deliveryTerm, @paymentTerms, @raw, @contentHash, @ts, @ts)`,
      )
      .run({
        purchaseId,
        externalNo: l.externalNo,
        lineNo: l.lineNo ?? null,
        title: l.title ?? null,
        amountNoVat: l.amountNoVat ?? null,
        place: l.place ?? null,
        deliveryTerm: l.deliveryTerm ?? null,
        paymentTerms: l.paymentTerms ?? null,
        raw: l.raw === undefined ? null : JSON.stringify(l.raw),
        contentHash: fp,
        ts,
      });
    return { id: Number(info.lastInsertRowid), isNew: true, changed: true };
  }

  const changed = existing.content_hash !== fp;
  db.prepare(
    `update lot set
       line_no = coalesce(@lineNo, line_no),
       title = coalesce(@title, title),
       amount_no_vat = coalesce(@amountNoVat, amount_no_vat),
       place = coalesce(@place, place),
       delivery_term = coalesce(@deliveryTerm, delivery_term),
       payment_terms = coalesce(@paymentTerms, payment_terms),
       raw = coalesce(@raw, raw),
       content_hash = @contentHash,
       last_seen_at = @ts
     where id = @id`,
  ).run({
    id: existing.id,
    lineNo: l.lineNo ?? null,
    title: l.title ?? null,
    amountNoVat: l.amountNoVat ?? null,
    place: l.place ?? null,
    deliveryTerm: l.deliveryTerm ?? null,
    paymentTerms: l.paymentTerms ?? null,
    raw: l.raw === undefined ? null : JSON.stringify(l.raw),
    contentHash: fp,
    ts,
  });
  return { id: existing.id, isNew: false, changed };
}

export function saveRawCapture(
  db: Db,
  kind: string,
  externalKey: string | null,
  payload: string,
  httpStatus?: number,
): void {
  db.prepare(
    `insert into raw_capture (kind, external_key, fetched_at, http_status, payload, payload_sha)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(kind, externalKey, now(), httpStatus ?? null, payload, sha256(payload));
}

/**
 * Файл кладётся один раз на хеш. Совпадение sha256 означает, что тот же
 * файл уже лежит и уже разобран — типовая документация повторяется из
 * закупки в закупку, и это прямая экономия.
 */
export function upsertDocument(
  db: Db,
  d: { sha256: string; filename?: string | null; mime?: string | null; sizeBytes: number; storagePath: string },
): { id: number; isNew: boolean } {
  const existing = db.prepare('select id from document where sha256 = ?').get(d.sha256) as
    | { id: number }
    | undefined;
  if (existing) return { id: existing.id, isNew: false };
  const info = db
    .prepare(
      `insert into document (sha256, filename, mime, size_bytes, storage_path, downloaded_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(d.sha256, d.filename ?? null, d.mime ?? null, d.sizeBytes, d.storagePath, now());
  return { id: Number(info.lastInsertRowid), isNew: true };
}

export function linkDocument(
  db: Db,
  link: {
    documentId: number;
    purchaseId: number;
    lotId?: number | null;
    docKind?: string | null;
    externalUuid?: string | null;
    sourceUrl?: string | null;
  },
): void {
  db.prepare(
    `insert or ignore into document_link
       (document_id, purchase_id, lot_id, doc_kind, external_uuid, source_url, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    link.documentId,
    link.purchaseId,
    link.lotId ?? null,
    link.docKind ?? null,
    link.externalUuid ?? null,
    link.sourceUrl ?? null,
    now(),
  );
}

export function getKv(db: Db, key: string): string | undefined {
  const row = db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(db: Db, key: string, value: string): void {
  db.prepare(
    `insert into kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

export function knownPurchaseNos(db: Db, nos: string[]): Set<string> {
  if (nos.length === 0) return new Set();
  const marks = nos.map(() => '?').join(',');
  const rows = db
    .prepare(`select external_no from purchase where platform = 'zakup.sk.kz' and external_no in (${marks})`)
    .all(...nos) as { external_no: string }[];
  return new Set(rows.map((r) => r.external_no));
}
