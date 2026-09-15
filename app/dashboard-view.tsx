"use client";

import { useEffect, useState } from "react";
import type { DealDashboard } from "@/lib/dashboard";

const REFRESH_MS = 8000;

function num(n: number | null | undefined) {
  return n == null ? "—" : String(n);
}

function when(ts: string | null | undefined) {
  if (!ts) return "—";
  return ts.replace("T", " ").replace("Z", " UTC").slice(0, 22);
}

export function DashboardView() {
  const [data, setData] = useState<DealDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/dashboard", { cache: "no-store" });
        if (!r.ok) throw new Error(`dashboard ${r.status}`);
        const j = await r.json() as DealDashboard & { ok?: boolean };
        if (!cancelled) {
          setData(j);
          setError(null);
          setTick((n) => n + 1);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data) {
    return <div className="wrap"><p className="muted">{error ? `Dashboard error: ${error}` : "Loading live Deal OS…"}</p></div>;
  }

  const t = data.today;
  const sys = data.system;

  return (
    <div className="wrap dash">
      <header className="dash-head">
        <div>
          <h1>Deal OS</h1>
          <p className="muted">Live · auto-refresh 8s · confirmed actions only · #{tick}</p>
        </div>
        <p className="muted stamp">as of {when(data.generatedAt)}</p>
      </header>

      {data.blockers.length > 0 && (
        <section className="card warn" aria-label="Blockers">
          <h2>Blocking deal flow</h2>
          <ul>{data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </section>
      )}

      <section aria-label="Today">
        <h2 className="sec">Today</h2>
        <div className="grid">
          <div className="card"><h2>Confirmed sends</h2><div className="n">{t.sends}</div></div>
          <div className="card"><h2>Replies</h2><div className="n">{t.replies}</div></div>
          <div className="card"><h2>Phones captured</h2><div className="n">{t.phones}</div></div>
          <div className="card"><h2>Oliver delivered</h2><div className="n">{t.oliverDelivered}</div><p className="muted">queued {t.oliverQueued} — not counted</p></div>
          <div className="card"><h2>Bounces</h2><div className="n">{t.bounces}</div></div>
          <div className="card"><h2>Interested / warm</h2><div className="n">{t.warm}</div></div>
        </div>
      </section>

      <section aria-label="Live pipeline">
        <h2 className="sec">Live pipeline</h2>
        <div className="pipe">
          {data.pipeline.stages.map((s, i) => (
            <div key={s.key} className="card pipe-step">
              <h2>{s.label}</h2>
              <div className="n">{s.n}</div>
              {i > 0 && <p className="muted">from {data.pipeline.stages[i - 1].n}</p>}
            </div>
          ))}
        </div>
        {data.pipeline.bottleneck && (
          <p className="muted">Biggest drop: {data.pipeline.bottleneck.from} → {data.pipeline.bottleneck.to} (−{data.pipeline.bottleneck.drop})</p>
        )}
      </section>

      <section aria-label="Active lots">
        <h2 className="sec">Active lots</h2>
        {data.lots.length === 0 ? <p className="muted">None live</p> : (
          <table>
            <thead>
              <tr>
                <th>Lot</th><th>Product</th><th>Qty / price</th><th>Matches</th>
                <th>Sends</th><th>Today</th><th>Replies</th><th>Phones</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.lots.map((l) => (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td>{l.title}{l.brand ? ` · ${l.brand}` : ""}</td>
                  <td>{l.quantity ?? "—"}{l.unit_price != null ? ` / $${l.unit_price}` : ""}</td>
                  <td>{l.matches}</td>
                  <td>{l.sends}</td>
                  <td>{l.sendsToday}</td>
                  <td>{l.replies}</td>
                  <td>{l.phones}</td>
                  <td>{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Warmest">
        <h2 className="sec">Warmest right now</h2>
        {data.warmest.length === 0 ? <p className="muted">No warm replies yet today</p> : (
          <table>
            <thead><tr><th>Buyer</th><th>Phone</th><th>Interest</th><th>When</th></tr></thead>
            <tbody>
              {data.warmest.map((w) => (
                <tr key={`${w.id}-${w.created_at}`}>
                  <td>{w.company} · {w.domain}</td>
                  <td>{w.phone || "—"}</td>
                  <td>{w.interest_level} / {w.classification}</td>
                  <td>{when(w.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Agents">
        <h2 className="sec">Agents</h2>
        <table>
          <thead><tr><th>Agent</th><th>State</th><th>Doing</th><th>Last success</th><th>Next</th></tr></thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.id}>
                <td>{a.id}<div className="muted">{a.role}</div></td>
                <td className={`st-${a.status}`}>{a.status}</td>
                <td>{a.doing}</td>
                <td>{when(a.lastSuccessfulAt)}</td>
                <td>{when(a.nextRunAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Recent activity">
        <h2 className="sec">Recent activity</h2>
        <ul className="feed">
          {data.activity.map((r, i) => (
            <li key={`${r.at}-${r.kind}-${r.label}-${i}`}>
              <span className={`tag tag-${r.kind}`}>{r.kind}</span>
              <span>{r.label}{r.phone ? ` · ${r.phone}` : ""}{r.extra && r.kind !== "send" ? ` · ${r.extra}` : ""}</span>
              <span className="muted">{when(r.at)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card gmail-connect" aria-label="System">
        <h2>System</h2>
        <p>Engine {sys.engine} · kill {sys.kill ? "ON" : "off"} · sender {sys.sender} {sys.senderConnected ? "connected" : "down"}</p>
        <p className="muted">
          Saefam inbound {sys.legacyConnected ? "read-only connected" : "not connected"} ·
          domain cap {sys.domainCap}/day · daily volume cap {sys.dailyCap ?? "none"} ·
          rolling-day confirmed {sys.rollingDaySends} ·
          sendable now {num(sys.emailSendable)} · untouched {num(sys.eligibleUntouched)}
        </p>
        <p className="muted">
          Last confirmed send {when(sys.lastConfirmedSendAt)} ·
          last scheduler cycle {when(sys.scheduler.lastSuccessfulSchedulerCycleAt)} ·
          next tick {when(sys.nextTickAt)} ·
          {sys.scheduler.scheduler_unhealthy ? sys.scheduler.scheduler_unhealthy_reason : "scheduler healthy"}
        </p>
        {sys.cooldownUntil && <p className="muted">Gmail cooldown until {when(sys.cooldownUntil)}</p>}
        <a className="btn" href="/api/gmail/oauth/start">Reconnect sender</a>
        {" "}
        <a className="btn" href="/api/gmail/oauth/start?mailbox=legacy">Reconnect Saefam inbox</a>
        {error && <p className="muted">Last refresh error: {error}</p>}
      </section>
    </div>
  );
}
