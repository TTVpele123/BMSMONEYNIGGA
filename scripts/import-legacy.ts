/**
 * Read-only import from Oliver Deal OS. Never writes to the legacy DB.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { db as bmsm, audit } from "../lib/db";
import { normalizeCategory } from "../lib/matcher";
import { recordEndpoint } from "../lib/channels/select";
import { enrollBuyer, recordMandate } from "../lib/research";

const LEGACY = process.env.LEGACY_DB ?? "/Users/baileysaevitzon/.buzz/var/oliver-deal-os/data/deal-os.db";

function tableExists(d: Database.Database, name: string): boolean {
  const row = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

export function importLegacy(legacyPath = LEGACY): { buyers: number; lots: number; mandates: number; suppressions: number } {
  if (!fs.existsSync(legacyPath)) {
    throw new Error(`legacy db not found: ${legacyPath}`);
  }
  const src = new Database(legacyPath, { readonly: true, fileMustExist: true });
  let buyers = 0, lots = 0, mandates = 0, suppressions = 0;

  if (tableExists(src, "buyers")) {
    const rows = src.prepare("SELECT * FROM buyers").all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const domain = String(r.domain ?? "").toLowerCase().replace(/^www\./, "");
      if (!domain) continue;
      let buyerId: number;
      try {
        buyerId = enrollBuyer({
          company: String(r.company ?? domain),
          domain,
          categories: String(r.categories ?? ""),
          channel: String(r.channel ?? "unknown"),
          outreach_channel: String(r.outreach_channel ?? "unknown"),
          source_evidence: r.source_evidence ? String(r.source_evidence) : undefined,
          verification_status: String(r.contact_verification ?? r.verification_class ?? "unverified"),
        }).buyerId;
      } catch {
        continue;
      }
      bmsm().prepare("UPDATE buyers SET txn_capacity_usd=?, geography=?, disqualified_reason=?, legacy_buyer_id=?, confidence=? WHERE id=?").run(
        r.txn_capacity_usd ?? null,
        r.geography ?? "unknown",
        r.disqualified_reason ?? null,
        r.id ?? null,
        r.confidence ?? null,
        buyerId,
      );
      if (r.contact_method && String(r.contact_method).includes("@")) {
        const email = String(r.contact_method).toLowerCase();
        bmsm().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,name,title,email,verification) VALUES(?,?,?,?,?)").run(
          buyerId, r.contact_name ?? null, r.contact_title ?? null, email, r.contact_verification ?? "unverified",
        );
        recordEndpoint({
          buyerId,
          channel: "email",
          handle: email,
          verified: /verified|public_intake|clay/i.test(String(r.contact_verification ?? "")),
          confidence: 0.9,
          source: "legacy",
        });
      }
      buyers += 1;
    }
  }

  if (tableExists(src, "inventory_lots")) {
    const rows = src.prepare("SELECT * FROM inventory_lots").all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const title = String(r.internal_name ?? r.brand ?? `legacy-${r.id}`);
      const cat = normalizeCategory(String(r.category ?? "other"));
      const existing = bmsm().prepare("SELECT id FROM lots WHERE external_key=?").get(`legacy:${r.id}`) as { id: number } | undefined;
      if (existing) { lots += 1; continue; }
      bmsm().prepare(
        `INSERT INTO lots(external_key,title,category,category_normalized,brand,quantity,unit_price,total_price,condition,location,availability,state,raw_text,project_gate)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `legacy:${r.id}`, title, cat, cat, r.brand ?? null, r.stated_quantity ?? null,
        r.seller_ask_unit ?? null, r.seller_ask_total ?? null, r.condition ?? null, r.location ?? null,
        r.availability_status ?? "active", "matchable", "imported from Deal OS", r.project_status ?? "AMBER",
      );
      lots += 1;
    }
  }

  if (tableExists(src, "buyer_mandates")) {
    const rows = src.prepare("SELECT * FROM buyer_mandates WHERE superseded_by IS NULL").all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const map = bmsm().prepare("SELECT id FROM buyers WHERE legacy_buyer_id=?").get(r.buyer_id) as { id: number } | undefined;
      if (!map) continue;
      try {
        recordMandate({
          buyerId: map.id,
          category: String(r.category),
          stance: (r.stance as "accepts" | "rejects" | "unknown") ?? "unknown",
          origin: r.origin ? String(r.origin) : "operator",
          sourceUrl: r.source_url ? String(r.source_url) : "legacy-import",
          sourceQuote: r.source_quote ? String(r.source_quote) : "imported from Deal OS",
          minUnits: (r.min_units as number | null) ?? null,
          maxUnits: (r.max_units as number | null) ?? null,
        });
        mandates += 1;
      } catch { /* skip invalid */ }
    }
  }

  if (tableExists(src, "email_suppressions")) {
    const rows = src.prepare("SELECT address_or_domain, reason FROM email_suppressions").all() as Array<{ address_or_domain: string; reason: string }>;
    const ins = bmsm().prepare("INSERT OR IGNORE INTO suppressions(address_or_domain,reason,source) VALUES(?,?,?)");
    for (const r of rows) {
      ins.run(String(r.address_or_domain).toLowerCase(), r.reason ?? "legacy", "legacy");
      suppressions += 1;
    }
  }

  if (tableExists(src, "buyer_category_stats")) {
    const rows = src.prepare("SELECT * FROM buyer_category_stats").all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const map = bmsm().prepare("SELECT id FROM buyers WHERE legacy_buyer_id=?").get(r.buyer_id) as { id: number } | undefined;
      if (!map) continue;
      bmsm().prepare(
        `INSERT INTO buyer_category_stats(buyer_id,category,sends,replies,offers,closes,ignores,rejects)
         VALUES(?,?,?,?,?,?,0,0)
         ON CONFLICT(buyer_id,category) DO UPDATE SET sends=excluded.sends, replies=excluded.replies, offers=excluded.offers, closes=excluded.closes`
      ).run(map.id, r.category, r.sends ?? 0, r.replies ?? 0, r.offers ?? 0, r.closes ?? 0);
    }
  }

  src.close();
  audit("import", "legacy_complete", { detail: { buyers, lots, mandates, suppressions } });
  return { buyers, lots, mandates, suppressions };
}

if (require.main === module) {
  console.log(JSON.stringify(importLegacy(), null, 2));
}
