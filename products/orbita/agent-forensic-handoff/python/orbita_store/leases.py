"""Explicit tree leases; live backends retain ownership until actual closure."""
import os
import psycopg
from . import StoreError
from .config import binding_for,require
from .session import Session


class StoreLease:
    def __init__(self,path,*,config,mode='shared',own_shared=None):
        require(mode in ('shared','exclusive'),'LEASE_MODE')
        binding,key=binding_for(path,config)
        key=os.path.normcase(key).replace('\\','/')
        self.key=key;self.mode=mode;self.closed=False
        if own_shared is not None:
            require(not own_shared.closed and own_shared.mode=='shared' and mode=='exclusive'
                    and own_shared.key==key and own_shared.session.binding.workspace_id==binding.workspace_id,'LEASE_OWNERSHIP')
            self.session=own_shared.session;self.tokens=own_shared.tokens
        else:
            self.session=Session(config,binding);self.tokens=set()
        try:
            self.token=str(self.session.raw.execute('SELECT orbita_common.acquire_store_lease(%s,%s,%s)::text',
                           (key,mode,own_shared.token if own_shared else None)).fetchone()[0])
            self.tokens.add(self.token)
        except BaseException as error:
            if own_shared is None:self.session.close(reusable=False)
            if isinstance(error,psycopg.errors.LockNotAvailable):raise StoreError('RECOVERY_STORE_BUSY' if mode=='exclusive' else 'RECOVERY_STORE_LOCKED') from None
            raise

    def close(self):
        if self.closed:return
        try:
            require(self.session.raw.execute('SELECT orbita_common.release_store_lease(%s)',(self.token,)).fetchone()[0],'LEASE_RELEASE_UNVERIFIED')
        except BaseException:
            self.session.close(reusable=False)
            raise
        finally:
            self.closed=True;self.tokens.discard(self.token)
            # A lease transport is never pooled. Failure closes its actual
            # backend, so other handles fail instead of reporting false unlock.
            if not self.tokens:self.session.close(reusable=False)

    def __enter__(self):return self
    def __exit__(self,*unused):self.close()
