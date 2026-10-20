# NexusCommander comprehensive quality and safety upgrade plan

**Review date:** 2026-07-28  
**Revised:** 2026-07-28 (rev. 3 — review corrections verified against both repositories; execution and filesystem guarantees clarified)  
**Reviewed version:** 0.8.34  
**Status:** Proposed release-gating plan  
**Scope:** Complete tracked desktop codebase: Svelte/SvelteKit UI, Tauri/Rust backend, configuration, dependencies, tests, documentation, packaging, and release scripts  
**Reviewed in:** `/mnt/Data/Development/_Apps/NexusCommander` (legacy desktop repository)  
**To be executed in:** `/mnt/Data/Development/_Apps/NexusCommander` (the monorepo — see section 1.1)  
**Supersedes as the current baseline:** `CODE_REVIEW_ACTIEPLAN_2026-07-13.md` and `SECURITY_AUDIT_2026-07-13.md`  
**Must be read together with:** `NEXUS_MIGRATIEPLAN_MONOREPO_2026-07-23.md` (this plan is sequenced after its Fase 9 cutover)

## 1. Executive decision

NexusCommander has a credible desktop-file-manager foundation: the Linux build succeeds, Svelte type checking is clean, all 26 current Rust unit tests pass, a Content Security Policy is present, and archive path validation has improved since the July 13 review.

The application should nevertheless **not yet be treated as safe for irreplaceable data or as production-ready on all advertised platforms**. The highest risks are not cosmetic defects. They are failure modes in copy, move, overwrite, rename, archive, cancellation, settings persistence, and symlink handling that can lose existing data, leave corrupt partial output, escape an intended directory, or tell the user that an operation succeeded when it did not.

The next release cycle should therefore be a stabilization cycle:

1. Freeze new destructive-operation and archive features.
2. Settle where the work lands — the monorepo, not this repository (section 1.1).
3. Complete the containment, data-integrity, and archive-security work in Phases 0–2.
4. Establish mandatory CI and release gates, on a substrate that exists (section 2).
5. Resume feature growth only after the Phase 2 exit criteria pass on Linux and Windows.

This review found no evidence that the repository itself contains committed secrets. It did not perform dynamic penetration testing, fuzzing, installer signing verification, or testing on physical Windows/macOS machines. Those are planned below.

## 1.1 Scope correction: this work belongs in the monorepo

The review was performed against the legacy desktop repository, but that is not where the long-term work should land. Active development has moved to the npm-workspaces monorepo at `/mnt/Data/Development/_Apps/NexusCommander`, where 24 Svelte components are shared through `@nexus/ui`. Implementation artifacts for Fases 0–8 of `NEXUS_MIGRATIEPLAN_MONOREPO_2026-07-23.md` are largely present, but Fase 8's end-to-end acceptance is not proven: the workflow files exist, the monorepo has no configured Git remote, and no completed three-platform CI run or published artifact set was available during this revision. Fase 9 cutover also remains open.

This has three consequences that change the plan materially:

1. **Every code deliverable below must be implemented in the monorepo, not in this repository.** Phase 3's module splits (`FileList.svelte`, options/dialog code) target files that now live in `packages/ui`, are shared with the PWA shell, and have a documented merge convention. Implementing them here would produce work that is discarded at cutover, or a second divergence that has to be merged again.
2. **Fase 9 cutover is a hard predecessor for Phase 1.** Phase 0 investigation and decisions can proceed in parallel; code changes must land only in the repository designated by P0.0, or the two efforts will conflict in the same files.
3. **Every finding must be re-baselined against the monorepo before implementation.** The audited legacy desktop is 0.8.34, while the monorepo desktop is 0.8.33 and several shared UI files were reconciled from the PWA implementation. Verified on 2026-07-28: QSF-018's target gating is present (`[target.'cfg(unix)']` for `uzers`/`libc`, `[target.'cfg(windows)']` for `winapi`) and a local `x86_64-pc-windows-gnu` check passes with warnings. The three-platform workflow is defined but has not been proven to run on a configured remote. Also verified as still open in the monorepo: the six unregistered IPC commands (QSF-008), the `v0.8.29` title drift (QSF-020), and the MIT/GPL-3.0 license conflict (QSF-020, with no `LICENSE` file at the monorepo root).

A related consequence for shared components: **safety-relevant behavior implemented in `@nexus/ui` now reaches the PWA shell too.** Any `OperationSpec`-aware dialog, conflict flow, or error surface must either be capability-gated through the existing `NexusIpc` seam or explicitly specified for both shells. The two backends keep separate trust models; a shared component must never assume the desktop one.

## 2. Review method and verified baseline

The review covered all tracked source/configuration files and focused on trust boundaries, file mutation, archive processing, native command exposure, frontend/native contract consistency, asynchronous behavior, state persistence, accessibility, dependency health, build portability, and release safety.

| Check | Result on 2026-07-28 | Interpretation |
|---|---|---|
| `npm run check` | Failed after `svelte-check` reported 0 errors and 0 warnings | Locale validation is red: five keys are missing from each of `de`, `es`, `fr`, and `pt` |
| `npm run build` | Passed | Main page emits a 1,008.90 kB minified JavaScript chunk (306.88 kB gzip) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Passed, 26/26 | Useful unit baseline, but no integration, end-to-end, crash, or hostile-fixture coverage |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | Failed | Rust source is not formatting-clean |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Failed with 16 diagnostics | Strict linting is not currently a viable release gate |
| `npm audit --json` | 3 low-severity advisories | All are in the SvelteKit/cookie path; update the compatible frontend stack |
| `cargo audit --file src-tauri/Cargo.lock --json` | Failed | Two `quick-xml` DoS advisories plus informational unsound/unmaintained/yanked dependency warnings |
| `cargo update --manifest-path src-tauri/Cargo.toml --dry-run` | Compatible updates available | Tauri 2.11.x and `quick-xml` 0.41 are available without a major-version migration |
| `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu` | Failed | Unix-only `uzers` is compiled for Windows and fails with 44 errors |
| Git worktree before documentation | Clean | The review did not start on top of uncommitted application changes |

The codebase is approximately 24,400 lines. Concentration risk is high: `FileList.svelte` is 3,141 lines, `archive.rs` 1,881, `vfs.rs` 1,344, `task_queue.rs` 997, `OptionsDialog.svelte` over 1,600, and several other files approach or exceed 1,000 lines.

### Delivery infrastructure baseline

The plan's gating model assumes infrastructure that does not exist yet in this repository, and only partly exists in the monorepo. This must be resolved before any exit criterion that says "CI is green" is meaningful:

| Fact | Legacy repo | Monorepo | Consequence |
|---|---|---|---|
| Remote | Self-hosted Forgejo over plain HTTP | No Git remote configured | No remote checks run for the monorepo until it is connected to a forge |
| CI | None (`.github/` absent) | `desktop.yml`, `web.yml` definitions present | Even when activated, desktop CI **builds only** — no `cargo fmt`, `clippy`, `cargo test`, `cargo audit`, `npm audit`, or locale gate |
| Release | `deploy.sh` on the developer machine | Not yet defined | Section 9's gates are aspirational until a substrate is chosen |

**Decision required before P0.4:** pick one of (a) GitHub as the CI and release substrate with Forgejo as a mirror, or (b) Forgejo Actions with a self-hosted runner, accepting that Windows and macOS runners must then be provided. Until that decision lands, P0.4 must ship a **local enforcement fallback** — a single `npm run verify` target plus a `pre-push` hook running the same command set — so the gates exist somewhere rather than nowhere.

### Re-verification status

The traceability table in section 7.1 labels every finding with its verification state on 2026-07-28:

- **Behavior-verified** — reproduced by executing a check or observing a runtime contract.
- **Code-verified; reproduction pending** — the concrete unsafe or inconsistent path is present in source, but a failing regression test still has to reproduce its effect. Direct source evidence is sufficient to prioritize the work; the reproducing test is required before the finding can be closed.
- **Implemented in monorepo; platform verification pending** — the code-level remediation is present and a local cross-check passes, but native CI/smoke evidence is still required.

### Severity model

