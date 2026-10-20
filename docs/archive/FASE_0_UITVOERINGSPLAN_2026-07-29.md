# Fase 0 execution plan — contain immediate risk

**Date:** 2026-07-29
**Status:** **Executed 2026-07-29.** All nine items landed; see "Outcome" below.
**Derived from:** `COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md`, section
"Phase 0 — Contain immediate risk" (P0.1–P0.9; P0.0/P0.0a are already
satisfied — the monorepo is the designated implementation target per
`CLAUDE.md`, confirmed again by this plan's re-verification pass).

## Context

The comprehensive quality/safety plan is a **proposal** — nothing in it has
been implemented yet. It was written against the just-completed Fase 9
cutover and is the designated next step. Before committing to an execution
order, every Phase 0 finding was re-verified against the current monorepo
state rather than trusted from the plan text, which is already partly stale
(several items had already been fixed as a side effect of Fase 9 work; one
new item turned up that the plan didn't know about).

Two decisions the plan explicitly reserves for the project owner were made:

- **License: MIT everywhere.** `apps/desktop/LICENSE` was GPL-3.0 text while
  every `package.json` (root, desktop, web) already declared `"MIT"` and
  `apps/web/LICENSE` was already MIT — a live conflict, not a hypothetical
  one.
- **CI substrate: deferred.** No git remote is configured. Only the local
  `npm run verify` + pre-push fallback is built now; the GitHub-vs-Forgejo
  choice stays open until a remote exists.

Two items are explicitly **out of scope** for this pass and should be picked
up next, before any Phase 1 rewrite of copy/move/archive begins:

- The full QSF-023 characterization suite (every format, cancellation,
  fault-injection case) — Phase 0 only adds targeted regression tests for the
  P0.6 stopgap.
- The complete 25-finding P0.0a traceability table — this pass re-verified
  only the findings with a Phase 0 deliverable.

## Verified current state (2026-07-29)

| Item | Plan claim | Actual state |
|---|---|---|
| QSF-008 unregistered IPC | 6 commands invoked, unregistered | **Confirmed live** — `archive_test`, `split_file`, `combine_files`, `check_is_binary`, `edit_config_file`, `get_os` invoked from `apps/desktop/src/lib/ipc.ts` (lines 173/177/181/201/462/492), none exist in `src-tauri/src` at all |
| QSF-006 Windows shell | `cmd /C start` injection risk | **Confirmed live** — 5 call sites in `apps/desktop/src-tauri/src/terminal.rs` (85-91, 138-144, 168-186, 189-195); array-style `.arg()` doesn't neutralize it because `cmd.exe` itself re-tokenizes (`&`, `|`, `^`, `%VAR%`) |
| QSF-024 locale keys | 5 keys missing in de/es/fr/pt | **Already fixed** — `check-locales.js` passes, keys landed with Fase 9 commits `11f63f2`/`134765b` |
| QSF-020 version string | hardcoded `v0.8.29` in app.html | **Already fixed** — `app.html:61` now a comment pointing at `tauri.conf.json` as single source. **New finding**: `apps/web/static/sw.js:4` has stale `CACHE_VERSION = 'v0.8.28'` |
| QSF-020 license | MIT/GPL conflict | **Confirmed live** — see Context above |
| QSF-014 CSP/asset scope | broad scope, undocumented | `assetProtocol.scope: ["**"]` confirmed; CSP already hardened (`script-src 'self'`, `object-src 'none'`, no `unsafe-eval`/`unsafe-inline` in script-src) but **no regression test exists** |
| QSF-023 test coverage | 26 tests, 5 files, no test dirs, no frontend tests | **Confirmed unchanged** |
| CI | build-only | **Confirmed** — `desktop.yml`/`web.yml` build+typecheck only, no test/fmt/clippy/audit; no remote configured; no `verify` script; no pre-push hook |
| QSF-025 plugin API | docs-only, no loader | **Confirmed** — `packages/ui/src/lib/plugin-api.ts` (250 lines) is interfaces only, zero dynamic import/eval of plugin code anywhere |
| QSF-007 elevation | whole-app `pkexec` restart | **Confirmed** — `lib.rs:314` `restart_as_root`, spawns `pkexec <current_exe>` and exits (Phase 4 work, not Phase 0 — noted for context only) |

## Execution order

Quick independent items first (separate commits each), the one high-risk item
(P0.6) as its own focused pass with full source reads first, dependency work
after (touches the same Cargo ecosystem as P0.2), verify/hook wiring last so
it reflects the final command set.

### 1. P0.1 — Disable the 6 unregistered IPC commands

Guard/hide the UI paths that call `archiveTest`, `splitFile`, `combineFiles`,
`checkIsBinary`, `editConfigFile`, `getOS` (call sites reachable from
`apps/desktop/src/lib/ipc.ts` — find each caller first) so they fail closed
with a clear "not implemented" state instead of a runtime IPC error. Not
implementing the backend commands — that's later, larger work.

### 2. P0.9 — Plugin API marked experimental

Add a status comment to `packages/ui/src/lib/plugin-api.ts` stating the API is
experimental/unimplemented, and a static check (small script, wired into
`npm run check`) asserting no file dynamically imports/evals anything from a
plugin-api path — a regression guard, since no loader exists today.

### 3. P0.5 — Metadata fixes

- Replace `apps/desktop/LICENSE` (currently GPL-3.0 text) with the MIT text
  already used in `apps/web/LICENSE`.
- Add a root `LICENSE` (MIT).
- Add `license = "MIT"` to `[package]` in
  `apps/desktop/src-tauri/Cargo.toml`.
- Bump the stale `CACHE_VERSION = 'v0.8.28'` in `apps/web/static/sw.js`.

### 4. P0.8 — CSP regression test + accepted-risk doc

Add a small test (Node script or Rust test) asserting the CSP string in
`apps/desktop/src-tauri/tauri.conf.json` hasn't regressed (no `unsafe-eval`,
no `unsafe-inline` in `script-src`, `object-src 'none'`). Record the accepted
`assetProtocol.scope: ["**"]` risk in `docs/archive/BACKENDS_EN_SECURITY.md` (already
referenced by `CLAUDE.md` for backend trust-model docs) naming the actual
consumers (`MiniPlayer.svelte` audio preview, `ContextMenu.svelte` open-with
icons, `FileViewer.svelte` image viewing) and a review date.

### 5. P0.2 — Windows shell invocation

Read `terminal.rs` in full first. Planned fix per call site:

- `open_file` (line ~138): replace the `cmd /C start` invocation with
  `tauri-plugin-opener` (**already a dependency** in `Cargo.toml` — this is
  exactly the "Tauri opener" the plan recommends, not a new dependency).
- `open_in_editor` (line ~168-195): spawn the editor directly via
  `Command::new(editor).arg(path)` — no `cmd`/`start` needed since the target
  program is already known, which removes the re-tokenization risk entirely.
- `open_terminal` (line ~85-91): path only reaches `.current_dir()`, not the
  command line, so it isn't part of this injection surface — verify during
  implementation and leave as-is if confirmed.

### 6. P0.6 — Destructive-overwrite stopgap (critical, own focused pass)

Read `vfs.rs`, `task_queue.rs`, and `archive.rs` in full before editing, per
`CLAUDE.md`'s safety-critical read-first rule. Add an explicit
destination-exists check that refuses the operation — returning a clear
structured `OpResult`, never silently — before any existing content is
touched, for: direct copy (`vfs.rs`), queued copy and move (`task_queue.rs`,
including the "delete destination before securing source" move path), and
archive creation (`archive.rs`). This is the item the plan itself calls out
as reducing the most near-term user risk.

**Targeted regression tests (P0.7 subset, rides along with this change):**

- An existing destination file survives byte-for-byte when copy/move/archive-
  create is attempted onto it.
- Normal copy/move/archive-create to a non-existing destination still
  succeeds unchanged.

Full QSF-023 characterization suite is flagged as follow-up work, not
attempted here.

### 7. P0.3 — Dependency updates + audits

Run `cargo audit`, `npm audit`, and `cargo update --dry-run` **in the
monorepo** (the plan's audit table is from the legacy repo and hasn't been
re-run here) to see the actual current advisories, then apply compatible
bumps. Follow the existing frozen decisions in `CLAUDE.md` (`rfd` stays
`gtk3`-only; don't reintroduce `xdg-portal`). Sequenced after P0.2 since both
touch the Tauri/Cargo dependency graph.

### 8. P0.4 — Local verify + pre-push fallback

Add a root `npm run verify` script chaining `npm run check`, `npm run build`,
`cargo fmt --check`, `cargo clippy`, `cargo test`, `cargo audit`, `npm audit`
(now meaningful after P0.3) and a plain shell pre-push hook (via
`git config core.hooksPath` — no new dependency like husky unless requested)
running the same command set. Done last so it reflects the final state of
everything above.

## Outcome (2026-07-29)

Eleven commits, `245057f`..`fb85689`. Every item landed as planned; the notes
below are the places where execution found something the plan did not know.

| Item | Commit | Note |
|---|---|---|
| P0.1 | `245057f` | Fix had to run through the capability seam, not the UI: the six commands **are** implemented on web (Express endpoints), so QSF-008 is desktop-only. Moved five from required to optional in `ipc-contract.ts` and dropped them from the desktop adapter, so `hasCapability` reports them absent. |
| P0.9 | `8f28b1b` | New `scripts/check-no-plugin-loader.js`. **The first version passed against a real loader** — its regex excluded backticks, so a template-literal plugin path never matched. Exactly the `CLAUDE.md` failure mode. Fixed and re-verified with four probes. |
| P0.5 | `feb7b76` | Licence settled on MIT. Also found `apps/web/scripts/bump-version.sh` **crashed on every run** — it rewrote a version in `AboutDialog.svelte`, which moved to `@nexus/ui` and now takes the version as a prop. No web bump could complete. New `scripts/check-versions.js` gates all sites. |
| P0.8 | `0e44cc7` | `scripts/check-csp.js` pins the directives that carry the weight, not the whole string. It also fails if the accepted-risk paragraph is deleted while the scope stays broad. |
| P0.2 | `a466e08` | Verified rather than assumed that `tauri-plugin-opener` avoids the shell: it enables open's `shellexecute-on-windows` feature, so both variants reach `ShellExecuteExW`. Without that feature the crate falls back to `cmd /c start` and the change would have been a no-op. Also removed a `cmd /C where` probe that was always true. |
| P0.6 | `de45eec` | New `src/safety.rs`; guards on `copy_file`, `copy_directory` (per file, so directory merges still work), `rename_entry`, `copy_file_chunked`, `execute_move` and `pack_archive`. 26 -> 36 tests. |
| P0.3 | `2b3ac91` | The plan's audit table did not survive contact with the monorepo. npm had **one high**, not three lows: `adm-zip` 0.5.18, a **direct** dependency of the web archive routes. Upgraded to 0.6.0 (semver-major) and round-trip verified. cargo had quick-xml in **two** versions; neither reaches a shipped target. A plain `cargo update` cleared all four plus three warnings. |
| P0.4 | `6205cc7`, `99d685a`, `fb85689` | Split in three: make fmt green, make clippy green, then add the gates — a gate that lands red gets bypassed, not fixed. Eight of clippy's 18 are one architectural problem (`too_many_arguments` in `archive.rs`) and are silenced with a pointer to P3.4. |

**Frozen decision re-verified:** `rfd` still resolves gtk3-only and `ashpd`
reaches no shipped target, checked again after the lockfile update.

**Deferred as planned:** CI substrate choice (no remote exists);
Windows-native verification (P4.1); the full QSF-023 characterization suite;
the complete 25-finding P0.0a traceability table.

**Two findings raised but not fixed here**, both outside P0.6's scope:
`batch_rename` still uses predictable temporary names and can overwrite on its
final rename (QSF-011, owned by P1.6); the release path still runs no tests at
all (QSF-021, owned by P4.3).

## Verification

- After each numbered item: run `npm run check` (svelte-check both apps +
  locale sync) and `cargo check && cargo test --manifest-path
  apps/desktop/src-tauri/Cargo.toml`.
- Item 6 (P0.6) specifically: run the new targeted regression tests and
  confirm they fail against a pre-fix checkout (revert locally, confirm red,
  re-apply) — per `CLAUDE.md`'s "verify a check can fail" rule.
- Item 5 (P0.2): manually exercise "open with default app" and "open in
  editor" from the desktop app on Linux (Windows-native verification isn't
  possible in this environment — call this out as unverified-on-Windows in
  the commit).
- Item 8 (P0.4): deliberately break one gate (e.g. introduce an unformatted
  Rust file) and confirm `npm run verify` and the pre-push hook both go red,
  per the same "verify a check can fail" rule.
- Commit each numbered item separately, matching the existing Fase 9 commit
  granularity in this repo's history.
