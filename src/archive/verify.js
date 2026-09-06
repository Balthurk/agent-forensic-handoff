import {createHash} from 'node:crypto';
import {openLedger,sourceManifest,revisionManifest,readObject,readJson,inside} from './storage.js';
import {recordBytes} from './read-evidence.js';
import {canonical,digest,failure} from './protocol.js';

export function verifyPublishedArchive(root,snapshot,{deep=true}={}){
  const db=openLedger(root,true),checks=[];
  const requireIntegrity=(condition,message)=>{if(!condition)throw failure('INTEGRITY_FAILED',message);};
  const add=(id,ok,observed,expected)=>{checks.push({id,ok,observed,expected});requireIntegrity(ok,id+' differs from its published commitment');};
  const key=(...parts)=>canonical(parts);
  try{
    db.exec('BEGIN');const health=db.prepare('PRAGMA integrity_check').all();add('sqlite.integrity',health.length===1&&health[0].integrity_check==='ok',health,'ok');
    // The immutable chain establishes the expected universe. Surviving SQL
    // rows are only the observed side and cannot define what should exist.
    const chain=[],visited=new Set();let revision=snapshot;
    while(revision){requireIntegrity(!visited.has(revision.revision_id),'Published revision chain contains a cycle');visited.add(revision.revision_id);const stored=revisionManifest(root,revision.revision_id);requireIntegrity(stored.archive_id===snapshot.archive_id,'Revision belongs to another archive');chain.push(stored);revision=stored.parent_revision_id?revisionManifest(root,stored.parent_revision_id):null;}chain.reverse();
    const expected={archive_commit:new Map(),source_revision:new Map(),session_version:new Map(),logical_event:new Map(),association_version:new Map(),legacy_alias:new Map()},sources=new Map();let previous=null,active=new Map();
    for(const stored of chain){
      requireIntegrity(stored.commit_seq===(previous?.commit_seq??0)+1&&stored.ledger_sha256===digest({parent:previous?.ledger_sha256??null,changes:stored.ledger_changes}),'Revision sequence or ledger change commitment differs');
      expected.archive_commit.set(key(stored.commit_seq),{seq:stored.commit_seq,revision_id:stored.revision_id,manifest_sha256:digest(stored),recorded_at:stored.recorded_at,job_id:stored.job_id});
      requireIntegrity(new Set(stored.source_manifest_ids).size===stored.source_manifest_ids.length,'Published source list contains duplicates');
      const introduced=stored.source_manifest_ids.filter(id=>!sources.has(id)),ordered=stored.ledger_changes.sources??introduced;
      requireIntegrity(canonical([...ordered].sort())===canonical([...introduced].sort()),'Source change set differs from newly published manifests');const nextActive=new Map(active);
      for(const id of ordered){
        const source=sourceManifest(root,id),seq=stored.commit_seq;sources.set(id,source);nextActive.set(source.source_lineage_id,id);
        expected.source_revision.set(key(id),{id,lineage_id:source.source_lineage_id,commit_seq:seq,manifest_json:source});
        const session={id:source.session_id,native_id:source.native_id,harness:source.harness,origin_domain_id:source.origin_domain_id,identity_status:source.identity_status,provisional:source.provisional,source_revision_id:id};
        // Multiple changed sources for one session use the committed input
        // order, matching the version selected by the writer transaction.
        expected.session_version.set(key(source.session_id,seq),{id:source.session_id,commit_seq:seq,data_json:session});
        for(const record of source.records)for(const event of record.events){const eventKey=key(event.id,seq),row={id:event.id,commit_seq:seq,data_json:{...event,evidence_refs:[record.evidence_ref]}};if(!expected.logical_event.has(eventKey))expected.logical_event.set(eventKey,row);else requireIntegrity(canonical(expected.logical_event.get(eventKey))===canonical(row),'Conflicting events share a committed identity');}
      }
      requireIntegrity(canonical([...nextActive.values()])===canonical(stored.source_manifest_ids),'Published active source membership differs from committed lineage changes');active=nextActive;
      for(const association of stored.ledger_changes.associations??[]){const {change}=association,associationKey=key(change.association_id,change.branch_id,stored.commit_seq);requireIntegrity(!expected.association_version.has(associationKey),'Duplicate committed association version');expected.association_version.set(associationKey,{id:change.association_id,branch_id:change.branch_id,commit_seq:stored.commit_seq,data_json:association});}
      if(stored.ledger_changes.legacy_sha256){
        const alias=readJson(inside(root,'legacy',stored.ledger_changes.legacy_case_hash+'.json'));requireIntegrity(digest(alias)===stored.ledger_changes.legacy_sha256&&alias.case_hash===stored.ledger_changes.legacy_case_hash,'Legacy import commitment differs');
        for(const event of alias.events){const aliasKey=key(alias.case_hash,event.legacy_event_id);requireIntegrity(!expected.legacy_alias.has(aliasKey),'Duplicate committed legacy alias');expected.legacy_alias.set(aliasKey,{case_hash:alias.case_hash,old_event_id:event.legacy_event_id,event_id:event.event_id,commit_seq:stored.commit_seq,evidence_json:event.evidence_refs});}
        if(deep)for(const artifact of alias.artifacts)for(const object of artifact.objects)readObject(root,object);
      }
      previous=stored;
    }
    const keys={archive_commit:row=>key(row.seq),source_revision:row=>key(row.id),session_version:row=>key(row.id,row.commit_seq),logical_event:row=>key(row.id,row.commit_seq),association_version:row=>key(row.id,row.branch_id,row.commit_seq),legacy_alias:row=>key(row.case_hash,row.old_event_id)};
    for(const [table,wanted]of Object.entries(expected)){
      const column=table==='archive_commit'?'seq':'commit_seq',observed=new Set();
      for(const row of db.prepare('SELECT * FROM '+table+' WHERE '+column+'<=?').iterate(snapshot.commit_seq)){
        const rowKey=keys[table](row);requireIntegrity(!observed.has(rowKey),table+' contains a duplicate published key');observed.add(rowKey);requireIntegrity(wanted.has(rowKey),table+' contains a fact outside the published commitments');
        for(const field of ['manifest_json','data_json','evidence_json'])if(Object.hasOwn(row,field))try{row[field]=JSON.parse(row[field]);}catch{throw failure('INTEGRITY_FAILED',table+' contains malformed committed JSON');}
        requireIntegrity(canonical(row)===canonical(wanted.get(rowKey)),table+' key, commit, content or reference differs from its commitment');
      }
      add('published.'+table,observed.size===wanted.size,{rows:observed.size},{rows:wanted.size});
    }
    let recordCount=0,eventCount=0;
    for(const source of sources.values()){
      const verifyObjects=(objects,length,sha)=>{let offset=0;const hasher=createHash('sha256');for(const object of objects){if(object.offset!==offset)throw failure('INTEGRITY_FAILED','Source object extents contain a gap or overlap');const bytes=readObject(root,object);hasher.update(bytes);offset+=bytes.length;}if(offset!==length||hasher.digest('hex')!==sha)throw failure('INTEGRITY_FAILED','Complete source digest or length differs');};
      if(deep){verifyObjects(source.objects,source.raw_bytes,source.raw_sha256);if(source.codec!=='none')verifyObjects(source.decoded_objects,source.decoded_bytes,source.decoded_sha256);}
      const cache=new Map();for(const record of source.records){recordCount++;if(deep)recordBytes(root,source,record,0,0,cache);eventCount+=record.events.length;}
    }
    add('source.records.events',true,{sources:sources.size,records:recordCount,events:eventCount},'exact published fact sets and selected-depth evidence verified');db.exec('COMMIT');return checks;
  }finally{db.close();}
}
