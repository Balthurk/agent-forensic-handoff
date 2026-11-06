"""Fresh complete byte and typed-row verification of an explicit import."""
from contextlib import closing
from pathlib import Path
import hashlib
from .config import binding_for,require
from .connection import Connection
from .manifests import stable
from .objects import ObjectStore,BLOCK


def verify_import(plan,receipt,root,*,config,limits=None,published=False):
    binding,key=binding_for(root,config);checked=[];custody_bytes=rows=0;expected={'.orbita-legacy/receipt.json':'file'}
    require(receipt['workspaceId']==binding.workspace_id and receipt['instanceId']==config.instance_id and receipt['authorityRestored'] is False,'LEGACY_VERIFY_BINDING')
    require(len(receipt['entries'])==len(plan['entries']),'LEGACY_VERIFY_ENTRIES')
    with ObjectStore(config,binding,read_only=True) as files:
        def digest(name):
            h=hashlib.sha256();size=0
            with files.open_read(key+'/'+name) as reader:
                while block:=reader.read(BLOCK):h.update(block);size+=len(block)
            return h.hexdigest(),size
        require(digest('.orbita-legacy/receipt.json')==(hashlib.sha256(stable(receipt)).hexdigest(),len(stable(receipt))),'LEGACY_VERIFY_RECEIPT')
        for i,(entry,proof) in enumerate(zip(plan['entries'],receipt['entries'],strict=True)):
            require(proof['index']==i and all(proof[k]==entry[k] for k in ('source','target','kind')) and proof['sourceSha256']==entry['sha256'],'LEGACY_VERIFY_ENTRY')
            custody='.orbita-legacy/originals/'+entry['source']+'.bin';require(proof['custodyPath']==custody,'LEGACY_VERIFY_CUSTODY')
            actual,size=digest(custody);require(actual==entry['sha256'],'LEGACY_VERIFY_CUSTODY_HASH');custody_bytes+=size;expected[custody]='file'
            if entry['kind']=='store':
                with closing(Connection(Path(root)/entry['target'],family=entry['family'],config=config,read_only=True)) as db:manifest=db.logical_manifest(limits=limits)
                require(manifest==proof['result']['manifest'],'LEGACY_VERIFY_TYPED_MANIFEST');rows+=manifest['rows'];expected[entry['target']]='store'
                checked.append(dict(target=entry['target'],family=entry['family'],rows=manifest['rows'],sha256=manifest['sha256']))
            elif entry['kind']=='file':require(digest(entry['target'])==(entry['sha256'],size),'LEGACY_VERIFY_FILE_BYTES');expected[entry['target']]='file'
        for derived in receipt['derivations']:
            require(digest(derived['target'])==(derived['sha256'],derived['bytes']),'LEGACY_VERIFY_DERIVED_BYTES');expected[derived['target']]='file'
            if derived['kind']=='volume':
                import json
                volume=json.loads(files.read_bytes(key+'/'+derived['target']))
                for name in ('operational','analytical'):
                    target='volume/'+name+'.pgstore'
                    with closing(Connection(Path(root)/target,family='volume',config=config,read_only=True)) as db:actual=db.logical_manifest(limits=limits)
                    require(actual==volume['stores'][name],'LEGACY_VERIFY_VOLUME');expected[target]='store'
        prefix=key+'/'
        actual=files.raw.execute("SELECT path,kind FROM orbita_common.entries WHERE starts_with(path,%s) AND kind<>'directory' LIMIT %s",(prefix,len(expected)+1)).fetchall()
        require({name[len(prefix):]:kind for name,kind in actual}==expected,'LEGACY_VERIFY_UNEXPECTED_CONTENT')
        if published:
            state=files.raw.execute('SELECT orbita_common.restore_state(%s)',(key,)).fetchone()[0]
            require(state is not None and state['planSha256']==receipt['planSha256'] and state['automaticWork'] is False and state['externalAccess'] is False,'LEGACY_VERIFY_CONTROL')
            if 'restoreContext' in receipt:require(all(state.get(k)==v for k,v in receipt['restoreContext'].items()),'LEGACY_VERIFY_RESTORE_CONTEXT')
    return dict(status='PASS_FRESH_IMPORT_READBACK',entries=len(plan['entries']),custodyBytes=custody_bytes,stores=checked,typedRows=rows,receiptSha256=hashlib.sha256(stable(receipt)).hexdigest())
