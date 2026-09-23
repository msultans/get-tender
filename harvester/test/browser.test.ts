import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalBrowser } from '../src/portal/browser.js';
import { config } from '../src/config.js';
import { rankListCandidates } from '../src/portal/discover.js';
import { rowsFromListResponse, fileRefsFromText } from '../src/portal/extract.js';

/**
 * Поддельный портал: SPA, которая рисует список, сходив за ним по XHR —
 * ровно так же устроен настоящий. Проверяем, что перехват ответов ловит
 * JSON и что из него собираются наши строки.
 */
const LIST_JSON = JSON.stringify({
  totalElements: 2,
  content: [
    {
      purchaseNumber: '1247669', lotNumber: '4514471', lineNumber: '443 У',
      nameRu: 'Осуществление Авиа отправки консолидированных грузов', customerNameRu: 'АО «Кселл»',
      statusNameRu: 'Опубликовано предварительное обсуждение', sumNoNds: '49875000.00',
      publishDate: '24.08.2026 10:00', endDate: '15.09.2026 11:00', placeNameRu: 'По всей территории РК',
    },
    {
      purchaseNumber: '1245224', lotNumber: '4507400', lineNumber: '398-2 Р',
      nameRu: 'Работы по восстановлению герметичных швов кровли', customerNameRu: 'АО «KEGOC»',
      statusNameRu: 'Опубликовано', sumNoNds: 17000000,
      publishDate: '31.08.2026 16:42', endDate: '09.09.2026 11:00', placeNameRu: 'Астана',
    },
  ],
});

const PAGE = `<!doctype html><meta charset="utf-8"><title>поддельный портал</title>
<div id="grid">загрузка…</div>
<a href="javascript:;" data-file="/eprocfilestorage/open-api/files/download/aaaabbbb-1111-2222-3333-444455556666">Объявление</a>
<script>
  fetch('/open-api/lots/search?page=0', { headers: { 'tor': 'c2lnbmF0dXJl'.repeat(8) } })
    .then(r => r.json())
    .then(d => { document.getElementById('grid').textContent = 'строк: ' + d.content.length; });
  fetch('/api/i18n/ru.json').then(r => r.json());
</script>`;

function startFakePortal(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/open-api/lots/search')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(LIST_JSON);
      } else if (url.startsWith('/api/i18n')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"да":"да"}');
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('браузер перехватывает XHR и из них собираются строки списка', { timeout: 120_000 }, async (t) => {
  // profileDir и остальные пути выводятся из dataDir, его и подменяем.
  config.dataDir = mkdtempSync(join(tmpdir(), 'gt-b-'));
  config.portalDelayMs = 0;

  const { server, base } = await startFakePortal();
  const browser = new PortalBrowser();
  t.after(async () => {
    await browser.close();
    server.close();
  });

  const page = await browser.goto(base, { waitMs: 1_500 });
  assert.match(await page.textContent('#grid') ?? '', /строк: 2/, 'поддельная SPA отрисовалась');

  // Перехват поймал оба запроса, включая тот, что нужен.
  assert.ok(browser.captures.length >= 2, `записано ${browser.captures.length} ответов`);

  const ranked = rankListCandidates(browser.captures);
  assert.ok(ranked.length > 0, 'запрос списка опознан среди трафика');
  assert.match(ranked[0]!.url, /lots\/search/, 'выбран именно список, а не словарь локализации');

  const body = browser.captures.find((c) => c.url === ranked[0]!.url)!.bodyPreview;
  const rows = rowsFromListResponse(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.purchaseNo, '1247669');
  assert.equal(rows[0]?.amountNoVat, 49_875_000);
  assert.equal(rows[0]?.status, 'preliminary_discussion');
  assert.equal(rows[1]?.purchaseNo, '1245224');

  // Подписанный заголовок виден в запросе — это то, что переиспользует гибрид.
  const headers = browser.lastApiRequestHeaders(/lots\/search/);
  assert.ok(headers, 'заголовки запроса доступны');
  assert.ok(headers.tor, 'нестандартный заголовок виден');

  // Ссылка на файл достаётся из разметки, хотя висит на javascript:;
  const refs = fileRefsFromText(await page.content(), base);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.uuid, 'aaaabbbb-1111-2222-3333-444455556666');
});
