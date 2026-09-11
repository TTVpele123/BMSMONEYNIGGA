import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MediaClass =
  | "clean_product_photo"
  | "warehouse_inventory_photo"
  | "document"
  | "screenshot_chat_capture"
  | "duplicate"
  | "low_resolution"
  | "invalid"
  | "pending";

const CHAT_UI_RE =
  /screenshot|whatsapp web|chat capture|private conversation|forwarded label|browser ui|phone ui|message is marked/i;
const DOCUMENT_RE = /measurement chart|hang tag|barcode|document|invoice|manifest/i;
const WAREHOUSE_RE = /warehouse|gaylord|case|pallet|inventory/i;

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function imageDimensions(buf: Buffer, mime: "image/png" | "image/jpeg"): [number | null, number | null] {
  if (mime === "image/png" && buf.length >= 24) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      const sof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
      if (sof.includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return [null, null];
}

export function classifyOliverMedia(input: {
  filePath: string;
  filename?: string;
  context?: string;
  seenHashes: Set<string>;
}): { sha256: string; classification: MediaClass; outreachSafe: boolean; reason: string; width: number | null; height: number | null; bytes: number } {
  const { filePath, filename = path.basename(filePath), context = "", seenHashes } = input;
  if (!fs.existsSync(filePath)) {
    return { sha256: "", classification: "invalid", outreachSafe: false, reason: "file missing", width: null, height: null, bytes: 0 };
  }
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const pngMagic = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpgMagic = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const mime = pngMagic || ext === ".png"
    ? "image/png" as const
    : jpgMagic || [".jpg", ".jpeg"].includes(ext)
      ? "image/jpeg" as const
      : null;
  const hash = sha256(buf);
  const [width, height] = mime ? imageDimensions(buf, mime) : [null, null];
  const blob = `${filePath} ${filename} ${context}`;

  let classification: MediaClass = "invalid";
  let reason = "unsupported";

  if (CHAT_UI_RE.test(blob)) {
    classification = "screenshot_chat_capture";
    reason = "WhatsApp/chat UI is never outbound media";
  } else if (!mime || buf.length < 800) {
    classification = "invalid";
    reason = "unsupported type or too small";
  } else if (width && height && (width < 400 || height < 200)) {
    classification = "low_resolution";
    reason = `${width}x${height} below 400x200`;
  } else if (seenHashes.has(hash)) {
    classification = "duplicate";
    reason = "duplicate content";
  } else if (DOCUMENT_RE.test(blob)) {
    classification = "document";
    reason = "document/label, not product media";
  } else if (WAREHOUSE_RE.test(blob)) {
    classification = "warehouse_inventory_photo";
    reason = "warehouse/inventory photo";
  } else {
    classification = "clean_product_photo";
    reason = "original Oliver product photo";
  }

  seenHashes.add(hash);
  const outreachSafe = classification === "clean_product_photo" || classification === "warehouse_inventory_photo";
  return { sha256: hash, classification, outreachSafe, reason, width, height, bytes: buf.length };
}

export function selectOutreachMedia<T extends { outreach_safe: number; lot_id: number | null; sha256: string; path: string; classification: string }>(
  rows: T[],
  lotId: number,
  max = 4,
): T[] {
  return rows
    .filter((r) => r.lot_id === lotId && r.outreach_safe === 1 && !/screenshot_chat_capture|invalid|duplicate/.test(r.classification))
    .slice(0, max);
}
