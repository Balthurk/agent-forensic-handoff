#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`afh: ${error?.message || error}\n`);
  if (process.env.AFH_DEBUG) process.stderr.write(`${error?.stack || ""}\n`);
  process.exitCode = 1;
});
