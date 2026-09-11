import { tick, heartbeat } from "../lib/orchestrator";
import { researchTick } from "../lib/research";

const research = researchTick();
const orch = tick();
console.log(JSON.stringify({ research, orch, heartbeat: heartbeat() }, null, 2));
