"""The shared PostgreSQL persistence boundary of the Orbita variant.

Legacy import readers are separate from runtime connections. An unavailable or
unconfigured server must never turn into a new local SQLite store.
"""

SCHEMA_VERSION = 1


class StoreError(RuntimeError):
    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code)
