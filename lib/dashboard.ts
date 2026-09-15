import { LIVE_DAILY_CAP, LIVE_DOMAIN_CAP, liveSentToday } from "./caps";
import { db, killSwitchOn } from "./db";
import { PREVIOUS_SENDER } from "./email/address";
import { activeSender, gmailConfigured, gmailSendCooldownUntil, senderPool } from "./email/provider";
import { legacyTokensPresent, tokensPresent } from "./email/tokens";
import { heartbeat } from "./orchestrator";
import { countEligibleUntouchedBuyers, eligibleActiveLotIds } from "./outbound-stall";

function parseDbUtc(ts: string): number {
  return Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}

const CONFIRMED = `status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''`;
const TODAY = `created_at >= datetime('now','start of day')`;
const REPLY = `classification NOT IN ('bounce','send_limit','out_of_office')`;

const GROK_AGENTS = [
  { id: "WHATSAPP_SCANNER", role: "Oliver WhatsApp ingest + handoff send" },
  { id: "BUYER_RESEARCHER", role: "Replenish high-quality fresh domains" },
  { id: "INBOUND_ANALYST", role: "Oliver handoff packets (scanner sends)" },
  { id: "FORM_OPERATOR", role: "Public wholesale forms" },
  { id: "OPPORTUNITY_RESEARCHER", role: "Lot-specific buyer opportunities" },
] as const;

function n(sql: string, ...params: unknown[]): number {
  return (db().prepare(sql).get(...params) as { n: number }).n;
}

function todayCounts() {
  const sends = n(`SELECT COUNT(*) AS n FROM outreach_attempts WHERE ${CONFIRMED} AND ${TODAY}`);
  const replies = n(`SELECT COUNT(*) AS n FROM inbound_events WHERE ${REPLY} AND ${TODAY}`);
  const phones = n(`SELECT COUNT(*) AS n FROM inbound_events WHERE ${TODAY} AND phone IS NOT NULL AND trim(phone)!=''`);
  const oliverQueued = n(`SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND state IN ('queued','claimed')`);
  const oliverDelivered = n(
    `SELECT COUNT(*) AS n FROM grok_jobs
      WHERE agent='INBOUND_ANALYST' AND state='done'
        AND COALESCE(finished_at, created_at) >= datetime('now','start of day')`,
  );
  const bounces = n(
    `SELECT COUNT(DISTINCT lower(from_address)) AS n FROM inbound_events
      WHERE classification='bounce' AND ${TODAY}
        AND from_address NOT LIKE '%mailer-daemon%'
        AND from_address NOT LIKE '%postmaster@%'`,
  );
  const warm = n(
    `SELECT COUNT(DISTINCT COALESCE(buyer_id, id)) AS n FROM inbound_events
      WHERE ${TODAY} AND (${REPLY}) AND (interest_level IN ('high','medium') OR classification='positive_interest')`,
  );
  return { sends, replies, phones, oliverDelivered, oliverQueued, bounces, warm };
}

