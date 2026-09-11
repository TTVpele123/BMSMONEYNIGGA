import { getSetting, killSwitchOn, setSetting, audit } from "@/lib/db";

export async function GET() {
  return Response.json({ kill_switch: killSwitchOn(), outbound_mode: getSetting("outbound_mode", "dry_run") });
}

export async function POST(req: Request) {
  const body = await req.json() as { kill?: boolean; outbound_mode?: string };
  if (typeof body.kill === "boolean") {
    setSetting("kill_switch", body.kill ? "true" : "false");
    audit("ops", body.kill ? "kill_on" : "kill_off", {});
  }
  if (body.outbound_mode === "dry_run" || body.outbound_mode === "live") {
    setSetting("outbound_mode", body.outbound_mode);
  }
  return Response.json({ kill_switch: killSwitchOn(), outbound_mode: getSetting("outbound_mode") });
}
