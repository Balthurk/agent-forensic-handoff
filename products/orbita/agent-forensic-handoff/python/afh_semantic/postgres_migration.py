"""Retired implicit migration and SQLite shadow export entry points.

Use an explicit legacy import plan or a verified common-store backup. These
names remain to fail closed for old callers; none reads config or writes files.
"""
from .postgres_backend import plain


def _disabled(root):
    plain(root)
    raise RuntimeError('ORBITA_PG_EXPLICIT_LEGACY_IMPORT_OR_BACKUP_REQUIRED')


def exclusive(root):return _disabled(root)
def migrate(root):return _disabled(root)
def export_held(root,**kwargs):return _disabled(root)
