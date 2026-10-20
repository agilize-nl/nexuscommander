# Fase 1 execution plan — build the safe mutation foundation

**Date:** 2026-07-29
**Status:** **Executed 2026-07-29/30.** All eight items landed; commits
`ebc28a5`..`2d19350`. See "Outcome" at the end.
**Derived from:** `COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md`, section
"Phase 1 — Build the safe mutation foundation" (P1.1–P1.7), section 6 (target
architecture), section 6.1 (what "atomic" can and cannot mean), and section 14
(recommended first implementation slice).
**Predecessor:** `FASE_0_UITVOERINGSPLAN_2026-07-29.md` — executed, eleven
commits `245057f`..`fb85689`.

## Context

Fase 0 contained the damage; Fase 1 removes the reason the containment was
needed. Today every mutating path writes straight at its final destination, so
`safety.rs` has to refuse each replacement outright. That refusal is the correct
stopgap and a bad product: "copy over an existing file" is an ordinary thing to
want, and right now it simply fails. P1.5 is what earns the right to delete
`safety.rs`.

The phase is sized at ~3× Phase 0 in the source plan. Phase 0 ran to eleven
commits, so Fase 1 is expected in the 25–35 range. The sequence below is
binding — P1.4 cannot start before there is something to regress against, and
P1.7 cannot start before the engine it routes into exists.

### Two dependency corrections found while planning

**P0.7 was deferred out of Fase 0 but is a hard dependency of P1.4.** The Fase 0
outcome records "the full QSF-023 characterization suite" as follow-up work.
The Phase 1 table lists P1.4's dependencies as "P1.2, P0.7", and its exit
evidence is *"fault-injection tests preserve old destination; characterization
suite still green"* — there is no characterization suite to keep green. Section
14 puts the same item at step 4, before any engine work. **P0.7 is therefore
item 1 of this plan, not a Fase 0 loose end.** Writing it after the rewrite
would characterize the rewrite, which is worth nothing.

**P0.7's own value depends on a subtlety.** Fase 0's stopgap already changed
observable behavior: every overwrite now returns an error. So the suite
characterizes *post-stopgap* behavior, and the assertions that matter are the
ones that must survive P1.5 unchanged (non-existing destination succeeds,
metadata preserved, cancellation semantics) versus the ones P1.5 is expected to
flip (existing destination refused → existing destination replaced
transactionally). Those two groups are separated explicitly in the suite so a
deliberate flip is not mistaken for a regression, per `CLAUDE.md`'s "verify a
check can fail".

## Verified current state (2026-07-29)

Every claim below was checked against the working tree, not taken from the plan
text.

| Area | State | Evidence |
|---|---|---|
| P0.6 stopgap sites | 6 guards to remove in P1.5 | `refuse_if_exists` called from `vfs.rs` `rename_entry`, `copy_file`, `copy_directory`; `task_queue.rs` `copy_file_chunked`, `execute_move`; `archive.rs` `pack_archive` |
| Test baseline | **36 tests, all green** | `cargo test` in `apps/desktop/src-tauri`; zero frontend tests, zero integration-test directory |
| IPC parity gate | **Does not exist** | `scripts/` holds `check-csp`, `check-no-plugin-loader`, `check-no-shell-injection`, `check-versions` — none checks `generate_handler!` against `ipc.ts`. `apps/desktop/CLAUDE.md` still says "Nothing enforces this yet"; QSF-008 was fixed by contract edit, not by a gate. **P1.1 owns this.** |
| Job execution model | Blocking I/O on the async runtime | `task_queue.rs:175` `tauri::async_runtime::spawn` runs `execute_copy`/`execute_move`/`execute_delete`, which are fully synchronous `fs` loops. No worker bound, no dedicated blocking pool. **P1.3 owns this.** |
| Duplicate-worker guard | Partial | `execute_task` refuses a second worker for `Running`/`WaitingForInput` (`task_queue.rs:162`), but there is no bound on how many *distinct* tasks run at once |
| Structured results | `OpResult { success, message }` only | `vfs.rs:32`. No operation kind, no per-entry outcome, no `CommitOutcome` variants, no journal. Failures are prose strings the UI can only display |
| `PathPolicy` | **Does not exist** | Nothing resolves symlinks by policy. `canonicalize_path` (`vfs.rs:467`, duplicated at `task_queue.rs:65`) is a self-containment check only; `entry_exists` in `safety.rs` is the single no-follow call in the codebase (QSF-003 still open) |
| `batch_rename` | Still unsafe, as recorded in Fase 0 | `vfs.rs:307` — temp names are `{from}.nc_rename_tmp_{i}` (predictable, collidable, and left behind on a crash) and the phase-2 rename can overwrite. QSF-011, **P1.6 owns it** |
| Durability | None anywhere | No `fsync`, no directory sync, no durability tier in any mutation path |

