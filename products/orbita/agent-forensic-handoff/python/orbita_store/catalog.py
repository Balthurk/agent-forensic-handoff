"""Operator installation of the hash-bound, reviewed family schema bundle."""
from pathlib import Path
import hashlib
import json

from .config import require
from .schema import install_family


def install_all(db):
    root=Path(__file__).with_name('schemas')
    manifest=json.loads((root/'manifest.json').read_text(encoding='utf8'))
    require(manifest.get('schema')==1,'SCHEMA_MANIFEST_VERSION')
    installed=[]
    with db.transaction():
        for family,entry in manifest['families'].items():
            name=entry['file']
            require(name==family+'.sql' and '/' not in name and '\\' not in name,'SCHEMA_MANIFEST_PATH')
            source=(root/name).read_bytes()
            require(hashlib.sha256(source).hexdigest()==entry['sha256'],'SCHEMA_SOURCE_HASH')
            # Only this privileged, hash-checked bundle admits a new family.
            # Runtime connections still cannot register or create a family.
            db.execute('INSERT INTO orbita_private.families(name) VALUES(%s) ON CONFLICT DO NOTHING',(family,))
            result=install_family(db,family,source.decode('utf8'))
            require(result['hashes']==entry['members'],'SCHEMA_MEMBER_HASH')
            installed.append(result)
    return dict(families=installed,manifestSha256=hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest())
