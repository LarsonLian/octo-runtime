#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { AdapterHost, AdapterHostRpcServer } from "@orbtex-ai/adapter-host";

const index = process.argv.indexOf("--manifest");
if (index < 0 || !process.argv[index + 1]) throw new Error("usage: orbtex-adapter-host --manifest <file>");
const manifestPath = resolve(process.argv[index + 1]);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const host = new AdapterHost();
for (const entry of manifest.adapters ?? []) {
  const specifier = entry.module.startsWith(".") || entry.module.startsWith("/")
    ? pathToFileURL(resolve(dirname(manifestPath), entry.module)).href
    : entry.module;
  const loaded = await import(specifier);
  const adapter = loaded[entry.export ?? "default"];
  if (!adapter) throw new Error(`missing export ${entry.export ?? "default"} from ${entry.module}`);
  const instance = typeof adapter === "function" && entry.factory ? adapter(entry.options ?? {}) : adapter;
  if (entry.type && instance.metadata?.type !== entry.type) throw new Error(`manifest type ${entry.type} does not match adapter ${instance.metadata?.type}`);
  host.register(instance);
}
new AdapterHostRpcServer({ host, output: process.stdout }).listen(process.stdin);
