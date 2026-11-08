import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryStatusText,recoveryJobText} from './web/recovery-display.mjs';

test('I08 imported PG01 control retains its provenance without inventing restored files or dates',()=>{
 const state=Object.freeze({schema:'orbita-restore-2',id:'synthetic',sourceFormat:'orbita-legacy-plan-2',planSha256:'a'.repeat(64),automaticWork:false,externalAccess:false});
 const text=recoveryStatusText(state);assert.match(text,/Importación registrada en PostgreSQL/);assert.doesNotMatch(text,/undefined|Invalid Date|Última restauración/);assert.match(text,/pausadas/);
 for(const sourceFormat of ['orbita-legacy-plan-1','orbita-legacy-plan-2'])assert.match(recoveryStatusText({...state,sourceFormat}),/^Importación/);
});
test('I08 current and legacy recovery receipts display only their actual available metadata',()=>{
 for(const detail of [{files:0},{archiveFiles:42}]){
  const text=recoveryStatusText({restoredAt:'2026-11-01T12:00:00Z',automaticWork:true,externalAccess:false,...detail});
  assert.match(text,/Última restauración registrada/);assert.match(text,new RegExp(`${detail.files??detail.archiveFiles} archivos`));assert.match(text,/Fecha de restauración/);assert.match(text,/Automáticas: activas/);
 }
 for(const bad of [undefined,null,'',false,'not-a-date'])assert.doesNotMatch(recoveryStatusText({files:-1,restoredAt:bad}),/Invalid Date|undefined|Fecha de restauración|-1 archivos/);
 assert.match(recoveryStatusText(null),/no tiene/);
});
test('I08 recovery progress distinguishes waiting, cancellation, timeout and external ownership',()=>{
 const waiting=recoveryJobText({status:'running',admission:{state:'waiting',http:2,background:1,automatic:3,deadlineAt:'2026-11-08T12:00:00Z'}});
 assert.match(waiting,/2 solicitudes · 1 trabajos de fondo · 3 tareas automáticas/);assert.match(waiting,/cancelar esta espera/);
 assert.match(recoveryJobText({status:'cancelled'}),/No se inició/);
 assert.match(recoveryJobText({error:'RECOVERY_DRAIN_TIMEOUT'}),/reintentarlo/);
 assert.match(recoveryJobText({error:'RECOVERY_STORE_BUSY'}),/Otro proceso/);
 assert.doesNotMatch(recoveryJobText({status:'running',phase:'Verificando memoria completa',admission:{state:'active'}}),/cancelar/);
});