function pipeline() {
  const found = n(`SELECT COUNT(*) AS n FROM buyers WHERE disqualified_reason IS NULL AND verification_status NOT IN ('mismatch_rejected','REJECTED')`);
  const contacted = n(
    `SELECT COUNT(DISTINCT buyer_id) AS n FROM outreach_attempts WHERE ${CONFIRMED}`,
  );
  const replied = n(
    `SELECT COUNT(DISTINCT buyer_id) AS n FROM inbound_events WHERE buyer_id IS NOT NULL AND ${REPLY}`,
  );
  const phones = n(
    `SELECT COUNT(DISTINCT buyer_id) AS n FROM inbound_events
      WHERE buyer_id IS NOT NULL AND ${REPLY} AND phone IS NOT NULL AND trim(phone)!=''`,
  );
  const oliver = n(
    `SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND state='done'`,
  );
  const warm = n(
    `SELECT COUNT(DISTINCT buyer_id) AS n FROM inbound_events
      WHERE buyer_id IS NOT NULL AND (interest_level IN ('high','medium') OR classification='positive_interest')`,
  );
  const stages = [
    { key: "found", label: "Buyer found", n: found },
    { key: "contacted", label: "Contacted", n: contacted },
    { key: "replied", label: "Replied", n: replied },
    { key: "phone", label: "Phone captured", n: phones },
    { key: "oliver", label: "Sent to Oliver", n: oliver },
    { key: "warm", label: "Warm / deal", n: warm },
  ];
  let bottleneck: { from: string; to: string; drop: number } | null = null;
  for (let i = 1; i < stages.length; i++) {
    const drop = stages[i - 1].n - stages[i].n;
    if (!bottleneck || drop > bottleneck.drop) {
      bottleneck = { from: stages[i - 1].label, to: stages[i].label, drop };
    }
  }
  return { stages, bottleneck };
}

function lotHasJson(id: number): string {
  return `EXISTS (SELECT 1 FROM json_each(oa.lot_ids) WHERE CAST(json_each.value AS INTEGER)=${id})`;
}

function activeLots() {
  const lots = db().prepare(
    `SELECT id, title, category, brand, quantity, unit_price, state, availability, project_gate
       FROM lots
      WHERE availability='active'
        AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
        AND state NOT IN ('paused','sold','archived')
      ORDER BY id`,
  ).all() as Array<{
    id: number; title: string; category: string; brand: string | null;
    quantity: number | null; unit_price: number | null; state: string;
    availability: string; project_gate: string;
  }>;
  return lots.map((lot) => {
    const matches = n(
      `SELECT COUNT(*) AS n FROM match_scores WHERE lot_id=? AND score>=0.45 AND hard_disqualified IS NULL`,
      lot.id,
    );
    const sends = n(
      `SELECT COUNT(*) AS n FROM outreach_attempts oa WHERE ${CONFIRMED} AND ${lotHasJson(lot.id)}`,
    );
    const sendsToday = n(
      `SELECT COUNT(*) AS n FROM outreach_attempts oa WHERE ${CONFIRMED} AND ${TODAY} AND ${lotHasJson(lot.id)}`,
    );
    const replies = n(
      `SELECT COUNT(*) AS n FROM inbound_events ie
        WHERE ie.buyer_id IS NOT NULL AND ${REPLY.replace(/classification/g, "ie.classification")}
          AND EXISTS (
            SELECT 1 FROM outreach_attempts oa
             WHERE oa.buyer_id=ie.buyer_id AND ${CONFIRMED} AND ${lotHasJson(lot.id)}
          )`,
    );
    const phones = n(
      `SELECT COUNT(DISTINCT ie.buyer_id) AS n FROM inbound_events ie
        WHERE ie.buyer_id IS NOT NULL AND ie.phone IS NOT NULL AND trim(ie.phone)!=''
          AND EXISTS (
            SELECT 1 FROM outreach_attempts oa
             WHERE oa.buyer_id=ie.buyer_id AND ${CONFIRMED} AND ${lotHasJson(lot.id)}
          )`,
    );
    let status = lot.state;
    if (sends === 0 && matches === 0) status = "needs buyers";
    else if (sends === 0) status = "matched, not sent";
    else if (phones > 0) status = "phone in hand";
    else if (replies > 0) status = "replies in";
    else status = "waiting on replies";
    return {
      id: lot.id,
      title: lot.title,
      category: lot.category,
      brand: lot.brand,
      quantity: lot.quantity,
      unit_price: lot.unit_price,
      matches,
      sends,
      sendsToday,
      replies,
      phones,
      status,
    };
  });
}

