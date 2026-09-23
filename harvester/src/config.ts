import { resolve, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Обычно Playwright находит браузер сам. Но если браузеры лежат в общем
 * каталоге с другой версией сборки (так устроены некоторые контейнеры),
 * он их не видит — тогда ищем исполняемый файл вручную.
 */
function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-linux', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const int = (v: string | undefined, d: number): number => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
};

export const config = {
  /** Корень портала. */
  baseUrl: process.env.PORTAL_BASE_URL ?? 'https://zakup.sk.kz',

  /** Куда складывать базу, файлы и профиль браузера. */
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  get dbPath() { return resolve(this.dataDir, 'harvester.sqlite'); },
  get storageDir() { return resolve(this.dataDir, 'storage'); },
  get profileDir() { return resolve(this.dataDir, 'browser-profile'); },

  /** Дозор: как часто смотреть первую страницу и сколько строк брать. */
  watchIntervalMs: int(process.env.WATCH_INTERVAL_MS, 60_000),
  watchRows: int(process.env.WATCH_ROWS, 20),

  /**
   * Пауза между запросами к порталу. Подбирается снизу вверх: портал
   * начинает отдавать ошибки при частых запросах. 4 секунды — осознанно
   * осторожный старт, а не замер.
   */
  portalDelayMs: int(process.env.PORTAL_DELAY_MS, 4_000),

  /** Столько файлов качаем разом обычным HTTP (мимо браузера). */
  downloadConcurrency: int(process.env.DOWNLOAD_CONCURRENCY, 4),

  /** Сколько ошибок подряд размыкают цепь. */
  breakerThreshold: int(process.env.BREAKER_THRESHOLD, 5),

  headless: process.env.HEADFUL !== '1',

  /** Путь к Chromium. Обычно Playwright находит его сам. */
  chromiumPath: findChromium(),

  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

export type Config = typeof config;
