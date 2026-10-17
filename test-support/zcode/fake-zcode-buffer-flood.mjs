import { createInterface } from "node:readline";
const mode = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  send({ id: request.id, result: request.method === "session/create" ? { sessionId: "s" } : {} });
  if (request.method !== "session/send") return;
  setTimeout(() => {
    if (mode === "complete") {
      send({
        method: "session/event",
        params: {
          sessionId: "s",
          seq: 1,
          type: "turn.completed",
          payload: { resultType: "success" }
        }
      });
      process.exit(0);
    }
    if (mode === "line") {
      process.stdout.write("x".repeat(256 * 1024 + 1));
      return;
    }
    for (let i = 1; i <= (mode === "count" ? 4100 : 70); i++)
      send({
        method: "session/event",
        params: {
          sessionId: "s",
          seq: i,
          type: "model.streaming",
          payload: { kind: "text_delta", delta: mode === "count" ? "x" : "x".repeat(64 * 1024) }
        }
      });
  }, 10);
});
