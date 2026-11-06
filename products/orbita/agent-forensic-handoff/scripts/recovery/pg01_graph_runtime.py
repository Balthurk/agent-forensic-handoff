"""Archive effective JVM arguments and compare them with a new restore target.

Docker Config.Env alone omits JVM options applied inside a running container.
This reader never changes a process, file, container, or service configuration.
"""
import base64,hashlib,json
from orbita_store.config import require
from orbita_store.service_archive import canonical

SCHEMA='orbita-graph-effective-jvm-1'
CASSANDRA_COMPATIBILITY=['-XX:-UseContainerSupport','-XX:ActiveProcessorCount=2']
PROGRAM=r'''
set -eu
for directory in /proc/[0-9]*; do
 executable=$(readlink "$directory/exe" 2>/dev/null) || continue
 case "$executable" in */java)
  before=$(awk '{print $22}' "$directory/stat")
  args=$(base64 "$directory/cmdline" | tr -d '\n')
  digest=$(sha256sum "$directory/exe")
  after=$(awk '{print $22}' "$directory/stat")
  test "$before" = "$after"
  printf '%s\n' "${directory##*/}" "$before" "$executable" "${digest%% *}" "$args"
 esac
done
'''

def parse_probe(raw):
    require(isinstance(raw,bytes) and len(raw)<=128*1024,'GRAPH_RUNTIME_OUTPUT_BUDGET')
    lines=raw.decode('utf-8').splitlines()
    require(len(lines)==5,'GRAPH_RUNTIME_EXPECTED_ONE_JAVA_PROCESS')
    pid,start,executable,digest,encoded=lines
    args=base64.b64decode(encoded,validate=True)
    require(0<len(args)<=65536 and args.endswith(b'\0'),'GRAPH_RUNTIME_CMDLINE_BYTES')
    return dict(pid=int(pid),startTicks=int(start),executable=executable,executableSha256=digest,
                argv=[v.decode('utf-8') for v in args[:-1].split(b'\0')],argvSha256=hashlib.sha256(args).hexdigest())

def validate_probe(value,kind):
    require(isinstance(value,dict) and set(value)=={'pid','startTicks','executable','executableSha256','argv','argvSha256'},'GRAPH_RUNTIME_PROBE_FIELDS')
    require(type(value['pid']) is int and value['pid']>0 and type(value['startTicks']) is int and value['startTicks']>0,'GRAPH_RUNTIME_PROCESS_IDENTITY')
    args=value['argv']
    require(isinstance(args,list) and 1<len(args)<=512 and all(isinstance(v,str) and '\0' not in v and len(v)<=32768 for v in args),'GRAPH_RUNTIME_ARGV')
    raw=('\0'.join(args)+'\0').encode('utf-8')
    require(len(raw)<=65536 and hashlib.sha256(raw).hexdigest()==value['argvSha256'],'GRAPH_RUNTIME_ARGV_DIGEST')
    require(isinstance(value['executable'],str) and value['executable'].startswith('/') and value['executable'].endswith('/java'),'GRAPH_RUNTIME_EXECUTABLE')
    require(isinstance(value['executableSha256'],str) and len(value['executableSha256'])==64 and all(c in '0123456789abcdef' for c in value['executableSha256']),'GRAPH_RUNTIME_EXECUTABLE_DIGEST')
    require(kind in ('cassandra','janus'),'GRAPH_RUNTIME_KIND')
    main='org.apache.cassandra.service.CassandraDaemon' if kind=='cassandra' else 'org.janusgraph.graphdb.server.JanusGraphServer'
    require(args.count(main)==1,'GRAPH_RUNTIME_MAIN_CLASS')
    main_index=args.index(main)
    required=['-Xms768M','-Xmx768M','-Xmn128M',*CASSANDRA_COMPATIBILITY] if kind=='cassandra' else ['-Xms128m','-Xmx768m']
    for token in required:require(args.count(token)==1 and args.index(token)<main_index,'GRAPH_RUNTIME_REQUIRED_OPTION')
    heaps={'-Xms':['-Xms768M'],'-Xmx':['-Xmx768M'],'-Xmn':['-Xmn128M']} if kind=='cassandra' else {'-Xms':['-Xms4096m','-Xms128m'],'-Xmx':['-Xmx4096m','-Xmx768m'],'-Xmn':[]}
    for prefix,expected in heaps.items():
        require([a for a in args if a.startswith(prefix)]==expected,'GRAPH_RUNTIME_HEAP_OPTION_ORDER')
    if kind=='cassandra':
        require([a for a in args if 'UseContainerSupport' in a]==CASSANDRA_COMPATIBILITY[:1],'GRAPH_RUNTIME_CONTAINER_METRICS_OPTION')
        require([a for a in args if a.startswith('-XX:ActiveProcessorCount=')]==CASSANDRA_COMPATIBILITY[1:],'GRAPH_RUNTIME_CPU_OPTION')
    return value

def validate_configuration(value,services):
    require(isinstance(value,dict) and set(value)=={'schema','before','after','sha256'} and value['schema']==SCHEMA,'GRAPH_RUNTIME_CONFIGURATION_REQUIRED')
    require(value['before']==value['after'],'GRAPH_SOURCE_RUNTIME_CHANGED_DURING_BACKUP')
    require(hashlib.sha256(canonical(value['before'])).hexdigest()==value['sha256'],'GRAPH_RUNTIME_CONFIGURATION_DIGEST')
    rows=value['before'];require(isinstance(rows,list) and len(rows)==len(services)==5,'GRAPH_RUNTIME_SERVICE_COUNT')
    for index,(row,service) in enumerate(zip(rows,services,strict=True)):
        kind='cassandra' if index<3 else 'janus'
        require(set(row)=={'containerId','image','startedAt','kind','process'},'GRAPH_RUNTIME_SERVICE_FIELDS')
        require(row['containerId']==service['Id'] and row['image']==service['Image'] and row['startedAt']==service['State']['StartedAt'] and row['kind']==kind,'GRAPH_RUNTIME_SERVICE_BINDING')
        validate_probe(row['process'],kind)
    return rows

def collect(services,call):
    rows=[]
    for index,service in enumerate(services):
        kind='cassandra' if index<3 else 'janus'
        owner='cassandra' if kind=='cassandra' else 'janusgraph'
        value=parse_probe(call(['docker','exec','-i','--user',owner,service['Id'],'sh','-s'],seconds=20,input_bytes=PROGRAM.encode(),limit=128*1024))
        validate_probe(value,kind)
        rows.append(dict(containerId=service['Id'],image=service['Image'],startedAt=service['State']['StartedAt'],kind=kind,process=value))
    return rows

def equivalent(source,target,kind):
    validate_probe(source,kind);validate_probe(target,kind)
    require(source['executable']==target['executable'] and source['executableSha256']==target['executableSha256'],'GRAPH_RESTORED_JAVA_EXECUTABLE_DIFFERS')
    # Only the two captured compatibility options move from a server options
    # file to JVM_EXTRA_OPTS. Every other argument retains its exact order.
    normalize=lambda args:[a for a in args if kind!='cassandra' or a not in CASSANDRA_COMPATIBILITY]
    require(normalize(source['argv'])==normalize(target['argv']),'GRAPH_RESTORED_JVM_ARGUMENTS_DIFFER')
    return dict(status='PASS_EFFECTIVE_JVM_CONFIGURATION',kind=kind,sourceArgvSha256=source['argvSha256'],targetArgvSha256=target['argvSha256'],executableSha256=target['executableSha256'],onlyPermittedArgumentRelocation=CASSANDRA_COMPATIBILITY if kind=='cassandra' else [])