- **Critical:** a plausible path to unintended data loss, arbitrary command execution, privilege-boundary failure, or directory escape in ordinary product use.
- **High:** serious integrity, security, or reliability failure requiring realistic but narrower conditions.
- **Medium:** material quality, maintainability, performance, accessibility, or trust issue.
- **Low:** contained defect, drift, or hygiene issue without an immediate high-impact failure.

## 3. Positive controls already present

The upgrade should preserve and extend these strengths:

- The main application builds successfully on the reviewed Linux environment.
- Svelte type checking currently reports no type errors or framework warnings.
- Rust unit tests cover task lifecycle basics, terminal resolution, desktop application parsing, copy timestamps, and several archive traversal cases.
- Archive entry names are lexically constrained, and ZIP extraction has entry-count, declared-size, and compression-ratio limits.
- A CSP is configured instead of leaving the webview unrestricted.
- External process launching generally uses argument arrays rather than constructing a shell string on Linux.
- Environment files and build artifacts are ignored by Git.
- The native command surface is explicitly registered through Tauri.

These controls are useful but do not yet cover filesystem race conditions, symlink traversal through existing destination paths, atomic commit, cross-platform compilation, or end-to-end command contracts.

## 4. Release-gating findings

### QSF-001 — Copy and overwrite are not transactional

**Severity:** Critical  
**Evidence:** `src-tauri/src/task_queue.rs` creates the final destination directly during chunked copy; `src-tauri/src/vfs.rs` uses direct `fs::copy` and `fs::write`; archive writers also create the final archive directly.

If a destination already exists, it can be truncated before the new copy is known to be complete. Cancellation, disk-full, power loss, permission failure, or a read error can destroy the previous destination and leave a partial replacement. Text saves, settings, bookmarks, and archives have variants of the same failure mode.

**Required remediation**

- Write to an unpredictable temporary file in the destination directory.
- Set intended metadata on the temporary object.
- Flush file contents and, where durability is promised, sync the file and containing directory.
- Verify byte count and optional digest before commit.
- Atomically replace the final destination only after success.
- Preserve the original until commit and clean recoverable temporary artifacts on failure.
- Return a structured outcome that distinguishes committed, skipped, cancelled, rolled back, partially rolled back, and failed.

**Acceptance gate**

Automated tests must inject read, write, sync, rename, permission, and disk-full failures at every stage. The pre-existing destination must remain byte-for-byte intact unless the new object has committed successfully.

### QSF-002 — Move can remove a valid destination before the source is secured

**Severity:** Critical  
**Evidence:** The queued move path removes an existing destination before attempting rename/copy. Cross-device fallback copies to the final destination and deletes the source without a verified commit protocol.

**Required remediation**

- Never delete the old destination as the first overwrite step.
- On the same filesystem, use the platform's atomic replacement primitive with an explicit policy.
- Across filesystems, use the transactional copy protocol from QSF-001, commit the destination, verify it, and only then remove the source.
- If source deletion fails, report `CopiedButSourceRetained`; do not report a successful move.
- Journal multi-item moves so interrupted operations can be inspected and resumed or rolled back.

**Acceptance gate**

Test same-filesystem and cross-filesystem moves with existing destinations, cancellation, locked files, disappearing sources, full disks, and source-delete failure. No test may lose both the original destination and the source.

### QSF-003 — Symlinks and path components can escape the intended operation tree

**Severity:** Critical  
**Evidence:** Recursive copy and task sizing use `is_dir`, `is_file`, and `exists`, which follow symlinks. Broken symlinks are often treated as nonexistent. Archive extraction lexically validates a joined path but then writes through existing destination components; a pre-existing parent or output symlink can redirect the write outside the extraction root.

Consequences include copying data outside the selected tree, recursion cycles, inability to delete a broken link, overwriting a symlink target, and archive extraction outside the chosen directory despite a lexically safe entry name.

**Required remediation**

- Centralize a `PathPolicy` based on `symlink_metadata`, not convenience methods that follow links.
- Make preserve/follow/reject behavior explicit per operation and visible to the user.
- Default to preserving links for copy/archive and never follow links during extraction.
- Track visited `(device, inode)` or the platform equivalent when following is explicitly enabled.
- Use no-follow, directory-relative filesystem APIs for extraction and privileged mutations (`openat2`/`openat` patterns on Linux and equivalent safe handles on Windows).
- Reject or safely replace any pre-existing symlink in an extraction path component.
- Treat broken symlinks as real directory entries.

**Acceptance gate**

Run a symlink fixture matrix covering file links, directory links, broken links, cycles, destination-parent links, final-output links, links crossing mount points, and races that exchange a directory for a link.

### QSF-004 — Archive extraction and creation are partial, overwrite-prone, and inconsistently bounded

**Severity:** Critical  
**Evidence:** Extraction writes directly into a potentially populated target and does not stage or roll back. Archive creation writes directly to the final file. Listing lacks the extraction limits. Packing silently skips missing sources. A single global cancellation flag and event name are shared by concurrent jobs.

**Required remediation**

- Extract into a new private staging directory using the no-follow rules from QSF-003.
- Preflight entry count, expanded size, free space, duplicate/case-colliding names, path depth, special entry types, and the destination conflict policy.
- Promote staged content through the same transactional operation engine as normal copies.
- Give every archive operation a job ID, independent cancellation token, bounded worker slot, progress channel, and retained final report.
- Treat a missing selected source as an error unless the user explicitly chooses best-effort mode.
- Create archives through a temporary file and atomic commit.
- Verify bytes read match declared ZIP sizes and provide meaningful completion/cancellation states.
- Apply limits to listing as well as extraction; stream/paginate large listings instead of collecting without bound.

**Acceptance gate**

Hostile archive tests must include traversal, absolute paths, Windows prefixes, pre-existing symlink components, archive symlinks/hard links, duplicate names, case collisions, extreme nesting, many tiny entries, high compression ratios, corrupt size fields, truncated input, special files, cancellation, and disk exhaustion.

### QSF-005 — Archive format and option contracts do not match behavior

**Severity:** High  
**Evidence:** Detection advertised `.tar.bz2`, `.tar.xz`, `.tar.zst`, `.zst`, and `.gz`, but listing and extraction previously supported different subsets. *(Remediated 2026-07-30: `read_archive`, `list_tar`, `unpack_archive`, and `archivePaths.js` aligned to fully support listing and unpacking `.tar.zst`, `.zst`, `.tzst`, `.tar.bz2`, `.tbz2`, `.tar.xz`, and `.txz`).* The UI can create formats it cannot reliably browse/unpack. Symlink packing semantics do not preserve links correctly. `solid_archive` is not consumed. Regular files are assigned mode `0755`. Unknown output formats fall back to ZIP.

**Required remediation**

- Publish one format capability matrix generated from backend capabilities.
- Reject unsupported extensions/options instead of guessing a fallback.
- Either implement a format completely—detect, list, test, extract, create—or hide it.
- Preserve file type, permissions, executable bits, timestamps, and links according to an explicit metadata policy.
- Range-check compression levels.
- Remove or implement `solid_archive`.
- Correct empty-input progress and elapsed-time calculations.

**Acceptance gate**

Round-trip fixtures for every advertised format must validate content, Unicode names, empty files/directories, metadata, executable bits, symlinks, cancellation, and interoperability with an independent archive tool.

### QSF-006 — Windows shell invocation permits command interpretation

**Severity:** Critical on Windows  
**Evidence:** Windows open/editor paths use `cmd /C start` with a file path supplied to `cmd.exe`. Shell metacharacters in a legitimate filename can be reinterpreted by the command processor.

**Required remediation**

- Replace `cmd.exe` with `ShellExecuteW`, the Tauri opener, or a direct executable launch with a validated argument list.
- Apply the same no-shell rule to all platform adapters.
- Add filenames containing spaces, quotes, `%`, `&`, `|`, `^`, parentheses, and Unicode to Windows tests.

**Acceptance gate**

No user-derived string reaches a command shell. A static check and Windows integration test must enforce this.

### QSF-007 — Running the complete application as root creates an excessive privilege boundary

**Severity:** High  
**Evidence:** The elevation command restarts the entire application through `pkexec`, after which the webview and broad native command surface run with elevated privileges.

Any webview, frontend injection, archive, path, or command defect then has root-level impact.

**Required remediation**

