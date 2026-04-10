import path from "node:path";
import { ensureDir } from "./fs.ts";
import type { AppPaths, EventRecord } from "./types.ts";

export class EventHistory {
  private readonly db: {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): void };
    close(): void;
  };

  private constructor(db: {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): void };
    close(): void;
  }) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  static async open(paths: AppPaths, sessionId: string): Promise<EventHistory | null> {
    if (process.env.KAVI_ENABLE_SQLITE_HISTORY !== "1") {
      return null;
    }

    await ensureDir(paths.homeStateDir);
    const dbPath = path.join(paths.homeStateDir, `${sessionId}.sqlite`);
    const sqlite = await import("node:sqlite");
    return new EventHistory(new sqlite.DatabaseSync(dbPath));
  }

  insert(sessionId: string, event: EventRecord): void {
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO events (id, session_id, timestamp, type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    statement.run(
      event.id,
      sessionId,
      event.timestamp,
      event.type,
      JSON.stringify(event.payload)
    );
  }

  close(): void {
    this.db.close();
  }
}
