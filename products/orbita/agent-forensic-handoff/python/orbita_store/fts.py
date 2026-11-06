"""Bounded Unicode61 phrase matching over rows in the common PostgreSQL store.

This is the compatibility path, not an indexed-search performance claim. It
uses one PostgreSQL snapshot for scan and final SQL, never an embedded engine.
Unsupported query grammar and exhausted budgets are explicit errors.
"""
from bisect import bisect_right
from dataclasses import dataclass
import time,uuid

from sqlglot import exp
from sqlglot.optimizer.scope import traverse_scope
from .config import require
from .schema import ident
from .unicode61_data import aDia,aChar,aEntry,aiOff,aFts5UnicodeBlock,aFts5UnicodeMap,aFts5UnicodeData

_CODES=tuple(x[0] for x in aEntry)
_CATEGORIES=frozenset((0,5,6,7,8,9,13,14,15,30,31))

def category(code):
    if code>=1<<20:return 0
    block=code>>16;key=code&65535
    lo,hi=aFts5UnicodeBlock[block:block+2]
    i=bisect_right(aFts5UnicodeMap,key,lo,hi)-1
    if i<lo or key>=aFts5UnicodeMap[i]+(aFts5UnicodeData[i]>>5):return 0
    kind=aFts5UnicodeData[i]&31
    return (5 if (key-aFts5UnicodeMap[i])&1 else 9) if kind==30 else kind

def is_diacritic(code):
    if not 768<=code<=817:return False
    return bool((0x08029FDF>>(code-768))&1) if code<800 else bool((0x000361F8>>(code-800))&1)

def fold(code):
    if code<128:return code+32 if 65<=code<=90 else code
    if code>=65536:return code+40 if 66560<=code<66600 else code
    start,flags,length=aEntry[bisect_right(_CODES,code)-1]
    if code<start+length and not (flags&1&(start^code)):code=(code+aiOff[flags>>1])&65535
    i=bisect_right(aDia,(code<<3)|7)-1
    if aChar[i]&128:return code  # unicode61 default remove_diacritics=1.
    return code if code>(aDia[i]>>3)+(aDia[i]&7) else aChar[i]&127

def tokens(text,check=None):
    if text is None:return ()
    require(isinstance(text,str),'FTS_TEXT_TYPE')
    result=[];word=[]
    for i,char in enumerate(text):
        if check is not None and i%1024==0:check()
        code=ord(char)
        # The historical tokenizer's UTF-8 decoder normalizes these two
        # noncharacters to U+FFFD before category lookup (including in words).
        if code in (0xFFFE,0xFFFF):code=0xFFFD
        alnum=code!=0 and category(code) in _CATEGORIES
        if alnum or word and code>=128 and is_diacritic(code):
            value=fold(code)
            if value:word.append(chr(value))
        elif word:result.append(''.join(word));word=[]
    if word:result.append(''.join(word))
    return tuple(result)

def _lex(query):
    require(isinstance(query,str) and len(query.encode('utf8'))<=65536,'FTS_QUERY_LIMIT')
    items=[];i=0
    while i<len(query):
        char=query[i]
        if char in ' \t\r\n\v\f':i+=1;continue
        if char in '()':items.append(char);i+=1;continue
        if char=='"':
            value=[];i+=1;closed=False
            while i<len(query):
                if query[i]=='"':
                    if i+1<len(query) and query[i+1]=='"':value.append('"');i+=2;continue
                    i+=1;closed=True;break
                value.append(query[i]);i+=1
            require(closed,'FTS_QUERY_SYNTAX');items.append(('phrase',tokens(''.join(value))))
        else:
            start=i
            while i<len(query) and (ord(query[i])>=128 or query[i].isascii() and (query[i].isalnum() or query[i] in '_\x1a')):i+=1
            require(i>start,'FTS_QUERY_UNSUPPORTED')
            word=query[start:i]
            require(not (word=='NEAR' and query[i:].lstrip(' \t\r\n\v\f').startswith('(')),'FTS_QUERY_UNSUPPORTED')
            items.append(word if word in ('AND','OR','NOT') else ('phrase',tokens(word)))
        require(len(items)<=256,'FTS_QUERY_LIMIT')
    return items

