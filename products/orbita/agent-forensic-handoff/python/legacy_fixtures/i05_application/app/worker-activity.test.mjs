import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {WorkerActivity} from './worker-activity.mjs';

test('I04 A11 HTTP lease requires both handler and transport completion in either order',()=>{
 for(const order of ['handler-first','transport-first']){
  const activity=new WorkerActivity(),res=new EventEmitter(),done=activity.request(res);assert.equal(activity.quiesce('a'),false);
  if(order==='handler-first')done();else res.emit('close');assert.equal(activity.http,1);assert.equal(activity.quiesce('a'),false);
  if(order==='handler-first')res.emit('finish');else done();assert.equal(activity.http,0);done();res.emit('close');assert.equal(activity.http,0);
  assert.equal(activity.quiesce('a'),true);assert.equal(activity.request(new EventEmitter()),null);assert.equal(activity.quiesce('b'),false);assert.equal(activity.resume('b'),false);assert.equal(activity.resume('a'),true);
 }
});
test('I04 A11 background registration precedes work and includes actual finally cleanup and rejection',async()=>{
 const activity=new WorkerActivity();let release,entered=false,cleanup=false;const gate=new Promise(r=>release=r);
 const pending=activity.background(async()=>{entered=true;try{throw Error('actual work rejected');}finally{await gate;cleanup=true;}});const observed=assert.rejects(pending,/actual work rejected/);
 assert.equal(entered,false);assert.equal(activity.jobs.size,1);assert.equal(activity.quiesce('a'),false);await Promise.resolve();assert.equal(entered,true);assert.equal(cleanup,false);assert.equal(activity.quiesce('a'),false);
 release();await observed;assert.equal(cleanup,true);assert.equal(activity.jobs.size,0);assert.equal(activity.quiesce('a'),true);
});