function lastJob(agent: string) {
  return db().prepare(
    `SELECT id, state, created_at, claimed_at, finished_at, substr(instruction,1,100) AS instruction
       FROM grok_jobs WHERE agent=? ORDER BY id DESC LIMIT 1`,
  ).get(agent) as {
    id: number; state: string; created_at: string; claimed_at: string | null;
    finished_at: string | null; instruction: string;
  } | undefined;
}

function agents(nextTickAt: string | null) {
  const pendingResearch = n(`SELECT COUNT(*) AS n FROM research_jobs WHERE state IN ('pending','running')`);
  const lastBuyer = db().prepare(`SELECT created_at, company, domain FROM buyers ORDER BY id DESC LIMIT 1`).get() as
    | { created_at: string; company: string; domain: string }
    | undefined;
  const lastScan = db().prepare(`SELECT scanned_at FROM whatsapp_messages ORDER BY id DESC LIMIT 1`).get() as
    | { scanned_at: string }
    | undefined;
  const claimedInbound = n(`SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND state='claimed'`);
  const queuedInbound = n(`SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND state IN ('queued','claimed')`);

  return GROK_AGENTS.map((agent) => {
    const job = lastJob(agent.id === "WHATSAPP_SCANNER" ? "INBOUND_ANALYST" : agent.id);
    let status: "working" | "idle" | "blocked" = "idle";
    let doing = "idle — waiting for next autonomy tick";
    let lastOk: string | null = job?.state === "done" ? (job.finished_at ?? job.created_at) : null;

    if (agent.id === "WHATSAPP_SCANNER") {
      if (claimedInbound) {
        status = "working";
        doing = job?.instruction || "sending Oliver handoff";
      } else if (queuedInbound) {
        status = "working";
        doing = `${queuedInbound} Oliver handoff(s) queued`;
      }
      if (lastScan?.scanned_at && (!lastOk || lastScan.scanned_at > lastOk)) lastOk = lastScan.scanned_at;
    } else if (agent.id === "BUYER_RESEARCHER" || agent.id === "OPPORTUNITY_RESEARCHER") {
      if (pendingResearch) {
        status = "working";
        doing = `${pendingResearch} discover job(s) pending`;
      }
      if (lastBuyer) lastOk = lastBuyer.created_at;
    } else if (job?.state === "claimed") {
      status = "working";
      doing = job.instruction;
    } else if (job?.state === "queued") {
      status = "working";
      doing = `queued #${job.id}: ${job.instruction}`;
    } else if (job?.state === "failed") {
      status = "blocked";
      doing = `last job #${job.id} failed`;
    } else if (job?.state === "done") {
      doing = `last job #${job.id} done`;
    }

    if (killSwitchOn()) {
      status = "blocked";
      doing = "kill switch on";
    }

    return {
      id: agent.id,
      role: agent.role,
      status,
      doing,
      lastSuccessfulAt: lastOk,
      nextRunAt: nextTickAt,
    };
  });
}

function activity() {
  const sends = db().prepare(
    `SELECT oa.created_at AS at, 'send' AS kind, b.company AS label, oa.lot_ids AS extra, NULL AS phone
       FROM outreach_attempts oa JOIN buyers b ON b.id=oa.buyer_id
      WHERE ${CONFIRMED} ORDER BY oa.id DESC LIMIT 20`,
  ).all() as ActivityRow[];
  const inbound = db().prepare(
    `SELECT created_at AS at,
            CASE WHEN classification='bounce' THEN 'bounce'
                 WHEN phone IS NOT NULL AND trim(phone)!='' THEN 'phone'
                 ELSE 'reply' END AS kind,
            COALESCE(from_address, classification) AS label,
            classification AS extra,
            phone
       FROM inbound_events
      WHERE classification NOT IN ('send_limit')
        AND NOT (classification='bounce' AND (from_address LIKE '%mailer-daemon%' OR from_address LIKE '%postmaster@%'))
      ORDER BY id DESC LIMIT 20`,
  ).all() as ActivityRow[];
  const buyers = db().prepare(
    `SELECT created_at AS at, 'research' AS kind, company || ' · ' || domain AS label, NULL AS extra, NULL AS phone
       FROM buyers ORDER BY id DESC LIMIT 15`,
  ).all() as ActivityRow[];
  const oliver = db().prepare(
    `SELECT COALESCE(finished_at, created_at) AS at, 'oliver' AS kind,
            'Oliver handoff #' || id AS label, state AS extra, NULL AS phone
       FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND state='done'
       ORDER BY id DESC LIMIT 10`,
  ).all() as ActivityRow[];
  const jobs = db().prepare(
    `SELECT COALESCE(finished_at, claimed_at, created_at) AS at, 'agent' AS kind,
            agent || ' ' || state || ' #' || id AS label, substr(instruction,1,80) AS extra, NULL AS phone
       FROM grok_jobs ORDER BY id DESC LIMIT 15`,
  ).all() as ActivityRow[];
  return [...sends, ...inbound, ...buyers, ...oliver, ...jobs]
    .filter((r) => r.at)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 40);
}

