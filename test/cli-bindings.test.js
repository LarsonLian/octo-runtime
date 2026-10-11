import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareCliBindings } from "../packages/octo-harness-daemon/dist/cli-bindings.js";

const exec = promisify(execFile);
test("Run launchers isolate credentials and safely forward arguments", async t => {
 const root = await mkdtemp(join(tmpdir(), "octo-cli binding-'"));
 t.after(() => rm(root, {recursive:true,force:true}));
 const bin = join(root,"bin"); await mkdir(bin);
 // Fixture only prints file contents so the test can compare separate Run identities.
 await writeFile(join(bin,"fixture-cli"), '#!/bin/sh\ncat "$TEST_CREDENTIAL_FILE"\nprintf "\\n%s\\n%s\\n%s\\n" "$1" "$TEST_FIXED" "${TEST_STALE-unset}"\n',{mode:0o700});
 const doc=JSON.stringify({schema:"octo.cli-bindings/v1",bindings:[{command:"fixture-cli",server:"fleet",credential_file_env:"TEST_CREDENTIAL_FILE",env:{TEST_FIXED:"quote' and $(no-command)"},unset_env:["TEST_STALE"]}]});
 const cleanup=[];
 const prepare=token=>prepareCliBindings(doc,{stateRoot:root,searchPath:bin,selectedServers:new Set(["fleet"]),credentials:{fleet:{Authorization:"Bearer octo_run_"+token,"X-Space-ID":"space","X-Namespace":"im"}},registerCleanup:path=>cleanup.push(path)});
 const [a,b]=await Promise.all([prepare("a"),prepare("b")]);
 assert.notEqual(a[0].path,b[0].path);
 for (const [bindings,token] of [[a,"a"],[b,"b"]]) {
  const launcher=await readFile(bindings[0].path,"utf8"); assert.ok(!launcher.includes("octo_run_"));
  const output=await exec(bindings[0].path,["literal ' $(no-command)"],{env:{...process.env,TEST_STALE:"old"}});
  const lines=output.stdout.trim().split("\n");
  assert.equal(JSON.parse(lines[0]).Authorization,"Bearer octo_run_"+token);
  assert.equal(lines[1],"literal ' $(no-command)"); assert.equal(lines[2],"quote' and $(no-command)"); assert.equal(lines[3],"unset");
 }
 for (const path of cleanup) {assert.equal((await stat(join(path,"credentials.json"))).mode&0o777,0o600);await rm(path,{recursive:true});}
 await assert.rejects(exec(a[0].path,[]),/ENOENT/);
 await assert.rejects(prepareCliBindings(doc,{stateRoot:root,searchPath:bin,selectedServers:new Set(),credentials:{},registerCleanup:()=>{}}),/INVALID/);
 await assert.rejects(prepareCliBindings(doc,{stateRoot:root,searchPath:bin,selectedServers:new Set(["fleet"]),credentials:{},registerCleanup:()=>{}}),/CREDENTIALS_REQUIRED/);
});
