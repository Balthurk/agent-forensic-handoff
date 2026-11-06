"""Keep the historical product checker path on the current complete checker."""
from pathlib import Path
import runpy
import sys


if __name__ == '__main__':
    checker = Path(__file__).resolve().parents[1] / 'agent-forensic-handoff/scripts/check.py'
    sys.argv[0] = str(checker)
    runpy.run_path(str(checker), run_name='__main__')