- Remove whole-application elevation.
- Introduce a minimal native helper for a small allowlist of privileged operations.
- Define and ship a Polkit policy with explicit authentication behavior.
- Use typed requests, canonical/no-follow path validation, operation-specific authorization, audit logging, timeouts, and no ambient shell.
- Keep the UI/webview unprivileged.
- Compile the helper only on supported Unix targets and implement a separate Windows elevation design if required.

**Acceptance gate**

Threat-model review confirms that a compromised renderer cannot issue arbitrary filesystem or process commands as root. Helper tests reject unrecognized operations and malformed paths.

### QSF-008 — Frontend/native IPC contracts have callable commands with no backend handler

**Severity:** High  
**Verification:** Code-verified in both repositories on 2026-07-28 by diffing all `invoke(...)` call sites against the `generate_handler!` list — 61 invoked names, 56 registered.  
**Evidence:** `src/lib/ipc.ts` invokes commands that are not registered in `src-tauri/src/lib.rs`: `archive_test`, `split_file`, `combine_files`, `check_is_binary`, `edit_config_file`, and `get_os`. Archive test, split/combine, and network UI paths actively call some of them.

The diff used for verification is mechanical and should become the P1.1 contract test directly rather than being rebuilt from scratch.

These flows can fail only at runtime; the current type check and Rust tests cannot detect the mismatch.

**Required remediation**

- Disable incomplete UI immediately or implement and register the missing commands.
- Generate TypeScript bindings from the Rust command schema, including request and response types.
- Add a contract test that compares all frontend invocations with the registered command set.
- Version structured IPC errors and never depend on string parsing for control flow.

**Acceptance gate**

The generated contract is the only allowed invocation layer, and CI fails for missing, renamed, duplicated, or type-incompatible commands.

### QSF-009 — Safety options shown to users are mostly inert

**Severity:** High  
**Evidence:** Settings/UI expose verification, free-space checking, reserved space, attribute/ownership copying, conflict behavior, and drop-menu defaults, but the operation commands receive only action/sources/target and do not consume the stored options. Drop-menu choices are not forwarded to the action.

This is a trust failure: the interface implies safeguards the backend does not perform.

**Required remediation**

- Define a versioned `OperationSpec` passed to every mutation.
- Include `ConflictPolicy`, `SymlinkPolicy`, `MetadataPolicy`, `VerificationPolicy`, free-space policy, cancellation behavior, and durability level.
- Validate the spec in Rust and return the effective policy in the task record.
- Remove every control that is not implemented.
- Add UI-to-engine integration tests proving each visible option changes native behavior.

**Acceptance gate**

No safety-related control may ship without a backend behavior test. Task details must show the effective policy used.

### QSF-010 — Task execution permits duplicate workers and orphaned waiting tasks

**Severity:** High  
**Evidence:** A paused task can be executed again while its original worker remains alive, because only running/waiting tasks are guarded. `clear_finished_tasks` does not retain `WaitingForInput`, potentially removing a task whose worker is awaiting conflict resolution. Active tasks are not capped. Blocking filesystem work runs on general async workers.

Delete progress is also calculated after deletion, producing zero item/byte totals for removed paths.

**Required remediation**

- Give each task a single owned state-machine runner and reject illegal transitions.
- Retain waiting tasks; never let registry cleanup invalidate a live worker.
- Use a bounded `spawn_blocking`/dedicated I/O worker pool with configurable queue limits.
- Make conflict resolution a typed, durable state transition.
- Make preflight sizing cancellable and asynchronous.
- Calculate delete progress before mutation or increment from the operation plan.
- Handle poisoned locks without panicking the application.

**Acceptance gate**

Property/state-machine tests must prove at-most-one runner, legal transitions only, bounded concurrency, retained terminal reports, and no deadlock under pause/cancel/conflict/clear races.

### QSF-011 — Rename transactions can collide and partial failures are hidden

**Severity:** High  
**Evidence:** Batch rename uses predictable temporary names, rollback failures are ignored, and the multi-rename UI discards returned per-item results and closes as if successful.

**Required remediation**

- Generate collision-resistant temporary names after verifying nonexistence.
- Preflight duplicate targets, case-only renames, invalid names, cross-platform reserved names, and target conflicts.
- Execute from a durable rename plan and surface rollback failures.
- Keep the result dialog open when any item fails and provide retry/exportable details.

**Acceptance gate**

Tests cover cycles (`a→b`, `b→a`), case-only changes, pre-existing temp-like names, partial permission failures, disappearing entries, and rollback failure.

### QSF-012 — Configuration and bookmarks can be lost or silently reset

**Severity:** High  
**Evidence:** Settings/bookmarks are written directly. Parse/read errors silently fall back to defaults/empty values. The close handler schedules a delayed save and immediately exits, without a reliable close barrier.

**Required remediation**

- Use atomic, schema-versioned writes with backup rotation and validation.
- Distinguish first run, missing file, invalid file, unsupported version, and I/O error.
- Do not overwrite a corrupt file until the user can recover/export it.
- Provide an awaited `flush()` service and prevent window close until bounded persistence completes.
- Use an OS config directory; do not silently fall back to a relative working-directory file.

**Acceptance gate**

Crash-at-each-write-stage tests preserve either the prior or new valid configuration. Close/restart tests prove the last confirmed settings and window bounds persist.

## 5. Additional quality and security findings

### QSF-013 — Unsafe HTML rendering should be removed

**Severity:** High for context-menu labels; Medium for current embedded help content

`ContextMenu.svelte` renders labels with `{@html}`. Some labels can include application names sourced from user-local desktop files. `HelpDialog.svelte` uses a hand-written Markdown-to-HTML renderer and `{@html}`. Current help files are embedded and backend-allowlisted, which reduces immediate exploitability, but the renderer is unsafe for future external/plugin content.

Render context-menu labels as text/components. Replace the Markdown implementation with a maintained parser plus sanitizer, block active URL schemes, and add injection fixtures. Hardcoded SVG constants may remain only through a typed trusted-icon component.

**Acceptance gate:** a lint rule rejects `{@html}` outside an allowlisted trusted-icon component, and a `.desktop` fixture whose `Name=` contains markup and an event-handler attribute renders as inert text.

### QSF-014 — Asset access is broader than necessary

**Severity:** Low (revised down from Medium)  
**Verification:** Code-verified — `assetProtocol.scope` is `["**"]` in `src-tauri/tauri.conf.json`.

**This re-opens a decision that was already made deliberately.** The 2026-07-13/14 audit left the scope at `["**"]` on the grounds that the app needs arbitrary-path access for audio preview (`MiniPlayer.svelte`), open-with icons (`ContextMenu.svelte`), and image viewing (`FileViewer.svelte`, which was moved off base64-over-IPC precisely to use `convertFileSrc`). The reasoning recorded there still holds: the IPC command surface already grants equally broad filesystem read access, so narrowing the asset scope moves a boundary that is not the real boundary. The strict CSP is the meaningful control.

The finding is therefore **not** "replace the broad scope"; it is "the residual risk is undocumented and untested". Required work:

- Record the accepted risk in the security policy, with the specific reason each consumer needs arbitrary paths.
- Add a CI test asserting the CSP string has not regressed (no `unsafe-eval`, no `unsafe-inline` in `script-src`, `object-src 'none'`).
- Revisit only if the IPC surface is narrowed first — scoping the asset protocol while `read_file_for_viewer` and friends remain unrestricted buys nothing.

**Acceptance gate:** the CSP regression test is in CI, and the accepted risk has a written owner and a review date.

### QSF-015 — Search and viewer requests have race and reporting defects

**Severity:** Medium

- Search begins before the frontend installs result listeners, so fast searches can finish before listeners exist.
- The active-search cap uses a non-atomic check/increment sequence.
- Invalid regular expressions silently become no matches.
- Completion does not distinguish success, truncation, cancellation, timeout, or error.
- Directory and file-view loads lack generation tokens, so a slower old request can overwrite newer navigation state.

Use per-request channels registered before work begins, a semaphore/atomic compare-exchange for caps, typed completion reasons, immediate regex validation, and request IDs/abort tokens on every navigation-driven load.

**Acceptance gate:** a test that completes a search before the caller subscribes still delivers every result; an artificially delayed directory load cannot overwrite the state of a newer navigation; an invalid regex returns a typed error rather than an empty result set.

