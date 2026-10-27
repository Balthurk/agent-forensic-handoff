import {createHash} from 'node:crypto';
import {openLedger,sourceManifest,validateSourceManifest,revisionManifest,readObject,readJson,inside} from './storage.js';
import {recordBytes} from './read-evidence.js';
import {canonical,digest,failure} from './protocol.js';
import {prepareOccurrenceFacts,prepareOccurrenceDelta,emptyOccurrenceState,occurrenceTables} from './occurrences.js';

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
    const presentTables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)),hasOccurrenceCommitment=chain.some(revision=>revision.ledger_changes.occurrence_facts_sha256);
    for(const table of ['archive_commit','source_revision','session_version','logical_event','association_version','legacy_alias',...(hasOccurrenceCommitment?occurrenceTables:[])])requireIntegrity(presentTables.has(table),'A committed ledger table is missing: '+table);
    const expected={archive_commit:new Map(),source_revision:new Map(),session_version:new Map(),logical_event:new Map(),association_version:new Map(),legacy_alias:new Map(),...Object.fromEntries(occurrenceTables.map(table=>[table,new Map()]))},sources=new Map(),occurrenceState=emptyOccurrenceState();let previous=null,active=new Map(),graphVersionSeen=false;
    for(const stored of chain){
      requireIntegrity(stored.commit_seq===(previous?.commit_seq??0)+1&&stored.ledger_sha256===digest({parent:previous?.ledger_sha256??null,changes:stored.ledger_changes}),'Revision sequence or ledger change commitment differs');
      expected.archive_commit.set(key(stored.commit_seq),{seq:stored.commit_seq,revision_id:stored.revision_id,manifest_sha256:digest(stored),recorded_at:stored.recorded_at,job_id:stored.job_id});
      requireIntegrity(new Set(stored.source_manifest_ids).size===stored.source_manifest_ids.length,'Published source list contains duplicates');
      const introduced=stored.source_manifest_ids.filter(id=>!sources.has(id)),ordered=stored.ledger_changes.sources??introduced;
      requireIntegrity(canonical([...ordered].sort())===canonical([...introduced].sort()),'Source change set differs from newly published manifests');const nextActive=new Map(active);
      for(const id of ordered){
        const indexed=db.prepare('SELECT manifest_json FROM source_revision WHERE id=? AND commit_seq<=?').get(id,stored.commit_seq);requireIntegrity(!!indexed,'Published source is absent from the ledger');const source=deep?sourceManifest(root,id):validateSourceManifest(JSON.parse(indexed.manifest_json),id),seq=stored.commit_seq;sources.set(id,source);nextActive.set(source.source_lineage_id,id);
        expected.source_revision.set(key(id),{id,lineage_id:source.source_lineage_id,commit_seq:seq,manifest_json:source});
        const session={id:source.session_id,native_id:source.native_id,harness:source.harness,origin_domain_id:source.origin_domain_id,identity_status:source.identity_status,provisional:source.provisional,source_revision_id:id};
        // Multiple changed sources for one session use the committed input
        // order, matching the version selected by the writer transaction.
        expected.session_version.set(key(source.session_id,seq),{id:source.session_id,commit_seq:seq,data_json:session});
        for(const record of source.records)for(const event of record.events){const eventKey=key(event.id,seq),row={id:event.id,commit_seq:seq,data_json:{...event,evidence_refs:[record.evidence_ref]}};if(!expected.logical_event.has(eventKey))expected.logical_event.set(eventKey,row);else requireIntegrity(canonical(expected.logical_event.get(eventKey))===canonical(row),'Conflicting events share a committed identity');}
      }
      if(stored.ledger_changes.occurrence_facts_sha256){requireIntegrity(stored.ledger_changes.occurrence_graph_version===undefined||stored.ledger_changes.occurrence_graph_version===1,'Unsupported occurrence graph derivation version');requireIntegrity(!graphVersionSeen||stored.ledger_changes.occurrence_graph_version===1,'Occurrence graph recipe cannot be downgraded');if(stored.ledger_changes.occurrence_graph_version===1)graphVersionSeen=true;const facts=deep?prepareOccurrenceDelta(prepareOccurrenceFacts([...sources.values()],stored.commit_seq,stored.recorded_at,root,occurrenceState,stored.ledger_changes.occurrence_graph_version??null).facts,occurrenceState):Object.fromEntries(occurrenceTables.map(table=>[table,db.prepare('SELECT id,commit_seq,data_json FROM '+table+' WHERE commit_seq=? ORDER BY rowid').all(stored.commit_seq).map(row=>({...row,data_json:JSON.parse(row.data_json)}))]));requireIntegrity(digest(facts)===stored.ledger_changes.occurrence_facts_sha256,'Occurrence facts differ from their published source commitment');for(const table of occurrenceTables)for(const row of facts[table]){expected[table].set(key(row.id,row.commit_seq),row);occurrenceState[table].set(row.id,row.data_json);}}
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
      if(!presentTables.has(table)){
        requireIntegrity(occurrenceTables.includes(table)&&!hasOccurrenceCommitment,'A committed ledger table is missing: '+table);
        add('published.'+table,true,{rows:0,format:'PRE_OCCURRENCE_EXTENSION'},'No occurrence commitment exists in this historical format');continue;
      }
      const column=table==='archive_commit'?'seq':'commit_seq',observed=new Set();
      for(const row of db.prepare('SELECT * FROM '+table+' WHERE '+column+'<=?').iterate(snapshot.commit_seq)){
        const rowKey=keys[table]?keys[table](row):key(row.id,row.commit_seq);requireIntegrity(!observed.has(rowKey),table+' contains a duplicate published key');observed.add(rowKey);requireIntegrity(wanted.has(rowKey),table+' contains a fact outside the published commitments');
        for(const field of ['manifest_json','data_json','evidence_json'])if(Object.hasOwn(row,field))try{row[field]=JSON.parse(row[field]);}catch{throw failure('INTEGRITY_FAILED',table+' contains malformed committed JSON');}
        requireIntegrity(canonical(row)===canonical(wanted.get(rowKey)),table+' key, commit, content or reference differs from its commitment');
      }
      add('published.'+table,observed.size===wanted.size,{rows:observed.size},{rows:wanted.size});
    }
    if(deep)for(const row of expected.content_object.values())readObject(root,row.data_json.object);
    let recordCount=0,eventCount=0;
    for(const source of sources.values()){
      const verifyObjects=(objects,length,sha)=>{let offset=0;const hasher=createHash('sha256');for(const object of objects){if(object.offset!==offset)throw failure('INTEGRITY_FAILED','Source object extents contain a gap or overlap');const bytes=readObject(root,object);hasher.update(bytes);offset+=bytes.length;}if(offset!==length||hasher.digest('hex')!==sha)throw failure('INTEGRITY_FAILED','Complete source digest or length differs');};
      if(deep){verifyObjects(source.objects,source.raw_bytes,source.raw_sha256);if(source.codec!=='none')verifyObjects(source.decoded_objects,source.decoded_bytes,source.decoded_sha256);}
      const cache=new Map();for(const record of source.records){recordCount++;if(deep)recordBytes(root,source,record,0,0,cache);eventCount+=record.events.length;}
    }
    add('source.records.events',true,{sources:sources.size,records:recordCount,events:eventCount},'exact published fact sets and selected-depth evidence verified');db.exec('COMMIT');return checks;
  }finally{db.close();}
}
