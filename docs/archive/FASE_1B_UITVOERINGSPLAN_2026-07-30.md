# Fase 1b execution plan — the web backend's safe mutation path (QSF-026)

**Date:** 2026-07-30
**Status:** Completed.
**Derived from:** `COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md` section 6
(target architecture) and section 6.1 (what "atomic" can and cannot mean), applied
to `apps/web/server` rather than to the desktop line the plan audited.
**Predecessor:** `FASE_1_UITVOERINGSPLAN_2026-07-29.md` — executed, ten commits
`ebc28a5`..`2d19350`, and its "Scope decision: the web backend is not in Fase 1",
which recorded **QSF-026** and deferred it to exactly this phase.

## Context

Fase 1 built the desktop commit engine and deleted `safety.rs`. The web backend
was left where it started: it has the same untransactional shape the desktop line
had before P0.6, and it never received even that stopgap. Desktop users were
protected from the Critical data-loss paths throughout Fase 0 and Fase 1 — web
users have not been protected at any point, and the web shell is the one that
runs deployed.

The Fase 1 scope decision remains correct: `CLAUDE.md`'s "backends are never
shared" means no line of `src-tauri/src/engine/` can cross over. What crosses is
the *design*, which is now settled and proven under fault injection. This phase
implements it a second time, in a runtime without `openat`, and is honest about
the places where the guarantee is therefore weaker.

Fase 1 ran to ten commits. This phase is smaller — the decisions are made — and
is expected in the 6–9 range, one per item below.

## Verified current state (2026-07-30)

Every claim below was checked against the working tree, not taken from the Fase 1
notes.

| Area | State | Evidence |
|---|---|---|
| Truncating copy | **Destination destroyed before the first source byte is read** | `lib/fileOps.js:50` — `createWriteStream(dest)` truncates on open. This is QSF-001 verbatim, and it is reached by `/api/fs/copy`, `/api/fs/move` and every queued copy task |
| Cross-device move | Copy-then-`unlink` with no staging and no verification | `lib/fileOps.js:121-123`, `lib/taskExecutor.js:206-212`. A failure mid-copy leaves the destination truncated *and* the source still present, reported as a thrown error |
| Whole-file writes | Written straight at the final path | `routes/fs.js:567` (`/api/fs/text`), `lib/taskExecutor.js:150`, `routes/archive.js:267`, `routes/archive.js:323`, `routes/bookmarks.js:22` |
| Delete | `rm` with `force`, no outcome modelling, no trash | `routes/fs.js:528`, `lib/taskExecutor.js:75`. There is no trash on this backend at all, so every delete is permanent — the UI does not say so |
| Rename | By path, no component-wise resolution | `routes/fs.js:540`. `rename(2)` itself replaces atomically, so this is a path-policy finding, not a transactionality one |
| Elevated mutations | **`sudo mv` and `sudo rm -rf`, as root, bypassing everything** | `routes/fs.js:715-772`. Arguments are an array via `spawn` (`fs.js:665`), so there is no shell-injection finding here; there is a destructive-overwrite finding, at the highest privilege the product has |
| Correct precedents already in tree | Two | `routes/upload.js:159-201` stages to a temp path, renames, and unlinks the temp on failure; `routes/settings.js:194-226` takes two backups, writes a temp file and renames |
| Path policy | `path.resolve` plus a NUL check | `lib/security.js:12-24`. No component-wise resolution, no `O_NOFOLLOW` anywhere in `server/`. `sanitizeRelPath` (`security.js:94`) is thorough but only applies to archive-relative paths |
| Structured results | `{ success, message }`, or a bare `{ success: true }` | `routes/fs.js:488`, `:518`, `:529`, `:541`. `runTask` sets `Completed` for anything that does not throw (`lib/taskExecutor.js:53`), so a move whose source deletion failed is indistinguishable from a clean one |
| Durability | **None** | No `fsync`, `fdatasync` or `FileHandle.sync()` anywhere under `apps/web/server` |
| Tests | One shell smoke test | `apps/web/tests/functional-smoke-test.sh`. No `test` script, no unit runner. Node 24 is the runtime, so `node:test` is available without adding a dependency |
| P0.6 stopgap | **Never applied here** | `refuse_if_exists` was a Rust function; nothing equivalent exists in `server/` |
| Static gates | Desktop only | `scripts/check-no-fs-bypass.js` scans `apps/desktop/src-tauri/src` and nothing else |

