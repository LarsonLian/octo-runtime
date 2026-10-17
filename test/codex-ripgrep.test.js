import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexEvent } from "@mininglamp-oss/octo-runtime-adapter-codex";

function completed(item) {
  return normalizeCodexEvent({ method: "item/completed", params: { item } })[0].payload;
}

test("Codex treats ripgrep no-match as a completed check without hiding command errors", () => {
  assert.deepEqual(
    completed({
      type: "commandExecution",
      id: "rg-direct",
      command: "rg -n TODO index.html",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: ""
    }),
    {
      id: "rg-direct",
      status: "completed",
      output: "",
      exitCode: 1
    }
  );
  assert.equal(
    completed({
      type: "commandExecution",
      id: "rg-chained",
      command: "/bin/zsh -lc \"git diff --check -- index.html && rg -n 'TODO|FIXME' index.html\"",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: ""
    }).status,
    "completed"
  );
  assert.equal(
    completed({
      type: "commandExecution",
      id: "rg-error",
      command: "rg TODO missing-dir",
      status: "failed",
      exitCode: 2,
      aggregatedOutput: "rg: missing-dir: No such file or directory"
    }).status,
    "failed"
  );
  assert.equal(
    completed({
      type: "commandExecution",
      id: "other-error",
      command: "false",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: ""
    }).status,
    "failed"
  );
});
