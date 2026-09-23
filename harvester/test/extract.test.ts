import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, parseDate, normalizeStatus, pickString, rowFromJson,
  rowsFromListResponse, fileRefsFromText, classifyDocKind,
} from '../src/portal/extract.js';

test('суммы разбираются из числа и из строки с пробелами', () => {
  assert.equal(parseAmount(49875000), 49_875_000);
  assert.equal(parseAmount('49875000.00'), 49_875_000);
  assert.equal(parseAmount('49 875 000,00'), 49_875_000);
  assert.equal(parseAmount('49 875 000 ₸'), 49_875_000);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount('—'), null);
});

test('даты приводятся к ISO из обоих форматов портала', () => {
  assert.equal(parseDate('25.08.2026 10:00'), '2026-08-25T10:00:00');
  assert.equal(parseDate('31.08.2026'), '2026-08-31T00:00:00');
  assert.equal(parseDate('2026-08-31T16:42:00Z'), '2026-08-31T16:42:00.000Z');
  assert.equal(parseDate(''), null);
});

test('статусы сводятся к нашему словарю, включая казахский', () => {
  assert.equal(normalizeStatus('Опубликовано предварительное обсуждение'), 'preliminary_discussion');
  assert.equal(normalizeStatus('Опубликовано'), 'published');
  assert.equal(normalizeStatus('Алдын ала талқылау жарияланды'), 'preliminary_discussion');
  assert.equal(normalizeStatus('Отменено'), 'other');
  assert.equal(normalizeStatus(null), null);
});

test('поле находится по смыслу имени на любой глубине', () => {
  const node = { a: { b: { customerNameRu: 'АО «Кселл»' } } };
  assert.equal(pickString(node, [/customer.*(name)?(_ru|ru)?$/i]), 'АО «Кселл»');
});

test('строка списка разбирается из правдоподобного ответа портала', () => {
  const row = rowFromJson({
    purchaseNumber: '1247669',
    lotNumber: '4514471',
    lineNumber: '443 У',
    nameRu: 'Осуществление Авиа отправки консолидированных грузов АО «Кселл» по РК',
    customerNameRu: 'Акционерное общество "Кселл"',
    statusNameRu: 'Опубликовано предварительное обсуждение',
    sumNoNds: '49875000.00',
    publishDate: '24.08.2026 10:00',
    endDate: '2026-09-15T11:00:00Z',
    placeNameRu: 'КАЗАХСТАН, По всей территории РК',
  });
  assert.ok(row);
  assert.equal(row.purchaseNo, '1247669');
  assert.equal(row.lotNo, '4514471');
  assert.equal(row.lineNo, '443 У');
  assert.equal(row.amountNoVat, 49_875_000);
  assert.equal(row.status, 'preliminary_discussion');
  assert.equal(row.publishedAt, '2026-08-24T10:00:00');
  assert.match(row.customerName ?? '', /Кселл/);
});

test('строка без номера закупки отбрасывается, а не выдумывается', () => {
  assert.equal(rowFromJson({ nameRu: 'что-то', sum: 100 }), null);
  assert.equal(rowFromJson({ purchaseNumber: 'не-число' }), null);
});

test('список достаётся из вложенного массива при любой обёртке', () => {
  const body = JSON.stringify({
    totalElements: 2,
    content: [
      { purchaseNumber: '1247669', lotNumber: '4514471', nameRu: 'Авиа', sumNoNds: 49875000 },
      { purchaseNumber: '1245224', lotNumber: '4507400', nameRu: 'Кровля', sumNoNds: 17000000 },
    ],
  });
  const rows = rowsFromListResponse(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.purchaseNo, '1247669');
  assert.equal(rows[1]?.amountNoVat, 17_000_000);
});

test('битый JSON не роняет разбор', () => {
  assert.deepEqual(rowsFromListResponse('<html>418</html>'), []);
});

test('ссылки на файлы вылавливаются и дедуплицируются', () => {
  const text = `
    <a href="javascript:;">Объявление</a>
    "/eprocfilestorage/open-api/files/download/fdd4e90d-1847-4df1-91a0-ee77371c7ccc-2021-mdb"
    https://zakup.sk.kz/eprocfilestorage/open-api/files/download/fdd4e90d-1847-4df1-91a0-ee77371c7ccc-2021-mdb
    "/eprocfilestorage/open-api/files/download/aaaabbbb-1111-2222-3333-444455556666"`;
  const refs = fileRefsFromText(text, 'https://zakup.sk.kz');
  assert.equal(refs.length, 2);
  assert.ok(refs.every((r) => r.url.startsWith('https://zakup.sk.kz/eprocfilestorage/')));
});

test('тип документа определяется по имени', () => {
  assert.equal(classifyDocKind('Объявление_1247669.pdf'), 'advert');
  assert.equal(classifyDocKind('Проект договора.pdf'), 'contract_draft');
  assert.equal(classifyDocKind('Lot_4514471_2026-08-24.pdf'), 'tech_spec');
  assert.equal(classifyDocKind('приложение_№2.docx'), 'annex');
  assert.equal(classifyDocKind(null), 'other');
});
