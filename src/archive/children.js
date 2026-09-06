import fs from 'node:fs';
import path from 'node:path';
import {digest} from './protocol.js';

const identity=source=>digest([source.harness,source.origin_domain_id,source.native_id]);
// A file request grants a bounded sibling search for directly observed child
// IDs. It never grants traversal of global harness state or arbitrary paths in
// transcript content. Unresolved children remain explicit coverage omissions.
export async function acquireObservedChildren(acquired,previous,params,acquire){
  const selected=new Map(acquired.filter(item=>item.manifest.native_id).map(item=>[identity(item.manifest),item])),known=new Map(),limit=params.max_child_sessions??32;let children=0;
  for(let index=0;index<acquired.length;index++){
    const parent=acquired[index].manifest;
    for(const record of parent.records)for(const event of record.events)for(const edge of event.session_edges??[]){
      if(typeof edge.childNativeId!=='string'||!edge.childNativeId.length)continue;
      const child={harness:parent.harness,origin_domain_id:parent.origin_domain_id,native_id:edge.childNativeId},key=identity(child);known.set(key,child);if(selected.has(key)||params.include_children===false||children>=limit)continue;
      const directory=await fs.promises.opendir(path.dirname(parent.boundary.path)),candidates=[];let inspected=0;
      for await(const entry of directory){if(++inspected>4096)break;if(entry.isFile()&&entry.name.includes(child.native_id)&&/\.(?:jsonl|ndjson)(?:\.(?:gz|zst|zstd))?$/.test(entry.name)){candidates.push(path.join(path.dirname(parent.boundary.path),entry.name));if(candidates.length>1)break;}}
      if(candidates.length!==1||inspected>4096)continue;
      const item=await acquire({...child,path:candidates[0]});acquired.push(item);selected.set(key,item);children++;
    }
  }
  const available=new Set([...previous,...acquired.map(item=>item.manifest)].filter(item=>item.native_id).map(identity)),omitted=[...known.keys()].filter(key=>!available.has(key));
  return {omitted:omitted.length,known:known.size,children_acquired:children,limit,resolution_boundary:'DIRECTLY_OBSERVED_IDS_IN_SIBLING_DIRECTORIES_MAX4096_ENTRIES'};
}
