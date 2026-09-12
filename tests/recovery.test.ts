import { describe, expect, it } from "vitest";
import { db } from "../lib/db";
import { emit, markFailed, unprocessedEvents } from "../lib/events";
import { tick } from "../lib/orchestrator";

describe("queue recovery", () => {
  it("retries failed handlers and dead-letters after 5 failures", async () => {
    const id = emit("match.requested", { lotId: 999999 }, "retry-missing-lot");
    // handler throws because lot missing? runMatching returns {0,0} without throw.
    // Force a poison event type via direct SQL.
    db().prepare("UPDATE events SET type='not.a.real.event' WHERE id=?").run(id);
    for (let i = 0; i < 5; i++) await tick();
    const row = db().prepare("SELECT processed_at, attempts, last_error FROM events WHERE id=?").get(id) as { processed_at: string | null; attempts: number; last_error: string };
    expect(row.attempts).toBeGreaterThanOrEqual(5);
    expect(row.processed_at).not.toBeNull();
    expect(row.last_error).toMatch(/unknown event/);
  });

  it("does not reprocess completed events", async () => {
    emit("research.tick", { queued: 0 }, "once");
    const a = await tick();
    const b = await tick();
    expect(a.processed).toBeGreaterThanOrEqual(1);
    expect(b.processed).toBe(0);
    expect(unprocessedEvents().length).toBe(0);
  });

  it("markFailed increments attempts", () => {
    const id = emit("learning.recorded", {}, "fail-me");
    markFailed(id, "boom");
    const row = db().prepare("SELECT attempts, last_error, processed_at FROM events WHERE id=?").get(id) as { attempts: number; last_error: string; processed_at: string | null };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("boom");
    expect(row.processed_at).toBeNull();
  });
});
