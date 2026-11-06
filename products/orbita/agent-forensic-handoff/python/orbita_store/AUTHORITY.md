# Revocation and repeatable snapshots

Connection admission requires READ COMMITTED, verifies the capability, and binds
the backend PID plus backend start to one workspace. Ordinary content reads may
then use REPEATABLE READ or SERIALIZABLE, including READ ONLY transactions.

Every workspace has two private PostgreSQL sequences with CACHE 1 and NO CYCLE.
Their values invalidate all authority, or only worker authority. A session keeps
the values captured at admission; RLS compares them with current sequence state.
This avoids authorizing with policy rows from an older MVCC snapshot. The tables
and content snapshot remain shared and unchanged. Runtime cannot read, reset, or
advance these private sequences.

Admissions hold shared transaction locks for both workspace and parent. Policy,
capability, parent, and purge changes acquire the matching exclusive locks before
advancing a fence. This prevents admitting an old policy with a new fence. A
parent discovered before lock acquisition must still match afterward; otherwise
admission fails. There is no automatic reconnect or replay.

Sequence advancement survives rollback. An aborted authority update therefore
conservatively invalidates older sessions, even when the policy row rolls back.
A new explicit admission checks the committed policy and captures current fences.
Membership changes do not invalidate maintenance authority; parent revocation,
maintenance-secret changes, and tombstones do. Restoring content never restores
these control values. A full service backup must include them and quiesce control
mutations while acquiring the recovery cut.

Fence objects are retained with control history. Removing an original workspace
or its fences requires the explicit, consumer-checked cleanup/recovery workflow.
They are not a schema or database per case and contain no application payload.

The operator installs this protocol on a fresh database and before managed access.
An upgrade initializes missing fence objects, and previously admitted sessions
without captured fences fail closed until explicitly admitted again.
