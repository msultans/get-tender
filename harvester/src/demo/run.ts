import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { openDb } from '../db/index.js';
import { log } from '../util/log.js';
import { PortalBrowser } from '../portal/browser.js';
import { watchOnce } from '../pipeline/watch.js';
import { fetchLoop } from '../pipeline/fetch.js';
import { startFakePortal, DEMO_EXPECTED } from './fake-portal.js';

/**
 * Прогон всего конвейера против поддельного портала, поднятого локально.
 *
 * Отвечает на вопрос «работает ли машина у меня», не трогая zakup.sk.kz:
 * браузер → перехват XHR → разбор строк → база → очередь → карточка →
 * скачивание файлов → дедупликация по sha256.
 */
export async function runDemo(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'get-tender-demo-'));
  const { server, base } = await startFakePortal();

  config.dataDir = dir;
  config.baseUrl = base;
  config.portalDelayMs = 0;
  delete process.env.PORTAL_LIST_URL;

  log.info('поддельный портал поднят', { адрес: base });
  const db = openDb();
  const browser = new PortalBrowser();
  const problems: string[] = [];

  try {
    log.info('── дозор ──');
    const seen = await watchOnce(db, browser);
    log.info('дозор отработал', seen);
    if (seen.fresh !== DEMO_EXPECTED.purchases) {
      problems.push(`дозор нашёл ${seen.fresh} новых закупок вместо ${DEMO_EXPECTED.purchases}`);
    }

    log.info('── повторный дозор: ничего не должно произойти ──');
    const again = await watchOnce(db, browser);
    if (again.fresh !== 0 || again.changed !== 0) {
      problems.push(`повторный обход дал новых ${again.fresh}, изменений ${again.changed} — должно быть 0 и 0`);
    } else {
      log.info('повтор безвреден — как и задумано');
    }
    await browser.close();

    log.info('── сборщик ──');
    for (let i = 0; i < DEMO_EXPECTED.purchases; i += 1) await fetchLoop(db, { once: true });

    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const got = {
      purchases: n('select count(*) n from purchase'),
      lots: n('select count(*) n from lot'),
      documents: n('select count(*) n from document'),
      links: n('select count(*) n from document_link'),
    };
    log.info('в базе', got);

    for (const [key, want] of Object.entries(DEMO_EXPECTED)) {
      const have = got[key as keyof typeof got];
      if (have !== want) problems.push(`${key}: ${have}, ожидалось ${want}`);
    }

    const failed = n(`select count(*) n from job where status = 'failed'`);
    if (failed > 0) problems.push(`задач упало: ${failed}`);

    console.log('\n─────────────────────────────────────────────');
    if (problems.length === 0) {
      console.log('ДЕМО ПРОЙДЕНО — конвейер работает целиком');
      console.log(`  закупок ${got.purchases} · лотов ${got.lots} · файлов ${got.documents} на ${got.links} привязок`);
      console.log('  общая тендерная документация сохранена один раз — дедупликация работает');
    } else {
      console.log('ДЕМО НЕ ПРОЙДЕНО');
      for (const p of problems) console.log(`  · ${p}`);
    }
    console.log('─────────────────────────────────────────────\n');
    return problems.length === 0;
  } finally {
    await browser.close();
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
