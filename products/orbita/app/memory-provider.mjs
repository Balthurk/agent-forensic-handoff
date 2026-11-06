// Model lifetime is independent of corpus initialization and storage bindings.
import {createTransformersProvider} from '../agent-forensic-handoff/src/semantic-model.js';
let providerPromise;
export const memoryProvider=()=>providerPromise??=(createTransformersProvider().catch(e=>{providerPromise=null;throw e;}));
export async function closeMemory(){if(providerPromise){const p=await providerPromise.catch(()=>null);await p?.dispose?.();providerPromise=null;}}
