process.env.BMSM_TEST_MODE = "1";
process.env.OUTBOUND_MODE = "dry_run";
process.env.KILL_SWITCH = "false";
process.env.BMSM_DISABLE_SCHEDULER = "1";

import { afterEach } from "vitest";
import { resetDbForTests } from "../lib/db";
import { setGmailClient } from "../lib/email/provider";
import { resetSchedulerRuntimeForTests } from "../lib/orchestrator";

afterEach(() => {
  process.env.OUTBOUND_MODE = "dry_run";
  process.env.KILL_SWITCH = "false";
  process.env.BMSM_DISABLE_SCHEDULER = "1";
  setGmailClient(null);
  resetSchedulerRuntimeForTests();
  resetDbForTests();
});