type ActivityRow = { at: string; kind: string; label: string; extra: string | null; phone: string | null };

function leadNextAction(buyerId: number, phone: string | null): string {
  if (phone) {
    const handed = n(
      `SELECT COUNT(*) AS n FROM escalations WHERE buyer_id=? AND state='handed_to_oliver' AND phone IS NOT NULL AND trim(phone)!=''`,
      buyerId,
    );
    if (handed) return "Handed to Oliver — keep this deal warm";
    const queued = n(
      `SELECT COUNT(*) AS n FROM grok_jobs
        WHERE agent='INBOUND_ANALYST' AND state IN ('queued','claimed')
          AND (instruction LIKE '%' || ? || '%' OR input LIKE '%' || ? || '%')`,
      phone,
      phone,
    );
    if (queued) return "Oliver handoff queued — scanner must send";
    return "Phone in hand — queue Oliver now";
  }
  return "Awaiting their phone — conversation is live";
}

function warmest() {
  const rows = db().prepare(
    `SELECT b.id, b.company, b.domain, ie.phone, ie.interest_level, ie.classification, ie.created_at,
            (SELECT oa.lot_ids FROM outreach_attempts oa WHERE oa.buyer_id=b.id AND ${CONFIRMED} ORDER BY oa.id DESC LIMIT 1) AS lot_ids
       FROM inbound_events ie
       JOIN buyers b ON b.id=ie.buyer_id
      WHERE ie.id IN (
        SELECT MAX(ie2.id) FROM inbound_events ie2
         WHERE ie2.buyer_id IS NOT NULL
           AND ie2.classification NOT IN ('bounce','send_limit','out_of_office','unsubscribe','suspicious','not_interested')
           AND (
             (ie2.phone IS NOT NULL AND trim(ie2.phone)!='')
             OR ie2.interest_level IN ('high','medium')
             OR ie2.classification IN ('positive_interest','information_request','request_call','counterprice')
           )
         GROUP BY ie2.buyer_id
      )
      ORDER BY CASE WHEN date(ie.created_at)=date('now') THEN 0 ELSE 1 END,
               CASE WHEN ie.phone IS NOT NULL AND trim(ie.phone)!='' THEN 0 ELSE 1 END,
               CASE ie.interest_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               ie.id DESC
      LIMIT 3`,
  ).all() as Array<{
    id: number; company: string; domain: string; phone: string | null;
    interest_level: string; classification: string; created_at: string; lot_ids: string | null;
  }>;
  return rows.map((w) => ({
    ...w,
    nextAction: leadNextAction(w.id, w.phone),
  }));
}