### QSF-016 — Duplicate listeners and polling create unnecessary work

**Severity:** Medium

`FileList.svelte` registers duplicate operating-system file-drop listeners. Each panel also polls path availability, the drive bar polls mounts, and path changes trigger additional drive loads.

Create one application-level event subscription and one mount/path monitor service with reference counting, caching, backoff, and invalidation events. Add instrumentation for listener counts and native call rate.

This is the same class of defect the monorepo migration already hit once: a global listener inside a component that exists twice runs every action twice. The shell must dispatch to the right panel instance; a shared component must never subscribe globally.

**Acceptance gate:** with both panels mounted, each OS drop event produces exactly one handler invocation, and an idle window's native call rate stays under an agreed ceiling measured over 60 seconds.

### QSF-017 — User-visible errors and partial results are routinely swallowed

**Severity:** High

Several create, pack, split/combine, rename, search, and task flows log to the console, discard structured `OpResult` values, close dialogs early, or hide failed tasks when they stop being active.

Introduce one operation result model and notification/history surface. Destructive failures must remain visible until acknowledged. Display affected path, phase, safe retry options, whether the original is intact, and where any recoverable temporary data resides.

**Acceptance gate:** a lint rule forbids discarding an `OpResult`, and for every destructive command an injected failure produces a user-visible, acknowledgement-gated record — asserted by test, not by inspection.

### QSF-018 — Cross-platform support is not compile-clean

**Severity:** High in this repository; **code-level remediation is present in the monorepo**  
**Verification:** Implemented in monorepo; native platform verification pending.

In this repository the Windows GNU target fails because unconditional `uzers` and Unix-specific code enter the Windows build. Elevation and UID checks are also Unix assumptions.

In the monorepo, `uzers`/`libc` sit under `[target.'cfg(unix)'.dependencies]`, `winapi` under `[target.'cfg(windows)']`, and Linux-only dependencies are target-gated. A local `cargo check --target x86_64-pc-windows-gnu` completed successfully on 2026-07-28 with five warnings. `desktop.yml` defines jobs for `ubuntu-latest`, `macos-latest`, and `windows-latest`, but the monorepo has no configured remote and no completed native CI run was available for verification.

**Remaining work is verification, not implementation:**

- Confirm the Windows build actually passes in native CI rather than treating the successful GNU cross-check as sufficient.
- Treat a cross-compile check as a compile gate only. It is not platform qualification; Windows path semantics and process launching need Windows-native tests (section 8.5).
- Do not advertise or release a platform until its native build, smoke tests, and operation suite pass. macOS is currently built but not tested.

### QSF-019 — Dependency advisories and old platform stack need managed remediation

**Severity:** High

- `quick-xml 0.38.4` has two 2026 denial-of-service advisories; it enters the all-platform graph through `plist`/Tauri and is not in the reviewed Linux runtime graph.
- `anyhow 1.0.102` has an unsoundness advisory and a compatible patched version.
- `glib 0.18.5` has a function-specific unsoundness advisory and is a direct dependency as well as part of the GTK stack.
- Older transitive `rand`, GTK3 ecosystem, unmaintained crates, and a yanked Windows crate are reported.
- `npm audit` reports three low advisories in the current SvelteKit chain.

**Correction to the remediation as originally written.** `quick-xml` and `anyhow` are not direct dependencies — neither appears in `src-tauri/Cargo.toml`. They cannot simply be "updated"; the version is chosen by whichever transitive parent pulls them in:

- `quick-xml` enters through Tauri's `plist`, which is **macOS-only and is not compiled on the Linux target**. This was already assessed and accepted on 2026-07-14. The correct action is to bump Tauri and re-check, not to force a version. If a bump does not move it, the options are a workspace `[patch]` entry or a documented, expiring exception — and the exception is defensible here because the affected code does not enter the Linux artifact at all. Verify with `cargo tree -i quick-xml --target all` compared against the same command without `--target all`.
- **Do not re-introduce the `xdg-portal` path to escape this.** `rfd` is deliberately pinned to the `gtk3` backend because `xdg-portal` pulls in an `ashpd`/`wayland-client`/`quick-xml` chain that had unresolved advisories of its own and reuses none of Tauri's existing GTK crates. Any dependency change that touches `rfd` must keep `default-features = false, features = ["gtk3"]` or explicitly re-argue that trade-off.
- `anyhow` likewise comes in transitively; bumping the parent or adding a lockfile-level update is the mechanism, and `cargo update -p anyhow` is the least invasive form.

Update Tauri and its plugins to compatible 2.11.x releases, run `cargo update -p` for the transitive advisories that permit it, then rerun the entire suite on every target. Remove the direct `glib` use if feasible; otherwise isolate it behind a small Linux adapter and document/upstream-track residual risk. Add grouped-update automation on whichever forge is chosen in section 2 (Renovate runs on Forgejo; Dependabot does not) and a time-bounded exception file for unavoidable advisories.

**Acceptance gate:** `cargo audit` and machine-readable `npm audit` results are collected on every supported target graph. CI blocks at the agreed severity threshold, while every non-blocking advisory remains visible and either receives a compatible fix or an entry in the exception file with owner, exposure analysis, compensating control, and expiry date. An expired exception fails CI.

### QSF-020 — Licensing and version metadata conflict

**Severity:** Medium

**Verification:** Code-verified in both repositories.

`package.json` declares MIT while the repository `LICENSE` is GPL-3.0, and Rust package metadata declares no license at all. `src/app.html` presents `v0.8.29` while package/Tauri manifests are 0.8.34 — the title is a hardcoded string that the version bump script does not touch, so it will drift again. The monorepo inherits both problems and additionally has **no `LICENSE` file at its root**.

This is not only hygiene. GPL-3.0 and MIT impose different obligations on redistributors, and shipping a `.deb` whose metadata contradicts the bundled license text is a real distribution defect.

Choose the intended license (only the project owner can decide this — note that a GPL-3.0 obligation, once distributed, cannot be retracted for versions already released), align every manifest/header/distribution notice, add the missing `LICENSE` at the monorepo root and `license` in `Cargo.toml`, generate an SBOM and third-party notice, and have releases validate license metadata. Derive version/build information from one source — the app title must read the manifest version rather than restate it — and expose commit/release identifiers in About diagnostics.

**Acceptance gate:** a CI check fails when `package.json`, `Cargo.toml`, `tauri.conf.json`, `LICENSE`, and any user-visible version string disagree.

### QSF-021 — Release automation can commit and publish unintended state

**Severity:** High

**Verification:** Code-verified.

`deploy.sh` bumps the version before any validation, builds, runs `git add .`, commits, and pushes straight to `main`. A failed build leaves version drift in the working tree, and `git add .` stages whatever else happens to be present — including files an editor or a parallel agent session created. There is no mandatory CI, clean-tree guard, changelog/tag, artifact signature, checksum, or protected promotion step. It also runs no tests at all: `npm run check`, `cargo test`, `cargo clippy`, and the audits are absent from the release path, so the only thing a release currently proves is that the `.deb` bundler succeeded.

Two further specifics: the script pushes to a self-hosted Forgejo over **plain HTTP**, so the connection lacks the confidentiality, server authentication, and transport integrity provided by TLS; and the stale-documentation check only warns, so it cannot block anything.

Split release into:

1. read-only preflight;
2. explicit version/changelog commit;
3. CI build/test on an immutable commit;
4. artifact signing, checksums, SBOM, and provenance;
5. manual promotion of the tested artifacts.

Never stage the entire tree — stage the exact files the bump script touches, by path. Protect the release branch, use annotated signed tags, and move the remote to HTTPS or SSH.

**Acceptance gate:** a release cannot be produced from a dirty tree, from a commit that has not passed the full gate set, or by a script that runs `git add .` / `git add -A`; a static check enforces the last one.

### QSF-022 — Architecture concentration makes safety behavior hard to verify

**Severity:** Medium

Very large frontend and Rust modules combine orchestration, policy, filesystem work, formatting, state, and UI. Archive implementations duplicate logic across formats. Direct `copyEntries`/`moveEntries` paths bypass the task/conflict flow.

All mutations should pass through one tested operation engine. Split large UI components into state/controller and focused view components. Separate archive format adapters from common staging, limits, progress, metadata, and commit logic.

