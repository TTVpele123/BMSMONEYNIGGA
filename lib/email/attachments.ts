import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { selectOutreachMedia } from "../media";
import type { MimeAttachment } from "./mime";

export type LotBrief = {
  id: number;
  title: string;
  category: string;
  quantity: number | null;
  unit_price: number | null;
  brand: string | null;
};

export type MediaPick = {
  lots: LotBrief[];
  attachments: MimeAttachment[];
  hashes: string[];
};

export function lotHasSendableMedia(lotId: number): boolean {
  return pickMediaForLot(lotId).length > 0;
}

function pickMediaForLot(lotId: number) {
  const media = db().prepare(
    "SELECT lot_id, sha256, path, filename, classification, outreach_safe, association_certain FROM lot_media WHERE lot_id=?"
  ).all(lotId) as Array<{
    lot_id: number; sha256: string; path: string; filename: string; classification: string;
    outreach_safe: number; association_certain: number;
  }>;
  const safe = selectOutreachMedia(media, lotId);
  return safe.filter((m) => {
    if (m.association_certain !== 1) return false;
    if (m.classification === "screenshot_chat_capture") return false;
    if (!m.path || !fs.existsSync(m.path)) return false;
    return true;
  });
}

/** Keep only lots that have certain original Oliver photos. Never send a media-less lot. */
export function selectSendableLots(lots: LotBrief[]): { ok: true; pick: MediaPick } | { ok: false; reason: string } {
  const kept: LotBrief[] = [];
  const attachments: MimeAttachment[] = [];
  const hashes: string[] = [];
  for (const lot of lots) {
    const media = pickMediaForLot(lot.id);
    if (!media.length) continue;
    if (kept.length >= 3) break;
    kept.push(lot);
    for (const [i, m] of media.entries()) {
      const buf = fs.readFileSync(m.path);
      const ext = path.extname(m.filename || m.path).toLowerCase();
      const mime = ext === ".png" ? "image/png" : "image/jpeg";
      attachments.push({
        filename: m.filename || `lot-${lot.id}-${i + 1}${ext || ".jpg"}`,
        mime,
        contentBase64: buf.toString("base64"),
        contentId: `lot-${lot.id}-${m.sha256.slice(0, 10)}`,
      });
      hashes.push(m.sha256);
    }
  }
  if (!kept.length) return { ok: false, reason: "no verified Oliver media for any offered lot" };
  return { ok: true, pick: { lots: kept.slice(0, 3), attachments, hashes } };
}