### Scope decision: the web backend is not in Fase 1

`apps/web/server` has the *same* untransactional shape —
`fileOps.js:50` `createWriteStream(dest)` truncates on open, `fileOps.js:119`
and `taskExecutor.js:203` `fs.rename` over a destination, `taskExecutor.js:150`
`writeFile(finalDest, …)`, `taskExecutor.js:75` `rm(src, { force: true })` —
and it received **no P0.6 stopgap**. The QSF plan never audited it; its findings
were taken from the desktop line.

This is a genuine gap, and it is being named here rather than absorbed. Phase 1
as specified builds a Rust engine (`OperationSpec`, no-follow adapters,
blocking-worker `JobManager`), and `CLAUDE.md`'s "backends are never shared"
rule means none of that code can cross over. Pulling Express into this phase
would roughly double it while sharing no implementation.

**Decision: Fase 1 is the desktop Rust engine.** A web-side equivalent is
recorded as new finding **QSF-026** and is proposed as a Fase 1b to run after
P1.5 has settled the semantics worth mirroring. What Fase 1 *does* owe the web
shell is the P1.1 contract: the result schema is defined in
`packages/ui/src/lib/ipc-contract.ts`, so the web adapter must be able to
produce it, and the UI must not grow a `if (isDesktop)` branch to tell the two
apart.

## Execution order

Eight items. Each is its own commit (or small commit series, as with P0.4).
`npm run check` plus `cargo test` after every one; `npm run verify` before any
push.

### 1. P0.7 — Characterization suite (the deferred Phase 0 dependency)

Capture what copy, move, delete, rename and archive-create do *today*, before
anything is rewritten. New `apps/desktop/src-tauri/tests/` integration
directory, since these drive real filesystems rather than unit-testing
internals.

Split into two clearly labelled groups:

- **`invariant_*`** — must stay true through P1.5/P1.6: copy to a free
  destination succeeds and preserves mtime; directory merge into a populated
  directory works; delete-to-trash failure never becomes a permanent delete;
  cancellation leaves the source intact; `keep-both` naming.
- **`stopgap_*`** — expected to flip when P1.5 lands: every existing-destination
  refusal. Each carries a comment naming P1.5 as the item that changes it.

Exit: suite green, wired into `npm run verify`, and demonstrated to fail — break
one invariant deliberately and confirm red.

### 2. P1.1 — `OperationSpec`, structured results, IPC parity gate

Three pieces, one commit each if they grow.

- **`OperationSpec`** (new `src/engine/spec.rs`): sources, destination,
  operation kind, `policy_version`, and the policy enums from plan section 6 —
  `ConflictPolicy`, `SymlinkPolicy`, `MetadataPolicy`, `VerificationPolicy`.
  Defined and serialized now; *not* yet honoured by the mutation paths. This is
  section 14 step 5's "without changing user-visible copy semantics yet".
- **Structured outcome**: `CommitOutcome` with the section 6.1 variants —
  `Committed`, `Skipped`, `CancelledBeforeCommit`, `RolledBack`,
  `CopiedSourceRetained`, `PartiallyCommitted { journal }`,
  `ManualRecoveryRequired`. `OpResult` gains the outcome without losing
  `success`/`message`, so no call site breaks in this commit; the mirror type
  lands in `ipc-contract.ts` as optional fields, which keeps the web adapter
  conforming.