Component splitting must follow the monorepo's existing conventions rather than inventing new ones: base the split on the side with the functional superset, and express platform differences through the four established seams (`NexusIpc` capability, props, component injection, callbacks) — never `if (isDesktop)`.

**Acceptance gate:** no file added or modified after Phase 3 exceeds an agreed line budget, a static check finds no mutation path that bypasses the operation engine, and each extracted module has documented invariants plus tests that exercise them.

### QSF-023 — Automated coverage is too shallow for a file manager

**Severity:** High

**Verification:** Code-verified — 26 `#[test]` functions across five source files, no `src-tauri/tests/` directory, no frontend test files, no test runner in `package.json`.

There are no frontend unit tests, Rust integration tests, end-to-end tests, filesystem fault-injection tests, or fuzz targets. Existing archive tests cover lexical traversal but not destination symlinks, rollback, limits, or format parity.

**The ordering matters more than the coverage number.** Phases 1 and 2 rewrite the copy, move, delete, rename, and archive paths — the most-used code in the product — with essentially no safety net underneath. Before any of that begins, capture a **characterization suite**: tests that record what the current implementation actually does for the ordinary, correct-path cases (copy a tree, move within and across filesystems, delete, rename, pack and unpack each format, cancel midway). These tests are not aspirational; they lock in behavior users already depend on, so the rewrite can be judged on whether it changed anything it should not have. Cases where current behavior is the defect are marked as expected-to-change with a reference to the finding that changes them.

Without this, the rewrite's own regression risk is unmanaged, and it is a larger near-term risk to user data than several of the findings it fixes.

Implement the test program in section 8 before treating safety-sensitive changes as complete.

**Acceptance gate:** the characterization suite exists and is green before P1.4 starts; from Phase 1 onward, no mutation-path change merges without a test that fails against the previous implementation.

### QSF-024 — Accessibility, localization, and bundle quality are below release-gate level

**Severity:** Medium

**Verification:** Behavior-verified — `node scripts/check-locales.js` reports the same five keys missing from each of `de`, `es`, `fr`, `pt`: `dialog.delete_trash_prompt_single`, `dialog.delete_permanent_prompt_single`, `dialog.copy_to_single`, `dialog.move_to_single`, `drop_menu.items_to_single`.

The locale checker reports 20 missing translations across four languages. Note what these specific keys are: the singular forms of the **delete, copy, and move confirmation prompts**. A missing key in a destructive-action confirmation is not a cosmetic localization gap — a non-English user can be asked to confirm an irreversible action through a fallback or empty string. This subset should be fixed in Phase 0, not deferred to P3.5 with the rest.

The UI contains multiple accessibility suppressions, non-semantic interactive containers, hardcoded English strings, and inconsistent overlay levels. Focus trapping/restoration and keyboard-only behavior are not systematically tested. The main JavaScript chunk is about 1 MB minified.

Make localization validation mandatory, remove suppressions through semantic controls, adopt one dialog/focus stack, run axe and keyboard end-to-end tests, and lazy-load CodeMirror languages, heavy dialogs, and icon groups.

**A green locale check must be proven to be able to fail.** The migration already produced a checker that validated an abandoned directory and reported success. When the check moves or the locale source changes, delete a key deliberately and confirm the check goes red.

**Acceptance gate:** locale validation is a blocking CI step and has been shown to fail on an intentionally removed key; axe reports no violations on every dialog; every dialog is reachable, operable, and dismissible by keyboard alone.

### QSF-025 — The plugin API is documentation-only and has no enforceable sandbox

**Severity:** Medium now; Critical if arbitrary plugins are enabled

The TypeScript plugin API describes runtime plugins and broad permissions, but no corresponding loader, isolation boundary, permission enforcement, signing, or revocation model was found.

Mark the API experimental and keep runtime loading disabled. Before enabling it, complete a separate threat model and use capability-based RPC from an isolated process/webview, explicit per-plugin grants, origin/signature verification, resource quotas, audit logs, and revocation. Never evaluate third-party JavaScript in the privileged main webview.

`EXTENSIES_PLUGINSYSTEEM_PLAN_2026-07-22.md` should be explicitly marked as blocked on this plan's Phase 5, so the two documents do not authorize contradictory work.

**Acceptance gate:** no code path can load or evaluate plugin code, enforced by a static check; the documentation states the API is experimental and unimplemented.

## 6. Target safety architecture

All mutating features should converge on the following model:

```text
UI intent
  -> validated, versioned OperationSpec
  -> asynchronous preflight and immutable operation plan
  -> bounded JobManager with one runner per job
  -> platform filesystem adapter + PathPolicy
  -> stage output in destination filesystem
  -> verify content/metadata and sync as required
  -> atomic commit
  -> source cleanup only after commit
  -> durable structured result and recovery record
```

Core types should include:

- `OperationSpec`: sources, destination, operation kind, and policy version.
- `ConflictPolicy`: ask, skip, replace, keep-both, merge, plus per-item decisions.
- `SymlinkPolicy`: preserve, reject, or explicitly follow with cycle protection.
- `MetadataPolicy`: timestamps, mode, ownership, ACL/xattrs, sparse files, and platform fallbacks.
- `VerificationPolicy`: byte count, digest, durability, and post-copy readback.
- `OperationPlan`: immutable normalized entries, conflicts, capacity estimate, and warnings.
- `JobRecord`: state, timestamps, effective policies, progress, cancellation token, errors, and recovery artifacts.
- `CommitOutcome`: committed, skipped, cancelled-before-commit, rolled-back, copied-source-retained, or manual-recovery-required.

The archive engine should be a client of this operation engine, not a parallel overwrite implementation.

### 6.1 What "atomic" can and cannot mean here

The plan as originally written implies atomic commit is available everywhere. It is not, and building on that assumption produces an engine that promises more than the filesystem can deliver. The following limits must be stated in the design and surfaced in the UI:

- **Single files and some new directory trees can be committed atomically at the namespace level.** A staged directory on the destination filesystem can be renamed atomically into a destination that does not yet exist. There is no portable primitive that atomically merges with or replaces an existing populated directory, however. Those recursive operations are therefore *journaled*: per-entry atomic commits plus a durable plan recording what has committed, so interruption leaves a describable and resumable state. `CommitOutcome` needs a `PartiallyCommitted { journal }` variant.
- **Same-filesystem replacement is platform- and object-specific.** Unix `rename(2)` atomically replaces regular files and can publish a directory when the target is absent or empty; Linux `renameat2(RENAME_EXCHANGE)` offers stronger non-portable exchange semantics on supported filesystems. On Windows, evaluate [`ReplaceFileW`](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew) and [`MoveFileExW`](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw) per operation and filesystem, but do not label either generally atomic without documented guarantees and native failure tests. Open destinations, ACLs, alternate streams, antivirus hooks, and sharing modes produce normal modelled errors, not unbounded retry loops.
- **Cross-filesystem operations are never atomic.** The temporary file must live in the *destination* directory to make the final rename same-filesystem; a system temp directory defeats the entire protocol.
- **Durability has a cost that must be a policy, not a default.** `fsync` per file plus a directory sync turns a large tree copy into an order-of-magnitude slower operation. Define tiers — `None`, `FlushOnly`, `SyncFile`, `SyncFileAndDirectory` — with the default chosen per operation kind, and let the user raise it. A safety default so slow that users turn it off protects nobody.
- **No-follow primitives are not universally available.** `openat2(RESOLVE_NO_SYMLINKS)` needs Linux 5.6+; the fallback is `openat` with `O_NOFOLLOW` walking one component at a time. Windows has no `O_NOFOLLOW`: use `FILE_FLAG_OPEN_REPARSE_POINT` together with `FILE_FLAG_BACKUP_SEMANTICS` for directories. Every platform adapter must declare which guarantee it actually provides, and `PathPolicy` must refuse an operation whose requested guarantee the adapter cannot meet rather than silently degrading.
- **Trash-based deletion is a different operation.** Deleting to trash goes through the `trash` crate and the desktop environment's trash specification; it is not `unlink`, and its failure modes differ. The current direct and queued implementations return an error and do **not** silently fall back to permanent deletion. Preserve that invariant with a regression test, model Trash outcomes separately, and require a new explicit user confirmation before any retry as permanent deletion.
- **Verification must be honest about what it proves.** A post-write readback proves the page cache agrees with what was written, not that the data reached the platter. Only the sync tiers make a durability claim, and the UI must not imply otherwise.

