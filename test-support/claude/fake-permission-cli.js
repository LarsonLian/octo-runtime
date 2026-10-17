import { createInterface } from "node:readline";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let pending = false;
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.type === "user") {
    pending = true;
    emit({
      type: "control_request",
      request_id: "permission-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "printf approval-fixture" },
        tool_use_id: "tool-1"
      }
    });
  } else if (value.type === "control_response" && pending) {
    if (value.response.request_id !== "permission-1") throw new Error("wrong permission request");
    const decision = value.response.response;
    if (
      decision.behavior === "allow" &&
      decision.updatedInput.command !== "printf approval-fixture"
    )
      throw new Error("tool input changed");
    emit({ type: "result", subtype: "success", result: `permission:${decision.behavior}` });
    break;
  }
}
