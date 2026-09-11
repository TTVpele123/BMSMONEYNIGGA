import { db, getSetting, killSwitchOn, outboundMode } from "@/lib/db";
import { northStar } from "@/lib/orchestrator";
import { openHandoffs } from "@/lib/escalate";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const ns = northStar();
  const lots = db().prepare("SELECT id, title, category, state, quantity FROM lots ORDER BY id DESC LIMIT 20").all() as Array<{ id: number; title: string; category: string; state: string; quantity: number | null }>;
  const convos = db().prepare(
    `SELECT c.id, c.state, c.channel, b.company FROM conversations c JOIN buyers b ON b.id=c.buyer_id ORDER BY c.id DESC LIMIT 20`
  ).all() as Array<{ id: number; state: string; channel: string; company: string }>;
  const lastScan = db().prepare("SELECT scanned_at, COUNT(*) AS n FROM whatsapp_messages GROUP BY scanned_at ORDER BY scanned_at DESC LIMIT 1").get() as { scanned_at: string; n: number } | undefined;
  const handoffs = openHandoffs();

  return (
    <div className="wrap">
      <h1>BMSMONEYNIGGA</h1>
      <p className="muted">Autonomous deal engine · mode {outboundMode()} · kill {killSwitchOn() ? "ON" : "off"} · sender {getSetting("authorized_sender")}</p>
      <div className="grid">
        <div className="card"><h2>Conversations / lot</h2><div className="n">{ns.conversations_per_lot}</div></div>
        <div className="card"><h2>Qualified convos</h2><div className="n">{ns.qualified_conversations}</div></div>
        <div className="card"><h2>Active lots</h2><div className="n">{ns.active_lots}</div></div>
        <div className="card"><h2>Deals / lot</h2><div className="n">{ns.deals_per_lot}</div></div>
      </div>
      <p>Last WhatsApp scan: {lastScan ? `${lastScan.scanned_at} (${lastScan.n} messages)` : "none yet"}</p>
      <h2>Open Oliver handoffs</h2>
      {handoffs.length === 0 ? <p className="muted">None</p> : handoffs.map((h) => <pre key={h.id} className="card">{h.packet}</pre>)}
      <h2>Lots</h2>
      <table>
        <thead><tr><th>ID</th><th>Title</th><th>Category</th><th>Qty</th><th>State</th></tr></thead>
        <tbody>
          {lots.map((l) => <tr key={l.id}><td>{l.id}</td><td>{l.title}</td><td>{l.category}</td><td>{l.quantity ?? "—"}</td><td>{l.state}</td></tr>)}
        </tbody>
      </table>
      <h2>Conversations</h2>
      <table>
        <thead><tr><th>ID</th><th>Buyer</th><th>Channel</th><th>State</th></tr></thead>
        <tbody>
          {convos.map((c) => <tr key={c.id}><td>{c.id}</td><td>{c.company}</td><td>{c.channel}</td><td>{c.state}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