### What the shared contract already expects

`packages/ui/src/lib/ipc-contract.ts:147` defines `CommitOutcome` with the same
seven variants as `engine/outcome.rs`, and `OpResult.outcome` is optional
specifically so the web adapter could arrive later without breaking
(`ipc-contract.ts:70-73` says so). This phase is that arrival. The UI must gain
no `if (isDesktop)` branch as a result — that is the Fase 1 obligation this phase
discharges.

## Scope

**In:** the transactional write path, path policy, delete/outcome modelling, the
elevated-mutation stopgap, and the static gate that keeps all of it.

**Out, deliberately:**

- **Archive extraction on the web side.** `lib/taskExecutor.js:104-156` extracts
  into a staging directory already, but into `os.tmpdir()` — which defeats the
  same-filesystem rename — and `routes/archive.js:250` unpacks straight into the
  destination. This is QSF-004's web twin and belongs with P2.3, so both backends
  get one extraction design rather than two.
- **Mid-copy conflict resolution.** `lib/taskExecutor.js:33` pauses the task and
  waits, exactly as desktop does. Preflight resolution stays the target for both
  shells and is a UX decision, not a structural one.
- **Elevation redesign.** Replacing `sudo mv` with a minimal privileged helper is
  the web analogue of QSF-007/P4.2. Item 6 below makes the current path
  non-destructive; it does not rebuild it.

## Execution order

Seven items. Each is its own commit. `npm run check` after every one;
`npm run verify` before any push.

### 1. P1b.0 — Characterization suite and a test runner

Web has no unit test runner. Fase 1's most expensive lesson was that the
characterization suite must exist *before* the rewrite — and its sharper version,
that a test which never exercises the branch it claims to cover is worth nothing
(the first trash test asserted a condition that could not fail on a working
desktop).

- Add `"test": "node --test server/**/*.test.js"` to `apps/web/package.json`, and
  a `tests/` layout under `apps/web/server/`. No new dependency: Node 24's
  `node:test` covers this.
- Two labelled groups, as in P0.7:
  - **`invariant_*`** — must survive the rewrite: copy to a free destination
    succeeds and preserves mode and mtime; directory merge into a populated
    directory works; cancellation leaves the source intact; `assertNotProtectedRoot`
    still refuses the protected set.
  - **`untransactional_*`** — documents what today's code destroys, and is
    expected to flip: a copy interrupted mid-stream leaves the destination
    truncated; an EXDEV move that fails after the copy leaves both sides damaged;
    `/api/fs/text` over an existing file destroys it on a failed write. Each
    carries a comment naming the item that flips it.
- Fault injection needs a mechanism, not manual poking. Proposal: a source that
  throws after N bytes (`Readable` subclass), so "fail mid-copy" is a parameter
  rather than a special test.
- Exit: suite green, wired into `scripts/verify.sh`, and demonstrated red by
  breaking one invariant deliberately.

### 2. P1b.1 — `server/lib/commit.js`, the staging protocol

The five steps of `engine/commit.rs`, in Node:

1. stage in the **destination directory** — never `os.tmpdir()`; a system temp
   dir makes the final rename cross-device and defeats the whole protocol;
2. `fs.open(staged, 'wx', 0o600)` so the staging name can never adopt an existing
   file;
3. verify per policy (byte count always; readback where the policy asks);
4. sync per durability tier;
5. `rename()` onto the target, then optionally sync the directory.

Public surface, matching what the call sites in item 4 need:
`writeFileAtomically`, `copyFileStaged`, `moveEntryStaged`, `keepBothName`,
and a `withStaging` helper whose `finally` removes the staging file or records it
as `orphaned_staging`.

Two things to get right:

- **Durability tiers** `none` / `flush` / `syncFile` / `syncFileAndDirectory`,
  defaulted per operation kind and raisable by the user. A directory fsync is
  `fs.open(dir, 'r')` + `sync()`; it works on Linux and throws on some other
  platforms — catch that and set `directorySynced: false` rather than failing the
  operation. The message the UI shows comes from the tier that was actually
  achieved, exactly as `CommitReport::durability_claim()` does. A per-file fsync
  makes a large tree copy an order of magnitude slower, so the default must stay
  usable or users will switch the safety off.
