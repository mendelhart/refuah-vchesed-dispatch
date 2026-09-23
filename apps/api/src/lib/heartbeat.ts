/** Written by the worker, read by the health checks. Kept separate to avoid an import cycle. */
export const workerHeartbeat: { lastTickAt: Date | null; lastHousekeepingAt: Date | null } = {
  lastTickAt: null,
  lastHousekeepingAt: null,
};
