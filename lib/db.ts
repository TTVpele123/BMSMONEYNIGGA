import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dbPath, isTestProcess } from "./paths";

let cached: Database.Database | null = null;

function applySchema(d: Database.Database): void {
  const sql = fs.readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8");
  d.exec(sql);
  d.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('outbound_mode',?)").run(process.env.OUTBOUND_MODE ?? "dry_run");
  d.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('kill_switch',?)").run(process.env.KILL_SWITCH ?? "false");
  d.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('authorized_sender','saevitzonoverstock@gmail.com')").run();
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
  const v = (process.env.OUTBOUND_MODE ?? getSetting("outbound_mode", "dry_run")).toLowerCase();
  return v === "live" ? "live" : "dry_run";
}

export function killSwitchOn(): boolean {
  const env = process.env.KILL_SWITCH;
  if (env === "true") return true;
  return getSetting("kill_switch", "false") === "true";
}
