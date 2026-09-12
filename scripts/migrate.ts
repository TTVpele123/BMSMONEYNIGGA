import { db } from "../lib/db";
import { applyP0Repairs } from "../lib/repairs";
import { expireIneligibleResearchJobs, pendingDiscoverQueue, researchTick } from "../lib/research";

db();
const repairs = applyP0Repairs();
const research = expireIneligibleResearchJobs();
const tick = researchTick();
console.log("schema applied", JSON.stringify({
  repairs,
  research: { cancelled: research.cancelled, expired: research.expired, kept: research.kept, jobs: research.jobs },
  tick,
  pending: pendingDiscoverQueue(),
}));
