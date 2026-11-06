"""Owned VM probe and host physical-memory monitor for a restore only."""
import json,subprocess,threading,time
from orbita_store.config import require
from orbita_store.service_archive import _environment
from pg01_graph_restore_layout import available_physical

PROGRAM="import json,time\nwhile True:\n v=next(int(s.split()[1])*1024 for s in open('/proc/meminfo') if s.startswith('MemAvailable:'))\n print(json.dumps(dict(available=v,utc=time.time())),flush=True);time.sleep(1)\n"

class MemoryWatch:
    def __init__(self,cid,abort):
        self.samples=[];self.failed=threading.Event();self.stopping=threading.Event();self.ready=threading.Event();self.errors=[];self.abort=abort;self.abort_sent=threading.Event();self.abort_lock=threading.Lock()
        self.process=subprocess.Popen(['docker','start','--attach',cid],stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,
                                      env=_environment(),creationflags=subprocess.CREATE_NO_WINDOW)
        def trigger():
            with self.abort_lock:
                if self.abort_sent.is_set() or self.stopping.is_set():return
                self.abort_sent.set()
            self.abort()
        def stderr():
            size=0
            while block:=self.process.stderr.read(4096):
                size+=len(block)
                if size>16384:self.errors.append('VM_PROBE_STDERR_BUDGET');self.failed.set()
        def sample():
            try:
                while raw:=self.process.stdout.readline(1025):
                    require(len(raw)<=1024 and raw.endswith(b'\n'),'GRAPH_MEMORY_PROBE_LINE')
                    value=json.loads(raw);require(set(value)=={'available','utc'} and type(value['available']) is int,'GRAPH_MEMORY_PROBE_VALUE')
                    physical=available_physical();self.samples.append(dict(at=value['utc'],vmAvailable=value['available'],hostAvailable=physical));self.ready.set()
                    if physical<2*1024**3 or value['available']<1024**3:self.errors.append('MEMORY_RESERVE_CROSSED');self.failed.set()
                    if self.failed.is_set() and not self.stopping.is_set():trigger()
            except BaseException:self.errors.append('VM_PROBE_READ_FAILED');self.failed.set()
            finally:
                if not self.stopping.is_set():self.errors.append('VM_PROBE_ENDED_EARLY');self.failed.set();trigger()
        def watchdog():
            while not self.stopping.wait(.5):
                if self.ready.is_set() and time.time()-self.samples[-1]['at']>=5:
                    self.errors.append('VM_PROBE_STALE');self.failed.set()
                if self.failed.is_set():trigger()
        self.threads=[threading.Thread(target=stderr,daemon=True),threading.Thread(target=sample,daemon=True),threading.Thread(target=watchdog,daemon=True)]
        for t in self.threads:t.start()
    def admit(self):
        require(self.ready.wait(15),'GRAPH_MEMORY_PROBE_START_TIMEOUT');self.check()
        current=self.samples[-1]
        require(current['hostAvailable']>=8*1024**3 and current['vmAvailable']>=7*1024**3 and available_physical()>=8*1024**3,'GRAPH_RESTORE_INITIAL_MEMORY_RESERVE')
    def check(self):
        require(not self.failed.is_set() and self.process.poll() is None,'GRAPH_RESTORE_MEMORY_MONITOR_FAILED')
        require(self.samples and time.time()-self.samples[-1]['at']<5,'GRAPH_RESTORE_MEMORY_MONITOR_STALE')
    def finish(self,stop_probe):
        self.stopping.set();stop_probe();self.process.wait(timeout=20)
        for t in self.threads:t.join(5)
        require(not any(t.is_alive() for t in self.threads),'GRAPH_MEMORY_MONITOR_NOT_CLOSED')
        self.process.stdout.close();self.process.stderr.close()
        return dict(status='FAIL_RESOURCE_PRESSURE' if self.failed.is_set() else 'PASS_OBSERVED_RESERVE',errors=self.errors,samples=self.samples,
                    minimumHost=min((s['hostAvailable'] for s in self.samples),default=None),minimumVm=min((s['vmAvailable'] for s in self.samples),default=None),ownedProcessExit=self.process.returncode)