## 7. Sequenced delivery plan

**How to read the estimates.** The original windows assumed "a small focused team". This project has one developer working with AI assistance, so calendar weeks are not a usable unit. The phases below are therefore **ordered, not scheduled**: the sequence and the dependencies are binding, and the sizes are expressed as multiples of Phase 0 rather than as calendar windows. Re-sizing after the first implementation slice (section 14) is expected. Security and data-integrity work takes precedence over any date.

**Phase 0 investigation can inspect both repositories, but no Phase 0 code change lands until P0.0 designates its target. Phases 1 onward run in the monorepo only** (section 1.1). If an emergency mitigation must reach the currently distributed legacy line, P0.0 must explicitly designate that as a separate, time-bounded backport and require the same change in the monorepo.

### Phase 0 — Contain immediate risk (smallest phase; do first)

| ID | Deliverable | Depends on | Exit evidence |
|---|---|---|---|
| P0.0 | Confirm the monorepo as the implementation target; complete or explicitly park the remaining Fase 9 cutover work; make the legacy repository read-only except for separately approved emergency backports | None | The monorepo is designated in writing; legacy release/backport policy and cutover status are explicit |
| P0.0a | Re-baseline all QSF findings against the designated monorepo commit and diff the audited legacy 0.8.34 mutation/UI paths against monorepo 0.8.33 | P0.0 | Traceability table records monorepo evidence, status, and regression test for every finding; no legacy-only fix is blindly reimplemented |
| P0.1 | Publish a known-limitations warning; disable or clearly mark unimplemented split/combine/archive-test/network paths | P0.0a | No active UI invokes an unregistered command |
| P0.2 | Replace Windows `cmd /C start`; verify the monorepo's target gating in native Windows CI | P0.0a | Windows CI job green; shell metacharacter integration test passes |
| P0.3 | Update compatible Tauri/frontend/Rust dependencies and resolve reported advisories | P0.0a, P0.2 | Audits are recorded in full; blocking findings pass or have approved, expiring exceptions; non-blocking findings remain tracked |
| P0.4 | Decide the CI substrate (section 2), then make CI run check, build, fmt, clippy, unit tests, audits, contract check, and platform checks; ship `npm run verify` plus a `pre-push` hook as the local fallback | P0.0 | Gate set runs on every push; each gate demonstrated to fail when it should |
| P0.5 | Fix the five missing locale keys, the hardcoded `v0.8.29` title, and take the license decision | P0.0a | Metadata and locale validation pass; version derives from one source |
| P0.6 | **Stopgap for the Critical data-loss paths:** refuse copy, move, and archive creation whenever the final destination already exists, regardless of conflict choice, unless that exact path already uses staging plus verified replacement; never delete an existing destination as the first step of a move | P0.0a | Reproducing tests show an existing destination is rejected unchanged and survives cancellation/failure byte-for-byte |
| P0.7 | Capture the characterization suite for current copy/move/delete/rename/archive behavior (QSF-023) | P0.0a, P0.4 | Suite green and running in CI before any Phase 1 rewrite begins |
| P0.8 | Document the accepted asset-protocol risk and add a CSP regression test | P0.0a, P0.4 | Risk record names the current consumers and review date; CI rejects a weakened CSP |
| P0.9 | Mark the plugin API experimental and add a static check that no path loads plugin code | P0.0a | Runtime loading remains impossible until the Phase 5 security model is approved |

P0.6 is the item that most reduces near-term user risk. It is intentionally restrictive: an explicit overwrite choice is not sufficient while the backend still writes directly to the final destination. The stopgap declines every unsafe replacement rather than pretending to handle it, and is removed only when P1.5 proves transactional replacement on the relevant platform.

### Phase 1 — Build the safe mutation foundation (largest phase; ~3× Phase 0)

| ID | Deliverable | Depends on | Exit evidence |
|---|---|---|---|
| P1.1 | Versioned `OperationSpec`, structured result/error schema, generated IPC bindings | P0.0a, P0.4 | Contract test covers every native command |
| P1.2 | Central `PathPolicy` and platform-safe no-follow adapters | P0.2 | Symlink/race fixture suite passes |
| P1.3 | Bounded single-runner `JobManager` using dedicated blocking workers | P1.1 | State-machine/concurrency tests pass |
| P1.4 | Transactional file/text/config write and atomic commit primitives, including the durability tiers and journaled tree semantics of section 6.1 | P1.2, P0.7 | Fault-injection tests preserve old destination; characterization suite still green |
| P1.5 | Transactional copy and same/cross-filesystem move | P1.3, P1.4 | Copy/move matrix passes under failures and cancellation; P0.6 stopgap removed |
| P1.6 | Safe delete (including trash-based deletion), rename, conflict, progress, and recovery semantics | P1.3–P1.5 | No hidden partial results; rollback cases pass; trash fallback-to-permanent is never silent |
| P1.7 | Route all direct VFS, clipboard, drag/drop, and dialog mutations through the engine | P1.5, P1.6 | Static/contract check finds no bypass |

**Phase 1 exit:** Existing data is never destroyed before replacement commit; symlink policy is explicit; every mutation produces a truthful retained result.

### Phase 2 — Rebuild archive handling on the safe foundation (~2× Phase 0)

| ID | Deliverable | Depends on | Exit evidence |
|---|---|---|---|
| P2.1 | One generated archive format/capability matrix and removal of unsupported options | P1.1 | UI and backend advertise identical capabilities |
| P2.2 | Job-scoped archive creation with atomic output | P1.3–P1.5 | Concurrent/cancelled jobs cannot interfere |
| P2.3 | Private no-follow extraction staging, full preflight, and transactional promotion | P1.2–P1.6 | Hostile fixture corpus passes |
| P2.4 | Metadata/symlink-correct format adapters and streaming bounded listing | P2.1–P2.3 | Independent round-trip matrix passes |
| P2.5 | Archive fuzzing for parsers, path normalization, and extraction planning | P2.3 | Time-boxed fuzz runs have no crash, escape, or unbounded allocation |

**Phase 2 exit:** Every advertised archive format can be safely created, listed, and extracted, or is removed from the product.

### Phase 3 — Reliability, UX truth, and maintainability (~3× Phase 0)

| ID | Deliverable | Depends on | Exit evidence |
|---|---|---|---|
| P3.1 | Awaited atomic settings/bookmark service with recovery UI | P1.4 | Close/crash/recovery tests pass |
| P3.2 | Durable task history and user-visible partial/error/recovery reporting | P1.1, P1.3 | No destructive error is console-only |
| P3.3 | Request IDs/channels for search, navigation, and viewer; one deduplicated application event/mount-monitor service | P1.3 | Race/load tests pass; listener-count and native-call-rate checks find no duplicate subscriptions |
| P3.4 | Split `FileList`, options/dialog code, task queue, VFS, and archive modules | Earlier phases | Module boundaries have focused tests and documented invariants |
| P3.5 | Accessibility/localization remediation and dialog/focus standardization | P0.5 | axe, keyboard, and locale gates pass |
| P3.6 | Code splitting and native-call/polling reduction | P3.3, P3.4 | Agreed bundle/startup/call-rate budgets pass |
| P3.7 | Remove unsafe `{@html}` label rendering and replace the hand-written Markdown renderer with a maintained parser plus sanitizer | P3.4 | Static rule and malicious-label/Markdown fixtures render active content inert |

### Phase 4 — Platform and release hardening (~2× Phase 0; may overlap Phase 3)

| ID | Deliverable | Depends on | Exit evidence |
|---|---|---|---|
| P4.1 | Linux, Windows, and macOS build/test runners and physical-machine smoke suite | Phases 1–3 | All claimed platforms pass the operation matrix |
| P4.2 | Minimal privileged helper and removal of whole-app elevation | P1.1, P1.2 | Privilege threat-model gate passes |
| P4.3 | Reworked immutable release pipeline, signing, checksums, SBOM, provenance | P0.4 | Release is produced from a tested commit without `git add .` |
| P4.4 | Crash reporting/log redaction/diagnostic export with opt-in privacy policy | P3.2 | Reports contain no file contents or sensitive paths by default |
| P4.5 | Documentation: build, test, architecture, security policy, recovery, contribution, support matrix | All | A new contributor can reproduce CI and a user can recover a failed job |

