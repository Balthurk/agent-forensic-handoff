"""Path checks shared by the volume and semantic stores; no filesystem writes."""
import os
from pathlib import Path
import stat
import sys


class PathSafetyError(ValueError):
    pass


def require_runtime():
    if tuple(sys.version_info[:2]) < (3, 12):
        raise PathSafetyError('PYTHON_3_12_REQUIRED')
    if not callable(getattr(Path, 'is_junction', None)) or not callable(getattr(Path, 'lstat', None)):
        raise PathSafetyError('PYTHON_PATH_CAPABILITY_REQUIRED')
    if os.name == 'nt' and not hasattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT'):
        raise PathSafetyError('PYTHON_REPARSE_CAPABILITY_REQUIRED')


def plain_path(value):
    require_runtime()
    path = Path(value).absolute()
    # lstat observes dangling links too. A missing descendant does not prevent
    # checking its existing ancestors, including an ancestor before '..'.
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise PathSafetyError('PATH_INSPECTION_FAILED') from error
        if stat.S_ISLNK(info.st_mode):
            raise PathSafetyError('LINK_PATH')
        if os.name == 'nt':
            attributes = getattr(info, 'st_file_attributes', None)
            if attributes is None:
                raise PathSafetyError('PYTHON_REPARSE_CAPABILITY_REQUIRED')
            if attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise PathSafetyError('LINK_PATH')
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise PathSafetyError('HARDLINK')
    return path
