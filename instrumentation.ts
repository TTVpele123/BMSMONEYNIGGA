export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (process.env.BMSM_DISABLE_SCHEDULER === "1") return;
  const { startScheduler } = await import("./lib/orchestrator");
  startScheduler();
}
