import "./env.js";

// Phase 0 placeholder. The Switch client arrives in Phase 2, detection in Phase 3.
console.log("[burn-watchdog] scaffold running. Switch client not implemented yet (Phase 2).");
console.log(
  `[burn-watchdog] AWS endpoint: ${process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566 (LocalStack default)"}`,
);

// Stay alive so the compose service doesn't restart-loop.
setInterval(() => {}, 60_000);