### Phase 5 — Optional capability growth (after stabilization)

- Design plugin isolation and permissions before enabling external code.
- Consider remote/network filesystem operations only after the operation engine models their weaker atomicity and consistency.
- Consider major Vite/TypeScript upgrades separately from the stabilization release.
- Migrate away from structural unmaintained platform dependencies when the Tauri ecosystem provides a supported path.

### 7.1 Finding-to-deliverable traceability

Findings QSF-013, QSF-014, QSF-016, QSF-020, and QSF-025 had no deliverable in the original phase tables and could have been closed by inspection alone. Every finding now maps to at least one item:

| Finding | Severity (rev. 3) | Verification | Deliverable |
|---|---|---|---|
| QSF-001 Copy/overwrite not transactional | Critical | Code-verified; reproduction pending | P0.6, P1.4, P1.5 |
| QSF-002 Move destroys destination first | Critical | Code-verified; reproduction pending | P0.6, P1.5 |
| QSF-003 Symlink/path escape | Critical | Code-verified; reproduction pending | P1.2 |
| QSF-004 Archive extraction unsafe | Critical | Code-verified; reproduction pending | P2.3, P2.5 |
| QSF-005 Format contract mismatch | High | Code-verified; reproduction pending | P2.1, P2.4 |
| QSF-006 Windows shell invocation | Critical (Windows) | Code-verified; Windows reproduction pending | P0.2 |
| QSF-007 Whole-app root elevation | High | Code-verified (`restart_as_root` registered) | P4.2 |
| QSF-008 Unregistered IPC commands | High | **Code-verified** by command-set comparison — six commands, in both repositories | P0.1, P1.1 |
| QSF-009 Inert safety options | High | Code-verified; reproduction pending | P1.1, P1.5, P1.6 |
| QSF-010 Duplicate workers / orphaned tasks | High | Code-verified; reproduction pending | P1.3 |
| QSF-011 Rename collisions | High | Code-verified; reproduction pending | P1.6 |
| QSF-012 Config/bookmark loss | High | Code-verified; reproduction pending | P1.4, P3.1 |
| QSF-013 `{@html}` rendering | High / Medium | Code-verified; injection test pending | **P3.7 (new)** |
| QSF-014 Asset protocol scope | Low (revised) | Code-verified; accepted-risk test pending | **P0.8 (new)** — document accepted risk, add CSP regression test |
| QSF-015 Search/viewer races | Medium | Code-verified; reproduction pending | P3.3 |
| QSF-016 Duplicate listeners/polling | Medium | Code-verified; reproduction pending | **P3.3** (extended to cover listener deduplication) |
| QSF-017 Swallowed errors | High | Code-verified; reproduction pending | P3.2 |
| QSF-018 Cross-platform build | High in legacy; verify monorepo natively | **Implemented in monorepo; GNU cross-check passed** | P0.2 (native verification) |
| QSF-019 Dependency advisories | High | Behavior-verified by dependency audits | P0.3 |
| QSF-020 License/version conflict | Medium | **Code-verified** — both repositories | P0.5, P4.3 |
| QSF-021 Release automation | High | **Code-verified** | P4.3 |
| QSF-022 Architecture concentration | Medium | Code-verified by line counts | P3.4 |
| QSF-023 Shallow coverage | High | **Code-verified** — 26 tests, no test dirs | P0.7, then section 8 throughout |
| QSF-024 A11y/l10n/bundle | Medium | **Behavior-verified** — 20 keys, all destructive prompts | P0.5 (prompt keys), P3.5, P3.6 |
| QSF-025 Plugin API | Medium / Critical-if-enabled | Code-verified (definitions only) | **P0.9 (new)** — mark experimental, block loading; Phase 5 for the rest |

New deliverables introduced by the review revisions: P0.0, P0.0a, P0.6, P0.7, P0.8, P0.9, P3.7.

### 7.2 Risk register for the plan itself

The plan carries risks of its own, and they are larger than several of the findings it closes. These need owners and mitigations like any other risk:

| Risk | Impact | Mitigation |
|---|---|---|
| The rewrite of copy/move/delete/archive introduces regressions in paths that work today | Data loss caused by the safety work | P0.7 characterization suite before P1.4; no mutation change merges without a failing-then-passing test |
| Phase 1/2 restructuring collides with the unfinished monorepo cutover | Duplicated or discarded work, or a second divergence to merge | P0.0 gates everything; no mutation-path work starts before the target repository is fixed |
| Scope is large enough to stall, leaving the product half-migrated | Two mutation engines coexist — worse than either alone | Each phase must leave the product shippable; P1.7's "no bypass" check is what prevents a permanent hybrid |
| Durability defaults make operations visibly slower | Users disable the safeguards, and the work is wasted | Durability tiers in section 6.1; benchmark before and after; the default must stay usable on a large tree |
| Gates are defined but never enforced because the CI substrate is undecided | The plan reads as complete while nothing blocks a bad release | P0.4 requires the local `pre-push` fallback regardless of the substrate decision |
| A gate passes without testing anything | False assurance, as already happened once with the locale checker | Every gate must be demonstrated to fail on a deliberately broken input before it counts as delivered |

## 8. Required test program

### 8.1 Unit and property tests

- Path normalization and policy on Unix, Windows prefixes, UNC/device forms, Unicode normalization, reserved names, and case sensitivity.
- Operation/job state transitions with generated event sequences.
- Conflict-plan determinism and keep-both naming.
- Progress invariants: monotonic, finite, bounded, and terminally consistent.
- Settings schema validation/migration.
- IPC request/response serialization and command-set parity.

### 8.2 Filesystem integration matrix

Run each destructive operation against:

- no destination, existing file, existing directory, and type mismatch;
- same filesystem and cross-filesystem;
- empty, small, large, sparse, read-only, executable, Unicode, and special-character names;
- symlinks, broken symlinks, cycles, hard links, mount points, and case-only collisions;
- insufficient space, quota, permission denial, locked/busy files, disappearing entries, and I/O fault injection;
- cancel/pause/conflict at every stage;
- process termination before write, after write, after sync, after commit, and before source cleanup.

Verify source/destination bytes, metadata, task result, cleanup/recovery artifacts, and restart behavior.

### 8.3 Archive corpus

Maintain generated and checked-in-small fixtures for every condition in QSF-004/QSF-005. Run larger bombs only in isolated CI with CPU, memory, file-count, disk, and time limits. Seed `cargo-fuzz`/libFuzzer targets with the corpus and retain regressions.

### 8.4 Frontend tests

- Unit-test controllers/stores and option-to-`OperationSpec` mapping.
- Component-test dialogs, conflict decisions, partial results, and recovery flows.
- Playwright/Tauri end-to-end tests for keyboard-only navigation, drag/drop, copy/move/delete/rename/archive, restart persistence, and failed operations.
- Run axe rules and assert focus trap, focus restore, labels, announcements, and reduced-motion behavior.

### 8.5 Platform tests

- Compile and test Linux, Windows MSVC, and supported macOS architectures in CI.
- Use Windows-native tests for path semantics and process opening; do not treat MinGW cross-check alone as platform qualification.
- Smoke-test packaged `.deb`/AppImage or chosen Linux bundles, Windows installer, and macOS bundle on clean virtual machines.

## 9. CI and release policy

The monorepo's `desktop.yml` currently only *builds*. Every gate below is therefore new work, not configuration of something existing. Each change must require:

1. repository formatting and generated-file consistency;
2. `npm run check` including locale validation;
3. frontend unit/component tests and production build;
4. `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`;
5. `cargo clippy --all-targets -- -D warnings` — **not** `--all-features`, which can enable feature combinations that do not build and makes the gate unreliable; if specific features need coverage, name them;
6. Rust unit/integration tests;
7. IPC contract verification;
8. `cargo audit`, a machine-readable full `npm audit` report, a blocking npm severity threshold, license policy, and secret scanning; low advisories may be non-blocking initially but must remain visible and tracked rather than disappearing behind `--audit-level=moderate`;
9. Linux and Windows builds, with macOS on changes affecting native code or before merge if capacity permits;
10. targeted operation/archive tests based on changed paths.

