import test from "node:test";
import assert from "node:assert/strict";
import { observeAcpToolStatus } from "../packages/octo-harness-adapter-sdk/dist/index.js";
test("unknown ACP state emits a bounded diagnostic without notification contents", async () => {
 const events = [], context = { observe: async event => { events.push(event); } };
 for (const status of [undefined,"pending","in_progress","completed","failed"]) observeAcpToolStatus(context,{sessionUpdate:"tool_call_update",status});
 assert.equal(events.length,0);
 observeAcpToolStatus(context,{sessionUpdate:"tool_call_update",status:"SECRET_UNKNOWN",rawOutput:"SECRET_OUTPUT"});
 assert.equal(events.length,1);
 assert.equal(events[0].data.diagnostic_code,"ACP_TOOL_STATUS_UNRECOGNIZED");
 assert.ok(!JSON.stringify(events).includes("SECRET"));
 observeAcpToolStatus({observe:async()=>{throw Error("unavailable")}}, {type:"tool_call_update",status:"unknown"});
 await new Promise(resolve=>setImmediate(resolve));
});
