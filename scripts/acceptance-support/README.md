# Reproducible acceptance prerequisites

The root test runner includes all 14 test files, including the four acceptance
suites and the specification suite. These suites require explicit, contained
scratch space and historical inputs. They must not silently disappear from a
clean checkout's test run.

Current full qualification uses Windows, Python 3.12+ and Node 24.15 with the
native SQLite authorizer. The mapped SHM observer is Windows specific. These
are acceptance-observation requirements, not a claim that every product command
requires this exact operating system.

After `npm ci` and `npm ci --prefix tools/specification`, fetch the historical
release if its objects are absent from a single-branch clone:

```powershell
git fetch origin f4887f3c13221b13acaf19396aec47dbc013c13b
python scripts/prepare-acceptance.py --lab C:/T/my-new-afh-acceptance-lab
npm test -- --prepared C:/T/my-new-afh-acceptance-lab/PREPARATION.json
```

Use a new absolute directory outside the checkout, with an existing parent.
Preparation never deletes or overwrites an earlier lab and performs no network
access. Missing commits, changed historical bytes, links or unavailable native
observation stop preparation. Failed preparation leaves its output for diagnosis;
use a different new directory after correcting the cause.

`MANIFEST.json` identifies 99 exact files in two historical runtimes. Most bytes
are already in the repository's published Git objects; three small historical
variants are stored as inactive `.source` files. The pregraph runtime retains
the original hard-coded SHA-256 requirement in its test. The pre03 runtime
retains the exact original runtime hash and commit identity. Legacy versions
0.1.0, 0.2.0 and 0.3.0 are materialized from their actual pinned Git commits,
then each historical engine creates its own two-record synthetic case. They are
not the current engine relabeled as an older version.

The reader consumer's only adaptation is its import path to the tested checkout.
The Windows SHM helper retains its original bytes and can only open the bounded
`ledger.sqlite-shm` target for read-only native observation. Each run binds the
helper and selected Python executable hashes in a fresh manifest. Its writable
mapping probe must be rejected by Windows.

Preparation is not a test pass or product acceptance. The runner keeps the same
test discovery and concurrency. Every assertion, oracle, real native observation,
historical availability check and recorded skip remains part of the full run.
The only test-path change replaces a private absolute pregraph path with an
explicit environment input; the original runtime hash check is unchanged.

Generated databases, receipts, temporary directories and legacy cases belong in
the external lab and must never be committed. Real user corpora and credentials
are not required by these root skill acceptance inputs. Órbita's independent
qualified snapshot and its private P1 oracle have their own instructions in
`products/orbita/README.md`.
