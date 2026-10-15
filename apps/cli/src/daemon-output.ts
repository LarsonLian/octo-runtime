function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function formatDaemonResult(value: unknown): string {
  const result = record(value);
  const service = record(result.service);
  const application = record(result.readiness ?? result.application);
  const action = result.action;
  const lines = [
    action === "start" ? "Backend started successfully."
      : action === "restart" ? "Backend restarted successfully."
      : action === "stop" ? "Backend stopped successfully."
      : action === "install" ? "Background service installed successfully."
      : action === "uninstall" ? "Background service removed. Runtime Home and credentials preserved."
      : `Backend: ${application.ready === true ? "ready" : "not ready"}`,
    `Service: ${typeof service.state === "string" ? service.state : "unknown"} (${typeof service.manager === "string" ? service.manager : "unknown"})`
  ];
  if (action === "install") lines.push(`Start at login: ${service.enabled === true ? "enabled" : "disabled"}`, "Start the backend: octo-runtime daemon start");
  if (application.ready === true || application.extras !== undefined) {
    const adapters = Array.isArray(application.adapters) ? application.adapters.filter((item): item is string => typeof item === "string") : [];
    lines.push(`Adapters (${adapters.length}): ${adapters.join(", ") || "none detected"}`);
    const extras = Object.entries(record(application.extras));
    const active = extras.filter(([, state]) => record(state).phase === "loaded").map(([name]) => name);
    lines.push(`Active Extras: ${active.join(", ") || "none"}`);
    for (const [name, state] of extras) {
      const phase = record(state).phase;
      if (phase !== "loaded") lines.push(`  ${name}: ${typeof phase === "string" ? phase : "unknown"}`);
      if (Object.hasOwn(record(state), "status")) {
        lines.push(`\nExtra ${name}:`, JSON.stringify(record(state).status, null, 2));
      }
      if (record(state).status_error) lines.push(`  ${name}: status query failed (EXTRA_STATUS_FAILED)`);
    }
  }
  return lines.join("\n");
}
