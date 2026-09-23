type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (order[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  const tail = extra && Object.keys(extra).length ? ' ' + fmt(extra) : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function fmt(extra: Record<string, unknown>): string {
  return Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
};
