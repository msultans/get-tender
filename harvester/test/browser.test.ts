import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalBrowser } from '../src/portal/browser.js';
import { config } from '../src/config.js';
import { rankListCandidates } from '../src/portal/discover.js';
import { rowsFromListResponse, fileRefsFromText } from '../src/portal/extract.js';
import { startFakePortal } from '../src/demo/fake-portal.js';

/**
 * Поддельный портал устроен как настоящий: SPA сама ходит за данными по
 * XHR. Проверяем, что перехват ответов ловит нужный запрос и что из него
 * собираются наши строки.
 */
test('браузер перехватывает XHR и из них собираются строки списка', { timeout: 120_000 }, async (t) => {
  config.dataDir = mkdtempSync(join(tmpdir(), 'gt-b-'));
  config.portalDelayMs = 0;

  const { server, base } = await startFakePortal();
  config.baseUrl = base;
  const browser = new PortalBrowser();
  t.after(async () => {
    await browser.close();
    server.close();
  });

  const page = await browser.goto(base, { waitMs: 1_500 });
  assert.match((await page.textContent('#out')) ?? '', /получено: 2/, 'поддельная SPA отрисовалась');
  assert.ok(browser.captures.length >= 1, `записано ${browser.captures.length} ответов`);

  const ranked = rankListCandidates(browser.captures);
  assert.ok(ranked.length > 0, 'запрос списка опознан среди трафика');
  assert.match(ranked[0]!.url, /lots\/search/);

  const rows = rowsFromListResponse(browser.captures.find((c) => c.url === ranked[0]!.url)!.bodyPreview);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.purchaseNo, '1247669');
  assert.equal(rows[0]?.amountNoVat, 49_875_000);
  assert.equal(rows[0]?.status, 'preliminary_discussion');
  assert.equal(rows[1]?.purchaseNo, '1245224');
  assert.equal(rows[1]?.amountNoVat, 17_000_000);

  // Подписанный заголовок виден — это то, что переиспользует гибридный режим.
  const headers = browser.lastApiRequestHeaders(/lots\/search/);
  assert.ok(headers?.tor, 'нестандартный заголовок виден в запросе');
});

/**
 * Регрессия. Переход на тот же адрес браузер считает пустой операцией, и
 * SPA не перезапускается — дозор на втором круге видел пустоту. Нашлось
 * прогоном демо.
 */
test('повторный заход на тот же адрес всё равно перезапускает SPA', { timeout: 120_000 }, async (t) => {
  config.dataDir = mkdtempSync(join(tmpdir(), 'gt-b2-'));
  config.portalDelayMs = 0;

  const { server, base } = await startFakePortal();
  config.baseUrl = base;
  const browser = new PortalBrowser();
  t.after(async () => {
    await browser.close();
    server.close();
  });

  const url = `${base}/#/ext/lots`;
  await browser.goto(url, { waitMs: 1_500 });
  assert.ok(rankListCandidates(browser.captures).length > 0, 'первый заход дал список');

  browser.clearCaptures();
  await browser.goto(url, { waitMs: 1_500 });
  assert.ok(
    rankListCandidates(browser.captures).length > 0,
    'второй заход на тот же адрес тоже должен дать список, иначе дозор слепнет после первого круга',
  );
});

test('ссылка на файл достаётся, хотя в разметке висит javascript:;', async () => {
  const { server, base } = await startFakePortal();
  try {
    const body = await (await fetch(`${base}/open-api/purchase/1247669`)).text();
    const refs = fileRefsFromText(body, base);
    assert.equal(refs.length, 2);
    assert.ok(refs.every((r) => r.url.startsWith(`${base}/eprocfilestorage/`)));
  } finally {
    server.close();
  }
});