- **`scripts/check-ipc-parity.js`**, wired into `check:static`: parse
  `generate_handler!` from `lib.rs`, parse the `invoke("…")` names from
  `apps/desktop/src/lib/ipc.ts`, fail on either direction of mismatch, with the
  five known-absent QSF-008 commands as a named, commented allowlist so the
  gate is green today and goes red the moment a sixth appears. Prove it fails:
  add a fake `invoke()`, confirm red, remove it.

### 3. P1.2 — `PathPolicy` and no-follow adapters

New `src/engine/path_policy.rs`. Resolve a path one component at a time,
refusing to traverse a symlink unless `SymlinkPolicy` says otherwise, with
depth and cycle bounds. Platform adapters declare what they actually guarantee:

- Linux: `openat2(RESOLVE_NO_SYMLINKS)` where the kernel is 5.6+, falling back
  to component-wise `openat` + `O_NOFOLLOW`. Detect at runtime, do not assume.
- Windows: `FILE_FLAG_OPEN_REPARSE_POINT` + `FILE_FLAG_BACKUP_SEMANTICS`,
  written against the API and marked **unverified-on-Windows** in the commit —
  the same honesty P0.2 used. Native qualification is P4.1.

Per section 6.1, an adapter that cannot meet the requested guarantee must make
`PathPolicy` **refuse the operation**, never silently downgrade. Fixture suite:
symlinked destination, symlinked intermediate component, cycle, hardlink,
mount-point crossing, `..` escape, case-only collision.

### 4. P1.3 — Bounded single-runner `JobManager`

New `src/engine/job.rs`. `JobRecord` per plan section 6 (state, timestamps,
effective policies, progress, cancellation token, errors, recovery artifacts).
Replace `tauri::async_runtime::spawn` with a bounded dedicated blocking pool —
these are synchronous `fs` loops and do not belong on the async runtime. One
runner per job, enforced by the state machine rather than by the current
status check. Fixes QSF-010's orphaned-waiting-task half as a consequence: a
job waiting on a conflict decision holds a worker, so the bound has to account
for it or the queue deadlocks — that is the case worth a test.

`TaskQueueManager` becomes a thin adapter over `JobManager` in this commit;
`TaskInfo` on the wire does not change yet.

### 5. P1.4 — Transactional write and atomic commit primitives

New `src/engine/commit.rs`. The staging protocol: temp file in the
**destination** directory (never the system temp dir — that defeats the
same-filesystem rename), write, verify per `VerificationPolicy`, sync per tier,
`rename` over the target.

- Durability tiers `None` / `FlushOnly` / `SyncFile` / `SyncFileAndDirectory`,
  default chosen per operation kind and raisable by the user. A safety default
  slow enough to be switched off protects nobody.
- Journaled trees: `PartiallyCommitted { journal }` with a durable per-entry
  record, because no portable primitive commits a populated directory merge
  atomically.
- Verification is honest: readback proves the page cache agrees, not that data
  reached the platter. Only the sync tiers make a durability claim, and the
  message text must not overstate it.
- First consumers, lowest risk first: `save_text_file` and the settings/bookmark
  writes. Recursive copy comes in P1.5.

Fault injection: fail at every stage (after temp create, mid-write, after
write/before sync, after sync/before rename) and assert the original
destination is byte-identical each time. Characterization suite still green.

### 6. P1.5 — Transactional copy and move; remove the stopgap

