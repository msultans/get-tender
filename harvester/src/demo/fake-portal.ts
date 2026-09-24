import { createServer, type Server } from 'node:http';

/**
 * Поддельный zakup.sk.kz для проверки работоспособности без настоящего портала.
 *
 * Устроен так же, как настоящий: SPA, которая сама ходит за данными по XHR,
 * ссылки на файлы висят на javascript:;, а сами файлы отдаются обычным HTTP.
 * Один и тот же файл тендерной документации привязан к обеим закупкам —
 * на нём видно, что дедупликация работает.
 */

const TD = pdf('Тендерная документация — общая для обеих закупок');
const SPEC_A = pdf('Техническая спецификация лота 4514471');
const SPEC_B = pdf('Техническая спецификация лота 4507400');

const FILES: Record<string, { body: Buffer; name: string }> = {
  'aaaaaaaa-0000-0000-0000-000000000001': { body: TD, name: 'Тендерная документация.pdf' },
  'bbbbbbbb-0000-0000-0000-000000000002': { body: SPEC_A, name: 'Lot_4514471_2026-08-24.pdf' },
  'cccccccc-0000-0000-0000-000000000003': { body: SPEC_B, name: 'Lot_4507400_2026-08-31.pdf' },
};

const LOTS = [
  {
    purchaseNumber: '1247669', lotNumber: '4514471', lineNumber: '443 У',
    nameRu: 'Осуществление Авиа отправки консолидированных грузов АО «Кселл» по РК',
    customerNameRu: 'Акционерное общество "Кселл"',
    statusNameRu: 'Опубликовано предварительное обсуждение',
    sumNoNds: '49875000.00', publishDate: '24.08.2026 10:00', endDate: '15.09.2026 11:00',
    placeNameRu: 'КАЗАХСТАН, По всей территории РК',
    files: ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'],
  },
  {
    purchaseNumber: '1245224', lotNumber: '4507400', lineNumber: '398-2 Р',
    nameRu: 'Работы по восстановлению герметичных швов кровли стилобатов здания',
    customerNameRu: 'АО «KEGOC»', statusNameRu: 'Опубликовано',
    sumNoNds: 17000000, publishDate: '31.08.2026 16:42', endDate: '09.09.2026 11:00',
    placeNameRu: 'Астана',
    files: ['aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003'],
  },
];

const PAGE = `<!doctype html><meta charset="utf-8"><title>поддельный портал</title>
<body><div id="out">загрузка…</div>
<script>
  const m = location.hash.match(/item\\/(\\d+)\\/advert/);
  const url = m ? '/open-api/purchase/' + m[1] : '/open-api/lots/search?page=0&sort=publishDate,desc';
  fetch(url, { headers: { tor: 'ZmFrZS1zaWduYXR1cmU=' } })
    .then(r => r.json())
    .then(d => {
      const rows = d.content || [d];
      document.getElementById('out').textContent = 'получено: ' + rows.length;
      for (const row of rows) for (const f of (row.files || [])) {
        const a = document.createElement('a');
        a.href = 'javascript:;';
        a.textContent = f;
        document.body.appendChild(a);
      }
    })
    .catch(e => { document.getElementById('out').textContent = 'ошибка: ' + e; });
</script></body>`;

export function startFakePortal(port = 0): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/';

      if (url.startsWith('/open-api/lots/search')) {
        return json(res, { totalElements: LOTS.length, content: LOTS.map(withFileUrls) });
      }
      const card = url.match(/^\/open-api\/purchase\/(\d+)/);
      if (card) {
        const lot = LOTS.find((l) => l.purchaseNumber === card[1]);
        return lot ? json(res, withFileUrls(lot)) : notFound(res);
      }
      const file = url.match(/\/eprocfilestorage\/open-api\/files\/download\/([A-Za-z0-9-]+)/);
      if (file) {
        const f = FILES[file[1] ?? ''];
        if (!f) return notFound(res);
        res
          .writeHead(200, {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          })
          .end(f.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${p}` });
    });
  });
}

/** Ссылки на файлы приходят внутри JSON карточки — как на настоящем портале. */
function withFileUrls<T extends { files: string[] }>(lot: T): T & { fileUrls: string[] } {
  return { ...lot, fileUrls: lot.files.map((u) => `/eprocfilestorage/open-api/files/download/${u}`) };
}

function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

function notFound(res: import('node:http').ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' }).end('нет такого');
}

function pdf(title: string): Buffer {
  const body =
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n` +
    `% ${title}\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

export const DEMO_EXPECTED = {
  purchases: 2,
  lots: 2,
  /** Три привязки, но два файла: тендерная документация общая. */
  documents: 3,
  links: 4,
};
