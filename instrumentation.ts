export async function register(): Promise<void> {
  // Next compiles this file for both Node and Edge. The import MUST stay inside
  // this compile-time check or Edge webpack will bundle better-sqlite3 and fail
  // on require('fs'). An early `if (edge) return` is not enough.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.BMSM_DISABLE_SCHEDULER === "1") return;
    const { startScheduler } = await import("./lib/orchestrator");
    startScheduler();
  }
}
