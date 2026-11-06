import {execFile} from 'node:child_process';
export function terminateOwned(child){if(!child?.pid)return;if(process.platform==='win32')execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else child.kill('SIGKILL');}
