import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isTestProcess(): boolean {
  return process.env.BMSM_TEST_MODE === "1" || process.env.VITEST === "true" || !!process.env.VITEST;
}

export function dataRoot(): string {
  if (process.env.BMSM_DATA_DIR) return process.env.BMSM_DATA_DIR;
  if (isTestProcess()) {
    const dir = path.join(os.tmpdir(), "bmsm-test", String(process.pid));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(os.homedir(), ".bmsmoneynigga");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  return dir;
}

export function dbPath(): string {
  if (isTestProcess()) return path.join(dataRoot(), "test.db");
  return path.join(dataRoot(), "data", "bmsm.db");
}

export function mediaRoot(): string {
  const dir = path.join(dataRoot(), "media");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "pending"), { recursive: true });
  return dir;
}
