export function wire(type, payload) {
  return JSON.stringify({
    version: 2,
    id: `wire-${Math.random()}`,
    type,
    sent_at: new Date().toISOString(),
    payload
  });
}

export function terminalGrant(event) {
  return {
    context_commit_granted: true,
    authoritative_terminal_status: "completed",
    authoritative_terminal_event_id: event.event_id
  };
}

export function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

export async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