- **Verification is honest.** A readback proves the page cache agrees with what
  was written. Only the sync tiers may claim durability.

Exit: the fault-injection tests from item 1 fail at each of the five stages and
the previous destination is byte-identical every time.

### 3. P1b.2 — `server/lib/pathPolicy.js`, and an honest guarantee

Node has no `openat`, so `Guarantee.ComponentwiseNoFollow` is not reachable
without a native addon. Do not pretend otherwise.

- Resolve one component at a time with `lstat`, refusing to traverse a symlink
  unless the policy allows it, with depth and cycle bounds — the same shape as
  `engine/path_policy.rs`, minus the race-freedom.
- Open the final target with `fs.constants.O_NOFOLLOW` where the operation writes.
- Export `platformGuarantee()` returning `advisory`, with the reason in the doc
  comment. Anything that requests a stronger guarantee must be **refused**, never
  silently downgraded — that rule is what makes the desktop version worth
  anything and it applies here unchanged.
- `resolveSafePath` keeps its current job (validate and absolutise the input) and
  gains a companion that resolves *for mutation*. Mixing the two is how a checker
  and a kernel end up disagreeing.

Fixture suite: symlinked destination, symlinked intermediate component, cycle,
hardlink, `..` escape, case-only collision, and a destination replaced by a
symlink between check and write (which this adapter **cannot** win — the test
asserts the advisory label, not a guarantee we do not have).

### 4. P1b.3 — Route every mutation through the engine

Sweep the call sites onto items 2 and 3:

| Call site | Becomes |
|---|---|
| `lib/fileOps.js` `copyOneFile` | `copyFileStaged`; the truncating `createWriteStream(dest)` disappears |
| `lib/fileOps.js` `moveSourceSync` EXDEV branch | `moveEntryStaged`; the source is released only after the destination commit |
| `lib/taskExecutor.js` copy/move loop | the same two, per entry |
| `routes/fs.js` `/text` | `writeFileAtomically` |
| `routes/fs.js` `/copy`, `/move`, `/rename` | engine calls with an explicit conflict policy, including keep-both |
| `routes/bookmarks.js`, `routes/settings.js` | `writeFileAtomically` (settings keeps its backups; it stops hand-rolling the temp file) |
| `routes/upload.js` | `writeFileAtomically` — it already stages, so this is deduplication, not new behaviour |
| `routes/archive.js` pack/split/combine outputs | `writeFileAtomically` on the *output*; extraction stays out of scope |

Delete gets modelled rather than routed: `rm` has nothing to stage, but it does
need an outcome and it needs the UI to say **permanent**, because this backend
has no trash. That is a locale change in `packages/ui/src/lib/locales/*.json`, all
six languages.

### 5. P1b.4 — Structured outcomes on the wire

`runTask` stops deriving success from "did not throw". Every mutating route and
every task returns `OpResult` with the `outcome` field from
`ipc-contract.ts:147`, using the same snake_case wire spellings the Rust side has
tests for. Concretely this makes three states expressible that today are not:

- `copied_source_retained` — the move whose source could not be released;
- `partially_committed` — the tree operation that stopped halfway;
- `rolled_back` — the failure the staging protocol exists to produce.

The UI already knows these variants and already has
`outcomeNeedsAttention()`. No `if (isDesktop)` branch may be added.

### 6. P1b.5 — The elevated path stops being destructive

`/api/fs/elevate-operation` runs `mv` and `rm -rf` as root. A JavaScript commit
engine cannot supervise a root subprocess, so this item does what P0.6 did for
desktop — it refuses rather than pretends:

- `mv` gains `-n` (no-clobber) and the route reports a conflict instead of
  overwriting. An elevated overwrite is the single most destructive operation the
  product can perform and it currently has the weakest protection.
- `rm -rf` keeps `assertNotProtectedRoot` and gains an explicit second
  confirmation in the UI, phrased as permanent.
- The route's doc comment records that this path is **not transactional** and
  names P4.2's minimal privileged helper as the real fix.

### 7. P1b.6 — The gate

