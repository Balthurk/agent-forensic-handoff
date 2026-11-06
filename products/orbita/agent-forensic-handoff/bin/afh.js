#!/usr/bin/env node
import { main } from "../src/cli.js";
import {closeCommonStore} from '../src/common-store.js';

async function run(){
  try{await main(process.argv.slice(2));}
  finally{closeCommonStore();}
}
run().catch((error) => {
  process.stderr.write(`afh: ${error?.message || error}\n`);
  if (process.env.AFH_DEBUG) process.stderr.write(`${error?.stack || ""}\n`);
  process.exitCode = 1;
});
