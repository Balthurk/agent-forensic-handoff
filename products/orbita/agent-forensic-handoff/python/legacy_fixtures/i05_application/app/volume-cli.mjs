import fs from 'node:fs';
import {volumeOperation} from './volume.mjs';
try{const input=JSON.parse(fs.readFileSync(process.argv[2]||0,'utf8'));process.stdout.write(JSON.stringify(await volumeOperation(input),null,2)+'\n');}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
