import {createHash} from 'node:crypto';
import {openLedger,sourceManifest,revisionManifest,readObject,readJson,inside} from './storage.js';
import {recordBytes} from './read-evidence.js';
import {digest,failure} from './protocol.js';

export function verifyPublishedArchive(root,snapshot,{deep=true}={}){
  const db=openLedger(root,true),checks=[];const add=(id,ok,observed,expected)=>{checks.push({id,ok,observed,expected});if(!ok)throw failure('INTEGRITY_FAILED',id+' differs from its published commitment');};
  try{
    db.exec('BEGIN');const health=db.prepare('PRAGMA integrity_check').all();add('sqlite.integrity',health.length===1&&health[0].integrity_check==='ok',health,'ok');
    let revision=snapshot;while(revision){const stored=revisionManifest(root,revision.revision_id),parent=stored.parent_revision_id?revisionManifest(root,stored.parent_revision_id):null,row=db.prepare('SELECT * FROM archive_commit WHERE seq=?').get(stored.commit_seq);add('revision.'+stored.commit_seq,!!row&&row.revision_id===stored.revision_id&&row.manifest_sha256===digest(stored)&&stored.ledger_sha256===digest({parent:parent?.ledger_sha256??null,changes:stored.ledger_changes})&&stored.commit_seq===(parent?.commit_seq??0)+1,stored.revision_id,'canonical revision and ledger change chain');
      if(stored.ledger_changes.legacy_sha256){const alias=readJson(inside(root,'legacy',stored.ledger_changes.legacy_case_hash+'.json'));add('legacy.'+stored.commit_seq,digest(alias)===stored.ledger_changes.legacy_sha256,digest(alias),stored.ledger_changes.legacy_sha256);if(deep)for(const artifact of alias.artifacts)for(const object of artifact.objects)readObject(root,object);}
      for(const association of stored.ledger_changes.associations??[]){const observed=db.prepare('SELECT data_json FROM association_version WHERE id=? AND branch_id=? AND commit_seq=?').get(association.change.association_id,association.change.branch_id,stored.commit_seq);add('association.'+association.revision.revision_id,!!observed&&digest(JSON.parse(observed.data_json))===digest(association),observed?'present':'missing','committed association bytes');}
      revision=parent;
    }
    let sourceCount=0,recordCount=0,eventCount=0;
    for(const row of db.prepare('SELECT * FROM source_revision WHERE commit_seq<=? ORDER BY commit_seq,id').iterate(snapshot.commit_seq)){
      const source=sourceManifest(root,row.id);if(digest(JSON.parse(row.manifest_json))!==digest(source))throw failure('INTEGRITY_FAILED','Ledger source differs from its immutable manifest');sourceCount++;
      const verifyObjects=(objects,length,sha)=>{let offset=0;const hasher=createHash('sha256');for(const object of objects){if(object.offset!==offset)throw failure('INTEGRITY_FAILED','Source object extents contain a gap or overlap');const bytes=readObject(root,object);hasher.update(bytes);offset+=bytes.length;}if(offset!==length||hasher.digest('hex')!==sha)throw failure('INTEGRITY_FAILED','Complete source digest or length differs');};
      if(deep){verifyObjects(source.objects,source.raw_bytes,source.raw_sha256);if(source.codec!=='none')verifyObjects(source.decoded_objects,source.decoded_bytes,source.decoded_sha256);}
      const cache=new Map();for(const record of source.records){recordCount++;if(deep)recordBytes(root,source,record,0,0,cache);for(const event of record.events){const observed=db.prepare('SELECT data_json FROM logical_event WHERE id=? AND commit_seq=?').get(event.id,row.commit_seq);if(!observed||digest(JSON.parse(observed.data_json))!==digest({...event,evidence_refs:[record.evidence_ref]}))throw failure('INTEGRITY_FAILED','Logical event differs from its committed source representation');eventCount++;}}
    }
    add('source.records.events',true,{sources:sourceCount,records:recordCount,events:eventCount},'all visible source records and event rows verified');db.exec('COMMIT');return checks;
  }finally{db.close();}
}
