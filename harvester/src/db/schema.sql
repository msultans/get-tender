-- Схема слоя выгрузки. Только то, что нужно дозору и сборщику;
-- таблицы разбора появятся, когда до него дойдут руки.

create table if not exists purchase (
  id                  integer primary key,
  platform            text    not null default 'zakup.sk.kz',
  external_no         text    not null,
  title               text,
  customer_name       text,
  method              text,   -- открытый тендер / ЗЦП / ...
  status              text,   -- preliminary_discussion | published | other
  published_at        text,
  bids_open_at        text,
  bids_close_at       text,
  total_amount_no_vat real,
  url                 text,
  raw                 text,   -- json как пришёл
  content_hash        text,   -- отпечаток наблюдаемых полей
  detail_fetched_at   text,   -- null = карточка ещё не открывалась
  first_seen_at       text    not null,
  last_seen_at        text    not null,
  unique (platform, external_no)
);

create table if not exists lot (
  id                  integer primary key,
  purchase_id         integer not null references purchase(id) on delete cascade,
  external_no         text    not null,   -- 4514471
  line_no             text,               -- 443 У
  title               text,
  amount_no_vat       real,
  place               text,
  delivery_term       text,
  payment_terms       text,
  raw                 text,
  content_hash        text,
  first_seen_at       text    not null,
  last_seen_at        text    not null,
  unique (purchase_id, external_no)
);

-- Файл хранится один раз на хеш содержимого.
create table if not exists document (
  id            integer primary key,
  sha256        text    not null unique,
  filename      text,
  mime          text,
  size_bytes    integer not null,
  storage_path  text    not null,
  downloaded_at text    not null
);

-- Привязка файла к закупке и, если известно, к лоту.
create table if not exists document_link (
  id            integer primary key,
  document_id   integer not null references document(id) on delete cascade,
  purchase_id   integer not null references purchase(id) on delete cascade,
  lot_id        integer references lot(id) on delete cascade,
  doc_kind      text,
  external_uuid text,
  source_url    text,
  created_at    text    not null
);

-- lot_id бывает null, а в SQLite null в unique не совпадает сам с собой,
-- поэтому уникальность по выражению.
create unique index if not exists document_link_uniq
  on document_link (document_id, purchase_id, ifnull(lot_id, 0));

-- Сырой ответ портала до всякого разбора: чтобы перегнать парсер
-- заново, не ходя на портал второй раз.
create table if not exists raw_capture (
  id           integer primary key,
  kind         text    not null,   -- list | purchase | probe
  external_key text,
  fetched_at   text    not null,
  http_status  integer,
  payload      text    not null,
  payload_sha  text    not null
);

create index if not exists raw_capture_key on raw_capture (kind, external_key, fetched_at);

-- Очередь задач. Ключ несёт идемпотентность: повторная постановка
-- той же задачи не создаёт вторую.
create table if not exists job (
  id              integer primary key,
  queue           text    not null,
  key             text    not null unique,
  payload         text    not null,
  status          text    not null default 'pending',  -- pending|running|done|failed
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,
  next_attempt_at text    not null,
  last_error      text,
  created_at      text    not null,
  finished_at     text
);

create index if not exists job_pick on job (queue, status, next_attempt_at);

create table if not exists kv (
  key        text primary key,
  value      text not null,
  updated_at text not null
);
