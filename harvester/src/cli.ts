import { openDb } from './db/index.js';
import { config } from './config.js';
import { log } from './util/log.js';
import { runProbe } from './portal/probe.js';
import { watchLoop, watchOnce } from './pipeline/watch.js';
import { fetchLoop } from './pipeline/fetch.js';
import { queueStats } from './pipeline/queue.js';
import { setKv, getKv } from './db/repo.js';
import { PortalBrowser } from './portal/browser.js';

const [, , command, ...args] = process.argv;

const HELP = `
get-tender harvester — выгрузка тендеров с zakup.sk.kz

  npm run probe     проверить портал и выбрать способ доступа
  npm run watch     дозор: раз в минуту смотреть первую страницу списка
  npm run fetch     сборщик: разбирать очередь карточек и качать файлы
  npm run status    что уже в базе

  npx tsx src/cli.ts watch --once     один проход дозора и выход
  npx tsx src/cli.ts fetch --once     одна карточка из очереди и выход

Настройки — через переменные окружения, см. src/config.ts:
  DATA_DIR, WATCH_INTERVAL_MS, PORTAL_DELAY_MS, HEADFUL=1, LOG_LEVEL=debug
`;

async function main(): Promise<void> {
  switch (command) {
    case 'probe': {
      log.info('проверяю портал', { baseUrl: config.baseUrl });
      const report = await runProbe();
      const db = openDb();
      setKv(db, 'portal.mode', report.verdict.mode);
      setKv(db, 'probe.at', report.startedAt);

      console.log('\n─────────────────────────────────────────────');
      console.log(`ВЕРДИКТ:  вариант ${report.verdict.variant} — ${report.verdict.mode}`);
      console.log(report.verdict.summary);
      console.log(`Файлы обычным HTTP: ${report.verdict.filesOverHttp ? 'да' : 'нет'}`);
      console.log('─────────────────────────────────────────────');
      for (const step of report.nextSteps) console.log(`  · ${step}`);
      console.log('\nОтчёт: probe-report.json, сырые ответы: probe-dump/');
      console.log('Значения заголовков и токенов в отчёт не попадают — только имена и длины.\n');
      break;
    }

    case 'watch': {
      const db = openDb();
      if (!getKv(db, 'portal.mode')) {
        log.warn('probe ещё не запускался — способ доступа к порталу не проверен');
      }
      if (args.includes('--once')) {
        const browser = new PortalBrowser();
        try {
          const res = await watchOnce(db, browser);
          console.log(JSON.stringify(res));
        } finally {
          await browser.close();
        }
      } else {
        log.info('дозор запущен', { интервалСек: config.watchIntervalMs / 1000 });
        await watchLoop(db);
      }
      break;
    }

    case 'fetch': {
      const db = openDb();
      await fetchLoop(db, { once: args.includes('--once') });
      break;
    }

    case 'status': {
      const db = openDb();
      const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
      console.log('\nБаза:', config.dbPath);
      console.log('Закупок:      ', one('select count(*) n from purchase'));
      console.log('  с карточкой:', one('select count(*) n from purchase where detail_fetched_at is not null'));
      console.log('Лотов:        ', one('select count(*) n from lot'));
      console.log('Файлов:       ', one('select count(*) n from document'));
      console.log('  привязок:   ', one('select count(*) n from document_link'));
      const bytes = (db.prepare('select coalesce(sum(size_bytes),0) n from document').get() as { n: number }).n;
      const links = one('select count(*) n from document_link');
      const docs = one('select count(*) n from document');
      console.log('Объём файлов: ', `${(bytes / 1024 / 1024).toFixed(1)} МБ`);
      if (links > 0) console.log('Дедупликация: ', `${docs} файлов на ${links} привязок`);
      console.log('\nОчередь:');
      const stats = queueStats(db);
      if (stats.length === 0) console.log('  пусто');
      for (const s of stats) console.log(`  ${s.queue.padEnd(18)} ${s.status.padEnd(9)} ${s.n}`);
      const lastOk = getKv(db, 'watch.last_ok_at');
      console.log('\nПоследний удачный обход:', lastOk ?? 'не было');
      console.log('Способ доступа:         ', getKv(db, 'portal.mode') ?? 'не проверен, запусти probe');
      console.log();
      break;
    }

    default:
      console.log(HELP);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  log.error('упало', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exitCode = 1;
});