def compile_query(query):
    require(query is not None,'FTS_QUERY_SYNTAX')
    items=_lex(query);require(bool(items),'FTS_QUERY_SYNTAX');position=0
    def atom(depth=0):
        nonlocal position
        require(depth<32 and position<len(items),'FTS_QUERY_SYNTAX')
        value=items[position];position+=1
        if value=='(':
            value=expression(0,depth+1)
            require(position<len(items) and items[position]==')','FTS_QUERY_SYNTAX');position+=1
            return value
        require(isinstance(value,tuple),'FTS_QUERY_SYNTAX');return value
    def expression(minimum,depth=0):
        nonlocal position
        left=atom(depth)
        while position<len(items) and items[position]!=')':
            op=items[position];implicit=isinstance(op,tuple) or op=='('
            require(not implicit or op!='(' and items[position-1]!=')','FTS_QUERY_UNSUPPORTED')
            precedence=4 if implicit else {'OR':1,'AND':2,'NOT':3}.get(op,0)
            require(precedence>0,'FTS_QUERY_SYNTAX')
            if precedence<minimum:break
            if not implicit:position+=1
            right=expression(precedence+1,depth+1)
            left=('AND' if implicit else op,left,right)
        return left
    tree=expression(0)
    require(position==len(items),'FTS_QUERY_SYNTAX')
    return tree

def matches(tree,columns):
    op=tree[0]
    if op=='phrase':
        phrase=tree[1];n=len(phrase)
        return bool(n) and any(any(column[i:i+n]==phrase for i in range(len(column)-n+1)) for column in columns)
    left=matches(tree[1],columns)
    if op=='AND':return left and matches(tree[2],columns)
    if op=='OR':return left or matches(tree[2],columns)
    return left and not matches(tree[2],columns)

@dataclass(frozen=True)
class Limits:
    rows:int=200000
    bytes:int=128*1024*1024
    seconds:float=30
    row_bytes:int=8*1024*1024

class Budget:
    def __init__(self,limits):
        self.limits=limits;self.rows=0;self.bytes=0;self.deadline=time.perf_counter()+limits.seconds
    def check(self):require(time.perf_counter()<self.deadline,'FTS_DEADLINE')
    def take(self,size):
        self.check();self.rows+=1;self.bytes+=size
        require(size<=self.limits.row_bytes and self.rows<=self.limits.rows and self.bytes<=self.limits.bytes,'FTS_SCAN_BUDGET')

def resolve(connection,node,values,limits):
    """Replace each table MATCH with exact row ids under caller's RR snapshot."""
    budget=Budget(limits)
    for match in list(node.find_all(exp.Match)):
        require(isinstance(match.this,exp.Column) and not match.this.table,'FTS_MATCH_TARGET')
        name=match.this.name.lower()
        meta=connection.catalog.get(name,{})
        virtual=meta.get('virtual')
        require(virtual and virtual['engine']=='fts5-contract' and virtual['tokenizer']=='unicode61','FTS_MATCH_TARGET')
        owner=match.find_ancestor(exp.Select)
        scope=next((s for s in traverse_scope(node) if s.expression is owner),None)
        require(scope is not None,'FTS_QUERY_SCOPE')
        aliases=[alias for alias,(_,source) in scope.selected_sources.items() if isinstance(source,exp.Table) and source.name.lower()==name]
        require(len(aliases)==1,'FTS_QUERY_SCOPE')
        expr=match.expression
        require(isinstance(expr,exp.Placeholder) or isinstance(expr,exp.Literal) and expr.is_string or isinstance(expr,exp.Null),'FTS_QUERY_PARAMETER')
        query=values[expr.name] if isinstance(expr,exp.Placeholder) else None if isinstance(expr,exp.Null) else expr.this
        tree=compile_query(query);ids=[]
        fields=virtual['indexed'];columns=','.join(ident(f) for f in fields)
        size='+'.join('coalesce(octet_length('+ident(f)+'),0)::bigint' for f in fields)
        # Inspect size before fetching large text. A server cursor bounds row
        # buffering; the transaction pins one snapshot until final SQL finishes.
        scan='SELECT rowid,'+size+' AS bytes,'+','.join('CASE WHEN ('+size+')<=%s THEN '+ident(f)+' ELSE NULL END' for f in fields)+' FROM '+ident(name)+' ORDER BY rowid'
        with connection.raw.cursor(name='fts_'+uuid.uuid4().hex) as cursor:
            cursor.execute(scan,(limits.row_bytes,)*len(fields))
            while batch:=cursor.fetchmany(64):
                for row in batch:
                    budget.take(row[1]);pieces=tuple(tokens(text,budget.check) for text in row[2:])
                    if matches(tree,pieces):ids.append(row[0])
        key='p'+str(max([int(k[1:]) for k in values]+[-1])+1);values[key]=ids
        replacement=exp.EQ(this=exp.column('rowid',table=aliases[0]),expression=exp.Any(this=exp.Paren(this=exp.Cast(this=exp.Placeholder(this=key),to=exp.DataType.build('BIGINT[]')))))
        match.replace(replacement)
    budget.check()
    return node,values,budget