Route `copy_file`, `copy_directory`, `copy_file_chunked`,
`copy_dir_recursive_chunked`, `rename_entry` and `execute_move` through
`commit.rs`. Same-filesystem move keeps using `rename`; cross-filesystem move
becomes copy-then-verify-then-delete-source, and the source is **never** removed
before the destination commit is durable (QSF-002's actual fix).

Then delete `src/safety.rs` and all six call sites, and flip the `stopgap_*`
tests from item 1 into their replacement assertions — an existing destination is
now *replaced transactionally* and survives every injected failure byte-for-byte.
Deleting the guard and proving the replacement must be the same commit; a gap
between them is a window where the repository has neither protection.

Update the `safety.rs` doc comment's promise ("Removed by P1.5") by actually
keeping it.

### 7. P1.6 — Safe delete, rename, conflict, progress, recovery

- **`batch_rename` rebuilt** (QSF-011): randomized temp names inside the target
  directory, a durable plan so an interrupted batch is describable, and the
  phase-2 rename going through `commit.rs` so it cannot overwrite. Left-behind
  `.nc_rename_tmp_*` files from a crashed old run get a recognized-and-reported
  path, not silent adoption.
- **Trash deletion** modelled as its own outcome, not an `OpResult` bool. The
  existing never-silently-fall-back-to-permanent invariant gets a regression
  test (item 1 already places it in the `invariant_*` group) and any retry as
  permanent deletion requires a *new* explicit confirmation.
- **Conflict decisions** become per-item and deterministic, `keep-both` naming
  included, replacing the current global-plus-current resolution pair.
- **No hidden partial results**: every job ends with a retained structured
  result. `CLAUDE.md` already forbids discarding an `OpResult`; this makes the
  discarding impossible rather than forbidden.

### 8. P1.7 — Route every mutation through the engine, and gate the bypass

Sweep the remaining direct-`fs` mutation sites — clipboard paste, drag/drop,
dialog-driven writes, `create_directory`, `delete_entry(s)`, `save_text_file` —
onto the engine. Then `scripts/check-no-fs-bypass.js`, wired into
`check:static`: no file outside `src/engine/` may call `fs::copy`, `fs::rename`,
`fs::remove_*`, `fs::write` or `File::create`, with an explicit reviewed
allowlist.

Prove it fails, and prove it the way `check-no-plugin-loader.js` had to be
proved — that gate's first version passed against a real loader because its
regex excluded backticks. Probe this one with at least: a plain call, a
`use std::fs as f;` alias, a fully-qualified `std::fs::rename`, and a call
inside a macro body.

## Fase 1 exit criteria

From the source plan, unchanged: existing data is never destroyed before the
replacement commits; symlink policy is explicit; every mutation produces a
truthful retained result. Concretely:

- `src/safety.rs` is gone and nothing needs it.
- Fault injection at every stage of copy/move/write leaves the prior
  destination byte-identical.
- `check-ipc-parity` and `check-no-fs-bypass` both run in `npm run verify` and
  have each been demonstrated red.
- The characterization suite is green, with every flipped assertion traceable
  to P1.5 or P1.6 in a comment.

## Verification

- After each item: `npm run check` and `cargo test --manifest-path
  apps/desktop/src-tauri/Cargo.toml`. `npm run verify` before pushing.
- Every new gate gets the `CLAUDE.md` treatment: break its input deliberately,
  confirm red, restore. Recorded in the commit message, not assumed.
- Fault injection is a first-class test dependency, not manual poking —
  decide the mechanism in item 5 and use it consistently from there.
- Windows-native behavior stays **unverified** for the whole phase (P4.1 owns
  it). Any Windows-specific adapter says so in its commit message rather than
  implying parity.

## Outcome

Ten commits, `ebc28a5`..`2d19350`. Every item landed. **`src/safety.rs` is gone
and nothing needs it** — the phase's headline result.

| Item | Commit | Note |
|---|---|---|
| P0.7 | `ebc28a5` | The **first trash test was worthless**: it asserted "if trash failed, the file survives", and on a working desktop trash never fails, so the branch that mattered never ran. Moved to its own binary which redirects `HOME` at a read-only directory to force the failure. Two live exposures got recorded as `stopgap_*` rather than left implicit — `save_text_file` had no P0.6 guard, and `batch_rename`'s predictable temp name **provably destroyed an unrelated file**. |
| P1.1 | `3e2cd84`, `964fe94`, `98fb26e` | Parity gate proved with five probes including the backtick case. `consumes_source()` replaces the plan's "destructive" framing: under QSF-001 every kind can destroy its destination, so that word separates nothing. |
| P1.2 | `1b5a0d2` | Two documented deviations: no `openat2` (the `openat`+`O_NOFOLLOW` fallback gives the same guarantee, and the raw-syscall path would be untestable here), and `..` is not normalized lexically (that is what makes the checker and the kernel disagree). Windows is honestly `Guarantee::Advisory`. |
| P1.3 | `a3fc049` | The deadlock had a **fourth** answer the plan did not list: bound threads and I/O concurrency *separately*, and have a parked job release its I/O permit. Conflict UX unchanged, no deadlock, preflight no longer forced. Closed two real double-worker holes — a **paused** task got a second worker, and a **cancelled** task could be restarted. Writing the guard as `!transition_to(Running)` was wrong and the characterization suite caught it: `WaitingForDecision → Running` is legal (it is how the conflict wait resumes), just not something an external `execute_task` may do. |
| P1.4 | `a5cc7be` | Fault injection at all five stages. The rename stage is deliberately different: the staged content is complete there, so it is *kept* and reported as `ManualRecoveryRequired` naming both paths. Also caught by building the lib: the non-test `fault_at!` macro expanded to nothing rather than an expression, so the crate compiled under `cfg(test)` and not otherwise. |
| P1.5 | `fe6a0a1` | `safety.rs` deleted with all six call sites, and every `stopgap_*` assertion flipped in the same commit. `rename_entry` turned out never to have needed staging — `rename(2)` replacing a destination is already atomic; what P0.6 was really protecting against was the *queued* move deleting the destination first. Archive creation stages to a `.part` file and renames, which gives the same guarantee without rewriting five format writers. |
| P1.6 | `596a53d` | `batch_rename` rebuilt; the QSF-011 data loss test is now a passing invariant and no `stopgap_*` test remains. `OpResult` finally gained the `outcome` field the TS contract had declared since P1.1 — `success` is *derived* from it so the two cannot disagree. Keep-both landed end to end including six locales, because it is the only resolution that cannot lose data. |
| P1.7 | `2d19350` | Closed two bypasses I had left: `batch_rename`'s cross-directory rename went by path (now `renameat` with two descriptors) and `execute_move` still called `fs::rename`. The gate's matcher is written against five evasions, all probed red. |

**Test count:** 36 unit → **109 unit + 40 integration + 2 trash**.

**New gates:** `check-ipc-parity.js`, `check-no-fs-bypass.js`.

### Fase 1 exit criteria — met

- `src/safety.rs` is gone and nothing needs it. ✔
- Fault injection at every stage of copy/move/write leaves the prior destination
  byte-identical. ✔ (five stages, `engine/commit.rs`)
- Both new gates run in `npm run verify` and have each been demonstrated red. ✔
- The characterization suite is green with every flipped assertion traceable to
  the item that flipped it, in a comment. ✔

### Carried forward, deliberately

- **QSF-026** — `apps/web/server` still has the untransactional shape
  (`createWriteStream(dest)`, `fs.rename` over a destination, `rm(src, {force})`)
  and never received even the P0.6 stopgap. Scope decision above; proposed as
  Fase 1b.
- **Archive extraction is still unsafe** (QSF-004). Creation was fixed in P1.5;
  extraction writes into the destination directly and is P2.3's. The
  `check-no-fs-bypass` allowlist entry for `archive.rs` says so and has to be
  removed when P2.3 lands.
- **Cross-device directory moves** fall back to a per-file tree copy plus a
  delete. Correct and interruptible, but the journal is not yet persisted to
  disk, so an interrupted one cannot be resumed — only described.
- **Conflicts are still resolved one at a time, mid-copy.** Preflight resolution
  (plan section 6) remains the target; P1.3 removed the deadlock that would have
  forced it, so it is now a UX decision rather than a structural one.
- **Windows is unverified.** Every Windows adapter says so in its own docs;
  `Guarantee::Advisory` is what that platform actually gets. P4.1 owns it.

## Explicitly out of scope

- **QSF-026, the web backend's untransactional mutations** — new finding, see
  the scope decision above. Proposed as Fase 1b.
- Archive rebuild (Phase 2) — P1.5 removes `pack_archive`'s stopgap guard by
  routing it through `commit.rs`, but archive *semantics* stay untouched.
- Whole-app elevation (QSF-007 / P4.2), release pipeline (QSF-021 / P4.3),
  `FileList`/`archive.rs` module splits (P3.4, which the eight silenced
  `too_many_arguments` clippy allows point at).
- CI substrate — still no git remote, unchanged from Fase 0.