Two conditions on this list:

- **Gates land green.** Introducing a gate that is already failing — `cargo fmt` and `clippy` both currently fail — trains everyone to ignore it. Fix the violations in the same change that adds the gate, or land the gate as non-blocking with a dated deadline for promotion.
- **Every gate is proven to fail.** Before a gate counts as delivered, break its input deliberately and confirm it goes red.

If Forgejo remains the primary forge, "required checks" means Forgejo Actions with a registered runner; Windows and macOS jobs then need runners that do not currently exist, which is the strongest practical argument for the GitHub option in section 2.

Nightly CI should run the full platform filesystem matrix, fuzzing time boxes, hostile archive corpus, end-to-end tests, and dependency freshness checks.

A release candidate is eligible for promotion only when:

- all P0 and applicable P1/P2 exit criteria are green;
- no open Critical or unaccepted High finding exists;
- every claimed platform passes packaged smoke tests;
- upgrade/rollback and configuration recovery are tested;
- artifacts are generated once from the tagged commit, signed, hashed, accompanied by an SBOM/provenance, and promoted without rebuilding;
- known limitations and security-relevant behavior changes are in release notes.

## 10. Dependency and migration strategy

Perform upgrades in controlled groups:

1. **Security-compatible group:** Tauri 2.11.x and Tauri plugins first, then re-measure whether `quick-xml` and `anyhow` moved on their own — both are transitive, so they are pulled forward by their parents or by `cargo update -p`, never by a direct version bump (see QSF-019). Then SvelteKit 2.70.x and compatible Svelte/tooling patches. Any change touching `rfd` must keep `default-features = false, features = ["gtk3"]`.
2. **Platform cleanup group:** already largely done in the monorepo — verify rather than redo the target gating for `uzers`, `libc`, `winapi`, and `glib`; remove unused direct native dependencies.
3. **Major-toolchain group after stabilization:** Vite 8, Svelte Vite plugin 7, TypeScript 7, and any major icon/tooling changes.

For each group: update lockfiles, review release/security notes, run all audits, test all platform graphs (`cargo tree --target all` plus actual builds), compare bundle/binary size, and document any temporary exception with owner, justification, exposure analysis, compensating control, and expiry date.

## 11. Documentation deliverables

Add or refresh:

- architecture and trust-boundary overview;
- operation-engine invariants and recovery protocol;
- archive format/limit matrix;
- native IPC schema and generated-binding workflow;
- supported platform/filesystem matrix;
- build/test/release instructions;
- security policy and vulnerability reporting channel;
- user-facing data-safety, cancellation, conflict, and recovery guide;
- configuration schema/migration policy;
- license, third-party notices, changelog, and release support policy;
- plugin security model before plugin execution is enabled.

The README should state current platform status and limitations instead of implying parity that CI does not prove.

## 12. Success metrics

A metric without a measurement method and a starting value is a slogan. Each item below needs a named check that produces it and a baseline recorded at the start of Phase 0; the ones marked *(baseline 2026-07-28)* already have theirs.

Track these for each stabilization release:

- zero known paths that truncate an existing destination before successful commit — measured by the fault-injection matrix, not by inspection;
- zero operations bypassing the operation engine — static check counting direct `fs::`/VFS mutation calls outside the engine;
- zero missing frontend/native commands — IPC contract check *(baseline 2026-07-28: 6)*;
- zero unhandled Critical/High audit findings — `cargo audit` plus the full machine-readable `npm audit` report, minus entries in the dated exception file; lower-severity findings remain visible and tracked;
- 100% pass rate for claimed-platform packaged smoke tests *(baseline: Linux only; Windows and macOS untested)*;
- 100% of visible safety options covered by native integration tests *(baseline: 0%)*;
- 100% of destructive outcomes retained and visible until acknowledged;
- zero locale validation failures *(baseline 2026-07-28: 20 missing keys across 4 locales)* and zero new accessibility suppressions;
- main initial JavaScript chunk below an agreed budget, asserted by a build-time size check *(baseline 2026-07-28: 1,008.90 kB minified / 306.88 kB gzip; target 500 kB minified)*;
- median and p95 startup, directory-load, search-start, and operation-progress latency tracked per release — these need an instrumentation mechanism that does not exist yet, so either build it in P3.6 or drop the metric rather than reporting it by feel;
- dependency exceptions have owners and expiry dates, with no silently ignored advisories, and an expired exception fails CI.

## 13. Ownership and review gates

This is a single-developer project. Five named owners and a mandatory second human reviewer are not available, and writing them into the plan makes the gates unenforceable rather than strong. The roles below are therefore **review hats** — checklists the same person applies deliberately at a phase boundary, not people:

- **Filesystem safety:** operation invariants, path/symlink policy, fault-injection sign-off.
- **Archive security:** format matrix, hostile corpus, resource limits, fuzzing.
- **Platform:** target gating, native launch/elevation, packaged test matrix.
- **Frontend quality:** IPC binding use, race removal, error visibility, accessibility/localization.
- **Release/security:** CI gates, advisories, licensing, signing, SBOM/provenance.

What replaces the second reviewer for Critical filesystem, archive, privilege, and process-launch changes:

1. **Evidence, not judgement.** Each acceptance gate must be satisfied by a test that fails against the previous implementation. A gate signed off by reading the diff does not count.
2. **A separated review pass.** The change is reviewed against its acceptance gate in a distinct session from the one that wrote it, with the finding text at hand — an independent review agent or a deliberate later pass, not a re-read while the implementation is still fresh.
3. **A written record per Critical finding** stating which test proves it closed. "Closed by inspection" is not an allowed outcome for a Critical.

The project owner decides three things this plan cannot decide: the license (QSF-020), the CI substrate (section 2), and whether Fase 9 cutover completes before Phase 1 (P0.0).

## 14. Recommended first implementation slice

The first mergeable slice should be deliberately narrow, and it happens **in the monorepo**:

0. Settle P0.0 — confirm the monorepo is the implementation target and finish or explicitly park Fase 9.
1. Complete P0.0a — re-baseline every finding against the chosen monorepo commit and account for the 0.8.34-to-0.8.33 drift before changing code.
2. Establish the CI gate set and make current formatting, linting, locale, and dependency gates green — fixing the `cargo fmt` and `clippy` violations in the same change, and proving each gate can fail.
3. Generate a command inventory and disable the six unimplemented IPC calls (`archive_test`, `split_file`, `combine_files`, `check_is_binary`, `edit_config_file`, `get_os`).
4. Capture the characterization suite for current copy behavior, so the next steps have something to regress against.
5. Add `OperationSpec`, `JobId`, structured outcomes, and a bounded single-runner job skeleton without changing user-visible copy semantics yet.
6. Implement atomic replacement for a single regular-file copy with no-follow destination checks, on Linux only — declare explicitly what the Windows adapter will have to provide instead.
7. Prove it with failure injection and existing-destination tests.
8. Route one UI copy flow through it and show the retained structured result.

That slice validates the architecture and test harness before extending it to recursive copy, move, delete, rename, and archives. Its real purpose is to find out what the engine actually costs — if step 5 turns out to be much larger than expected, the phase sizing in section 7 must be revised before Phase 1 continues, not after.

## 15. Final release posture

Until Phases 0–2 are complete, releases should be labeled preview/beta and should warn users to maintain independent backups. After those phases, production readiness should be decided from the evidence—fault-injection results, hostile archive corpus, platform builds, and packaged smoke tests—not from feature completeness alone.

Two things the original plan left open:

- **Versions already distributed.** Version 0.8.34 was reviewed and contains the Critical paths documented here. Earlier `.deb` releases may share them, but were not independently audited and must not be described as affected without verification. The plan covers future releases but says nothing about installations already in use. Decide explicitly whether the known-limitations warning from P0.1 reaches existing installations—a release note nobody reads is not a mitigation—and record the decision either way.
- **What "not production-ready" means in practice.** The Critical findings are all in ordinary, frequently used paths: copy, move, overwrite, extract. This is not a product that is safe except at the edges. Until P0.6 lands, the honest statement to users is that operations which overwrite existing files can lose the original, and the README should say so rather than implying platform parity and general readiness that CI does not prove.
