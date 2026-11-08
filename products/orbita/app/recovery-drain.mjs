import {setTimeout as delay} from 'node:timers/promises';

export function recoveryWaitBudget(value=15000){
 if(!Number.isInteger(value)||value<50||value>30000)throw Error('RECOVERY_WAIT_BUDGET');
 return value;
}

// The caller first closes admission. Snapshot counts live handlers/transports,
// background finally blocks and automatic work, never only the HTTP method.
// Invoke run in the same event-loop turn as the final idle/authority checks.
export async function afterRecoveryDrain({snapshot,signal,waitTimeoutMs=15000,onWaiting,run}){
 const budget=recoveryWaitBudget(waitTimeoutMs),deadline=performance.now()+budget,deadlineAt=new Date(Date.now()+budget).toISOString();
 for(;;){
  signal?.throwIfAborted();const remaining=deadline-performance.now();
  if(remaining<=0)throw Error('RECOVERY_DRAIN_TIMEOUT');
  const pending=snapshot();
  if(![pending.http,pending.background,pending.automatic].every(n=>Number.isInteger(n)&&n>=0))throw Error('RECOVERY_ACTIVITY_INVALID');
  if(pending.http===0&&pending.background===0&&pending.automatic===0){signal?.throwIfAborted();return run();}
  onWaiting?.({state:'waiting',...pending,deadlineAt,waitTimeoutMs:budget});
  await delay(Math.min(25,remaining),undefined,{signal});
 }
}
