import test from "node:test";
import assert from "node:assert/strict";
import { startLogViewer } from "../apps/cli/dist/log-viewer.js";

test("trace viewer is loopback-only and protects its read API with a fragment capability", async () => {
  const viewer = await startLogViewer({
    query: async options => [{ ts: "2026-01-02T03:04:05.000Z", event: "adapter.selected", run_id: options.runId }]
  });
  try {
    const viewerUrl = new URL(viewer.url);
    const capability = viewerUrl.hash.slice(1);
    viewerUrl.hash = "";
    const page = await fetch(viewerUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Octo Harness Trace Viewer/);

    const api = new URL("/api/traces?runId=run-42", viewerUrl);
    assert.equal((await fetch(api)).status, 401);
    const response = await fetch(api, { headers: { Authorization: `Bearer ${capability}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      records: [{ ts: "2026-01-02T03:04:05.000Z", event: "adapter.selected", run_id: "run-42" }]
    });
  } finally {
    await viewer.close();
  }

  await assert.rejects(startLogViewer({ host: "0.0.0.0", query: async () => [] }), /loopback/);
});
