import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../paths";

function keyBytes(): Buffer {
  const fromEnv = process.env.BMSM_SECRET?.trim();
  if (fromEnv) return crypto.createHash("sha256").update(fromEnv).digest();
  const file = path.join(dataRoot(), "data", ".secret.key");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32));
  return fs.readFileSync(file);
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const bin = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, bin]).toString("base64");
}

export function decryptJson<T>(blob: string): T {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return JSON.parse(text) as T;
}
