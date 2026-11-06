"""SQL syntax handling for application-owned statements, never arbitrary SQL."""
import hashlib
import re
from functools import lru_cache

import sqlglot
from sqlglot import exp
from sqlglot.errors import ErrorLevel

from . import StoreError


def statements(script):
    """Split literals/comments and the one supported append-only trigger body."""
    start=0; i=0; quote=None; comment=None; trigger=False
    while i<len(script):
        c=script[i]; nxt=script[i:i+2]
        if comment:
            if comment=='line' and c=='\n':comment=None
            elif comment=='block' and nxt=='*/':comment=None;i+=1
        elif quote:
            if c==quote:
                if i+1<len(script) and script[i+1]==quote:i+=1
                else:quote=None
        elif nxt=='--':comment='line';i+=1
        elif nxt=='/*':comment='block';i+=1
        elif c in "'\"`":quote=c
        elif c=='[':quote=']'
        elif c==';':
            current=script[start:i].strip()
            trigger=bool(re.match(r'CREATE\s+TRIGGER\b',current,re.I))
            if not trigger or re.search(r'\bEND\s*$',current,re.I):
                if current:yield current
                start=i+1;trigger=False
        i+=1
    if quote or comment=='block':raise StoreError('ORBITA_PG_INCOMPLETE_SQL')
    if script[start:].strip():yield script[start:].strip().rstrip(';')


def _parse(statement):
    try:
        node=sqlglot.parse_one(statement,read='sqlite',error_level=ErrorLevel.RAISE)
    except sqlglot.errors.SqlglotError:
        raise StoreError('ORBITA_PG_SQL_SYNTAX') from None
    if node is None or isinstance(node,(exp.Command,exp.Block)):
        raise StoreError('ORBITA_PG_SQL_UNSUPPORTED')
    return node


@lru_cache(maxsize=512)
def _parse_template(statement):return _parse(statement)


def parse(statement):
    # Mutable ASTs are never shared. Only short, repeated syntax is retained;
    # parameters, connection state, permissions and query results are not.
    return _parse_template(statement).copy() if len(statement)<=4096 else _parse(statement)


def canonical_sql(statement):
    return parse(statement).sql(dialect='sqlite',normalize=True,comments=False)


def fingerprint(statement):
    return hashlib.sha256(canonical_sql(statement).encode('utf8')).hexdigest()


def parameterize(statement, parameters):
    """Name every placeholder before parsing, preserving quoted text and order."""
    out=[]; values={}; i=0; position=0; quote=None; comment=None
    named=isinstance(parameters,dict)
    while i<len(statement):
        c=statement[i]; nxt=statement[i:i+2]
        if comment:
            out.append(c)
            if comment=='line' and c=='\n':comment=None
            elif comment=='block' and nxt=='*/':out.append('/');i+=1;comment=None
        elif quote:
            out.append(c)
            if c==quote:
                if i+1<len(statement) and statement[i+1]==quote:out.append(quote);i+=1
                else:quote=None
        elif nxt=='--':out.extend(nxt);i+=1;comment='line'
        elif nxt=='/*':out.extend(nxt);i+=1;comment='block'
        elif c in "'\"`":out.append(c);quote=c
        elif c=='[':out.append(c);quote=']'
        elif c=='?' or (c in ':$@' and re.match(r'[A-Za-z_]',statement[i+1:i+2])):
            end=i+1
            if c!='?':
                while end<len(statement) and re.match(r'[A-Za-z_0-9]',statement[end]):end+=1
                if not named:raise StoreError('ORBITA_PG_NAMED_PARAMETERS_REQUIRED')
                value=parameters.get(statement[i+1:end])
            else:
                if named or position>=len(parameters):raise StoreError('ORBITA_PG_PARAMETER_COUNT')
                value=parameters[position]
            key='p'+str(position);values[key]=value;position+=1
            out.append(':'+key);i=end-1
        else:out.append(c)
        i+=1
    if not named and position!=len(parameters):raise StoreError('ORBITA_PG_PARAMETER_COUNT')
    return ''.join(out),values


def postgres(node):
    return node.sql(dialect='postgres',identify=True,comments=False,unsupported_level=ErrorLevel.RAISE)
