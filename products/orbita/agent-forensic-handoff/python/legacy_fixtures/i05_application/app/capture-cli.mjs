import fs from 'node:fs';
import {registerCapture,captureOnce,captureStatus} from './capture.mjs';
const request=JSON.parse(fs.readFileSync(0,'utf8'));
try{let result;if(request.op==='register')result=registerCapture(request.source,request.allowPaths);else if(request.op==='capture')result=await captureOnce(request.id,request.allowPaths,request.options);else if(request.op==='status')result=captureStatus();else throw new Error('UNKNOWN_CAPTURE_OPERATION');process.stdout.write(JSON.stringify({ok:true,result}));}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