export function dealDashboard() {
  const today = todayCounts();
  const beat = heartbeat();
  const cooldown = gmailSendCooldownUntil();
  const senders = senderPool();
  const currentSender = activeSender();
  const lastCycle = db().prepare(
    "SELECT at FROM audit_log WHERE actor='orchestrator' AND action='scheduler_cycle' ORDER BY id DESC LIMIT 1",
  ).get() as { at: string } | undefined;
  const lastSend = db().prepare(
    `SELECT created_at FROM outreach_attempts WHERE ${CONFIRMED} ORDER BY created_at DESC LIMIT 1`,
  ).get() as { created_at: string } | undefined;
  const lastCycleAt = lastCycle?.at ?? null;
  const minutesSinceCycle = lastCycleAt != null ? (Date.now() - parseDbUtc(lastCycleAt)) / 60_000 : null;
  const sched = {
    schedulerStartedAt: null as string | null,
    schedulerVersion: "runSchedulerCycle/v1",
    lastSuccessfulSchedulerCycleAt: lastCycleAt,
    minutesSinceLastSchedulerCycle: minutesSinceCycle == null ? null : Number(minutesSinceCycle.toFixed(1)),
    scheduler_unhealthy: minutesSinceCycle != null && minutesSinceCycle >= 12,
    scheduler_unhealthy_reason: minutesSinceCycle != null && minutesSinceCycle >= 12 ? "scheduler_cycle_stale" : null,
  };
  const minutesSinceSend = lastSend ? (Date.now() - parseDbUtc(lastSend.created_at)) / 60_000 : null;
  const eligibleUntouched = n(
    `SELECT COUNT(*) AS n FROM buyers b
      WHERE b.disqualified_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM outreach_attempts oa WHERE oa.buyer_id=b.id AND ${CONFIRMED})`,
  );
  const sendCapacity = countEligibleUntouchedBuyers(eligibleActiveLotIds());
  const nextTickAt = lastCycleAt
    ? new Date(parseDbUtc(lastCycleAt) + 300_000).toISOString()
    : null;
  const blockers: string[] = [];
  if (beat.kill) blockers.push("kill switch on");
  if (beat.mode !== "live") blockers.push(`outbound mode ${beat.mode}`);
  if (!senders.some((s) => s.send)) blockers.push("Gmail sender not connected");
  if (!legacyTokensPresent()) blockers.push("Saefam inbox not connected");
  if (cooldown) blockers.push(`Gmail 429 cooldown until ${cooldown.toISOString()}`);
  const saefam = senders.find((s) => s.address === PREVIOUS_SENDER);
  if (saefam && saefam.connected && !saefam.send) {
    blockers.push("Saefam recovered — reconnect with send to join the sender pool");
  }
  if (minutesSinceSend != null && minutesSinceSend >= 15) blockers.push("no_confirmed_send_15m");
  if (today.oliverQueued) blockers.push(`${today.oliverQueued} Oliver handoff(s) queued — not delivered`);

  return {
    generatedAt: new Date().toISOString(),
    today,
    lots: activeLots(),
    agents: agents(nextTickAt),
    pipeline: pipeline(),
    activity: activity(),
    warmest: warmest(),
    system: {
      engine: beat.mode,
      kill: beat.kill,
      listening: true,
      sender: currentSender,
      senderConnected: senders.some((s) => s.send) || tokensPresent(),
      configuredForSend: gmailConfigured(),
      senders,
      legacyInbox: PREVIOUS_SENDER,
      legacyConnected: legacyTokensPresent(),
      domainCap: LIVE_DOMAIN_CAP,
      dailyCap: LIVE_DAILY_CAP,
      rollingDaySends: liveSentToday(),
      emailSendable: sendCapacity.email,
      eligibleUntouched,
      lastConfirmedSendAt: lastSend?.created_at ?? null,
      cooldownUntil: cooldown?.toISOString() ?? null,
      scheduler: sched,
      nextTickAt,
      queuedOliverHandoffs: today.oliverQueued,
    },
    blockers,
  };
}

export type DealDashboard = ReturnType<typeof dealDashboard>;
