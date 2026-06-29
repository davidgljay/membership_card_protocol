import Database from "better-sqlite3";

export interface DeviceRecord {
  push_token: string;
  app_id: string;
  last_registered_at: string;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const path = process.env.DB_PATH ?? "/data/registry.db";
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    runMigrations(db);
  }
  return db;
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS device_registry (
      push_token         TEXT NOT NULL PRIMARY KEY,
      app_id             TEXT NOT NULL,
      last_registered_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_last_registered
      ON device_registry(last_registered_at);
  `);
}

export function upsertDevice(push_token: string, app_id: string): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO device_registry (push_token, app_id, last_registered_at)
       VALUES (?, ?, ?)
       ON CONFLICT(push_token) DO UPDATE SET
         app_id = excluded.app_id,
         last_registered_at = excluded.last_registered_at`
    )
    .run(push_token, app_id, now);
}

export function getRecentDevices(since: Date): DeviceRecord[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT push_token, app_id, last_registered_at
       FROM device_registry
       WHERE last_registered_at >= ?`
    )
    .all(since.toISOString()) as DeviceRecord[];
}

export function pruneOldDevices(before: Date): number {
  const database = getDb();
  const result = database
    .prepare(`DELETE FROM device_registry WHERE last_registered_at < ?`)
    .run(before.toISOString());
  return result.changes;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
