import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "../lib/db";
import { ingestWhatsApp } from "../lib/intake";
import {
  discoverQuery,
  enqueueResearch,
  expireIneligibleResearchJobs,
  pendingDiscoverQueue,
  researchTick,
} from "../lib/research";
import { writeTestPng } from "./png";

let photoNonce = 0;
function seedLot(title: string, withPhoto: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-p03-"));
  const photo = path.join(dir, `${title.replace(/\s+/g, "-")}.jpg`);
  photoNonce += 1;
  writeTestPng(photo, 420 + photoNonce * 8, 220 + photoNonce * 4);
  const ingested = ingestWhatsApp({
    chat: "oliver",
    scanned_at: new Date().toISOString(),
    messages: [{
      id: `wa-${title}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      text: `${title} 1000 units $4`,
      media: withPhoto ? [{ filename: path.basename(photo), path: photo }] : [],
    }],
  });
  return db().prepare("SELECT id, title, category, state, availability, project_gate FROM lots WHERE id=?").get(ingested.lotsTouched[0]) as {
    id: number; title: string; category: string; state: string; availability: string; project_gate: string;
  };
}

describe("P0 #3 research job expiry and per-lot dedupe", () => {
  it("cancels media-less/paused jobs, expires generic pre-gate jobs, and keeps eligible ones", () => {
    const good = seedLot("Licensed NFL apparel", true);
    const bad = seedLot("No photo lot", false);
    db().prepare(
      "INSERT INTO research_jobs(kind,query,state) VALUES('discover',?,'pending')"
    ).run(discoverQuery(good));
    db().prepare(
      "INSERT INTO research_jobs(kind,query,state) VALUES('discover',?,'pending')"
    ).run(discoverQuery(bad));
    db().prepare(
      "INSERT INTO research_jobs(kind,query,state) VALUES('discover',?,'pending')"
    ).run("licensed apparel closeout wholesale buyers");
    const extra = db().prepare(
      "INSERT INTO research_jobs(kind,query,lot_id,state) VALUES('discover',?,?,'pending')"
    ).run(`wholesale buyers ${good.category} ${good.title} again`, good.id);

    const before = (db().prepare("SELECT COUNT(*) AS n FROM research_jobs").get() as { n: number }).n;
    const result = expireIneligibleResearchJobs();
    expect(result.cancelled).toBe(2);
    expect(result.expired).toBe(1);
    expect(result.kept).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM research_jobs").get() as { n: number }).n).toBe(before);

    const badRow = db().prepare("SELECT state, last_error, lot_id FROM research_jobs WHERE query=?").get(discoverQuery(bad)) as {
      state: string; last_error: string; lot_id: number;
    };
    expect(badRow.state).toBe("cancelled");
    expect(badRow.lot_id).toBe(bad.id);
    expect(badRow.last_error).toMatch(/media-less or paused/);

    const generic = db().prepare("SELECT state FROM research_jobs WHERE query='licensed apparel closeout wholesale buyers'").get() as { state: string };
    expect(generic.state).toBe("expired");

    const extraRow = db().prepare("SELECT state FROM research_jobs WHERE id=?").get(Number(extra.lastInsertRowid)) as { state: string };
    expect(extraRow.state).toBe("cancelled");

    const kept = pendingDiscoverQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0].lotId).toBe(good.id);
  });

  it("enqueues at most one pending discover job per media-eligible lot and never for media-less lots", () => {
    const good = seedLot("Licensed NFL hoodies", true);
    const bad = seedLot("Media-less leftovers", false);
    expect(enqueueResearch("discover", discoverQuery(bad), bad.id)).toBe(0);
    expect(enqueueResearch("discover", "licensed apparel closeout wholesale buyers")).toBe(0);

    const first = enqueueResearch("discover", discoverQuery(good), good.id);
    const second = enqueueResearch("discover", `other query for ${good.title}`, good.id);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(pendingDiscoverQueue().filter((j) => j.lotId === good.id)).toHaveLength(1);

    const tick1 = researchTick();
    const tick2 = researchTick();
    expect(tick2.queued).toBe(0);
    const pending = pendingDiscoverQueue();
    expect(pending.every((j) => j.lotId === good.id)).toBe(true);
    expect(pending).toHaveLength(1);
    expect(tick1.seeded).toBe(1);
  });
});