Extend `scripts/check-no-fs-bypass.js` with a second target: outside
`server/lib/commit.js`, the web backend may not call `createWriteStream`,
`writeFile`, `rename`, `rm`, `unlink`, `copyFile`, `cp` or `truncate`. One
allowlist entry per reviewed file, with a written reason, as the desktop half
already does.

Prove it red — and prove it the way the desktop gates had to be proved, since
`check-no-plugin-loader.js` once passed against a real loader because its regex
excluded backticks. At least four probes:

1. `await fs.rename(a, b)` — the plain spelling;
2. `import fsp from 'node:fs/promises'` — a different module specifier and alias;
3. `const { rename } = fs;` then a bare `rename(a, b)` — destructured;
4. `const m = await import('fs'); m.renameSync(a, b)` — dynamic import.

A gate that misses any of these does not count as delivered.

## Fase 1b exit criteria

- No mutation in `apps/web/server` reaches its final destination without staging,
  except deletion (nothing to stage) and the elevated path (item 6, refused
  rather than pretended).
- Fault injection at every stage of copy, move and write leaves the previous
  destination byte-identical.
- Every mutating route and task returns a `CommitOutcome`; `success` is derived
  from it so the two cannot disagree.
- `check-no-fs-bypass.js` covers both backends and has been demonstrated red on
  the web half with all four evasions.
- The web backend declares `advisory` as its path guarantee, and nothing claims
  more.
- The shared UI has gained no platform branch.

## Verification

- After each item: `npm run check` and `npm test -w apps/web`.
  `npm run verify` before pushing — the new test run joins `scripts/verify.sh`.
- Every new gate gets the `CLAUDE.md` treatment: break its input deliberately,
  confirm red, restore. Recorded in the commit message, not assumed.
- The deployed instance is the risk here, not the dev tree. Before the phase
  lands anywhere near CT188, the fault-injection suite must run against a real
  filesystem on that host — the durability tiers behave differently on network
  storage, and a directory fsync that throws must degrade to
  `directorySynced: false` rather than failing an operation.

## Carried forward from Fase 1, not addressed here

These stay open and are sequenced after this phase:

1. **Cross-device tree-move journal (desktop).** `copy_dir_recursive_chunked`
   (`task_queue.rs:409`) returns counters and an error string — no `Journal` is
   built at all today, so an interrupted tree move can be described only by
   whichever filename happened to be in `current_file`. Two commits: build the
   journal in memory and map it to `PartiallyCommitted`; then persist it as
   append-only NDJSON in a recovery directory, journal the per-entry source
   release, and make resume idempotent by re-checking the destination rather than
   trusting the record to be exact. Batch the flushes — an fsync per entry is the
   performance trap section 6.1 warns about. A minimal recovery prompt at startup
   belongs with it, because an unread journal is just a file.
2. **P2.3 — archive extraction, both backends.** `unpack_zip_safe`
   (`archive.rs:1614`) validates paths lexically and enforces limits, then writes
   with `File::create` straight into the destination. Extraction becomes: plan
   (preflight, no bytes written) → private staging directory inside the
   destination → per-entry promotion through `commit.rs` with a journal. The
   `archive.rs` allowlist entry in `check-no-fs-bypass.js` is removed in the same
   phase, and the gate proved red again. The web twin (`taskExecutor.js` staging
   into `os.tmpdir()`) is fixed here, not in Fase 1b.
3. **P4.1 — Windows.** `platform_guarantee()` returns `Advisory`
   (`path_policy.rs:83`) and the mingw cross-check is a compile gate, not
   qualification. Three tiers, in order: surface the guarantee in the UI so users
   see what their platform actually provides; then a `verify-windows.ps1` runbook
   plus a recorded qualification document, since there is still no CI substrate;
   then the real adapter work (`FILE_FLAG_OPEN_REPARSE_POINT` +
   `FILE_FLAG_BACKUP_SEMANTICS`, and `ReplaceFileW` evaluated per filesystem with
   documented failure tests). If qualification cannot happen before release,
   marking Windows unsupported is the honest alternative to shipping `Advisory`
   under the same flag as Linux.

Recommended order: **this phase → 1 → 2 → 3.** Item 1 is small and produces the
journal infrastructure item 2 reuses; item 3's first tier is cheap and can be
pulled forward at any time.
