"""Explicit configuration; credentials never enter reprs, errors or receipts."""
from dataclasses import dataclass, field
from pathlib import Path
import json
import os
import uuid
from afh_semantic.path_safety import plain_path, PathSafetyError

from . import StoreError


def require(condition, code):
    if not condition:
        raise StoreError('ORBITA_PG_' + code)


def plain_local_path(value):
    try:return plain_path(value)
    except PathSafetyError as error:raise StoreError('ORBITA_PG_'+str(error)) from error


@dataclass(frozen=True)
class Binding:
    root: str
    workspace_id: str
    capability: str = field(repr=False)


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    dbname: str
    user: str
    password: str = field(repr=False)
    instance_id: str
    bindings: tuple[Binding, ...]

    def connection_parameters(self):
        return {k: getattr(self, k) for k in ('host', 'port', 'dbname', 'user', 'password')}


def parse_config(value):
    require(isinstance(value, dict) and value.get('schema') == 1, 'CONFIG_SCHEMA')
    require(value.get('host') in ('127.0.0.1', '::1', 'localhost'), 'LOOPBACK_REQUIRED')
    require(type(value.get('port')) is int and 1 <= value['port'] <= 65535, 'CONFIG_PORT')
    require(value.get('user') == 'orbita_runtime', 'RUNTIME_ROLE_REQUIRED')
    for key in ('dbname', 'password'):
        require(isinstance(value.get(key), str) and bool(value[key]), 'CONFIG_FIELD')
    try:
        instance_id = str(uuid.UUID(value['instanceId']))
    except (KeyError, ValueError, TypeError, AttributeError):
        raise StoreError('ORBITA_PG_INSTANCE_ID') from None
    require(isinstance(value.get('bindings'), list) and value['bindings'], 'ROOT_BINDINGS_REQUIRED')
    bindings = []
    seen = set()
    for item in value['bindings']:
        try:
            root = str(plain_local_path(item['root']).resolve())
            workspace_id = str(uuid.UUID(item['workspaceId']))
            capability = item['capability']
        except (KeyError, ValueError, TypeError, AttributeError):
            raise StoreError('ORBITA_PG_BINDING') from None
        require(isinstance(capability, str) and 32 <= len(capability) <= 256, 'CAPABILITY')
        normalized = os.path.normcase(root)
        require(normalized not in seen, 'DUPLICATE_ROOT_BINDING')
        seen.add(normalized)
        bindings.append(Binding(root, workspace_id, capability))
    return Config(value['host'], value['port'], value['dbname'], value['user'], value['password'], instance_id, tuple(bindings))


def read_config():
    # A worker gets one bounded inline configuration, never an inherited admin
    # configuration. The file alternative is for the local operator/server.
    inline = os.environ.get('ORBITA_POSTGRES_BINDING')
    name = os.environ.get('ORBITA_POSTGRES_CONFIG')
    require(bool(inline) != bool(name), 'EXACTLY_ONE_CONFIG_REQUIRED')
    try:
        if inline:
            raw = inline
        else:
            path = plain_local_path(name)
            require(path.stat().st_size <= 1024 * 1024, 'CONFIG_SIZE')
            raw = path.read_text(encoding='utf-8-sig')
        return parse_config(json.loads(raw))
    except StoreError:
        raise
    except Exception:
        raise StoreError('ORBITA_PG_CONFIG_UNAVAILABLE') from None


def binding_for(value, config):
    # Check lexical traversal before normalization; resolving a path must not
    # erase an attempted escape through an existing link or a '..' component.
    raw = os.fspath(value)
    if raw.startswith('\\\\?\\'):
        raw = raw[4:]
    require('..' not in Path(raw).parts, 'PATH_TRAVERSAL')
    # plain_local_path returns an absolute path and freshly lstat-checks every
    # ancestor. These are virtual PG locators: do not walk the native tree a
    # second time to resolve an already rejected link. Noncanonical native
    # aliases cannot acquire a different root binding through this route.
    path = plain_local_path(raw)
    candidates = []
    for binding in config.bindings:
        root = Path(binding.root)
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        candidates.append((len(root.parts), binding, relative.as_posix()))
    require(bool(candidates), 'PATH_NOT_BOUND')
    _, binding, relative = max(candidates, key=lambda x: x[0])
    return binding, '' if relative == '.' else relative
