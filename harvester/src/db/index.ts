import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string = config.dbPath): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
  return db;
}

export const now = (): string => new Date().toISOString();
