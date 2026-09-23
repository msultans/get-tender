import { chromium, type BrowserContext, type Page, type Response } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { log } from '../util/log.js';

export interface Capture {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  bodyPreview: string;
  bodyBytes: number;
  isJson: boolean;
  at: number;
}

/**
 * Живой браузерный контекст — единственное, что умеет разговаривать с API
 * портала: прямой запрос отдаёт 418 без подписанного заголовка, который
 * ставит само приложение.
 *
 * Контекст один и работает последовательно. Портал начинает отдавать
 * ошибки при частых запросах, поэтому между запросами выдерживается пауза,
 * а серия ошибок размыкает цепь.
 */
export class PortalBrowser {
  private ctx?: BrowserContext;
  private page?: Page;
  private lastRequestAt = 0;
  private failureStreak = 0;
  private openedAt = 0;
  readonly captures: Capture[] = [];

  async open(): Promise<void> {
    if (this.ctx) return;
    mkdirSync(config.profileDir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      executablePath: config.chromiumPath,
      userAgent: config.userAgent,
      viewport: { width: 1600, height: 1000 },
      locale: 'ru-RU',
    });
    this.ctx.on('response', (res) => void this.record(res));
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.openedAt = Date.now();
    log.info('браузер открыт', { headless: config.headless, profile: config.profileDir });
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.page = undefined;
  }

  /**
   * Портал — SPA и сам ходит в своё API по XHR. Этот ответ можно забрать
   * целиком, вместо того чтобы разбирать отрисованную из него вёрстку:
   * так не ломается от правок разметки и не зависит от языка интерфейса.
   */
  private async record(res: Response): Promise<void> {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;

      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      const isJson = ct.includes('json');
      let preview = '';
      let bytes = 0;
      try {
        const body = await res.body();
        bytes = body.byteLength;
        if (isJson || ct.includes('text')) preview = body.subarray(0, 60_000).toString('utf8');
      } catch {
        /* тело могло быть уже сброшено — записываем хотя бы метаданные */
      }

      this.captures.push({
        url: res.url(),
        method: req.method(),
        resourceType: type,
        status: res.status(),
        requestHeaders: await req.allHeaders().catch(() => ({})),
        responseHeaders: res.headers(),
        bodyPreview: preview,
        bodyBytes: bytes,
        isJson,
        at: Date.now(),
      });
    } catch (err) {
      log.debug('не записал ответ', { error: String(err) });
    }
  }

  /** Пауза между обращениями к порталу — щадящий режим, не параллелим. */
  private async pace(): Promise<void> {
    const wait = config.portalDelayMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private noteOk(): void {
    this.failureStreak = 0;
  }

  private noteFail(): void {
    this.failureStreak += 1;
    if (this.failureStreak >= config.breakerThreshold) {
      throw new Error(
        `портал отдал ${this.failureStreak} ошибок подряд — цепь разомкнута, ` +
          `увеличь PORTAL_DELAY_MS и попробуй позже`,
      );
    }
  }

  async goto(url: string, opts: { waitMs?: number } = {}): Promise<Page> {
    await this.open();
    await this.pace();
    const page = this.page!;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // SPA дорисовывает список уже после domcontentloaded.
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
      this.noteOk();
      return page;
    } catch (err) {
      this.noteFail();
      throw err;
    }
  }

  /**
   * Смена hash не перерисовывает попап — SPA этого не делает сама,
   * нужен полный перезаход.
   */
  async gotoHash(hash: string, opts: { waitMs?: number } = {}): Promise<Page> {
    return this.goto(`${config.baseUrl}/${hash.startsWith('#') ? '' : '#'}${hash}`, opts);
  }

  page_(): Page {
    if (!this.page) throw new Error('браузер не открыт');
    return this.page;
  }

  /**
   * Заголовки, которые браузер ставит сам, включая подписанные.
   * Это то, что гибридный режим переиспользует в обычном HTTP-клиенте.
   */
  lastApiRequestHeaders(match: RegExp): Record<string, string> | undefined {
    for (let i = this.captures.length - 1; i >= 0; i -= 1) {
      const c = this.captures[i]!;
      if (match.test(c.url) && c.status < 400) return c.requestHeaders;
    }
    return undefined;
  }

  async cookieHeader(): Promise<string> {
    const cookies = (await this.ctx?.cookies()) ?? [];
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  clearCaptures(): void {
    this.captures.length = 0;
  }

  uptimeSec(): number {
    return this.openedAt ? Math.round((Date.now() - this.openedAt) / 1000) : 0;
  }
}
