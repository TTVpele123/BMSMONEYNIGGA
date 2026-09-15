import { heartbeat, runSchedulerCycle } from "../lib/orchestrator";

const cycle = await runSchedulerCycle();
console.log(JSON.stringify({ ...cycle, heartbeat: heartbeat() }, null, 2));
