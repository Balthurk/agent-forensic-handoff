import fs from 'node:fs';
import {volumeOperation,volumeWorker} from './volume.mjs';
import {closeCommonStore} from '../agent-forensic-handoff/src/common-store.js';
try{const input=JSON.parse(fs.readFileSync(process.argv[2]||0,'utf8'));const result=['export-parquet','verify-export'].includes(input.op)?await volumeWorker(input):await volumeOperation(input);process.stdout.write(JSON.stringify(result,null,2)+'\n');}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}finally{closeCommonStore();}
