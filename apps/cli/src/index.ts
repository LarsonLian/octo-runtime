#!/usr/bin/env node
import { runCli } from "./main.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}
