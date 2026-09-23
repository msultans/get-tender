import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankListCandidates, inspectJsonShape, unusualHeaders, decideMode } from '../src/portal/discover.js';
import { storagePathFor, contentHash, canonicalJson } from '../src/util/hash.js';
import { guessExtension, filenameFromDisposition } from '../src/portal/http.js';
import { redactHeaders, redactText } from '../src/util/redact.js';

const listBody = JSON.stringify({
  totalElements: 2,
  content: [
    { purchaseNumber: '1247669', nameRu: 'Авиа', sumNoNds: 49875000, publishDate: '2026-08-24' },
    { purchaseNumber: '1245224', nameRu: 'Кровля', sumNoNds: 17000000, publishDate: '2026-08-31' },
  ],
});

test('среди трафика опознаётся запрос списка, а мусор отсеивается', () => {
  const ranked = rankListCandidates([
    { url: 'https://zakup.sk.kz/api/i18n/ru.json', method: 'GET', status: 200, isJson: true, bodyPreview: '{"ok":"да"}', bodyBytes: 11 },
    { url: 'https://zakup.sk.kz/open-api/lots/search?page=0', method: 'POST', status: 200, isJson: true, bodyPreview: listBody, bodyBytes: 400 },
    { url: 'https://zakup.sk.kz/api/user', method: 'GET', status: 401, isJson: true, bodyPreview: '{}', bodyBytes: 2 },
  ]);
  assert.ok(ranked.length >= 1);
  assert.match(ranked[0]!.url, /lots\/search/);
  assert.ok(ranked[0]!.score > 50);
  assert.ok(!ranked.some((c) => c.url.includes('/api/user')), 'ответ с 401 не кандидат');
});

test('форма JSON определяется вместе с путём до массива', () => {
  const shape = inspectJsonShape(listBody);
  assert.equal(shape.arrayLength, 2);
  assert.equal(shape.arrayPath, 'content');
  assert.ok(shape.looksLikePurchaseNumbers);
  assert.ok(shape.looksLikeAmounts);
  assert.deepEqual(shape.topLevelKeys, ['totalElements', 'content']);
});

test('битый JSON не роняет разбор формы', () => {
  assert.equal(inspectJsonShape('<html>418 I am a teapot</html>').arrayLength, 0);
});

test('нестандартные заголовки отделяются от обычных', () => {
  const extra = unusualHeaders({
    accept: 'application/json',
    'user-agent': 'Chrome',
    cookie: 'JSESSIONID=x',
    'sec-fetch-mode': 'cors',
    tor: 'a'.repeat(120),
    'x-request-id': '42',
  });
  assert.deepEqual(extra.map((e) => e.name).sort(), ['tor', 'x-request-id']);
  assert.equal(extra.find((e) => e.name === 'tor')?.length, 120);
});

test('вердикт различает три исхода', () => {
  assert.equal(decideMode({ fileOverPlainHttp: true, apiWithoutHeaders: true, apiWithBrowserHeaders: true }).mode, 'http');
  assert.equal(decideMode({ fileOverPlainHttp: true, apiWithoutHeaders: false, apiWithBrowserHeaders: true }).mode, 'hybrid');
  const d = decideMode({ fileOverPlainHttp: true, apiWithoutHeaders: false, apiWithBrowserHeaders: false });
  assert.equal(d.mode, 'browser');
  assert.equal(d.variant, 'D');
  assert.equal(d.filesOverHttp, true, 'файлы качаются HTTP даже когда API требует браузера');
});

test('путь в хранилище выводится из хеша и разводит файлы по каталогам', () => {
  const sha = 'abcdef0123456789'.repeat(4);
  assert.equal(storagePathFor(sha, '.pdf'), `ab/cd/${sha}.pdf`);
  assert.equal(storagePathFor(sha, 'pdf'), `ab/cd/${sha}.pdf`);
  assert.equal(storagePathFor(sha, ''), `ab/cd/${sha}`);
});

test('канонический JSON не зависит от порядка ключей', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.notEqual(contentHash({ sum: 1 }), contentHash({ sum: 2 }));
});

test('расширение берётся из имени, иначе из типа содержимого', () => {
  assert.equal(guessExtension('Объявление.PDF', 'application/octet-stream'), '.pdf');
  assert.equal(guessExtension(null, 'application/pdf'), '.pdf');
  assert.equal(guessExtension(null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=utf-8'), '.docx');
  assert.equal(guessExtension(null, null), '.bin');
});

test('имя файла достаётся из Content-Disposition, включая кириллицу', () => {
  assert.equal(filenameFromDisposition('attachment; filename="Lot_4514471.pdf"'), 'Lot_4514471.pdf');
  assert.equal(
    filenameFromDisposition("attachment; filename*=UTF-8''%D0%9E%D0%B1%D1%8A%D1%8F%D0%B2%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5.pdf"),
    'Объявление.pdf',
  );
  assert.equal(filenameFromDisposition(undefined), null);
});

test('в отчёт не попадают значения сессионных заголовков', () => {
  const red = redactHeaders({ cookie: 'JSESSIONID=secret', tor: 'x'.repeat(88), accept: 'application/json' });
  assert.equal(red.accept, 'application/json');
  assert.ok(!red.cookie!.includes('secret'));
  assert.match(red.tor!, /скрыто, 88 символов/);
});

test('длинные токены маскируются и в свободном тексте', () => {
  const out = redactText('token=eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 и ещё ' + 'Z'.repeat(50));
  assert.ok(!out.includes('Z'.repeat(50)));
  assert.ok(out.includes('«скрыто»') || out.includes('«jwt скрыт»'));
});
