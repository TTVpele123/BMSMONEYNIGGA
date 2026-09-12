import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dbPath, isTestProcess } from "./paths";

let cached: Database.Database | null = null;

function applySchema(d: Database.Database): void {
  const sql = fs.readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8");
  d.exec(sql);
  ensureResearchJobsSchema(d);
  d.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('outbound_mode',?)").run(process.env.OUTBOUND_MODE ?? "dry_run");
  d.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('kill_switch',?)").run(process.env.KILL_SWITCH ?? "false");
  d.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('authorized_sender','saevitzonoverstock@gmail.com')").run();
}

/** Existing DBs were created with a narrower CHECK and no lot_id. Rebuild in place. */
function ensureResearchJobsSchema(d: Database.Database): void {
  const row = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='research_jobs'").get() as { sql: string } | undefined;
  if (!row) return;
  const cols = d.prepare("PRAGMA table_info(research_jobs)").all() as { name: string }[];
  const hasLotId = cols.some((c) => c.name === "lot_id");
  const hasCancelled = /'cancelled'/.test(row.sql);
  if (hasLotId && hasCancelled) return;
  d.exec("PRAGMA foreign_keys=OFF");
  d.exec(`
    CREATE TABLE research_jobs__mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      query TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','running','done','failed','cancelled','expired')),
      result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      lot_id INTEGER REFERENCES lots(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO research_jobs__mig(id,kind,query,state,result,attempts,last_error,lot_id,created_at,updated_at)
    SELECT id, kind, query, state, result, attempts, last_error, NULL, created_at, updated_at FROM research_jobs;
    DROP TABLE research_jobs;
    ALTER TABLE research_jobs__mig RENAME TO research_jobs;
    CREATE INDEX IF NOT EXISTS idx_research_pending ON research_jobs(state, kind);
    CREATE INDEX IF NOT EXISTS idx_research_lot_pending ON research_jobs(lot_id, state);
  `);
  d.exec("PRAGMA foreign_keys=ON");
}

export function db(): Database.Database {
  if (cached) return cached;
  const file = dbPath();
  if (!isTestProcess() && /deal-os\.db$/.test(file)) {
    throw new Error("refusing to open Deal OS production database");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma("foreign_keys = ON");
  d.pragma("journal_mode = WAL");
  applySchema(d);
  cached = d;
  return d;
}

export function resetDbForTests(): void {
  if (!isTestProcess()) throw new Error("resetDbForTests only in test process");
  if (cached) {
    cached.close();
    cached = null;
  }
  const file = dbPath();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + suffix); } catch { /* missing is fine */ }
  }
}

export function getSetting(key: string, fallback = ""): string {
  const row = db().prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db().prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function audit(actor: string, action: string, opts: {
  entityType?: string;
  entityId?: string | number;
  ok?: boolean;
  detail?: unknown;
} = {}): void {
  db().prepare(
    `INSERT INTO audit_log(actor,action,entity_type,entity_id,ok,detail) VALUES(?,?,?,?,?,?)`
  ).run(
    actor,
    action,
    opts.entityType ?? null,
    opts.entityId == null ? null : String(opts.entityId),
    opts.ok === false ? 0 : 1,
    JSON.stringify(opts.detail ?? {}),
  );
}

export function outboundMode(): "dry_run" | "live" {
  const setting = getSetting("outbound_mode", "").toLowerCase();
  if (setting === "live" || setting === "dry_run") return setting;
  const env = (process.env.OUTBOUND_MODE ?? "dry_run").toLowerCase();
  return env === "live" ? "live" : "dry_run";
}

export function killSwitchOn(): boolean {
  const env = process.env.KILL_SWITCH;
  if (env === "true") return true;
  return getSetting("kill_switch", "false") === "true";
}
